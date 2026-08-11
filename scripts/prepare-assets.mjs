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

function main() {
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

main();
