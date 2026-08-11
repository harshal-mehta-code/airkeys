# 04 — Audio engine

Owns target **#3 (premium sound over loud speakers)** and the output half of
target **#1**.

---

## 1. Sampling strategy

Synthesised piano always sounds synthesised. AirKeys uses **multi-sampled
acoustic piano**, with **Salamander Grand Piano** (Yamaha C5, AKG C414 pair in
AB ~12 cm above the strings, 48 kHz/24-bit, CC-BY) as the presumptive default —
the same source behind `@tonejs/piano`. `smplr`'s lighter Steinway-derived set
is the fallback if payload becomes the binding constraint.

The full 88 × 16-velocity matrix is hundreds of megabytes. Unshippable as-is.

### Progressive loading — first note in under a second

| Stage | Contents | Size | When |
| --- | --- | --- | --- |
| **Core** | Every minor third (~30 pitches) × 3 velocity layers, Opus ~112 kbps mono-summed-to-stereo | **~1.5–2.5 MB** | Blocking; must finish before the first note |
| **Enhanced** | Fill to 6 velocity layers, add release samples | ~8 MB | Background; hot-swap when ready |
| **Full** | Every whole tone, 10–16 velocity layers, pedal-down variants | ~25–40 MB | Background / on Wi-Fi / cached |

Pitch-shift up to ±1 semitone from the nearest sample via `playbackRate` — the
standard minor-third sampling compromise, and transparent on piano.

Hot-swapping mid-performance must be seamless: new buffers are only bound for
*future* voices; sounding notes finish on the buffer they started with.

Cache in the **Cache API**, not `localStorage`. Second visit is instant, and
that matters enormously for retention.

### Codec

Opus in WebM where supported (best quality per byte), **AAC in `.m4a` as the
Safari-safe fallback**, feature-detected via `canPlayType`. Decode once to
`AudioBuffer` at load; never decode in the hot path.

---

## 2. What actually makes it sound like a piano

Samples alone give you a *good* piano. These four give you a *real* one, and
they're the difference target #3 is really asking about:

1. **Release samples** — the key-up thump. Small, cheap, disproportionately
   convincing.
2. **Sympathetic resonance** — undamped strings ringing in response. Implemented
   as a bank of tuned, damped comb resonators fed at low gain from the dry bus,
   retuned to currently-held pitches. Runs in an `AudioWorklet`. This is the
   single most "expensive-sounding" addition available.
3. **Pedal-down resonance** — with sustain engaged, the whole soundboard opens.
   Either a dedicated pedal-down IR blended in, or the resonator bank opened up
   across the full harmonic series.
4. **Round-robin + velocity crossfade** — avoids the machine-gun effect on
   repeated notes and the audible steps between velocity layers.

---

## 3. Signal chain

```
voices ──▶ per-note pan ──▶ DRY BUS ──┬──▶ resonance worklet ──┐
  (AudioBufferSourceNode                │                        │
   + gain envelope)                     ├──▶ convolver (hall IR)─┤
                                        │                        │
                                        └────────────────────────┴──▶ SUM
                                                                       │
   accompaniment (bass/drums/pads) ────────────────────────────────────┤
                                                                       ▼
                                      highpass 30 Hz  ──▶ tone/tilt EQ
                                                 ──▶ glue compressor
                                                 ──▶ brickwall limiter (worklet)
                                                 ──▶ output gain ──▶ destination
```

Deliberately **native-node-first**. Given documented AudioWorklet distortion and
crackle issues on mobile — and Safari's history of delayed, glitchy WebAudio
output — worklets are used only for the limiter and the resonance bank, both of
which have native fallbacks (`DynamicsCompressorNode`-based limiting; resonance
off) if underruns are detected at runtime.

### Loudspeaker readiness

This is where "premium over loud speakers" is won or lost:

- **30 Hz highpass** — piano samples carry sub-30 Hz rumble that steals headroom
  and makes small speakers flap. Removing it makes everything louder and cleaner.
- **Glue compression** — gentle (2:1, slow attack) across the bus so stacked
  voices cohere.
- **True brickwall limiter** with lookahead — polyphonic piano peaks are brutal;
  without this, loud passages clip and sound cheap.
- **Loudness normalisation to ≈ −14 LUFS integrated**, measured offline per
  preset so genre switches don't jump in volume.
- **Convolution reverb** — a good hall or studio IR is, subjectively, most of
  "premium". Ship 3–4 IRs (~200–500 kB each compressed).
- **Output profiles** — *Phone speaker* (midrange presence, sub rolled off
  further, more limiting), *Headphones* (wide, full sub, light limiting), *Big
  speakers* (flat, dynamic). Cannot be auto-detected reliably; offer as a
  visible, one-tap choice and remember it.

---

## 4. Scheduling and latency

- `new AudioContext({ latencyHint: 'interactive' })`. Reported worklet callback
  intervals differ by hint (`playback` ≈ 23 ms, `interactive` ≈ 11.6 ms,
  `balanced` ≈ 9.9 ms), but the mapping is implementation-defined — expose an
  advanced override rather than trusting one value.
- **Lookahead scheduling** driven by a *worker* timer (main-thread timers are
  throttled and jittery), scheduling into the audio clock ~80 ms ahead.
- The POE hands us an `audioTime`; voices start exactly there. Because
  `audioTime` is continuous rather than frame-quantised, **timing jitter is
  eliminated** even at 30 fps.
- If a predicted note is aborted (§ 02 4.5) before it sounds, its scheduled
  source is stopped and disposed — free false-positive recovery.
- Report `baseLatency + outputLatency` into the POE's lead-time estimate; flag
  Bluetooth-scale values (> 100 ms) to the user, because no amount of prediction
  can hide them.

---

## 5. Voice management

- Cap polyphony by tier: 64 (desktop) / 40 (tablet) / 24 (phone).
- Steal by *quietest-and-oldest*, never newest.
- Release with a short ramp (~15–30 ms) — abrupt stops click.
- Pool and reuse `GainNode`s; `AudioBufferSourceNode`s are single-use by spec,
  so allocate lazily and let them be collected after `onended`.
- Watch for the audio thread falling behind and shed the resonance bank first,
  reverb second, polyphony third. Never let it drop out.

---

## 6. Mobile and Safari specifics

- **Unlock:** create/resume the `AudioContext` inside the first user gesture; a
  silent buffer play is still the reliable iOS unlock.
- **Interruptions:** calls, route changes and backgrounding suspend the context.
  Resume on `visibilitychange` and on `statechange`, and re-check `outputLatency`
  after any route change (plugging in headphones changes it).
- **Silent switch:** iOS may mute Web Audio with the hardware silent switch — if
  the user reports no sound, surface a hint rather than failing silently.
- **Autoplay:** never attempt sound before interaction; the onboarding "tap to
  begin" doubles as the unlock gesture.
- **Thermals:** long sessions throttle. Tie audio quality to the same tier
  ladder the vision pipeline uses, and degrade in step.

---

## 7. Recording and export

Recording is the growth loop, so it is a first-class audio feature:

- Tap the master chain pre-`destination` with a `MediaStreamDestination`.
- Record audio + the rendered visual canvas via `MediaRecorder` into WebM/MP4.
- **No camera video by default.** Frames never leave the device unless the user
  explicitly enables camera-in-frame.
- Offer a "polish" pass on export — the same chain with slower, higher-quality
  limiting — so shared clips sound better than the live monitor.
- Also export **MIDI**. It costs almost nothing, and it makes AirKeys a genuine
  sketching tool for musicians rather than only a toy.
