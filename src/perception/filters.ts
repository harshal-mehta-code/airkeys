/** Small numeric helpers for the perception pipeline. */

export type Vec3 = [number, number, number];

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function len(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}
export function norm(a: Vec3): Vec3 {
  const l = len(a) || 1e-9;
  return [a[0] / l, a[1] / l, a[2] / l];
}
/** Angle between two vectors, radians, numerically safe. */
export function angle(a: Vec3, b: Vec3): number {
  const d = dot(norm(a), norm(b));
  return Math.acos(Math.min(1, Math.max(-1, d)));
}
export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * One Euro filter — adaptive cutoff, so it smooths heavily when the signal is
 * slow and gets out of the way when it moves fast. That trade-off is exactly
 * what a low-latency gesture system needs, and it beats a fixed EMA, which
 * must choose between lag and jitter.
 */
export class OneEuro {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;

  constructor(
    private minCutoff = 1.2,
    private beta = 0.03,
    private dCutoff = 1.0
  ) {}

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  reset() {
    this.xPrev = null;
    this.dxPrev = 0;
  }

  filter(x: number, tSec: number): number {
    if (this.xPrev === null || tSec <= this.tPrev) {
      this.xPrev = x;
      this.tPrev = tSec;
      return x;
    }
    const dt = tSec - this.tPrev;
    this.tPrev = tSec;

    const dx = (x - this.xPrev) / dt;
    const ad = OneEuro.alpha(this.dCutoff, dt);
    this.dxPrev = ad * dx + (1 - ad) * this.dxPrev;

    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxPrev);
    const a = OneEuro.alpha(cutoff, dt);
    const out = a * x + (1 - a) * this.xPrev;
    this.xPrev = out;
    return out;
  }
}

/**
 * Least-squares cubic fit, y = c0 + c1 t + c2 t^2 + c3 t^3.
 *
 * A cubic (constant jerk) is the smallest model that can express "still
 * accelerating now, will peak shortly" — a quadratic has constant
 * acceleration and so can never predict the peak. Times should be supplied
 * relative to the newest sample so t = 0 means "now".
 */
export function fitCubic(ts: number[], ys: number[]): [number, number, number, number] | null {
  const n = ts.length;
  if (n < 4) return null;

  // normal equations for a 4-term polynomial basis
  const A = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const b = [0, 0, 0, 0];
  for (let k = 0; k < n; k++) {
    const t = ts[k];
    const p = [1, t, t * t, t * t * t];
    for (let i = 0; i < 4; i++) {
      b[i] += p[i] * ys[k];
      for (let j = 0; j < 4; j++) A[i][j] += p[i] * p[j];
    }
  }

  // Gaussian elimination with partial pivoting
  for (let i = 0; i < 4; i++) {
    let piv = i;
    for (let r = i + 1; r < 4; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
    if (Math.abs(A[piv][i]) < 1e-12) return null;
    if (piv !== i) {
      [A[i], A[piv]] = [A[piv], A[i]];
      [b[i], b[piv]] = [b[piv], b[i]];
    }
    for (let r = i + 1; r < 4; r++) {
      const f = A[r][i] / A[i][i];
      for (let c = i; c < 4; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  const x = [0, 0, 0, 0];
  for (let i = 3; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < 4; j++) s -= A[i][j] * x[j];
    x[i] = s / A[i][i];
  }
  if (x.some((v) => !Number.isFinite(v))) return null;
  return [x[0], x[1], x[2], x[3]];
}

/** Running median over a short window — robust to the odd wild latency sample. */
export class RunningMedian {
  private buf: number[] = [];
  constructor(private size = 15) {}
  push(v: number) {
    if (!Number.isFinite(v)) return;
    this.buf.push(v);
    if (this.buf.length > this.size) this.buf.shift();
  }
  get value(): number | null {
    if (!this.buf.length) return null;
    const s = [...this.buf].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }
}
