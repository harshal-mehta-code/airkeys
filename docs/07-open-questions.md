# 07 — Open questions

Decisions that need a human before or during implementation. Each has a
recommendation so nothing blocks on a maybe.

---

## Q1. Is the "shape not spelling" trade-off acceptable?

**The question.** AirKeys deliberately does *not* let you choose exact pitches.
You control contour, register, rhythm, dynamics and density; the engine picks
the notes. This is what makes it feel great and forgiving — and it means a
trained pianist cannot play a specific tune.

**Why it matters.** It defines the product. Everything in `03-music-engine.md`
follows from it.

**Recommendation:** accept it, and expose the Assist slider so advanced users
can reclaim literal control at the low end. Note that even at Assist 0 the
pitch mapping stays zone-based — true note-accurate air piano is a different
(and much worse) product.

---

## Q2. Sample library and licensing

**Options.** Salamander Grand (CC-BY 3.0, needs visible in-app attribution) ·
`smplr`'s Steinway-derived set · commercially licensed samples · commissioned
recording.

**Recommendation:** Salamander for Phases 0–4 with proper attribution. Revisit
before any commercial launch — an exclusive, well-recorded piano would be a real
differentiator, and CC-BY attribution is a slightly awkward fit for a polished
consumer app.

---

## Q3. Native app later?

A native iOS app gets ARKit hand tracking (better and lower latency), true
low-latency audio, and no browser audio quirks. The web gets instant, linkable,
zero-install access — which is worth more for virality.

**Recommendation:** web first, unquestionably. Revisit only if Phase 0's latency
numbers fall short on mobile browsers specifically.

---

## Q4. How much should the engine "play itself"?

Auto-accompaniment and call-and-response make it sound amazing, but push toward
"I watched music happen" rather than "I played". Too little and beginners feel
they failed; too much and nobody feels ownership.

**Recommendation:** accompaniment on by default, tied to the Assist slider, and
always instantly toggleable. Watch the Phase 4 user test for the phrase "I
wasn't really doing anything" — that's the signal it's gone too far.

---

## Q5. Bluetooth audio

120–300 ms of latency that prediction cannot hide, on the default output for a
large share of phone users.

**Options:** warn only · aggressively over-predict (commit much earlier, hurting
accuracy) · degrade to a sustained/pad-based mode where timing matters less.

**Recommendation:** warn clearly, and build the pad-mode fallback in Phase 5.
Over-predicting past ~120 ms means predicting before the gesture is
distinguishable from noise — it trades a latency problem for a false-trigger
problem, which is worse.

---

## Q6. Minimum supported device?

Setting the floor too low means shipping a bad experience that gets bad reviews;
too high loses users.

**Recommendation:** require a camera capable of ≥ 24 fps and a device that
sustains ≥ 20 fps inference. Below that, show no-camera mode with an honest
explanation rather than a broken instrument.

---

## Q7. Monetisation — does it shape the build?

Free with attribution · premium genres/sample packs · subscription · one-off
unlock.

**Recommendation:** decide before Phase 4, because it determines whether
sharing carries a watermark and whether genres need entitlement plumbing.
Retrofitting either is unpleasant. No opinion on which model; just don't leave
it until Phase 5.

---

## Q8. Genre launch set

`03-music-engine.md` proposes ten. Building all ten well is more work than
building three superbly.

**Recommendation:** three at Phase 1 (Cinematic, Lo-fi, Jazz Club — maximally
different from each other), ten by Phase 5. Genre configs are data, so adding
them later is cheap; getting the *config schema* right early is what matters.

---

## Q9. Should the camera feed be visible at all?

Showing it aids calibration and self-correction. Hiding it (pure hand-light on
black) looks dramatically better and is far more shareable.

**Recommendation:** heavily stylised feed by default, with a "hide camera" toggle
that goes full silhouette. Prototype shows the stylised version — worth
feedback on.

---

## Q10. Prototype feedback wanted specifically on

1. Overall layout — is the camera-as-stage right, or should the visualiser
   dominate more?
2. Is one **Assist** slider the right amount of visible control, or do you want
   tempo / key / density surfaced too?
3. Genre carousel vs. a simpler dropdown.
4. Do the note-particle visuals read as premium, or as a screensaver?
5. Is the note ribbon (recent notes scrolling) useful or noise?
6. How prominent should **Record** be? Current prototype treats it as a primary
   action on the reasoning in `05-ux-and-product.md`.
