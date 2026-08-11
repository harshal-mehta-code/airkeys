# 01 — Architecture

## 1. Shape of the system

Five stages. The contract between them is deliberately narrow so each can be
tested, replaced or stubbed in isolation.

```
 ┌────────────┐   frames    ┌────────────┐  landmarks  ┌────────────┐
 │  CAPTURE   │ ──────────▶ │  TRACKING  │ ──────────▶ │ PERCEPTION │
 │ camera,    │  VideoFrame │ MediaPipe  │  + timing   │ filter,    │
 │ rVFC clock │             │ (worker)   │             │ features,  │
 └────────────┘             └────────────┘             │ POE predict│
                                                       └─────┬──────┘
                                                             │ StrikeEvent
                                                             │ (scheduled t)
                                                             ▼
 ┌────────────┐   NoteEvent  ┌────────────┐   Intent   ┌────────────┐
 │   AUDIO    │ ◀─────────── │  MUSIC     │ ◀───────── │  MAPPING   │
 │ sampler,   │  (audio-time │ harmony,   │            │ gesture →  │
 │ DSP, master│   scheduled) │ voicing,   │            │ intent     │
 └────────────┘              │ groove     │            └────────────┘
        │                    └────────────┘
        ▼
   speakers                        │
                                   ▼
                            ┌────────────┐
                            │  VISUALS   │  (driven from the same
                            │ overlay,   │   scheduled events, so
                            │ particles  │   sight and sound agree)
                            └────────────┘
```

**The event that crosses the middle of the diagram is not "a note happened".**
It is *"a note will happen at audio-clock time T"*. Everything downstream is
scheduled against the Web Audio clock, which is why the system has no jitter
even though its input is a jittery 30–60 Hz video stream.

---

## 2. Threading model

Real-time audio and ML inference must never contend with React renders or
layout. Four execution contexts:

| Context | Runs | Why there |
| --- | --- | --- |
| **Main thread** | UI (React), camera element, `requestVideoFrameCallback`, frame hand-off | Must own DOM and the `<video>` element |
| **Tracking worker** | MediaPipe `HandLandmarker` inference | Inference is 5–40 ms; on the main thread it would stall everything |
| **Scheduler worker** | Lookahead timer ticking every ~15 ms | `setTimeout` on the main thread is throttled and jittery; a worker timer isn't |
| **Audio thread** | `AudioWorklet`: limiter, sympathetic resonance | Only place with hard real-time guarantees |

Perception + mapping + music engine run on the **main thread**. They are cheap
(< 1 ms/frame) and keeping them there avoids serialisation latency. If profiling
shows contention, perception moves into the tracking worker — the module
boundary is drawn to allow that without a rewrite.

Frames move as transferable `VideoFrame`/`ImageBitmap` (zero-copy). Landmarks
come back as a packed `Float32Array` in a ring buffer, not as JSON objects — at
60 fps × 2 hands × 21 landmarks × 2 coordinate spaces, object churn would cause
GC pauses that are audible.

### The two clocks

`performance.now()` (vision) and `AudioContext.currentTime` (audio) drift and
have different origins. A `ClockBridge` module maintains the affine mapping
between them, re-estimated continuously with a slow filter. Every predicted
onset is converted through it exactly once. Getting this wrong is the classic
source of "it works but feels weird" — it is worth its own unit tests.

---

## 3. Module map

```
src/
  capture/
    CameraManager.ts       constraint negotiation, device switching, orientation
    FrameClock.ts          rVFC loop, captureTime → latency estimation
  tracking/
    tracker.worker.ts      MediaPipe HandLandmarker host
    TrackerClient.ts       main-thread proxy, ring buffer, backpressure
  perception/
    Resampler.ts           variable fps → fixed 120 Hz internal stream
    OneEuro.ts             adaptive low-latency landmark filter
    HandFrame.ts           palm-local basis, joint angles, scale normalisation
    Features.ts            per-finger flexion, velocities, posture, spread
    PredictiveOnset.ts     ballistic model, commit horizon, velocity estimate
    Gates.ts               the six false-trigger gates
    Calibration.ts         play volume, noise floor, latency, reach
  mapping/
    IntentMapper.ts        StrikeEvent + hand state → MusicalIntent
    ContourTracker.ts      ascending/descending/static inference
    ChordGesture.ts        simultaneity clustering, spread → voicing width
  music/
    theory/                scales, chords, intervals, voicing math
    Harmony.ts             key/mode state, progression graph, reharmonisation
    VoiceLeading.ts        candidate voicings + smoothness search
    Melody.ts              contour realisation, chord/passing tone selection
    Groove.ts              tempo inference, partial quantisation, swing
    Arranger.ts            song structure, accompaniment, dynamics arc
    Ornaments.ts           runs, grace notes, arpeggio sweeps, glissandi
    genres/                one config bundle per genre
  audio/
    AudioEngine.ts         graph construction, lifecycle, iOS unlock
    Sampler.ts             progressive sample loading, voice allocation
    Scheduler.ts           lookahead scheduling against the audio clock
    worklets/
      limiter.worklet.ts
      resonance.worklet.ts
    master/                reverb, EQ, glue comp, loudness
  visuals/
    Overlay.ts             hand skeleton, play-volume guides
    Particles.ts           note-synced feedback (WebGL)
  app/                     React UI shell, settings, onboarding, sharing
```

Rule: **nothing under `music/` or `audio/` imports from `tracking/` or React.**
The music engine must be drivable from a MIDI keyboard, a mouse, or a test
fixture. That is how it gets tested without a camera, and it's what made the
prototype possible.

---

## 4. Stack

| Choice | Decision | Reasoning |
| --- | --- | --- |
| Build | **Vite + TypeScript** | Fast, first-class worker & worklet bundling |
| UI | **React**, chrome only | Zero React in the hot path; engine is framework-agnostic |
| Tracking | **`@mediapipe/tasks-vision`** | Only mature browser option |
| Audio | **Raw Web Audio API** | Tone.js adds abstraction and scheduling we'd fight; we borrow its *sample set*, not its runtime |
| Overlay | **WebGL** (regl or raw) | Canvas2D particle counts get expensive on mobile |
| State | Small event-emitter store | Redux-style stores are the wrong shape for 120 Hz data |
| Hosting | **Static** (Vercel) | No server needed; everything runs client-side |
| Analytics | Privacy-preserving, aggregate only | Video never leaves the device — say so loudly in the UI |

### Privacy stance

No frame ever leaves the device. Recording captures **audio + the rendered
visualisation**, never raw camera video, unless the user explicitly opts into a
camera-in-frame recording. This is both correct and a marketing asset; it
belongs on the landing screen.

---

## 5. Degradation ladder

The app must never simply fail. Each rung falls back to the next:

1. **Full** — 60 fps, GPU delegate, 2 hands, full samples, resonance worklet, reverb.
2. **Reduced** — 30 fps, GPU, 2 hands, core samples, no resonance worklet.
3. **Lite** — 30 fps, CPU delegate, 1 hand priority, core samples, native limiter only.
4. **No camera / denied permission** — mouse, touch and QWERTY input drive the
   *same* `MusicalIntent` interface. The app is still fun, still shareable, and
   the music engine is fully exercised. This is not a consolation prize; it's
   the desktop practice mode.

Tier is chosen at startup from a 2-second probe (measured inference time,
achieved fps, `deviceMemory`, `hardwareConcurrency`) and re-evaluated
continuously — thermal throttling on phones will push a device down a rung
mid-session and it must do so smoothly, without an audio dropout.
