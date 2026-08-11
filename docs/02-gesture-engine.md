# 02 — Gesture engine

Owns targets **#1 (no lag)**, **#2 (no false triggers)** and **#4 (device
consistency)**.

---

## 1. Capture

### Constraint negotiation

Frame rate matters more than resolution — it directly reduces latency and gives
the predictor more samples per keystroke. Negotiate in this order, taking the
first that succeeds:

```
1280×720 @ 60   →   960×540 @ 60   →   640×480 @ 60
→ 1280×720 @ 30 →   640×480 @ 30   →   whatever the device gives
```

Downscale to ≤ 512 px on the long edge before inference regardless of capture
resolution. MediaPipe gains nothing from more pixels here and costs real
milliseconds.

Also handle: front/rear camera choice and the resulting mirroring, device
rotation, `deviceId` persistence, and hot-swap when a camera is unplugged.

### The frame clock

Drive everything from `requestVideoFrameCallback`, not `requestAnimationFrame`:
it fires once per *video* frame and carries the metadata we need.

```ts
video.requestVideoFrameCallback((now, meta) => {
  // captureTime is present for local camera sources
  const captureLatency = meta.captureTime ? now - meta.captureTime : null;
  latencyEstimator.push(captureLatency);   // slow median filter
  submitFrameToTracker(video, meta.mediaTime);
});
```

`captureLatency` feeds the predictor's lead time. When `captureTime` is
unavailable, fall back to the calibration-measured value (§ 7).

---

## 2. Tracking

`HandLandmarker` in a worker, following Google's sample pattern: model fetched
as a buffer and supplied via `modelAssetBuffer`, `runningMode: 'VIDEO'`,
`numHands: 2` (4 in Duet mode), GPU delegate with CPU fallback,
`detectForVideo(bitmap, timestampMs)` with monotonic timestamps, bitmap closed
after use.

**Backpressure:** never queue frames. If the worker is busy when a new frame
arrives, drop the old one. A stale frame is worse than no frame — it poisons
velocity estimates. Track the drop rate; sustained dropping means demote a tier.

Consume **`worldLandmarks`** for all kinematics and **normalised landmarks**
only for drawing.

---

## 3. Feature extraction (scale- and camera-invariant)

This section is the whole answer to target #4. Every feature below is
dimensionless or normalised, so a threshold tuned on a laptop webcam works on an
iPad at arm's length.

### 3.1 Fixed-rate resampling

Cameras deliver 24 / 30 / 60 fps, unevenly. The detector must not care.
Interpolate the landmark stream onto a **fixed 120 Hz internal clock**, then
filter with a **One-Euro filter** (adaptive cutoff: heavy smoothing when slow,
light smoothing when fast — precisely the trade-off a low-latency gesture system
needs, and strictly better than a fixed EMA).

Downstream code sees a uniform 120 Hz stream. All thresholds become
frame-rate independent by construction.

### 3.2 Palm-local basis

Build an orthonormal frame per hand per sample from the wrist (0), index MCP (5)
and pinky MCP (17):

- **origin** = palm centroid
- **û** = normalise(MCP₅ − MCP₁₇)  (across the palm)
- **ŵ** = normalise(û × (wrist − origin))  (palm normal)
- **v̂** = ŵ × û  (along the palm)

Hand scale `S` = ‖wrist − MCP_middle‖. Divide all displacements by `S`.

Everything expressed in this frame is invariant to where the hand is, how far
away it is, and how it's rotated. **A hand translating downward produces zero
articulation signal in this frame; a finger flexing produces a large one.** That
single property removes the largest class of false triggers.

### 3.3 Per-finger features

For each of 10 fingers, at 120 Hz:

| Feature | Definition | Used for |
| --- | --- | --- |
| `flex` | MCP + PIP joint angle sum (radians) | **Primary strike signal** |
| `flexVel`, `flexAcc` | 1st/2nd derivative, Savitzky–Golay smoothed | Ballistic model |
| `tipVel` | fingertip velocity in palm frame, in units of `S`/s | Secondary strike signal |
| `verticality` | \|downward component\| / ‖velocity‖ | Strike vs. swipe |
| `spread` | angle to neighbouring fingers | Voicing width |
| `curlRest` | flexion relative to this user's rest pose | Personalisation |

### 3.4 Per-hand features

`palmNormalTilt` (angle from "down"), `palmVel` (bulk translation — subtracted
out of finger features), `handOpenness`, `zoneX` (horizontal position in the
calibrated play volume, 0–1), `handedness` + confidence, `trackingQuality`.

Savitzky–Golay is preferred over plain finite differences for derivatives: it
fits a low-order polynomial over a short window, which is both smoother and —
importantly — gives the polynomial coefficients the predictor needs anyway.

---

## 4. The Predictive Onset Engine (POE)

**The core of the app.** Fire the note before the finger arrives, so the sound
lands when the finger would have.

### 4.1 Why this works

A keystroke is ballistic. After ~2–3 samples of downstroke, the rest of the
trajectory is strongly determined. The air-drumming literature confirms the
acceleration peak both *precedes* the hit and *varies less* than the hit itself,
making it the better trigger feature.

### 4.2 Lead time

```
L_total = L_capture + L_inference + L_processing + L_output
```

- `L_capture` — from `rVFC.captureTime`, or calibration
- `L_inference` — measured in the worker, running median
- `L_processing` — measured, ~1 ms
- `L_output` — `AudioContext.outputLatency` (+ `baseLatency`)

`L_total` is re-estimated continuously. Typical desktop ≈ 45 ms, phone ≈ 70 ms,
Bluetooth ≈ 200 ms+ (unhideable — warn instead).

### 4.3 Algorithm

Per finger, a small state machine: `IDLE → ARMED → COMMITTED → REFRACTORY`.

**IDLE → ARMED.** `flexVel` exceeds the adaptive noise floor (§ 7) in the
flexion direction *and* `flexAcc` is positive. Snapshot the trajectory.

**ARMED — every sample**, fit a constant-jerk model to the last 4 samples of
`flex(t)` and solve for the predicted contact time `t_c`: the moment flexion
velocity peaks and begins to reverse (the deceleration onset), which is the
acceleration-peak feature the literature identifies.

```
t_remaining = t_c − t_now
if (t_remaining ≤ L_total)  →  COMMIT
```

We commit exactly when the remaining travel time has shrunk to the pipeline
latency. Earlier would be guessing; later would be late.

**COMMITTED.** Emit a `StrikeEvent`:

```ts
{
  hand: 'L' | 'R',
  finger: 0..4,
  audioTime: number,     // ClockBridge(t_c) — sample-accurate
  velocity: number,      // 0..1, from predicted peak flexVel
  confidence: number,    // 0..1, product of the six gates
  zoneX: number,
  spread: number,
}
```

`audioTime` is the *predicted contact instant* mapped into the audio clock. The
audio engine schedules against it. **This is what kills jitter**: the note is
placed on a continuous clock, not quantised to a video frame.

**REFRACTORY.** 70–90 ms lockout, plus a Schmitt trigger — flexion must recross
an extension threshold before the finger can re-arm. Kills tracking-noise
double-triggers.

### 4.4 Predicting velocity, not just timing

We commit before peak velocity, so peak `flexVel` hasn't been observed yet. The
same jerk model extrapolates it. Error is small (single-digit %) and maps to a
dynamics error far below the perceptual threshold — and velocity is one
dimension where being slightly wrong is musically harmless.

### 4.5 Two safety valves

1. **Abort window.** Between COMMIT and `audioTime` there are still a few frames.
   If the finger visibly reverses without completing, and the note has not yet
   sounded, cancel the scheduled voice. Recovers a good share of false positives
   *for free* — a benefit only a scheduled-ahead architecture can offer.
2. **Confidence → velocity.** Marginal strikes are not suppressed; they are
   played *quietly*. A false positive at *ppp* inside the current chord is
   inaudible as an error; a true positive suppressed is a hole in your
   performance. Asymmetric costs, asymmetric treatment.

---

## 5. False-trigger suppression: the six gates

Confidence is the product of six gate scores in [0, 1]. Below a floor, nothing
fires; between floor and 1, the note plays proportionally softer.

| # | Gate | Rejects |
| --- | --- | --- |
| **G1** | **Play volume** — hand inside the calibrated slab | Hands at rest, out of frame, reaching for coffee |
| **G2** | **Posture** — palm normal within a cone of "down", fingers not fisted | Waving, talking with hands, pointing, phone-holding |
| **G3** | **Articulation** — flexion velocity dominates bulk palm velocity | Repositioning the whole hand (the biggest false-positive source) |
| **G4** | **Kinematic signature** — downstroke duration 50–250 ms, verticality above threshold, plausible amplitude | Swipes, drifts, slow curls |
| **G5** | **Tracking health** — landmark confidence, no implausible jumps, handedness stable | Occlusion, hand entering/leaving, mistracking |
| **G6** | **Musical plausibility** — density governor; rate-limits per hand and globally | Flailing, tracking storms, one finger machine-gunning |

### G6 deserves emphasis

It is a *musical* gate on a *perception* problem, and it is unreasonably
effective. If gestures arrive faster than a pianist could plausibly play, the
excess is not rendered as notes — it is absorbed into the ornament system as a
run or a roll, or dropped. The user cannot produce a mess even when the tracker
is having a bad second.

### And the deepest defence

**Every note AirKeys can possibly play is correct in the current key and
chord.** A false trigger is not a wrong note — it is an extra passing tone. The
worst-case failure is "slightly busier than intended". No other design decision
buys as much robustness for as little cost, and it is why targets #2 and #5 are
really the same target.

---

## 6. Sustain, dynamics and continuous control

Not everything is a discrete strike:

- **Sustain pedal** — flat open palm held below the play volume (either hand), or
  the automatic pedalling of the arranger (default on).
- **Expression** — hand height within the volume maps to a slow dynamics/timbre
  contour, smoothed heavily (this is a *macro* control, not per-note).
- **Modulation** — palm rotation → reverb send / filter openness in pad-based
  genres.
- **Damping** — a quick flat-palm downward swipe cuts sustain (a real gesture
  pianists make, and it reads unambiguously).

---

## 7. Calibration (~8 seconds, once per session, skippable)

Runs as a delightful onboarding moment, not a settings screen:

1. **Rest** (2 s) — "hold your hands like there's a keyboard". Captures the play
   volume, rest pose, hand scale `S`, per-finger `curlRest`, and the **noise
   floor** (landmark jitter variance under stillness). Every threshold is
   expressed as a multiple of measured noise, which is why the app behaves the
   same on a crisp webcam and a grainy phone in dim light.
2. **Three taps** (3 s) — "tap three times like you're playing". Measures the
   user's stroke amplitude, duration and dynamic range; personalises the
   ballistic model.
3. **Latency check** (3 s) — visual metronome; a flash is scheduled at predicted
   contact, and the residual between the predicted and observed contact frame
   refines `L_total`. Also detects catastrophic Bluetooth latency and warns.

Everything persists to `localStorage`, keyed by camera `deviceId`.

An always-visible, unobtrusive **tracking quality meter** shows green/amber/red
with a one-line reason ("too dark", "hands too close to camera", "only 24 fps
available"). Users forgive a system that tells them what's wrong.

---

## 8. How each target is met

| Target | Mechanism |
| --- | --- |
| **#1 No lag** | POE commits `L_total` ahead of contact; notes scheduled on the audio clock → perceived latency ≈ 0 and jitter ≈ 0 |
| **#2 No false triggers** | Six gates, palm-local articulation signal, refractory + Schmitt, abort window, confidence→velocity, density governor, and musically-safe failure |
| **#4 Consistency** | World landmarks, joint angles, hand-scale normalisation, 120 Hz resampling, noise-relative thresholds, device tiering, per-camera calibration |
