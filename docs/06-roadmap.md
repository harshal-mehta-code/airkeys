# 06 — Roadmap

Sequenced so the **riskiest unknown is tested first**. Everything hinges on
whether predictive onset detection actually feels instantaneous; if it doesn't,
the product needs rethinking, and that must be discovered in week one rather
than after the UI is built.

---

## Phase 0 — De-risk the core claim *(highest priority)*

**Goal: prove a predicted air-strike can feel like zero latency.**

Ugly single-page spike. No UI, no genres, no samples — one sine blip.

- Camera → worker → `HandLandmarker` → landmarks on screen
- `rVFC` `captureTime` latency measurement; `outputLatency` readout
- Palm-local frame, flexion angles, 120 Hz resampler, One-Euro filter
- Ballistic predictor with a live-adjustable commit horizon
- On-screen HUD: predicted vs. actual contact error, per-strike

**Exit criteria — all must hold:**

| Metric | Target |
| --- | --- |
| Median predicted-vs-actual contact error | ≤ 15 ms |
| Onset timing jitter (σ) | ≤ 8 ms |
| Detection rate on deliberate strikes | ≥ 97 % |
| False positives during 60 s of deliberate non-playing motion | ≤ 1 |
| Blind A/B vs. a real MIDI keyboard: "which felt more instant?" | AirKeys chosen ≥ 40 % |

That last one is the real test. **If Phase 0 fails, stop and re-plan** —
candidate pivots: require 60 fps hardware, add a longer commit horizon with
explicit metronome-locked play, or shift to a sustained/gesture-continuous
instrument model rather than discrete strikes.

---

## Phase 1 — Music engine, headless

Built and tested with **no camera at all**, driven by mouse/keyboard and
recorded fixtures.

- Theory core; harmony state machine + progression graphs
- Voice-leading search; melody with contour + motif memory
- Groove: tempo inference, partial quantisation, swing
- Three genres end to end (Cinematic, Lo-fi, Jazz Club)
- Property tests, golden-path replay, distinguishability test

**Exit:** listening panel agrees three genres are distinguishable and none
produces a wrong-sounding note across 30 minutes of replay.

---

## Phase 2 — Audio engine

- Progressive sampler; Cache API; Opus/AAC selection
- Voice management, round-robin, release samples
- Master chain: HPF, glue comp, brickwall limiter, convolution reverb
- Loudness normalisation across presets; output profiles
- Sympathetic resonance worklet (+ native fallback)
- iOS unlock, interruption and route-change handling

**Exit:** time-to-first-note < 1.0 s on a mid-tier phone over 4G; no clipping at
full polyphony; A/B against a commercial piano VST judged "close enough" by the
listening panel; verified on iOS Safari without crackle.

---

## Phase 3 — Integration and robustness

- Full six-gate validator; calibration flow; tracking-quality meter
- Device tiering and dynamic degradation
- Intent mapping complete (chords, spread, contour, sustain, expression)
- Gesture amplification and ornaments
- Arranger, accompaniment, call-and-response

**Exit — the device matrix.** Consistent, playable results on: iPhone (recent +
3-year-old), iPad (incl. Center Stage on), Android mid-range, MacBook built-in,
external USB webcam, ultrawide webcam, and one deliberately bad camera. Same
thresholds, no per-device hand tuning.

---

## Phase 4 — Fun and distribution

- Full UI, colour grading, hand-light visuals, particles
- Genre carousel with audition
- Record & share; MIDI export; session songs
- Duet mode; no-camera mode; attract mode; daily seed
- Accessibility pass; anti-frustration states

**Exit:** ten first-time users, unassisted. ≥ 8 produce something they like in
under a minute; ≥ 5 record and share unprompted.

---

## Phase 5 — Polish

Ten genres, presets, onboarding refinement, performance tuning, analytics on
aggregate quality metrics (never content), PWA install, offline support.

---

## Continuous measurement

Instrument these from Phase 0 and never stop watching them:

| Metric | Why |
| --- | --- |
| End-to-end latency (p50/p95) | Target #1 |
| Onset jitter σ | Target #1 |
| False positives / minute of non-play | Target #2 |
| Missed-strike rate | Target #2 |
| Achieved fps, inference ms, tier distribution | Target #4 |
| Time-to-first-note | Retention |
| Session length, share rate, return rate | Product |

All aggregate, all on-device-derived, no camera data, no audio content.

---

## Rough sizing

| Phase | Effort |
| --- | --- |
| 0 — De-risk | 1–2 weeks |
| 1 — Music | 3–4 weeks |
| 2 — Audio | 2–3 weeks |
| 3 — Integration | 3–4 weeks |
| 4 — Fun | 3–4 weeks |
| 5 — Polish | ongoing |

Phases 1 and 2 can run in parallel with 0 **only after** Phase 0's exit criteria
are met. Building the music and audio engines before knowing the input works is
the main way this project could waste two months.
