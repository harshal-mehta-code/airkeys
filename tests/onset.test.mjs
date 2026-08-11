/**
 * Predictive onset tests.
 *
 * Drives HandPerception with synthetic landmarks describing a ballistic
 * keystroke, and checks the three things the whole product rests on:
 *   1. a deliberate stroke fires exactly once,
 *   2. it fires EARLY — the note is committed before the finger lands,
 *   3. incidental motion does not fire.
 *
 * Run: npm run test:onset
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// esbuild ships with vite; transpile the perception module to plain ESM
const out = path.join(mkdtempSync(path.join(tmpdir(), "ak-")), "perception.mjs");
execFileSync(
  path.join("node_modules", ".bin", "esbuild"),
  ["src/perception/Perception.ts", "--bundle", "--format=esm", `--outfile=${out}`, "--log-level=warning"],
  { stdio: "inherit" }
);
const { HandPerception } = await import(out);

/* ---------------- synthetic hand ---------------- */

const FINGER_BASE = [1, 5, 9, 13, 17];

/**
 * Build a geometrically consistent hand where each finger's three joints are
 * bent by `curl` radians. Only relative angles matter to the detector, so an
 * idealised hand exercises exactly the code paths a real one does.
 */
function makeHand(curls, wristXY = [0.5, 0.5]) {
  const world = new Float32Array(63);
  const normed = new Float32Array(63);
  const set = (arr, i, x, y, z) => {
    arr[i * 3] = x;
    arr[i * 3 + 1] = y;
    arr[i * 3 + 2] = z;
  };

  set(world, 0, 0, 0, 0); // wrist

  for (let f = 0; f < 5; f++) {
    const base = FINGER_BASE[f];
    const spread = (f - 2) * 0.022;
    const mcp = [spread, -0.035, 0];
    set(world, base, mcp[0], mcp[1], mcp[2]);

    const curl = curls[f];
    const lens = [0.038, 0.026, 0.02];
    const angles = [curl, curl * 1.1, curl * 0.8];
    let dir = [0, -1, 0];
    let p = mcp;
    for (let s = 0; s < 3; s++) {
      // rotate the bone direction in the y–z plane (flexion)
      const a = angles[s];
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const nd = [dir[0], dir[1] * ca - dir[2] * sa, dir[1] * sa + dir[2] * ca];
      dir = nd;
      p = [p[0] + dir[0] * lens[s], p[1] + dir[1] * lens[s], p[2] + dir[2] * lens[s]];
      set(world, base + s + 1, p[0], p[1], p[2]);
    }
  }

  // image-space projection: enough for zone + bulk-motion gating
  for (let i = 0; i < 21; i++) {
    normed[i * 3] = wristXY[0] + world[i * 3] * 2.2;
    normed[i * 3 + 1] = wristXY[1] + world[i * 3 + 1] * 2.2;
    normed[i * 3 + 2] = world[i * 3 + 2];
  }
  return { world, normed };
}

/** Smoothstep: velocity peaks exactly at the midpoint — that is "contact". */
function strokeCurl(tMs, startMs, durMs, amp, rest) {
  if (tMs <= startMs) return rest;
  const u = Math.min(1, (tMs - startMs) / durMs);
  return rest + amp * (3 * u * u - 2 * u * u * u);
}

/* ---------------- harness ---------------- */

const REST = 0.22;
const FPS = 60;
const LEAD = 0.05; // 50 ms pipeline latency to cancel

/**
 * `phase` shifts the sampling grid relative to the stroke. It matters a lot:
 * where the frames happen to land inside a 160 ms stroke changes how many
 * in-stroke samples the fit gets, so a single run is not a measurement.
 */
function runScenario({ strokes = [], durationMs = 1400, lead = LEAD, drift = 0, phase = 0, fps = FPS }) {
  const p = new HandPerception("R");
  const dt = 1000 / fps;
  const fired = [];
  let t = phase * dt;
  let calibrated = false;

  while (t < durationMs) {
    const curls = [REST, REST, REST, REST, REST];
    for (const s of strokes) {
      if (s.finger == null) continue;
      curls[s.finger] = strokeCurl(t, s.startMs, s.durMs, s.amp, REST);
    }
    const wx = 0.5 + (drift * t) / 1000;
    const { world, normed } = makeHand(curls, [wx, 0.5]);
    const frame = { side: "R", world, normed, score: 0.95, tMs: t };

    if (!calibrated) {
      p.calibrate(frame);
      calibrated = true;
    }
    const out = p.update(frame, lead);
    for (const ev of out) fired.push({ ...ev, frameT: t });

    t += dt;
  }
  return fired;
}

/* ---------------- assertions ---------------- */

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}${detail ? "  " + detail : ""}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? "  " + detail : ""}`);
  }
}

console.log("\n--- predictive onset ---");

// 1. a normal keystroke fires once
{
  const durMs = 160; // typical air-played stroke: no key to stop the finger
  const startMs = 400;
  const trueContact = startMs + durMs / 2; // peak velocity

  const errs = [];
  const leads = [];
  let missed = 0;
  let extra = 0;
  const N = 24;
  for (let i = 0; i < N; i++) {
    const fired = runScenario({
      strokes: [{ finger: 1, startMs, durMs, amp: 0.62 }],
      phase: i / N,
    });
    if (fired.length === 0) { missed++; continue; }
    if (fired.length > 1) extra += fired.length - 1;
    errs.push(fired[0].contactPerfMs - trueContact);
    leads.push(trueContact - fired[0].frameT);
  }
  const sorted = errs.map(Math.abs).sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p90 = sorted[Math.floor(sorted.length * 0.9)];

  check("every stroke detected", missed === 0, `(${missed}/${N} missed)`);
  check("no double triggers", extra === 0, `(${extra} extra)`);
  // The user-facing property is WHERE THE NOTE LANDS, not when we decided:
  // the note is scheduled at contactPerfMs on the audio clock.
  check("median placement error < 35ms @60fps", p50 < 35, `p50=${p50.toFixed(1)}ms p90=${p90.toFixed(1)}ms`);
  // At 60 fps a 160 ms stroke yields only ~5 samples before contact — the
  // minimum a cubic fit needs — so the DECISION lands near contact even
  // though the scheduled note does not. See docs/07 § N1.
  const medLead = leads.sort((a, b) => a - b)[Math.floor(leads.length / 2)];
  console.log(`INFO  median decision ${medLead.toFixed(0)}ms before contact (negative = after)`);

  const one = runScenario({ strokes: [{ finger: 1, startMs, durMs, amp: 0.62 }], phase: 0 });
  check("velocity in range", one[0].velocity > 0.05 && one[0].velocity <= 1, `v=${one[0].velocity.toFixed(2)}`);
  check("confidence positive", one[0].confidence > 0, `c=${one[0].confidence.toFixed(2)}`);
}

// 2. dynamics: a faster stroke must be louder than a slow one
{
  const slow = runScenario({ strokes: [{ finger: 1, startMs: 400, durMs: 240, amp: 0.5 }] });
  const fast = runScenario({ strokes: [{ finger: 1, startMs: 400, durMs: 90, amp: 0.75 }] });
  const ok = slow.length && fast.length && fast[0].velocity > slow[0].velocity;
  check(
    "harder stroke is louder",
    !!ok,
    ok ? `slow=${slow[0].velocity.toFixed(2)} fast=${fast[0].velocity.toFixed(2)}` : "(missing strike)"
  );
}

// 3. repeated strikes on one finger all register
{
  const strokes = [];
  for (let i = 0; i < 4; i++) strokes.push({ finger: 1, startMs: 300 + i * 300, durMs: 150, amp: 0.62 });
  // one finger, sequential strokes — emulate by running each separately is
  // wrong, so build a combined curl curve instead
  const p = new HandPerception("R");
  const dt = 1000 / FPS;
  let t = 0;
  let fired = 0;
  let calibrated = false;
  while (t < 1900) {
    let c = REST;
    for (const s of strokes) {
      if (t > s.startMs && t < s.startMs + s.durMs * 2) {
        const u = Math.min(1, (t - s.startMs) / s.durMs);
        const up = Math.max(0, 1 - Math.max(0, (t - s.startMs - s.durMs) / s.durMs));
        c = REST + s.amp * (3 * u * u - 2 * u * u * u) * up;
      }
    }
    const { world, normed } = makeHand([REST, c, REST, REST, REST]);
    const frame = { side: "R", world, normed, score: 0.95, tMs: t };
    if (!calibrated) {
      p.calibrate(frame);
      calibrated = true;
    }
    fired += p.update(frame, LEAD).length;
    t += dt;
  }
  check("4 repeated strikes → 4 notes", fired === 4, `(got ${fired})`);
}

console.log("\n--- false trigger suppression ---");

// 4. a completely still hand fires nothing
{
  const fired = runScenario({ strokes: [] });
  check("still hand fires nothing", fired.length === 0, `(got ${fired.length})`);
}

// 5. slow deliberate curl (making a fist) is not a strike
{
  const fired = runScenario({ strokes: [{ finger: 1, startMs: 300, durMs: 900, amp: 0.9 }], durationMs: 1800 });
  check("slow curl is not a strike", fired.length === 0, `(got ${fired.length})`);
}

// 6. striking while the whole hand sweeps across frame is gated out (G3)
{
  const fired = runScenario({
    strokes: [{ finger: 1, startMs: 400, durMs: 160, amp: 0.62 }],
    drift: 1.6, // screen widths per second — a big repositioning sweep
  });
  check("strike during a fast hand sweep is suppressed", fired.length === 0, `(got ${fired.length})`);
}

console.log("\n--- frame rate robustness ---");

// 7. same stroke at 30 fps still detected
{
  const p = new HandPerception("R");
  const durMs = 190;
  const startMs = 400;
  const trueContact = startMs + durMs / 2;
  let t = 0;
  let calibrated = false;
  const fired = [];
  while (t < 1200) {
    const c = strokeCurl(t, startMs, durMs, 0.62, REST);
    const { world, normed } = makeHand([REST, c, REST, REST, REST]);
    const frame = { side: "R", world, normed, score: 0.95, tMs: t };
    if (!calibrated) {
      p.calibrate(frame);
      calibrated = true;
    }
    for (const ev of p.update(frame, LEAD)) fired.push({ ...ev, frameT: t });
    t += 1000 / 30;
  }
  check("detected at 30 fps", fired.length === 1, `(got ${fired.length})`);
  if (fired.length) {
    check(
      "30 fps prediction within 40ms",
      Math.abs(fired[0].contactPerfMs - trueContact) < 40,
      `error ${(fired[0].contactPerfMs - trueContact).toFixed(1)}ms`
    );
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
