# 00 — Research findings

Everything here is the evidence base for the design decisions in the rest of
`docs/`. Sources are listed at the bottom.

---

## 1. The latency problem is not an optimisation problem

This is the single most important finding, and it reframes target #1.

### 1.1 Measured / documented latency budget

End-to-end, gesture → sound at the user's ear:

| Stage | Typical | Worst realistic | Notes |
| --- | --- | --- | --- |
| Camera sensor exposure + ISP + driver | 20–60 ms | 80 ms | Not controllable from the browser. Phone cameras and "smart" webcams (iPad Center Stage, Windows Studio Effects) are the worst offenders. |
| Frame delivery into `<video>` / capture surface | 5–15 ms | 30 ms | Frame-rate quantised: at 30 fps this alone contributes 0–33 ms of jitter. |
| Transfer to worker (`ImageBitmap`/`VideoFrame`) | 1–5 ms | 10 ms | Zero-copy where supported. |
| `HandLandmarker` inference | 5–15 ms (GPU) | 25–40 ms (CPU) | GPU delegate = WebGL today; WebGPU for vision tasks is still open upstream. |
| Gesture logic | < 1 ms | 2 ms | Negligible. |
| Audio output latency (`AudioContext.outputLatency`) | 5–30 ms | 100 ms+ | Bluetooth speakers/headphones are catastrophic here (often 120–300 ms). |
| **Total** | **~60–130 ms** | **~250 ms+** | |

### 1.2 Why that's fatal

Musicians perceive an instrument as "tight" below roughly **20–30 ms** action-to-sound,
and clearly laggy above ~50 ms. Timing *jitter* is judged even more harshly than
constant latency — a consistent 40 ms delay is playable, a 10–50 ms wandering
delay is not.

A naive pipeline lands at 2–4× the acceptable figure, and frame quantisation at
30 fps injects ±16 ms of jitter on top. **No amount of optimisation closes that
gap**, because the largest single term (sensor + ISP) is outside our control.

### 1.3 The way out: predict, then schedule

Two published results make the fix possible.

**(a) Preparatory motion is informative.** Work on anticipating musical gestures
in accelerometer signals shows models can trigger a drum sound *just before*
physical impact by reading the preparatory motion, cutting perceived latency.

**(b) Acceleration peaks beat hits.** Analysis of air-drumming motion compared
two candidate features — the "hit" (the direction change at the end of the
stroke) and the "acceleration peak" (the sharp peak in acceleration magnitude as
the hand decelerates). The acceleration peak is the better trigger because it
**occurs earlier and with less variability**.

So: a keystroke is a *ballistic* motion. Once ~2–3 samples of the downstroke
exist, the remainder of the trajectory is highly predictable. We extrapolate the
time of contact, and emit the note early enough that it *arrives* at the moment
the finger would have landed.

This converts an unwinnable latency race into a tractable prediction problem —
and it also **removes jitter**, because the note is scheduled on the sample-accurate
Web Audio clock rather than fired on whichever video frame happened to notice.

Detailed design: [`02-gesture-engine.md § 4`](02-gesture-engine.md#4-the-predictive-onset-engine-poe).

### 1.4 Measuring the latency we must cancel

`HTMLVideoElement.requestVideoFrameCallback()` gives per-frame metadata
including **`captureTime`** (when the frame was captured, available for local
camera sources), `expectedDisplayTime`, and `processingDuration`. Comparing
`captureTime` against the callback's `now` yields a live, per-device estimate of
capture-side latency — exactly the quantity the predictor needs to cancel.
`AudioContext.outputLatency` supplies the output-side term.

Together they let AirKeys **auto-calibrate its lead time per device**, rather
than shipping one hardcoded guess.

---

## 2. Hand tracking

### 2.1 Choice: MediaPipe Tasks Vision `HandLandmarker`

The mature option for the browser. Relevant properties:

- 21 landmarks per hand, up to N hands (`numHands`, default 2).
- Two coordinate outputs: **normalised landmarks** (image space, for overlay
  drawing) and **world landmarks** (approximately metric, origin at the hand's
  geometric centre). *World landmarks are the ones to do kinematics on* — they
  are far less sensitive to camera FOV, distance and framing.
- `delegate: 'GPU'` (currently WebGL-backed) vs `'CPU'`. WebGPU support for
  vision tasks is an open upstream issue, so plan for WebGL and treat WebGPU as
  a future upgrade.
- `runningMode: 'VIDEO'` with `detectForVideo(frame, timestampMs)` — monotonic
  timestamps required.
- Confidence knobs: hand detection / presence / tracking, all default 0.5.

### 2.2 It runs in a Web Worker

Google's own web samples run `HandLandmarker` inside a worker: the model is
fetched as a buffer and passed as `modelAssetBuffer`, frames arrive as
`ImageBitmap` or `VideoFrame` via `postMessage`, `detectForVideo` is called with
a timestamp, results are posted back, and the bitmap is closed. This is the
pattern to copy — it keeps inference off the main thread so UI and audio
scheduling never stall behind it.

### 2.3 The signal to actually use

Depth (`z`) from a single camera is the weakest axis of MediaPipe's output. Any
design that keys off "how far forward is the fingertip" will be noisy and
device-dependent.

**Finger flexion angle is the robust alternative.** A real keystroke is a
flexion at the MCP and PIP joints. Joint angles are:

- unitless (scale-invariant → same thresholds at any camera distance),
- translation-invariant (hand can move around the frame),
- largely view-invariant compared to raw z.

So the primary strike signal is **joint angular velocity**, with fingertip
displacement *in a palm-local reference frame* as the secondary signal. Working
in the palm frame is what separates "a finger articulated" from "the whole hand
moved", which is the main source of false positives.

### 2.4 Frame rate is the top technical risk

A fast keystroke lasts ~60–120 ms. At 30 fps that is **2–4 samples** — barely
enough to fit a ballistic model, and the reason many air-instrument demos feel
mushy. Mitigations, in priority order:

1. Request 60 fps explicitly and prefer fps over resolution (hand tracking does
   not need 1080p; 480–720p is ample).
2. Resample the landmark stream to a fixed internal 120 Hz clock with
   interpolation + One-Euro filtering, so the detector sees a uniform stream
   regardless of source rate.
3. When only 30 fps is available, widen the commit horizon and lean harder on
   the ballistic prior (accept slightly worse velocity estimation).

---

## 3. Audio

### 3.1 Sampled piano beats synthesis, but it's heavy

**Salamander Grand Piano** (Yamaha C5, recorded with a pair of AKG C414s in AB
~12 cm above the strings, 48 kHz / 24-bit) is the reference free library: 88
keys × 16 velocity layers, CC-BY licensed, and the basis of `@tonejs/piano`,
which samples every third note across the keyboard. `smplr` is a lighter
alternative shipping a Steinway-derived set at 4 velocity groups.

The full matrix is hundreds of megabytes — unusable as a page load. The design
answer is **progressive loading**: ship a small core set for an instant first
note, then stream the full velocity/pitch matrix in the background and hot-swap.
Details in [`04-audio-engine.md`](04-audio-engine.md).

### 3.2 `latencyHint` measurably changes the audio callback interval

Reported `AudioWorkletProcessor` callback intervals by hint: `"playback"`
≈ 23.2 ms, `"interactive"` ≈ 11.6 ms, `"balanced"` ≈ 9.9 ms. Use
`"interactive"` as the default and expose a manual override, since the mapping
is implementation-defined and not uniform across browsers.

### 3.3 Mobile / Safari caveats — plan around these

- Safari has historically shipped bugs where WebAudio output is *delayed and
  glitchy*, and its support for latency introspection has lagged
  (a known `FIXME` in WebKit). Firefox and Chrome on iOS/iPadOS use WebKit and
  inherit the same behaviour, so "use another browser" is not a fix on iOS.
- The mandated 128-sample AudioWorklet quantum is reported to cause distortion
  and crackle on some mobile devices, with iOS crackling on user interaction
  during playback. Practical consequence: **do the heavy lifting with native
  nodes** (`AudioBufferSourceNode`, `ConvolverNode`, gain/biquad graphs) and
  reserve AudioWorklet for the few things natives can't do (brickwall limiting,
  sympathetic resonance), with a native fallback path if a worklet underruns.
- AudioContext requires a user gesture to start on iOS, and can be interrupted
  by calls/route changes — needs explicit resume-on-visibility handling.
- Bluetooth output adds 120–300 ms that prediction *cannot* hide (it exceeds a
  keystroke's whole duration). Detect via `outputLatency` and warn the user.

---

## 4. Music generation

### 4.1 Don't reach for a neural model

Real-time interactive systems in this space (OMax / ImproteK / Djazz, Somax 2)
work because their generative algorithms are **fast and incremental**, producing
output in sync with the performer, typically by concatenating phrases from an
indexed corpus against a known chord progression. The lesson transfers directly:
for a note that must land within ~10 ms of a decision, a rule-based +
constraint-satisfaction engine with a stochastic layer is the right tool. A
model-based approach can later run *above* the real-time layer (choosing
progressions, structure, mood arcs) where a 100 ms budget is fine.

### 4.2 Voice leading is a solved, cheap problem

Smooth voice leading — minimising total intervallic movement between successive
chord voicings — is what separates "chords" from "a pianist". It can be
implemented as a search over voicing candidates, and the literature pairs
voice-leading rules with a **Viterbi** pass to pick an optimal path. At our
polyphony a greedy nearest-voicing search with a small beam is sufficient and
runs in microseconds.

### 4.3 What makes generated piano sound *human*

Three things, all cheap, all mandatory:

1. **Partial quantisation.** Snap onsets toward a (optionally swung) grid at
   ~0.6–0.8 strength, never 1.0. Full quantisation sounds like a drum machine;
   none sounds sloppy. Because AirKeys *predicts* onsets ahead of time, it can
   snap forward to the next grid line at no latency cost — a benefit unique to
   the predictive architecture.
2. **Velocity shaping.** Metric accent patterns, plus small correlated noise —
   not per-note independent randomness.
3. **Pedalling and resonance.** Automatic sustain that lifts on chord change,
   plus sympathetic string resonance and release samples. This is most of the
   perceived gap between "MIDI piano" and "piano".

---

## 5. Ranked risks

| # | Risk | Severity | Mitigation |
| --- | --- | --- | --- |
| R1 | 30 fps cameras give too few samples per keystroke → mushy or missed onsets | **High** | Force 60 fps where possible; 120 Hz resampler; widen commit horizon at low fps; measure and surface a "tracking quality" score |
| R2 | Bluetooth audio latency (120–300 ms) defeats prediction entirely | **High** | Detect via `outputLatency`; explicit in-app warning + "wired/speaker recommended" |
| R3 | Prediction misfires produce phantom notes | **High** | Confidence→velocity mapping (uncertain strikes play quietly); musical-failure design; density governor |
| R4 | iOS WebAudio glitching / worklet distortion | Medium | Native-node-first graph, worklet fallback, conservative voice caps on mobile |
| R5 | Sample payload vs. time-to-first-note | Medium | Progressive load: ~1–3 MB core, background upgrade |
| R6 | "Smart" cameras (Center Stage, Studio Effects) re-frame mid-session | Medium | Palm-local reference frames; adaptive re-anchoring of the play volume |
| R7 | Thermal throttling on phones during long sessions | Medium | Device tiering + dynamic quality scaling on measured inference time |
| R8 | Poor lighting destroys tracking | Medium | Luminance check + guided fix in onboarding |
| R9 | Sample library licence obligations | Low | CC-BY attribution in-app; see `07-open-questions.md` |

---

## Sources

- [MediaPipe HandLandmarker worker sample (`hand-landmarker.worker.ts`)](https://github.com/google-ai-edge/mediapipe-samples-web/blob/main/src/workers/hand-landmarker.worker.ts)
- [WebGPU support for Vision Tasks — MediaPipe issue #5826](https://github.com/google-ai-edge/mediapipe/issues/5826)
- [GPU delegate performance — MediaPipe issue #6041](https://github.com/google-ai-edge/mediapipe/issues/6041)
- [MediaPipe Hands solution docs](https://mediapipe.readthedocs.io/en/latest/solutions/hands.html)
- [`HTMLVideoElement.requestVideoFrameCallback()` — MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)
- [`requestVideoFrameCallback` explainer — WICG](https://github.com/WICG/video-rvfc/blob/gh-pages/explainer.md)
- [Keeping audio and visuals in sync with the Web Audio API (output latency)](https://www.jamieonkeys.dev/posts/web-audio-api-output-latency/)
- [Does `latencyHint` affect the AudioWorklet callback interval? — web-audio-api-v2 #70](https://github.com/WebAudio/web-audio-api-v2/issues/70)
- [AudioWorklet real-world problems — web-audio-api #2632](https://github.com/WebAudio/web-audio-api/issues/2632)
- [WebKit bug 221334 — WebAudio delayed and glitchy on Safari](https://bugs.webkit.org/show_bug.cgi?id=221334)
- [AudioWorklet — MDN](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet)
- [Salamander Grand Piano (SFZ Instruments)](https://sfzinstruments.github.io/pianos/salamander/)
- [`@tonejs/piano`](https://github.com/tambien/Piano)
- [`smplr` — web audio sampler](https://github.com/danigb/smplr)
- [Air Drums, and Bass: Anticipating Musical Gestures in Accelerometer Signals with a Lightweight CNN](https://www.researchgate.net/publication/374936940_Air_Drums_and_Bass_Anticipating_Musical_Gestures_in_Accelerometer_Signals_with_a_Lightweight_CNN)
- [An Efficient Real-Time Air Drumming Approach Using MediaPipe Hand Gesture Model](https://www.researchgate.net/publication/378167124_An_Efficient_Real-Time_Air_Drumming_Approach_Using_MediaPipe_Hand_Gesture_Model)
- [Reflecting on the Musicality of ML-based Music Generators in Real-Time Jazz Improvisation (OMax/ImproteK/Djazz)](https://www.researchgate.net/publication/355128945_Reflecting_on_the_Musicality_of_Machine_Learning_based_Music_Generators_in_Real-Time_Jazz_Improvisation_A_case_study_of_OMax-ImproteK-Djazz)
- [SongDriver: Real-time Music Accompaniment Generation](https://arxiv.org/pdf/2209.06054)
- [Latency Compensation by Linear Prediction of Hand Posture](https://link.springer.com/chapter/10.1007/978-3-031-70058-3_30)
