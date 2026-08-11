/**
 * Copies runtime assets out of node_modules into public/ before dev/build.
 *
 * These are large binaries (~45 MB) that we deliberately do not commit:
 *   - MediaPipe WASM runtime  (@mediapipe/tasks-vision)
 *   - Salamander piano samples (@audio-samples/piano-mp3-velocityN)
 *
 * Samples are renamed to their MIDI number so URLs never contain a '#'.
 * The hand landmarker model IS committed (public/models) — it has no npm
 * source, so vendoring it is the only way to keep the app same-origin.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NM = path.join(root, "node_modules");

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const VELOCITY_LAYERS = [4, 9, 14];
export const LOWEST_MIDI = 33;   // A1
export const HIGHEST_MIDI = 93;  // A6
export const SAMPLE_STEP = 3;    // Salamander samples every minor third

function noteName(midi) {
  return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}

function copyDir(from, to, filter) {
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(from)) {
    if (filter && !filter(f)) continue;
    fs.copyFileSync(path.join(from, f), path.join(to, f));
    n++;
  }
  return n;
}

const MODEL_PATH = "public/models/hand_landmarker.task";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

/**
 * The model is committed, but a deploy that ships source only (no binaries)
 * still needs it. Fetch it at build time when it is absent so the deployed app
 * serves it same-origin either way — no third-party request at runtime.
 */
async function ensureModel() {
  const dst = path.join(root, MODEL_PATH);
  if (fs.existsSync(dst) && fs.statSync(dst).size > 1_000_000) {
    console.log(`[assets] model present (${(fs.statSync(dst).size / 1e6).toFixed(1)} MB)`);
    return;
  }
  console.log("[assets] model missing — downloading…");
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1_000_000) throw new Error(`model download too small: ${buf.length} bytes`);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, buf);
  console.log(`[assets] model downloaded (${(buf.length / 1e6).toFixed(1)} MB)`);
}

async function main() {
  await ensureModel();

  // ---- MediaPipe WASM
  const wasmSrc = path.join(NM, "@mediapipe/tasks-vision/wasm");
  if (!fs.existsSync(wasmSrc)) {
    console.error("[assets] @mediapipe/tasks-vision not installed — run npm install");
    process.exit(1);
  }
  const wasmDst = path.join(root, "public/mediapipe/wasm");
  const nWasm = copyDir(wasmSrc, wasmDst);

  // ---- Piano samples
  let nSamples = 0;
  let bytes = 0;
  for (const v of VELOCITY_LAYERS) {
    const src = path.join(NM, `@audio-samples/piano-mp3-velocity${v}/audio`);
    if (!fs.existsSync(src)) {
      console.error(`[assets] missing @audio-samples/piano-mp3-velocity${v}`);
      process.exit(1);
    }
    const dst = path.join(root, `public/audio/piano/v${v}`);
    fs.mkdirSync(dst, { recursive: true });
    for (let m = LOWEST_MIDI; m <= HIGHEST_MIDI; m += SAMPLE_STEP) {
      const from = path.join(src, `${noteName(m)}v${v}.mp3`);
      if (!fs.existsSync(from)) {
        console.error(`[assets] missing sample ${noteName(m)}v${v}.mp3`);
        process.exit(1);
      }
      const to = path.join(dst, `${m}.mp3`);
      fs.copyFileSync(from, to);
      bytes += fs.statSync(to).size;
      nSamples++;
    }
  }

  console.log(
    `[assets] ${nWasm} wasm files, ${nSamples} piano samples ` +
    `(${(bytes / 1e6).toFixed(1)} MB) → public/`
  );
}

main().catch((e) => {
  console.error("[assets]", e.message);
  process.exit(1);
});
