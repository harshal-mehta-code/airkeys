/**
 * Perception: landmarks in, predicted strikes out.
 *
 * Three ideas carry this file.
 *
 * 1. FINGER FLEXION, NOT FINGERTIP DEPTH, is the strike signal. MediaPipe's
 *    z axis is its weakest output. Joint angles are unitless, so they are
 *    invariant to camera distance, framing and resolution — which is most of
 *    the cross-device requirement solved for free.
 *
 * 2. THE PALM IS THE REFERENCE FRAME. Bulk hand motion is subtracted from
 *    articulation, which separates "a finger moved" from "the whole hand
 *    moved". That distinction is the single largest source of false triggers.
 *
 * 3. WE PREDICT, WE DO NOT REACT. A keystroke is ballistic: after a few
 *    samples of downstroke the rest of the trajectory is determined. We fit a
 *    constant-jerk model, solve for the moment flexion velocity peaks (the
 *    acceleration peak, which the air-drumming literature identifies as both
 *    earlier and more consistent than the strike itself), and commit exactly
 *    when the remaining travel time has shrunk to the pipeline latency.
 */
import { OneEuro, fitCubic, angle, cross, norm, sub, clamp, type Vec3 } from "./filters";

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
  ts: number[];
  ys: number[];
  armed: boolean;
  armedAt: number;
  committed: boolean;
  peakFlex: number;
  refractoryUntil: number;
  restFlex: number;
}

export interface PerceptionTuning {
  /** minimum flexion velocity, rad/s, to consider a downstroke */
  armVel: number;
  /** flexion velocity mapped to full dynamic range */
  velFull: number;
  /** per-finger lockout after a strike, seconds */
  refractory: number;
  /** max palm-relative bulk motion allowed while striking (screen widths/s) */
  maxPalmSpeed: number;
}

export const DEFAULT_TUNING: PerceptionTuning = {
  armVel: 2.6,
  velFull: 16,
  refractory: 0.085,
  maxPalmSpeed: 1.1,
};

/**
 * Samples used for the ballistic fit. Five spans ~83 ms at 60 fps — long
 * enough to be stable, short enough to sit inside a single downstroke.
 */
const FIT_SAMPLES = 5;

/** A downstroke longer than this is a deliberate curl, not a keystroke. */
const MAX_DOWNSTROKE_SEC = 0.28;

export class HandPerception {
  side: HandSide;
  tuning: PerceptionTuning;

  private fingers: FingerState[] = [];
  private lastNormed: Float32Array | null = null;
  private lastTMs = 0;
  private palmSpeed = 0;
  private restNormal: Vec3 | null = null;

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
        armed: false,
        armedAt: 0,
        committed: false,
        peakFlex: 0,
        refractoryUntil: 0,
        restFlex: 0,
      });
    }
  }

  /** Capture the user's rest pose so thresholds are relative to them. */
  calibrate(frame: HandFrame) {
    this.restNormal = palmNormal(frame.world);
    for (let f = 0; f < 5; f++) {
      this.fingers[f].restFlex = flexion(frame.world, FINGER_CHAINS[f]);
    }
  }

  markAbsent(nowMs: number) {
    if (nowMs - this.lastSeenMs > 220) {
      this.present = false;
      for (const f of this.fingers) {
        f.ts.length = 0;
        f.ys.length = 0;
        f.armed = false;
        f.committed = false;
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
    const out: StrikeEvent[] = [];
    this.present = true;
    this.lastSeenMs = frame.tMs;

    // ---- image-space bulk motion (world landmarks are hand-centric and so
    // carry no translation at all)
    const wristN: Vec3 = pt(frame.normed, 0);
    const midN: Vec3 = pt(frame.normed, 9);
    const apparent = Math.hypot(wristN[0] - midN[0], wristN[1] - midN[1]) || 0.08;
    if (this.lastNormed && frame.tMs > this.lastTMs) {
      const prevW: Vec3 = pt(this.lastNormed, 0);
      const dt = (frame.tMs - this.lastTMs) / 1000;
      const d = Math.hypot(wristN[0] - prevW[0], wristN[1] - prevW[1]);
      const inst = d / Math.max(dt, 0.001);
      this.palmSpeed += (inst - this.palmSpeed) * 0.35;
    }
    this.lastNormed = frame.normed.slice();
    this.lastTMs = frame.tMs;

    // mirrored for a selfie view: moving your hand to your right raises the
    // register, which is the direction a pianist expects
    this.zoneX = clamp(1 - wristN[0], 0, 1);

    // ---- posture gate: palm roughly in the pose it was calibrated in
    const pn = palmNormal(frame.world);
    const ref: Vec3 = this.restNormal ?? [0, -1, 0];
    const tilt = angle(pn, ref);
    this.postureScore = clamp(1 - tilt / (Math.PI * 0.55), 0, 1);

    // ---- per-finger onset detection
    for (let f = 0; f < 5; f++) {
      const st = this.fingers[f];
      const raw = flexion(frame.world, FINGER_CHAINS[f]);
      const flex = st.euro.filter(raw, tSec);

      st.ts.push(tSec);
      st.ys.push(flex);
      // Short buffer on purpose. A window longer than the stroke itself makes
      // the cubic fit average over the flat approach and the stroke together,
      // which pushes the predicted contact well past the real one.
      if (st.ts.length > FIT_SAMPLES) {
        st.ts.shift();
        st.ys.shift();
      }

      if (tSec < st.refractoryUntil) continue;

      // Schmitt-style release: the finger must extend again before it can
      // re-arm, which kills double triggers from tracking noise
      if (st.committed) {
        if (flex < st.peakFlex - 0.22) {
          st.committed = false;
          st.armed = false;
        }
        continue;
      }

      if (st.ts.length < 4) continue;

      const t0 = st.ts[st.ts.length - 1];
      const rel = st.ts.map((t) => t - t0);
      const fit = fitCubic(rel, st.ys);
      if (!fit) continue;
      const [, c1, c2, c3] = fit;

      const vel = c1; // dflex/dt at t = 0 (now)
      const acc = 2 * c2;

      if (!st.armed) {
        if (vel > this.tuning.armVel && acc > 0) {
          st.armed = true;
          st.armedAt = tSec;
        } else {
          continue;
        }
      }

      // abandon a stroke that stalls
      if (tSec - st.armedAt > 0.32) {
        st.armed = false;
        continue;
      }

      let contactIn: number | null = null;
      let peakVel = vel;

      if (c3 < -1e-6) {
        // acceleration zero-crossing: 2c2 + 6c3 t = 0
        const tStar = -c2 / (3 * c3);
        if (tStar > 0 && tStar < 0.25) {
          contactIn = tStar;
          peakVel = c1 + 2 * c2 * tStar + 3 * c3 * tStar * tStar;
        }
      }

      // Safety valve: we are already past the predictable window (decelerating
      // hard) but a real stroke happened. Fire now — late beats missing.
      const late = contactIn === null && acc < 0 && vel > this.tuning.armVel * 1.15;

      if (contactIn === null && !late) continue;
      if (contactIn !== null && contactIn > leadSec) continue; // too early to commit

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
      if (Math.abs(peakVel) < this.tuning.armVel * 1.6) {
        st.armed = false;
        continue;
      }

      const gates = this.gateScore(frame, apparent, downstroke > 0.02);
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
      st.peakFlex = Math.max(flex, st.peakFlex * 0.4 + flex * 0.6);
      st.refractoryUntil = tSec + this.tuning.refractory;

      out.push({
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
      });
    }

    return out;
  }

  /** Product of the gates, in 0..1. Zero means do not fire at all. */
  private gateScore(frame: HandFrame, apparent: number, durationOk: boolean): number {
    // G5 tracking health
    const health = clamp((frame.score - 0.4) / 0.4, 0, 1);
    if (health <= 0) return 0;

    // G2 posture
    const posture = this.postureScore;
    if (posture < 0.22) return 0;

    // G3 articulation dominates bulk motion. palmSpeed is in screen widths
    // per second, scaled by apparent hand size so distance doesn't matter.
    const rel = this.palmSpeed / Math.max(apparent, 0.02);
    const artic = clamp(1 - (rel - this.tuning.maxPalmSpeed) / 2.2, 0, 1);
    if (artic <= 0) return 0;

    // G4 plausible stroke duration
    const dur = durationOk ? 1 : 0.35;

    return clamp(health * posture * artic * dur, 0, 1);
  }
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
