# 03 — Music engine

Owns targets **#5 (smart musical response)** and **#6 (feels like mastery)**.

---

## 1. The principle, restated

> **The user controls the shape. The engine controls the spelling.**

The engine never asks "which note did they mean?" — an unanswerable question in
mid-air. It asks "what kind of musical event was that, and where in the texture
does it belong?" and then composes the answer.

This is why AirKeys can feel virtuosic while remaining forgiving: the user's
real expressive bandwidth (contour, dynamics, rhythm, density, register, hand
roles) is fully honoured, and the dimension humans *cannot* control in the air —
exact pitch — is delegated.

---

## 2. Gesture → musical intent

`IntentMapper` turns a `StrikeEvent` plus hand state into a `MusicalIntent`.

| Gesture dimension | Musical meaning |
| --- | --- |
| **Left vs. right hand** | Role: left = bass + harmony, right = melody + lead. Mirrors real piano; instantly intuitive. Swappable for left-handed users. |
| **Horizontal position** (`zoneX`) | Register zone — ~6 coarse bands per hand. Deliberately coarse: forgiving, and still expressive. |
| **Strike velocity** | Dynamics, and *articulation*: hard = accented/staccato, soft = legato. |
| **Simultaneous fingers** (≤ 40 ms cluster) | Chord density — 1 note, 2 = interval/dyad, 3 = triad, 4 = 7th, 5 = extended (9/11/13). |
| **Finger spread** | Voicing openness — close position ↔ spread / drop-2 / quartal. |
| **Successive strike direction** | Melodic contour: ascending, descending, static, oscillating. |
| **Inter-onset intervals** | Tempo inference and subdivision. |
| **Rapid adjacent-finger sequence** | Run / flourish trigger (§ 7). |
| **Hand height** | Slow expression contour (brightness, dynamics arc). |
| **Palm rotation** | Modulation — reverb send, filter, tremolo depth by genre. |
| **Flat palm held low** | Sustain pedal. |
| **Both hands strike together, hard** | Structural accent — section change, big hit. |

### Contour is the interesting one

Absolute position selects a *zone*; the *note within the zone* comes from
`ContourTracker`, which watches the trajectory of recent strikes:

- moving right/up → walk **up** the scale from the last note
- moving left/down → walk **down**
- same place → repeat, neighbour tone, or octave, chosen by context
- large jump → leap to a chord tone in the new zone

The user thus gets genuine melodic authorship — they decide the line's shape,
step by step — without needing pitch accuracy. In testing terms: two different
performances must produce recognisably different melodies. If they don't, the
mapping is broken and the app is a toy.

---

## 3. Harmony

### State

`{ key, mode, currentChord, progressionPosition, tension, sectionType }`

### Progression generation

A weighted, function-aware directed graph per genre — tonic → subdominant →
dominant → tonic tendencies, with genre-specific edge weights. On top:

- **secondary dominants** and **borrowed chords** at a controlled probability
  driven by a `tension` parameter that follows the arrangement arc,
- **modal interchange** for colour,
- **pedal points** and **static vamps** for lo-fi/ambient, where progression
  movement should be minimal.

Progression advances on a **musical grid** (typically 1–2 bars) so harmony has
its own rhythm independent of the user's note rate — this is essential, or the
harmony stutters when the user pauses. Hard left-hand strikes can *push* an
early change, giving the user real harmonic agency.

### Reharmonisation

If the user's melodic contour repeatedly implies a note outside the current
chord, the engine reharmonises *toward* them rather than fighting — substituting
a chord that contains the implied tone. The instrument bends to the player.

---

## 4. Voice leading

Chord voicings are chosen by search, not by stacking thirds:

1. Generate candidate voicings for the target chord (inversions, drop-2/drop-3,
   rootless, quartal, genre-permitted extensions) within the active register.
2. Score each: **total semitone movement from the previous voicing** (dominant
   term), plus penalties for parallel fifths/octaves where the genre cares,
   muddy low intervals (a major third below ~E2 is mud on any speaker), voice
   crossing, and register drift.
3. Keep a small beam (~4) so the next chord isn't cornered.

Greedy-with-beam is microseconds at our polyphony. The literature pairs
voice-leading rules with Viterbi for globally optimal paths; that's available if
offline pre-planning of a progression ever warrants it, but is overkill for
real-time.

**This single subsystem is most of the difference between "chords are playing"
and "a pianist is playing."**

---

## 5. Melody

Right hand, note selection given a target zone and contour direction:

- **On strong beats / high velocity** → chord tones (guaranteed consonance).
- **Off-beat / low velocity** → scale and passing tones, approach notes,
  chromatic enclosures in jazz-family genres.
- **Avoid-note filtering** per chord type (e.g. natural 11 over a major triad).
- **Range and tessitura control** so the melody doesn't wander into the basement
  or the top octave and stay there.
- **Motif memory** — the engine stores recent melodic cells and, when the user's
  contour resembles a previous one, *reuses and varies* the earlier cell. This
  is what makes an improvisation sound composed rather than random, and it's
  cheap: a short ring buffer plus an interval-contour similarity metric.

---

## 6. Groove

- **Tempo inference** from inter-onset intervals: a histogram over plausible
  tempi with a prior centred on the genre's default, updated with hysteresis.
  Once locked, the tempo is *sticky* — jumping tempo mid-phrase feels awful.
- **Partial quantisation** at strength ~0.6–0.8, with genre-appropriate swing.
  Because onsets are *predicted ahead*, the quantiser can snap forward to the
  next grid line **at zero latency cost** — a real advantage of the predictive
  architecture over reactive designs.
- **Assist slider** exposes quantisation strength and correctness constraints
  as one user-facing control (§ 9).
- **Micro-timing** — melody very slightly ahead, bass very slightly behind, per
  genre. Tiny, and a large part of "feel".

---

## 7. Gesture amplification: how one move becomes a flourish

Target #6 lives here. A master pianist produces far more notes than gestures.
AirKeys maps *one* gesture to a musically-appropriate *many* when the gesture
warrants it:

| Gesture | Output |
| --- | --- |
| Fast sequential adjacent fingers, one direction | A scalar **run** of 6–16 notes, correctly accelerating and decelerating, landing on a chord tone |
| Broad spread-hand sweep | **Arpeggio sweep** or glissando across the current chord |
| Firm single strike, high velocity | Note + **grace note** or octave doubling |
| Trembling/oscillating fingers | **Tremolo** or trill |
| Both hands, wide, hard | Full-register **stab** with bass octave + spread voicing |
| Sustained held posture | Slow **arpeggiated pad** continuing under the melody |

Amplification is bounded by the density governor, and its strength is tied to
the Assist slider. This is the "I can suddenly play" moment — it must be tuned
so that it feels *earned* rather than automatic. The gesture must be clearly
intentional before the engine gives you a flourish.

---

## 8. Arrangement

Noodling gets boring in 45 seconds. The `Arranger` gives sessions a shape:

- **Song structure** — intro → verse → build → chorus → break → outro over
  60–120 s, adjusting harmonic rhythm, register, density and accompaniment.
- **Auto-accompaniment** (optional, default **on** — it is the single biggest
  "wow" multiplier): drums, bass and pads locked to inferred tempo. Playing over
  a groove that responds to you is the addictive part.
- **Call and response** — if the user pauses > ~2 beats, the engine answers with
  a short phrase derived from their last motif, then hands back. This makes the
  app feel like a duet partner and it converts hesitation into delight.
- **Automatic pedalling** — sustain lifts on chord change, catches on bass notes.
- **Dynamic arc** — long-term crescendo/diminuendo shaping.

---

## 9. Genres and the Assist slider

A genre is a **config bundle**, not code:

```ts
interface Genre {
  scales; progressionGraph; voicingRules; harmonicRhythm;
  grid; swing; microTiming; ornamentVocabulary;
  instrumentPreset; mixPreset; accompaniment; tempoRange; densityCurve;
}
```

Launch set — chosen for breadth of feel and instant recognisability:

**Cinematic** · **Lo-fi** · **Jazz Club** · **Gospel** · **Neo-Classical** ·
**Synthwave** · **Ambient** · **Blues** · **Latin/Bossa** · **Anime / City Pop**

Non-Western modes (Dorian, Phrygian dominant, pentatonic sets, and a
raga-flavoured bundle) broaden this cheaply and give the app a distinct
character next to Western-major-only competitors.

### The Assist slider

One control, 0–100 %, spanning:

| | Full Assist (100) | Purist (0) |
| --- | --- | --- |
| Quantisation | Tight | Raw |
| Wrong notes | Impossible | Possible |
| Amplification | Generous flourishes | 1 gesture ≈ 1 note |
| Accompaniment | Full band | None |

Default ~75 %. It is the app's difficulty curve, its accessibility setting and
its longevity mechanic in a single slider — a user who plays for a month can
walk it down and the instrument grows with them.

---

## 10. Testing musical quality

Music can't be unit-tested for "good", but it can be tested for "not broken":

- **Property tests** — every emitted note is in the active scale (at Assist >
  threshold); no voicing exceeds a hand span; no interval below E2 narrower than
  a fifth; voice-leading movement stays under a bound.
- **Golden-path replay** — recorded `StrikeEvent` streams replayed through the
  engine, with MIDI output diffed against approved fixtures. Catches regressions
  precisely because the engine has no dependency on the camera.
- **Distinguishability test** — two different gesture streams must produce
  measurably different melodies (edit distance over interval contours above a
  floor). Guards against the engine ignoring the user, the most insidious
  possible failure.
- **Listening panel** — a fixed set of 30-second renders per genre, reviewed by
  ear each release. Non-negotiable; the metrics above cannot detect "boring".
