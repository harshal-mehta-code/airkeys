/**
 * Perception: landmarks in, predicted strikes out.
 *
 * Four ideas carry this file.
 *
 * 1. A STRIKE IS FINGER FLEXION *PLUS* FINGERTIP DESCENT. Flexion alone —
 *    which is all v1 measured — describes a finger curling while the hand
 *    hangs motionless in space. Almost nobody plays that way. Told to play an
 *    invisible piano, people tap: the wrist drops and the finger goes along
 *    with it, sometimes barely curling at all. MediaPipe's world landmarks are
 *    hand-centric, so that entire motion is invisible in them — a stiff-finger
 *    tap produces literally no signal. The tip's image-space descent supplies
 *    the missing half, and the two channels reinforce each other because a
 *    curl lowers the tip too.
 *
 * 2. THE PALM IS THE REFERENCE FRAME, BUT ONLY SIDEWAYS. Bulk motion must be
 *    separated from articulation, or every hand sweep rains notes. But bulk
 *    *vertical* motion is the strike, so only the lateral component may be
 *    treated as noise. v1 gated on undirected speed and so suppressed exactly
 *    the gesture it was meant to capture.
 *
 * 3. WE PREDICT, WE DO NOT REACT. A keystroke is ballistic: after a few
 *    samples of downstroke the rest of the trajectory is determined. We fit a
 *    constant-jerk model, solve for the moment the onset signal's velocity
 *    peaks (the acceleration peak, which the air-drumming literature
 *    identifies as both earlier and more consistent than the strike itself),
 *    and commit when the remaining travel time has shrunk to the point where
 *    waiting for another frame would make us late.
 *
 * 4. A HAND-LED TAP IS ONE NOTE, NOT FIVE. When the wrist carries the whole
 *    hand down, every finger sees the same descent. Those are separated into
 *    common mode (the hand) and differential (real articulation), so a tap
 *    plays the finger that actually led it.
 */
import { OneEuro, fitCubic, quadDeriv, angle, cross, norm, sub, clamp, type Vec3 } from "./filters";

export type HandSide = "L" | "R";

export interface StrikeEvent {
  hand: HandSide;
  finger: number;
  /** predicted contact instant on the performance clock (ms) */
  contactPerfMs: number;
  velocity: number;
  confidence: number;
  zoneX: number;
  /** how many fingers of this hand struck within the cluster window */
  simultaneous: number;
}

export interface HandFrame {
  side: HandSide;
  /** 21 × 3 metric-ish landmarks, origin at hand centre */
  world: Float32Array;
  /** 21 × 3 image-space landmarks, 0..1 */
  normed: Float32Array;
  score: number;
  /** capture time of the frame these came from, performance clock (ms) */
  tMs: number;
}

/** MediaPipe hand landmark chains: [base, mid, distal, tip] per finger. */
const FINGER_CHAINS: number[][] = [
  [1, 2, 3, 4], // thumb
  [5, 6, 7, 8], // index
  [9, 10, 11, 12], // middle
  [13, 14, 15, 16], // ring
  [17, 18, 19, 20], // pinky
];
const FINGER_TIPS = [4, 8, 12, 16, 20];

function pt(a: Float32Array, i: number): Vec3 {
  return [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
}

/** Summed MCP + PIP flexion. Unitless, so thresholds port across devices. */
function flexion(world: Float32Array, chain: number[]): number {
  const wrist = pt(world, 0);
  const a = pt(world, chain[0]);
  const b = pt(world, chain[1]);
  const c = pt(world, chain[2]);
  const d = pt(world, chain[3]);
  const base = angle(sub(a, wrist), sub(b, a));
  const mid = angle(sub(b, a), sub(c, b));
  const distal = angle(sub(c, b), sub(d, c));
  return base + mid + distal * 0.5;
}

/** Palm normal from wrist / index-MCP / pinky-MCP. */
function palmNormal(world: Float32Array): Vec3 {
  const w = pt(world, 0);
  const i = pt(world, 5);
  const p = pt(world, 17);
  return norm(cross(sub(i, w), sub(p, w)));
}

interface FingerState {
  euro: OneEuro;
  /** sample times of the combined onset signal, seconds */
  ts: number[];
  /** the combined onset signal itself */
  ys: number[];
  /** raw flexion, kept separately to tell articulation from a hand drop */
  flex: number[];
  armed: boolean;
  armedAt: number;
  /** onset signal at the moment of arming, for a depth-proportional release */
  armSig: number;
  committed: boolean;
  peakSig: number;
  refractoryUntil: number;
  /**
   * Slow min-follower over the onset signal: where this finger sits when it
   * is not striking. The distance above it is the depth of the current
   * stroke, which is what makes a stroke's *rate* measurable.
   */
  restLevel: number;
}

/** A strike plus the evidence needed to tell a real one from a passenger. */
interface Candidate {
  ev: StrikeEvent;
  /** this fingertip's descent beyond the hand's common-mode drop */
  lead: number;
  /** recent slope of raw flexion — articulation with hand motion removed */
  artic: number;
}

export interface PerceptionTuning {
  /** minimum onset velocity, signal units/s, to consider a downstroke */
  armVel: number;
  /** onset velocity mapped to full dynamic range */
  velFull: number;
  /** per-finger lockout after a strike, seconds */
  refractory: number;
  /**
   * Lateral palm speed, in hand-lengths per second, above which a strike
   * starts being attenuated as a repositioning sweep. Vertical speed is
   * deliberately excluded — that component is the strike.
   */
  maxLateralSpeed: number;
  /** lateral speed at which strikes are suppressed outright */
  lateralCutoff: number;
  /**
   * Weight of the fingertip-descent channel against the flexion channel,
   * radians per hand-length. Roughly equal contribution from a typical tap.
   */
  tipWeight: number;
  /**
   * Minimum peak velocity divided by the depth travelled so far, in units of
   * 1/s — how fast the stroke is relative to its own size. This is the one
   * number that tells a soft tap from a slow curl of the same peak speed,
   * because it measures duration without depending on where a velocity
   * threshold happened to be crossed.
   */
  minStrokeRate: number;
}

/**
 * Defaults measured against synthetic gestures spanning what people actually
 * do (scripts behind docs/07): a soft deliberate tap peaks around 8 signal
 * units/s, an ordinary tap 18–34, a hard 90 ms tap near 68. The gestures that
 * must stay silent — a slow fist, a hand settling — peak at 3–9, overlapping
 * the soft tap outright, which is why minStrokeRate rather than armVel is
 * what actually separates them.
 */
export const DEFAULT_TUNING: PerceptionTuning = {
  armVel: 6.5,
  velFull: 45,
  refractory: 0.11,
  maxLateralSpeed: 8,
  lateralCutoff: 20,
  tipWeight: 1,
  minStrokeRate: 7,
};

/**
 * Samples used for the ballistic fit. Five spans ~83 ms at 60 fps — long
 * enough to be stable, short enough to sit inside a single downstroke. A
 * cubic needs four, which is also the floor on a slow phone.
 */
const FIT_SAMPLES = 5;

/** A downstroke longer than this is a deliberate curl, not a keystroke. */
const MAX_DOWNSTROKE_SEC = 0.28;

/** Frames to average when learning the user's rest pose. */
const CALIB_FRAMES = 8;

/**
 * After any strike, how long a finger merely carried along by the same hand
 * drop stays silent. Long enough to cover the frame-to-frame scatter of one
 * gesture, short enough to leave a fast trill alone.
 */
const BULK_LOCKOUT_SEC = 0.09;

export class HandPerception {
  side: HandSide;
  tuning: PerceptionTuning;

  private fingers: FingerState[] = [];
  private lastNormed: Float32Array | null = null;
  private lastTMs = 0;
  private lateralSpeed = 0;
  private handScale = 0;
  private frameDt = 1 / 30;
  private restNormal: Vec3 | null = null;
  private calibN = 0;
  private calibSum: Vec3 = [0, 0, 0];
  private lastEmitAt = -1;

  /** live values used by the UI */
  zoneX = 0.5;
  present = false;
  postureScore = 0;
  lastSeenMs = 0;

  constructor(side: HandSide, tuning: PerceptionTuning = DEFAULT_TUNING) {
    this.side = side;
    this.tuning = tuning;
    for (let i = 0; i < 5; i++) {
      this.fingers.push({
        // Tuned by parameter sweep against synthetic ballistic strokes: the
        // filter must not lag, because lag moves the apparent velocity peak
        // later and the predictor then commits after contact. A high beta
        // opens the cutoff wide during the stroke; the 5-point least-squares
        // fit supplies most of the actual smoothing.
        euro: new OneEuro(20, 2.0),
        ts: [],
        ys: [],
        flex: [],
        armed: false,
        armedAt: 0,
        armSig: 0,
        committed: false,
        peakSig: 0,
        refractoryUntil: 0,
        restLevel: NaN,
      });
    }
  }

  /**
   * Learn the user's rest pose. Averaged over the first several steady
   * frames rather than snapped from one: the single frame v1 used was
   * whichever frame the hand happened to be detected in — often mid-entry,
   * edge-on — and every posture score afterwards was measured against it.
   */
  calibrate(frame: HandFrame) {
    if (this.calibN >= CALIB_FRAMES) return;
    const n = palmNormal(frame.world);
    // keep the running sum on one side of the sphere; the normal flips sign
    // when the hand is seen from the other face
    const s = this.calibN && dotV(this.calibSum, n) < 0 ? -1 : 1;
    this.calibSum = [
      this.calibSum[0] + n[0] * s,
      this.calibSum[1] + n[1] * s,
      this.calibSum[2] + n[2] * s,
    ];
    this.calibN++;
    this.restNormal = norm(this.calibSum);
  }

  /** True once the rest pose has settled; the UI uses it for the recal cue. */
  get calibrated(): boolean {
    return this.calibN >= CALIB_FRAMES;
  }

  recalibrate() {
    this.calibN = 0;
    this.calibSum = [0, 0, 0];
    this.restNormal = null;
  }

  markAbsent(nowMs: number) {
    if (nowMs - this.lastSeenMs > 220) {
      this.present = false;
      this.lateralSpeed = 0;
      this.lastNormed = null;
      for (const f of this.fingers) {
        f.ts.length = 0;
        f.ys.length = 0;
        f.flex.length = 0;
        f.armed = false;
        f.committed = false;
        f.peakSig = 0;
        f.euro.reset();
      }
    }
  }

  /**
   * Feed one frame.
   * @param leadSec total pipeline latency to cancel (capture + inference +
   *                processing + audio output)
   * @returns strikes committed on this frame
   */
  update(frame: HandFrame, leadSec: number): StrikeEvent[] {
    const tSec = frame.tMs / 1000;
    const out: Candidate[] = [];
    this.present = true;
    this.lastSeenMs = frame.tMs;

    // ---- image-space geometry. World landmarks are hand-centric and carry
    // no translation at all, so everything about where the hand *is* has to
    // come from here.
    const wristN: Vec3 = pt(frame.normed, 0);
    const midN: Vec3 = pt(frame.normed, 9);
    const apparent = Math.hypot(wristN[0] - midN[0], wristN[1] - midN[1]) || 0.08;
    // Smoothed, because every threshold below is denominated in hand-lengths
    // and a jittery scale would modulate all of them at once.
    this.handScale = this.handScale ? this.handScale + (apparent - this.handScale) * 0.15 : apparent;
    const scale = Math.max(this.handScale, 0.02);

    if (this.lastNormed && frame.tMs > this.lastTMs) {
      const prevW: Vec3 = pt(this.lastNormed, 0);
      const dt = (frame.tMs - this.lastTMs) / 1000;
      this.frameDt += (Math.min(dt, 0.2) - this.frameDt) * 0.2;
      // Lateral only. The vertical component of a tap is the signal, and
      // gating on undirected speed is what made v1 mute during real playing.
      const inst = Math.abs(wristN[0] - prevW[0]) / Math.max(dt, 0.001);
      this.lateralSpeed += (inst - this.lateralSpeed) * 0.35;
    }
    this.lastNormed = frame.normed.slice();
    this.lastTMs = frame.tMs;

    // mirrored for a selfie view: moving your hand to your right raises the
    // register, which is the direction a pianist expects
    this.zoneX = clamp(1 - wristN[0], 0, 1);

    // ---- posture: how far the palm has turned from its rest pose
    const pn = palmNormal(frame.world);
    const ref: Vec3 = this.restNormal ?? [0, -1, 0];
    const tilt = Math.min(angle(pn, ref), angle(pn, [-ref[0], -ref[1], -ref[2]]));
    this.postureScore = clamp(1 - tilt / (Math.PI * 0.5), 0, 1);

    // ---- onset signal per finger, and its common mode across the hand
    const depth: number[] = [];
    const sig: number[] = [];
    const rawFlex: number[] = [];
    for (let f = 0; f < 5; f++) {
      const d = frame.normed[FINGER_TIPS[f] * 3 + 1] / scale; // image y grows downward
      const fl = flexion(frame.world, FINGER_CHAINS[f]);
      depth.push(d);
      rawFlex.push(fl);
      sig.push(fl + this.tuning.tipWeight * d);
    }
    const commonDepth = median5(depth);

    const gates = this.gateScore(frame, scale);

    // ---- per-finger onset detection
    for (let f = 0; f < 5; f++) {
      const st = this.fingers[f];
      const s = st.euro.filter(sig[f], tSec);

      // Rest level: drops to meet the signal at once, rises after it only
      // over seconds. So a stroke's depth is measured from where the finger
      // was resting, while a hand simply held lower is forgotten in time.
      if (!Number.isFinite(st.restLevel) || s < st.restLevel) st.restLevel = s;
      else st.restLevel += (s - st.restLevel) * (1 - Math.exp(-this.frameDt / 3));

      st.ts.push(tSec);
      st.ys.push(s);
      st.flex.push(rawFlex[f]);
      // Short buffer on purpose. A window longer than the stroke itself makes
      // the cubic fit average over the flat approach and the stroke together,
      // which pushes the predicted contact well past the real one.
      if (st.ts.length > FIT_SAMPLES) {
        st.ts.shift();
        st.ys.shift();
        st.flex.shift();
      }

      if (tSec < st.refractoryUntil) continue;

      // Schmitt-style release: the finger must come back up before it can
      // re-arm, which kills double triggers from tracking noise. The
      // hysteresis is a fraction of the stroke's own depth — a fixed one is
      // far too small next to a deep wrist-led tap, and the finger re-arms
      // partway down its own rebound.
      if (st.committed) {
        const back = Math.max(0.22, (st.peakSig - st.armSig) * 0.45);
        if (s < st.peakSig - back) {
          st.committed = false;
          st.armed = false;
        }
        continue;
      }

      const n = st.ts.length;
      if (n < 3) continue;

      const t0 = st.ts[n - 1];
      const rel = st.ts.map((t) => t - t0);

      // Kinematics from the last three samples. Arming and the late path use
      // these, so a stroke is recognised two frames in rather than four —
      // which is the difference between catching a 90 ms tap and dropping it.
      const kin = quadDeriv(rel, st.ys);
      if (!kin) continue;
      const [vel, acc] = kin;

      // With five samples a cubic is nearly an interpolant, so its endpoint
      // derivative can swing wildly on a signal that is merely rebounding —
      // which is how a single tap used to produce a second phantom note on
      // the way back up. The mean slope over the window cannot: require the
      // finger to have genuinely descended before believing any derivative.
      const span = st.ts[n - 1] - st.ts[0];
      const meanSlope = span > 0 ? (st.ys[n - 1] - st.ys[0]) / span : 0;
      if (meanSlope < this.tuning.armVel * 0.4) {
        st.armed = false;
        continue;
      }

      if (!st.armed) {
        // v1 also required acc > 0 here. On a 20–30 fps phone the first
        // in-stroke sample often already sits past peak acceleration, and the
        // finger then never armed at all — which is most of why detection
        // collapsed below 30 fps.
        if (vel > this.tuning.armVel) {
          st.armed = true;
          st.armedAt = tSec;
          st.armSig = st.ys[0];
        } else {
          continue;
        }
      }

      // abandon a stroke that stalls
      if (tSec - st.armedAt > 0.32) {
        st.armed = false;
        continue;
      }

      // Prediction proper needs the constant-jerk model, and that needs four
      // samples. When they exist we can say *when* the peak will arrive;
      // when they do not, we can still say a stroke is happening.
      let contactIn: number | null = null;
      let peakVel = vel;

      const fit = n >= 4 ? fitCubic(rel, st.ys) : null;
      if (fit) {
        const [, c1, c2, c3] = fit;
        if (c3 < -1e-6) {
          // acceleration zero-crossing: 2c2 + 6c3 t = 0
          const tStar = -c2 / (3 * c3);
          if (tStar > 0 && tStar < 0.25) {
            contactIn = tStar;
            peakVel = c1 + 2 * c2 * tStar + 3 * c3 * tStar * tStar;
          }
        }
      }

      // Safety valve: no peak is predictable from this window but a real
      // stroke is plainly under way. Fire now — late beats missing.
      //
      // v1 demanded acc < 0 here, i.e. that the stroke was already
      // decelerating. A 90 ms tap at 30 fps — the hardest, most deliberate
      // gesture a user can make — never has four samples inside its own
      // downstroke, so it yields no zero-crossing, and the fit is dominated by
      // the flat approach preceding it, so it shows no in-window deceleration
      // either. Those strokes were simply dropped. Waiting instead for the
      // runway to run out catches them without firing on every strong sample.
      const late =
        contactIn === null &&
        vel > this.tuning.armVel * 1.15 &&
        (acc < 0 || tSec - st.armedAt >= this.frameDt * 0.9);

      if (contactIn === null && !late) continue;
      // Commit once waiting for another frame would make us late, not once
      // the contact is inside the pipeline latency: at 20 fps the next frame
      // is 50 ms away, and a window that ignores that is stepped straight over.
      if (contactIn !== null && contactIn > leadSec + this.frameDt * 0.7) continue;

      // G4, hard form: a keystroke's downstroke is short. Anything that takes
      // longer than MAX_DOWNSTROKE_SEC from arming to contact is a deliberate
      // curl (making a fist, relaxing the hand), not a strike.
      const downstroke = tSec - st.armedAt + (contactIn ?? 0);
      if (downstroke > MAX_DOWNSTROKE_SEC) {
        st.armed = false;
        continue;
      }
      // and it carries real speed — this is what separates a soft strike from
      // a slow drift that happens to cross the arming threshold
      if (Math.abs(peakVel) < this.tuning.armVel * 1.1) {
        st.armed = false;
        continue;
      }
      // Speed relative to the stroke's own depth. A gentle tap and a slow
      // fist reach the same peak velocity; they do not travel the same
      // distance getting there, and this is what tells them apart.
      const strokeDepth = Math.max(s - st.restLevel, 0.05);
      if (Math.abs(peakVel) / strokeDepth < this.tuning.minStrokeRate) {
        st.armed = false;
        continue;
      }

      if (gates <= 0) {
        st.armed = false;
        continue;
      }

      const velocity = clamp(
        (Math.abs(peakVel) - this.tuning.armVel) / (this.tuning.velFull - this.tuning.armVel),
        0.06,
        1
      );

      st.committed = true;
      st.armed = false;
      st.peakSig = Math.max(s, st.peakSig * 0.4 + s * 0.6);
      st.refractoryUntil = tSec + this.tuning.refractory;

      const ev: StrikeEvent = {
        hand: this.side,
        finger: f,
        contactPerfMs: frame.tMs + (contactIn ?? 0) * 1000,
        // marginal strikes play quietly rather than being suppressed: a false
        // positive at ppp inside the current chord is inaudible, a suppressed
        // true positive is a hole in the performance
        velocity: velocity * (0.45 + 0.55 * gates),
        confidence: gates,
        zoneX: this.zoneX,
        simultaneous: 1,
      };
      out.push({
        ev,
        // how much of this finger's descent was its own rather than the
        // whole hand's, and how much of it was actual articulation
        lead: depth[f] - commonDepth,
        artic: flexSlope(st),
      });
    }

    return this.collapse(out, tSec);
  }

  /**
   * A wrist-led tap moves every fingertip by the same amount, so all five
   * fingers detect it. Keep the ones that actually articulated; if none did,
   * the hand itself was the gesture and it plays as a single note from the
   * finger that led.
   *
   * The passengers do not all commit on the same frame — the leading finger
   * fires and a neighbour follows one frame later — so this has to hold a
   * short memory rather than work frame by frame. Fingers that genuinely
   * articulate are never suppressed: that is a chord, and it should sound
   * like one.
   */
  private collapse(cands: Candidate[], tSec: number): StrikeEvent[] {
    const articThreshold = this.tuning.armVel * 0.45;
    let kept = cands;

    if (cands.length > 1) {
      const articulated = cands.filter((c) => c.artic > articThreshold);
      kept = articulated.length
        ? articulated
        : [cands.reduce((a, b) => (b.lead > a.lead ? b : a))];
    }
    if (tSec - this.lastEmitAt < BULK_LOCKOUT_SEC) {
      kept = kept.filter((c) => c.artic > articThreshold);
    }
    if (!kept.length) return [];

    this.lastEmitAt = tSec;
    return kept.map((c) => ({ ...c.ev, simultaneous: kept.length }));
  }

  /** Product of the gates, in 0..1. Zero means do not fire at all. */
  private gateScore(frame: HandFrame, scale: number): number {
    // G5 tracking health
    const health = clamp((frame.score - 0.4) / 0.4, 0, 1);
    if (health <= 0) return 0;

    // G2 posture. A soft multiplier with a floor, not a cliff: a hard cut
    // here means a hand held at an unlucky angle is silently, permanently
    // mute, which is indistinguishable from the app being broken.
    const posture = 0.55 + 0.45 * this.postureScore;

    // G3 articulation must dominate *lateral* bulk motion. Denominated in
    // hand-lengths per second so camera distance does not matter.
    const rel = this.lateralSpeed / scale;
    const t = this.tuning;
    const artic = clamp(1 - (rel - t.maxLateralSpeed) / (t.lateralCutoff - t.maxLateralSpeed), 0, 1);
    if (artic <= 0) return 0;

    return clamp(health * posture * artic, 0, 1);
  }
}

function dotV(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function median5(v: number[]): number {
  return [...v].sort((a, b) => a - b)[2];
}

/** Recent slope of raw flexion — articulation with the hand's motion removed. */
function flexSlope(st: FingerState): number {
  const n = st.flex.length;
  if (n < 3) return 0;
  const dt = st.ts[n - 1] - st.ts[n - 3];
  if (dt <= 0) return 0;
  return (st.flex[n - 1] - st.flex[n - 3]) / dt;
}

/**
 * G6, the density governor: a musical gate on a perception problem. If
 * gestures arrive faster than a pianist could plausibly play, the excess is
 * dropped rather than rendered, so the user cannot produce a mess even when
 * the tracker is having a bad second.
 */
export class DensityGovernor {
  private times: number[] = [];
  constructor(private perSecond = 12) {}

  allow(nowMs: number): boolean {
    this.times = this.times.filter((t) => nowMs - t < 1000);
    if (this.times.length >= this.perSecond) return false;
    this.times.push(nowMs);
    return true;
  }
}
