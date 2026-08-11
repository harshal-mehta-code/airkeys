# 05 — UX and product

The brief asked for something "so fun and addictive that people want to actually
use it." That is a product problem as much as an engineering one, so it gets its
own document. Items marked **[added]** are proposals beyond the original brief.

---

## 1. The first thirty seconds decide everything

Most camera-instrument demos die at the setup screen. AirKeys must produce a
beautiful sound before it asks for anything.

```
0:00  Landing. One line: "Play an invisible piano." One button: "Start playing".
      Behind it, a looping demo of hands playing with music — the promise, shown.
0:02  Camera permission, with a plain-language reason and the privacy promise
      ("Nothing leaves your device. Ever.") stated *before* the browser prompt.
0:05  Camera on. Hands detected. A soft cinematic chord swells automatically the
      instant hands are recognised — before the user has done anything.
0:08  "Now tap the air." First note. It sounds enormous.
0:20  Calibration happens invisibly, disguised as the first thing you play.
0:30  Auto-accompaniment fades in underneath. The user is now in a band.
```

**No tutorial, no settings, no modal.** Calibration (§ 02.7) is folded into
play. The tracking-quality meter appears only when something is wrong.

---

## 2. Screen layout

Camera view is the stage, not a debug window.

```
┌──────────────────────────────────────────────────────────┐
│  AirKeys            [Cinematic ▾]         ⚙   ●REC       │  top bar, floats
│                                                          │
│                                                          │
│              ( mirrored camera, dimmed and               │
│                colour-graded to match genre )            │
│                                                          │
│         ✦    hand skeletons + note particles    ✦        │
│                                                          │
│        ·············  play volume guide  ············    │
│                                                          │
│   ♪ ♪   ♪    ♪ ♪ ♪    ♪   ← note ribbon (recent notes)   │
│                                                          │
│   C minor · 82 BPM · ●●●○ tracking      Assist ▁▃▅▇      │  bottom bar
└──────────────────────────────────────────────────────────┘
```

Design rules:

- **The camera feed is heavily treated** — desaturated, vignetted, tinted per
  genre. Raw webcam footage of yourself is unflattering and breaks the spell;
  a stylised silhouette is beautiful and makes people want to record it.
- **Hands render as light, not as skeletons.** Glowing joints, trailing motion,
  particles bursting on each note. This is the shareable asset.
- **Visual feedback fires at prediction time**, in lockstep with the scheduled
  note. Synchronised sight and sound reinforce the illusion of zero latency —
  and mis-synchronised visuals would actively destroy it.
- **Chrome auto-hides** after a few seconds of playing.
- One control is always visible: **Assist**. It's the difficulty curve.

---

## 3. Genre selection

A horizontal card carousel, each card with its own colour grade, and — crucially
— **each card auditions on hover/focus** with a two-second loop. Users pick with
their ears. Switching genres mid-performance crossfades harmonically rather than
cutting: the current chord is reinterpreted in the new genre's language.

---

## 4. Features beyond the brief

### **[added] Record & Share** — the growth loop

The single highest-leverage addition. A one-tap record button produces a
vertical-format clip: stylised hand-light visuals, the music, and a small
AirKeys mark. Audio + visuals only, no camera footage by default.

Nobody shares a screenshot of an app. Everybody shares a ten-second clip of
themselves apparently playing gorgeous piano out of thin air. **This is the
distribution strategy**, and it should be built in Phase 4, not "later".

### **[added] Duet mode**

`numHands: 4` — two people, four hands, one instrument. Roles split
automatically (one takes bass/harmony, the other melody). Ridiculously fun, and
it doubles the audience per session.

### **[added] Session songs**

Rather than endless noodling, a session builds a 60–120 s piece with real
structure (§ 03.8) and ends on a resolved cadence. The user gets a *finished
thing* — which is what makes it shareable and what makes them come back.

### **[added] No-camera mode**

Mouse, touch, and QWERTY drive the same `MusicalIntent` interface. Desktop users
without a camera, users who deny permission, and anyone on a train still get the
music engine. It also happens to be the harness that makes the music engine
testable.

### **[added] MIDI export**

Nearly free, and it turns AirKeys from a toy into a sketchpad for actual
musicians — a completely different retention curve.

### **[added] Haptics**

`navigator.vibrate` on each note on supported devices. Embodiment makes an
invisible instrument feel physical. (Unavailable on iOS Safari.)

### **[added] Daily seed**

A shared daily key/genre/tempo, so everyone's clips that day are in the same
world and can be stitched or compared. Cheap ritual, strong retention.

### **[added] Ambient attract mode**

If hands leave frame for ~10 s, the engine keeps playing gently on its own and
fades the visuals to a screensaver. Walk-up appeal at desks, events, and shop
windows — and it means the app is never silent and awkward.

---

## 5. Accessibility

- Assist at 100 % makes the instrument playable with very coarse motor control —
  a genuine accessibility win, not a side effect. Wheelchair users, users with
  tremor, and children all get musical results.
- **Single-hand mode** — one hand covers both roles.
- **Reduced-motion** setting damps particles; **photosensitivity-safe** visuals
  (no rapid full-screen flashes).
- Full keyboard operation for all chrome; visible focus states.
- Captions/labels never rely on colour alone (the tracking meter has text).
- Respect `prefers-reduced-motion` and `prefers-color-scheme`.

---

## 6. Anti-frustration

| Failure | Response |
| --- | --- |
| Too dark | Overlay: "It's a bit dark — more light on your hands helps" |
| Hands out of frame | Gentle edge glow pointing to the play area |
| Camera denied | Immediate fallback to no-camera mode, no dead end |
| Bluetooth latency | One-time notice: "Bluetooth adds delay. Wired or speaker feels much better." |
| Low fps | Auto-tier down silently; only surface it if quality is genuinely poor |
| Nothing triggers | After ~10 s of hands-present-but-no-notes, offer a 5-second re-calibration |

The rule: **never a dead end, never a raw error, always the next thing to try.**

---

## 7. What "addictive" actually requires

Ranked by expected impact:

1. **Instant gratification** — beautiful sound within 10 seconds, zero learning.
2. **Perceived mastery** — gesture amplification makes users sound better than
   they are, immediately.
3. **Zero perceived latency** — without it, none of the above survives.
4. **Shareability** — the clip is the product's advertising.
5. **A finished artefact** — session songs, not endless noodling.
6. **Depth on tap** — the Assist slider means skill growth is possible.
7. **Social** — duet mode, daily seed.

Note that items 1–3 are engineering problems and items 4–7 are product
problems. Both halves have to land.
