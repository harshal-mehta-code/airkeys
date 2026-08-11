# 08 — v1 implementation notes

What actually got built, what it measures, and what is not true yet.

---

## Scope

v1 deliberately implements the spine of the product and nothing else:

**Built**

- Camera capture with fps-first constraint negotiation and `requestVideoFrameCallback` timing
- MediaPipe `HandLandmarker` in a worker, GPU delegate with CPU fallback, frame dropping under backpressure
- Perception: palm-local reference frame, per-finger flexion, One-Euro filtering, cubic ballistic fit, predictive commit, six gates, density governor, auto-calibration of rest pose
- Composition: Cinematic genre, progression graph, nearest-voicing voice leading, contour-driven melody, chord gestures, gesture amplification (flourishes), partial quantisation
- Audio: progressive Salamander sampler with velocity crossfade, procedural convolution reverb, HPF / glue compression / ceiling, automatic pedalling, voice stealing, synth fallback
- Visuals: graded camera, hands-as-light from real landmarks, particles, note ribbon
- Pointer + keyboard fallback when there is no camera
- Recording (canvas + audio → WebM download)

**Not built** (deliberately deferred)

Other genres · sympathetic resonance worklet · duet mode · MIDI export ·
session structure / arranger arc · call-and-response · daily seed · attract
mode · sharing beyond a local file download · device tiering beyond the
GPU→CPU fallback.

---

## Assets

| Asset | Source | Size | Committed? |
| --- | --- | --- | --- |
| `hand_landmarker.task` | Google MediaPipe models | 7.8 MB | **Yes** — no npm source |
| Piano samples | `@audio-samples/piano-mp3-velocity{4,9,14}` (Salamander V3, CC BY 3.0) | 12.0 MB | No — copied at build time |
| MediaPipe WASM | `@mediapipe/tasks-vision` | 33 MB (one variant loaded) | No — copied at build time |

`scripts/prepare-assets.mjs` runs on `predev` / `prebuild` and copies the
npm-sourced assets into `public/`. Everything is served same-origin; there is
no third-party CDN dependency at runtime.

Samples are trimmed to A1–A6 every minor third — the register the composer
actually uses — and renamed to their MIDI number so URLs never contain a `#`.

---

## Measured results

### Predictive onset (`npm run test:onset`, synthetic ballistic strokes)

Measured over a deterministic sweep of 24 sampling phases, because where the
frames land inside the stroke changes the result materially — a single run is
not a measurement.

| Property | Result |
| --- | --- |
| Strokes detected | **24/24**, zero double triggers |
| Note placement error vs. intended contact, 60 fps | **p50 25 ms, p90 41 ms** |
| Note placement error, 30 fps | **38 ms** |
| Median decision time | ~5 ms *after* contact (the note is still scheduled at the predicted instant, which is what the player hears) |
| Deliberate stroke → exactly one note | pass |
| 4 repeated strikes → 4 notes | pass |
| Harder stroke is louder | pass |
| Still hand → no notes | pass |
| Slow curl (making a fist) → no notes | pass |
| Strike during a fast hand sweep → suppressed | pass |

### Browser smoke test (headless Chromium, fake camera)

Tracker initialises, GPU delegate selected, model and WASM load, camera runs,
audio context runs, all 63 samples decode, accompaniment plays, pointer/keyboard
fallback works when `getUserMedia` fails, and no page errors in either mode.

---

## What is NOT verified

Stated plainly, because the tests above can look more conclusive than they are:

1. **No real hands have ever been tracked by this build.** The container has no
   camera. Every perception result comes from a synthetic hand model. The
   geometry is consistent and exercises the same code paths, but real MediaPipe
   output has noise, dropouts, handedness flips and occlusion that synthetic
   data does not.
2. **The latency budget is unmeasured on real hardware.** Headless inference
   measured 600 ms+ under SwiftShader; a real GPU should be 5–15 ms. The
   `lead` readout in the telemetry bar shows the live figure — that number on a
   real device is the single most important thing to look at first.
3. **Nobody has heard it.** Sample decoding is verified; the actual sound,
   mix balance, reverb amount and loudness are unjudged.
4. **iOS/Safari is untested.** The audio graph is native-node-first specifically
   to avoid the documented worklet problems, but that is a precaution, not a
   verification.
5. **One-Euro tuning is fitted to synthetic strokes** (see `07 § N3`).

---

## Known rough edges

- `armVel` / `velFull` are global constants. They should be derived from the
  per-user noise floor captured at calibration, as `02-gesture-engine.md § 7`
  specifies. Calibration currently captures rest pose and palm normal only.
- Calibration triggers on the first frame with tracking score > 0.75, with no
  check that the hand is actually still. A `Recal` button is provided as the
  escape hatch.
- Tempo is fixed per genre; there is no tempo inference from the player yet, so
  quantisation snaps to a fixed grid rather than to the player's own pulse.
- The transport uses a main-thread `setInterval`; the plan calls for a worker
  timer. Fine while the tab is focused, which is when audio runs.
- Chord gestures need 3+ fingers within a 38 ms cluster window. Whether that is
  achievable in the air is unknown until real testing.
