# AirKeys

**Play an invisible piano in the air. Sound like a master.**

AirKeys uses a phone camera, webcam or tablet camera to watch your hands. You
pretend to play a piano that isn't there — and the app improvises real,
beautiful piano music in the genre you pick, in real time, following your
phrasing, your dynamics, your hands.

It does *not* try to detect which key you hit. There are no keys. The magic is
that AirKeys reads the **shape** of your performance — contour, dynamics,
rhythm, hand roles, chord gestures — and composes the **content** to match. You
supply the intent; the engine supplies the notes. The result feels like you can
suddenly play.

---

## Status

**v1 built and deployable.** One genre (Cinematic), real hand tracking, real
Salamander piano samples, predictive onset detection.

| Deliverable | State |
| --- | --- |
| Research + technical plan | ✅ `docs/` |
| Interactive UI prototype | ✅ `prototype/airkeys-prototype.html` |
| **v1 app** | ✅ `src/` — see [`docs/08-v1-notes.md`](docs/08-v1-notes.md) |
| Real-hardware validation | ⬜ **Not done** — no camera in the build environment |

> **Read [`docs/08-v1-notes.md`](docs/08-v1-notes.md) before trusting v1.** It
> lists exactly what is verified and what is not. In short: the perception
> pipeline has only ever seen synthetic hands, and nobody has heard the audio.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build to dist/
npm run test:onset # predictive onset + false-trigger tests
```

`predev`/`prebuild` copy the MediaPipe WASM runtime and the piano samples out
of `node_modules` into `public/` — they are npm dependencies, not committed
binaries. The hand landmarker model *is* committed, since it has no npm source.

Grant camera access when asked; if you decline or have no camera, the app falls
back to pointer and `A`–`L` keyboard input and everything else still works.

---

## The six targets

These came from the product brief and every design decision in `docs/` traces
back to one of them.

| # | Target | Where it's solved |
| --- | --- | --- |
| 1 | **No perceived lag** between gesture and sound | [Predictive Onset Engine](docs/02-gesture-engine.md#4-the-predictive-onset-engine-poe) — we fire *before* the finger lands |
| 2 | **No false triggers** | [Six-gate strike validator](docs/02-gesture-engine.md#5-false-trigger-suppression-the-six-gates) + graceful-failure music design |
| 3 | **Premium sound on loud speakers** | [Progressive sampling + mastering chain](docs/04-audio-engine.md) |
| 4 | **Consistent across cameras/devices** | [Scale-invariant features](docs/02-gesture-engine.md#3-feature-extraction-scale-and-camera-invariant) + fixed-rate resampling + device tiering |
| 5 | **Smart musical response** to hands, speed, direction, chords | [Intent mapping](docs/03-music-engine.md#2-gesture--musical-intent) |
| 6 | **Feels like mastery** | [Gesture amplification + arrangement engine](docs/03-music-engine.md#7-gesture-amplification-how-one-move-becomes-a-flourish) |

---

## The core design principle

> **The user controls the shape. The engine controls the spelling.**

Nobody can accurately hit an invisible C♯ in mid-air, and building the app as if
they could is the trap that kills every "air piano" demo. So AirKeys never maps
a hand position to an absolute pitch. It maps:

- *where* you strike → a **register zone** (coarse, ~6 zones, forgiving)
- *which direction* you're moving → **melodic contour** (ascending / descending / static)
- *how hard* → **dynamics**
- *how many fingers at once* → **chord density**
- *how fast, how often* → **rhythm and tempo**
- *left vs. right hand* → **role** (harmony/bass vs. melody/lead)

The composition engine then picks notes that are guaranteed to be correct in the
current key, chord and genre. **A mistracked finger produces a tasteful
embellishment, not a wrong note.** Failure is designed to be musical — which is
also the deepest answer to target #2.

---

## Documentation

Read in order:

| Doc | Contents |
| --- | --- |
| [`00-research.md`](docs/00-research.md) | Findings, latency budget, technology survey, cited sources, ranked risks |
| [`01-architecture.md`](docs/01-architecture.md) | System design, threading model, data flow, stack choices |
| [`02-gesture-engine.md`](docs/02-gesture-engine.md) | Vision pipeline, predictive onset, false-trigger gates, calibration |
| [`03-music-engine.md`](docs/03-music-engine.md) | Intent mapping, harmony, voice leading, groove, genres, arrangement |
| [`04-audio-engine.md`](docs/04-audio-engine.md) | Sampling strategy, DSP, resonance modelling, loudness, mobile audio |
| [`05-ux-and-product.md`](docs/05-ux-and-product.md) | Onboarding, UI, sharing loop, retention, added features |
| [`06-roadmap.md`](docs/06-roadmap.md) | Milestones, acceptance criteria, measurement plan |
| [`07-open-questions.md`](docs/07-open-questions.md) | Decision log — all resolved, plus new questions v1 raised |
| [`08-v1-notes.md`](docs/08-v1-notes.md) | **What v1 actually is: scope, measurements, and what is not verified** |

---

## Prototype

`prototype/airkeys-prototype.html` is a self-contained, runnable UI prototype.
It has **no camera and no hand tracking** — the hands are simulated — but the
**audio and the music engine are real**: a procedurally synthesised piano, a
generated convolution reverb, and a working harmony / voice-leading /
groove engine you can hear differences between genres on.

It exists so the UI and the *musical feel* can be critiqued before any
production code is written.

Open it directly in a browser, or view the published Artifact link.

---

## Licence / attribution

Piano samples are **Salamander Grand Piano V3** by Alexander Holm, licensed
[CC BY 3.0](http://creativecommons.org/licenses/by/3.0/), sourced via the
`@audio-samples/piano-mp3-velocity*` packages. Attribution is displayed in-app
beneath the player, as the licence requires.

Hand tracking uses Google MediaPipe Tasks Vision. All tracking runs on-device;
no video ever leaves the browser.
