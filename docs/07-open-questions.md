# 07 — Open questions — RESOLVED

All ten questions were answered before v1 was built. Recorded here as the
decision log; the reasoning behind each option is in the git history of this
file.

| # | Question | Decision |
| --- | --- | --- |
| Q1 | Accept that a pianist cannot play a specific tune? | **Yes.** "Shape not spelling" is the product. |
| Q2 | Sample library and licensing | **Salamander Grand Piano V3**, CC BY 3.0, Alexander Holm. Attributed in-app under the player. |
| Q3 | Native iOS app | **Web first.** Revisit native later. |
| Q4 | How much should the engine play itself? | **Accompaniment on by default**, tied to Assist, one-tap off. |
| Q5 | Bluetooth audio latency | **Warn only.** Pad-mode fallback deferred. |
| Q6 | Minimum supported device | **≥ 24 fps camera, ≥ 20 fps sustained inference.** Below that, pointer/keyboard mode. |
| Q7 | Monetisation | **Free for now.** No entitlement plumbing in v1. |
| Q8 | Genre launch set | **One genre (Cinematic)** until the app itself is good. Genre is a config bundle, so more are cheap later. |
| Q9 | Show the camera feed? | **Stylised feed by default**, with a Silhouette toggle. |
| Q10 | Prototype UI feedback | Layout kept. One Assist slider kept. Carousel kept. **Particles and Ribbon each got a hide toggle. Record demoted to a quiet tool button.** |

---

## New questions raised by building v1

### N1. Prediction lead is limited by frame rate — how much does it matter in practice?

At 60 fps a 160 ms downstroke yields only ~5 samples before contact, which is
the minimum a cubic fit needs. The engine therefore *decides* at roughly the
moment of contact, and buys its accuracy back by **scheduling the note at the
predicted contact instant on the audio clock** rather than firing on the frame.

Synthetic tests put the scheduled note within ~24 ms of intended contact at
60 fps and ~38 ms at 30 fps. That beats a reactive design by a wide margin but
is not the "zero perceived latency" the plan targets.

**Needs real-hardware measurement.** If it reads as laggy, the options are: a
stronger ballistic prior (fit amplitude/duration/onset of a stroke template
from 3 samples instead of a free cubic from 5), or requiring 60 fps+ cameras.

### N2. Landmark noise degrades prediction more than frame rate does

The parameter sweep showed prediction error is roughly flat (~20 ms) across
filter settings once realistic landmark jitter is present, and that detection
rate — not timing — is what suffers. Real MediaPipe jitter magnitude is not yet
measured. This is the top thing to instrument on device.

### N3. One-Euro tuning is currently fitted to synthetic strokes

`minCutoff = 20, beta = 2.0` was chosen by sweeping against a synthetic
ballistic model. It is very likely wrong for real hands. It should be re-fitted
against recorded landmark traces from real players as soon as those exist.
