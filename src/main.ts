/**
 * AirKeys v1 — wiring.
 *
 * capture → tracking(worker) → perception(predict) → performer(compose)
 *         → audio(schedule on the audio clock) → visuals(at the same instant)
 */
import "./styles.css";
import { AudioEngine } from "./audio/AudioEngine";
import { CameraManager } from "./capture/CameraManager";
import { TrackerClient } from "./tracking/TrackerClient";
import {
  DensityGovernor,
  HandPerception,
  type HandFrame,
  type HandSide,
  type StrikeEvent,
} from "./perception/Perception";
import { Performer } from "./music/Performer";
import { Stage } from "./visuals/Stage";
import { CINEMATIC } from "./music/theory";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/* ---------------- state ---------------- */

const audio = new AudioEngine();
const performer = new Performer(audio, CINEMATIC);
const camera = new CameraManager();
const tracker = new TrackerClient();
const governor = new DensityGovernor(14);
const perception: Record<HandSide, HandPerception> = {
  L: new HandPerception("L"),
  R: new HandPerception("R"),
};

let stage: Stage;
let started = false;
let cameraOn = false;
let cameraError = "";
const flash: Record<HandSide, number[]> = { L: [0, 0, 0, 0, 0], R: [0, 0, 0, 0, 0] };

/* ---------------- latency budget ---------------- */

function leadSeconds(): number {
  const capture = cameraOn ? camera.captureLatencySec : 0.005;
  return capture + tracker.inferenceSec + 0.002 + audio.outputLatency;
}

/* ---------------- pipeline ---------------- */

function onTrackResult(hands: Array<{ side: string; score: number; world: Float32Array; normed: Float32Array }>, captureTMs: number) {
  const seen: Record<HandSide, boolean> = { L: false, R: false };
  const lead = leadSeconds();
  const renderHands = [];

  for (const h of hands) {
    // MediaPipe reports the anatomical hand for a non-mirrored input frame,
    // which is what we feed it. Left hand takes harmony, right takes melody.
    const side: HandSide = h.side.toLowerCase().startsWith("l") ? "L" : "R";
    if (seen[side]) continue;
    seen[side] = true;

    const p = perception[side];
    const frame: HandFrame = {
      side,
      world: h.world,
      normed: h.normed,
      score: h.score,
      tMs: captureTMs,
    };

    // Calibration disguised as play: learn the rest pose over the first few
    // steady frames, so posture is judged against this user's hand rather
    // than against whichever frame they happened to be detected in.
    if (!p.calibrated && h.score > 0.75) p.calibrate(frame);

    const strikes = p.update(frame, lead);
    for (const s of strikes) {
      if (!governor.allow(performance.now())) continue;
      fireStrike(s);
    }

    renderHands.push({ side, normed: h.normed, flash: flash[side] });
  }

  for (const side of ["L", "R"] as HandSide[]) {
    if (!seen[side]) perception[side].markAbsent(performance.now());
  }
  stage.hands = renderHands;
}

function fireStrike(s: StrikeEvent) {
  performer.strike(s);
  // visual flash rides the same predicted instant as the note
  const delay = Math.max(0, s.contactPerfMs - performance.now());
  window.setTimeout(() => {
    flash[s.hand][s.finger] = 1;
  }, delay);
}

/* ---------------- start ---------------- */

async function begin() {
  if (started) return;
  started = true;

  // The camera request goes out FIRST, while the tap that got us here is
  // still live user activation. iOS Safari will not show the permission
  // prompt otherwise, and awaiting the sample download before asking — as
  // this used to — reliably lost the gesture on a phone: no prompt, no
  // camera, and (because the context was never really started) no sound.
  const cameraReady = startCamera();

  setVeil("Waking the piano…", "Loading samples");
  await audio.init();
  audio.setReverb(performer.genre.reverb);

  await audio.sampler.loadCore();
  void audio.sampler.loadRest();

  performer.start();
  $("veil").classList.add("gone");
  // hand focus back to the document so the A–L keys work immediately
  $<HTMLButtonElement>("begin").blur();

  await cameraReady;
}

let trackerStarted = false;

/**
 * Camera is optional: if it fails the app still plays from pointer and
 * keyboard, which is also how the engine is exercised in tests. Never
 * rejects — the caller awaits it only to sequence status text.
 */
function startCamera(): Promise<void> {
  setStatus("Starting camera…", "warn");
  camera.onFrame = (bmp, tMs) => tracker.send(bmp, tMs);
  tracker.onResult = (r) => onTrackResult(r.hands, r.captureTMs);
  if (!trackerStarted) {
    tracker.init(2);
    trackerStarted = true;
  }

  return camera
    .start()
    .then(() => {
      stage.video = camera.video;
      cameraOn = true;
      cameraError = "";
      setStatus("Looking for your hands", "warn");
      $("hint").textContent = "Tap the air where a keyboard would be";
      $("cam-retry").hidden = true;
    })
    .catch((e: unknown) => {
      cameraOn = false;
      cameraError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      setStatus("No camera — pointer or A–L", "warn");
      $("hint").textContent = cameraDeniedText(e);
      // A denial can simply mean the prompt never appeared. The retry button
      // gives Safari a fresh, unambiguous gesture to hang the prompt on.
      $("cam-retry").hidden = false;
    });
}

function cameraDeniedText(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Camera blocked. Allow it below, or in aA → Website Settings on iPhone.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No usable camera. Move and tap on the stage, or press A–L.";
  }
  return "No camera. Move and tap on the stage, or press A–L.";
}

function setVeil(title: string, sub: string) {
  $("veil-title").textContent = title;
  $("veil-sub").textContent = sub;
}

function setStatus(text: string, level: "good" | "warn" | "bad") {
  $("qtext").textContent = text;
  const lamp = $("lamp");
  lamp.style.background = `var(--${level})`;
  lamp.style.boxShadow = `0 0 8px var(--${level})`;
}

/* ---------------- fallback input ---------------- */

function syntheticStrike(hand: HandSide, zone: number, velocity: number, finger: number) {
  if (!started) {
    void begin();
    return;
  }
  const s: StrikeEvent = {
    hand,
    finger,
    contactPerfMs: performance.now(),
    velocity,
    confidence: 1,
    zoneX: zone,
    simultaneous: 1,
  };
  fireStrike(s);
}

function wireFallbackInput() {
  const vp = $("viewport");
  let lastX = 0.5;
  let lastT = 0;
  let speed = 0;

  vp.addEventListener("pointermove", (e) => {
    const r = vp.getBoundingClientRect();
    const nx = (e.clientX - r.left) / r.width;
    const now = performance.now();
    if (lastT) speed = Math.abs(nx - lastX) / Math.max(0.001, (now - lastT) / 1000);
    lastX = nx;
    lastT = now;
  });

  vp.addEventListener("pointerdown", (e) => {
    // controls layered over the stage (the camera retry) are not keystrokes
    if ((e.target as HTMLElement | null)?.closest("button")) return;
    if (!started) {
      void begin();
      return;
    }
    if (cameraOn) return; // real hands are driving
    const r = vp.getBoundingClientRect();
    const nx = (e.clientX - r.left) / r.width;
    const vel = Math.min(1, 0.45 + speed * 0.3 + Math.random() * 0.12);
    const zone = Math.min(1, Math.max(0, (nx - 0.1) / 0.8));
    if (nx < 0.42) syntheticStrike("L", zone, vel, e.shiftKey ? 2 : 1);
    else syntheticStrike("R", zone, vel, e.shiftKey ? 3 : 1);
  });

  const KEYS = "asdfghjkl;".split("");
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    // Only text entry should swallow these. Buttons must NOT, or the app is
    // mute after "Start playing" until you click elsewhere — the start button
    // still holds focus.
    const tag = (e.target as HTMLElement | null)?.tagName ?? "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    const i = KEYS.indexOf(e.key.toLowerCase());
    if (i < 0) return;
    e.preventDefault();
    if (!started) {
      void begin();
      return;
    }
    if (cameraOn) return;
    const zone = i / (KEYS.length - 1);
    const vel = 0.5 + Math.random() * 0.35;
    if (i < 4) syntheticStrike("L", zone, vel, i % 5);
    else syntheticStrike("R", zone, vel, i % 5);
  });
}

/* ---------------- recording ---------------- */

let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];

function toggleRecord(btn: HTMLButtonElement) {
  if (!started || !audio.ready) return;
  if (recorder) {
    recorder.stop();
    return;
  }
  const canvas = $<HTMLCanvasElement>("stage");
  const stream = new MediaStream();
  canvas.captureStream(30).getVideoTracks().forEach((t) => stream.addTrack(t));
  audio.recordingStream().getAudioTracks().forEach((t) => stream.addTrack(t));

  const types = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t));
  if (!mimeType) {
    setStatus("Recording not supported here", "bad");
    return;
  }

  chunks = [];
  recorder = new MediaRecorder(stream, { mimeType });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: mimeType });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `airkeys-${Date.now()}.webm`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    recorder = null;
    btn.setAttribute("aria-pressed", "false");
    btn.textContent = "Rec";
  };
  recorder.start();
  btn.setAttribute("aria-pressed", "true");
  btn.textContent = "Stop";
}

/* ---------------- UI ---------------- */

function wireUI() {
  const g = performer.genre;
  document.documentElement.style.setProperty("--glow", g.accent);
  document.documentElement.style.setProperty("--glow-dim", `${g.accent}33`);
  stage.setAccent([
    Math.round(g.grade[0] * 255),
    Math.round(g.grade[1] * 255),
    Math.round(g.grade[2] * 255),
  ]);

  $("begin").addEventListener("click", () => void begin());
  $("veil").addEventListener("click", () => void begin());

  $("cam-retry").addEventListener("click", (e) => {
    e.stopPropagation();
    $("cam-retry").hidden = true;
    void startCamera();
  });

  // Safari suspends the audio context behind our back (route changes, tab
  // switches, low power). Any tap is a licence to bring it back.
  for (const ev of ["pointerdown", "touchend"] as const) {
    window.addEventListener(ev, () => audio.resumeIfNeeded(), { passive: true });
  }

  const assist = $<HTMLInputElement>("assist");
  const assistOut = $("assist-out");
  const applyAssist = () => {
    const v = +assist.value;
    performer.assist = v / 100;
    performer.composer.assist = v / 100;
    assist.style.setProperty("--pct", `${v}%`);
    assistOut.textContent = `${v} · ${
      v > 88 ? "full" : v > 62 ? "guided" : v > 34 ? "loose" : v > 12 ? "sparse" : "purist"
    }`;
  };
  assist.addEventListener("input", applyAssist);
  applyAssist();

  const toggle = (id: string, initial: boolean, fn: (on: boolean) => void) => {
    const b = $<HTMLButtonElement>(id);
    let on = initial;
    b.setAttribute("aria-pressed", String(on));
    b.addEventListener("click", () => {
      on = !on;
      b.setAttribute("aria-pressed", String(on));
      fn(on);
    });
  };

  toggle("btn-particles", true, (on) => (stage.showParticles = on));
  toggle("btn-ribbon", true, (on) => {
    stage.showRibbon = on;
    $("ribbon-wrap").classList.toggle("hidden", !on);
    stage.resize();
  });
  toggle("btn-band", true, (on) => {
    performer.band = on;
    audio.setPad(on);
  });
  toggle("btn-camera", false, (on) => (stage.silhouette = on));

  $<HTMLButtonElement>("btn-rec").addEventListener("click", (e) =>
    toggleRecord(e.currentTarget as HTMLButtonElement)
  );

  $("btn-recal").addEventListener("click", () => {
    perception.L.recalibrate();
    perception.R.recalibrate();
    setStatus("Recalibrating — hold your hands still", "warn");
  });

  performer.onNote = (n) => {
    stage.pushNote({ midi: n.midi, vel: n.velocity, t: n.atPerfMs, hand: n.hand });
    const hp = perception[n.hand];
    const x = hp.present ? 1 - hp.zoneX : n.hand === "L" ? 0.32 : 0.68;
    const delay = Math.max(0, n.atPerfMs - performance.now());
    window.setTimeout(() => stage.burst(x, 0.66, n.velocity), delay);
  };

  performer.onChord = () => {
    $("r-chord").textContent = performer.composer.label();
  };
}

/* ---------------- loop ---------------- */

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  for (const side of ["L", "R"] as HandSide[]) {
    for (let i = 0; i < 5; i++) flash[side][i] *= Math.pow(0.0025, dt);
  }
  stage.draw(dt);
  requestAnimationFrame(frame);
}

function telemetry() {
  if (!started || !audio.ready) return;
  audio.syncClock();
  $("r-lat").textContent = String(Math.round(leadSeconds() * 1000));
  $("r-fps").textContent = cameraOn ? String(camera.achievedFps) : "—";
  $("r-load").textContent = `${Math.round(audio.sampler.progress * 100)}%`;

  if (!cameraOn) {
    setStatus(cameraError ? "No camera — pointer or A–L" : "Pointer mode", "warn");
    return;
  }
  const present = perception.L.present || perception.R.present;
  if (!present) setStatus("Show your hands to the camera", "warn");
  else if (camera.achievedFps < 22) setStatus(`Low frame rate (${camera.achievedFps} fps)`, "bad");
  else if (tracker.delegate === "CPU") setStatus("Tracking (CPU fallback)", "warn");
  else setStatus("Tracking good", "good");
}

/* ---------------- boot ---------------- */

function boot() {
  stage = new Stage($<HTMLCanvasElement>("stage"), $<HTMLCanvasElement>("ribbon"));
  wireUI();
  wireFallbackInput();
  window.setInterval(telemetry, 500);
  requestAnimationFrame(frame);

  $("r-key").textContent = `${["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"][
    performer.genre.tonic
  ]} minor`;
  $("r-bpm").textContent = String(performer.genre.bpm);
  $("r-chord").textContent = performer.composer.label();

  // Debug handle — used by the smoke tests and handy in the field for
  // reading the live latency budget out of the console.
  (window as unknown as { airkeys: unknown }).airkeys = {
    audio, performer, camera, tracker, perception, stage,
    leadSeconds,
    state: () => ({
      started,
      cameraOn,
      cameraError,
      trackerReady: tracker.ready,
      delegate: tracker.delegate,
      fps: camera.achievedFps,
      dropped: tracker.droppedFrames,
      inferenceMs: Math.round(tracker.inferenceSec * 1000),
      captureLatencyMs: Math.round(camera.captureLatencySec * 1000),
      captureTimeSupported: camera.captureTimeSupported,
      leadMs: Math.round(leadSeconds() * 1000),
      audioState: audio.ready ? audio.ctx.state : "off",
      outputLatencyMs: audio.ready ? Math.round(audio.outputLatency * 1000) : null,
      samplerProgress: audio.ready ? audio.sampler.progress : 0,
      notes: stage.ribbon.length,
      chord: performer.composer.label(),
    }),
  };

  document.addEventListener("visibilitychange", () => {
    if (!audio.ready) return;
    if (document.hidden) void audio.ctx.suspend();
    else void audio.ctx.resume().then(() => audio.syncClock(true));
  });
}

boot();
