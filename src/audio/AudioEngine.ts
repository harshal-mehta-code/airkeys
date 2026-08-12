/**
 * Audio graph, clock bridge and scheduling.
 *
 * Two things matter here beyond sound quality:
 *
 *  - Notes are scheduled against AudioContext.currentTime, never fired on a
 *    video frame. That is what removes timing jitter even though the input
 *    is a jittery 30–60 Hz camera stream.
 *  - ClockBridge maps performance.now() (vision) onto the audio clock. The
 *    two have different origins and drift; converting through one place
 *    keeps predicted onsets honest.
 *
 * The graph is native-node-first. AudioWorklet is documented to distort on
 * some mobile browsers, and Safari has a history of glitchy WebAudio output,
 * so v1 uses only native nodes.
 */
import { Sampler } from "./Sampler";

export class AudioEngine {
  ctx!: AudioContext;
  sampler!: Sampler;
  ready = false;

  private dry!: GainNode;
  private verbSend!: GainNode;
  private padBus!: GainNode;
  private outGain!: GainNode;
  private recDest?: MediaStreamAudioDestinationNode;
  private noise!: AudioBuffer;

  /** audioTime = perfMs / 1000 + clockOffset */
  private clockOffset = 0;
  private clockInit = false;

  private active: Array<{ g: GainNode[]; at: number; tag: string }> = [];
  private maxVoices = 24;

  async init(): Promise<void> {
    if (this.ready) return;

    // iOS routes plain WebAudio to the *ringer* channel, so the hardware
    // silent switch mutes the piano completely — the app looks alive and
    // makes no sound. Declaring a playback session moves it to the media
    // channel. Safari 16.4+; a no-op everywhere else.
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
    if (session) {
      try {
        session.type = "playback";
      } catch {
        /* older WebKit exposes the object read-only */
      }
    }

    const AC: typeof AudioContext =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC({ latencyHint: "interactive" });
    // Not awaited on purpose: on iOS a resume() issued outside a live user
    // gesture can stay pending indefinitely, and awaiting it here would hang
    // startup behind it. resumeIfNeeded() retries on later taps.
    if (this.ctx.state === "suspended") void this.ctx.resume();

    const ctx = this.ctx;

    // Nudge the context out of its "never produced audio" state on iOS.
    const unlock = ctx.createBufferSource();
    unlock.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    unlock.connect(ctx.destination);
    unlock.start(0);

    // ---- master chain
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 30; // sub-30 Hz rumble only steals headroom

    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -18;
    glue.knee.value = 26;
    glue.ratio.value = 2.4;
    glue.attack.value = 0.006;
    glue.release.value = 0.26;

    // safety ceiling — polyphonic piano peaks are brutal without one
    const ceiling = ctx.createDynamicsCompressor();
    ceiling.threshold.value = -2.5;
    ceiling.knee.value = 0;
    ceiling.ratio.value = 20;
    ceiling.attack.value = 0.002;
    ceiling.release.value = 0.12;

    this.outGain = ctx.createGain();
    this.outGain.gain.value = 0.9;

    hp.connect(glue);
    glue.connect(ceiling);
    ceiling.connect(this.outGain);
    this.outGain.connect(ctx.destination);

    // ---- reverb (procedural IR; no external asset to download)
    const conv = ctx.createConvolver();
    conv.buffer = this.makeIR(3.1, 2.2);
    const verbReturn = ctx.createGain();
    verbReturn.gain.value = 0.55;
    conv.connect(verbReturn);
    verbReturn.connect(hp);

    this.verbSend = ctx.createGain();
    this.verbSend.gain.value = 0.5;
    this.verbSend.connect(conv);

    this.dry = ctx.createGain();
    this.dry.gain.value = 0.9;
    this.dry.connect(hp);

    this.padBus = ctx.createGain();
    this.padBus.gain.value = 1;
    const padLp = ctx.createBiquadFilter();
    padLp.type = "lowpass";
    padLp.frequency.value = 1800;
    padLp.Q.value = 0.4;
    this.padBus.connect(padLp);
    padLp.connect(this.dry);
    padLp.connect(this.verbSend);

    this.noise = this.makeNoise(1);
    this.sampler = new Sampler(ctx);
    this.ready = true;
    this.syncClock(true);
  }

  /** Safari suspends the context on its own; call from any user gesture. */
  resumeIfNeeded() {
    if (!this.ready || this.ctx.state !== "suspended") return;
    void this.ctx.resume().then(() => this.syncClock(true));
  }

  /* ---------------- clock ---------------- */

  syncClock(force = false) {
    if (!this.ready) return;
    const offset = this.ctx.currentTime - performance.now() / 1000;
    if (!this.clockInit || force) {
      this.clockOffset = offset;
      this.clockInit = true;
    } else {
      // slow filter: the two clocks drift, but jumping the mapping around
      // would smear onset timing
      this.clockOffset += (offset - this.clockOffset) * 0.05;
    }
  }

  audioTimeFromPerf(perfMs: number): number {
    return perfMs / 1000 + this.clockOffset;
  }

  get outputLatency(): number {
    if (!this.ready) return 0.02;
    const ol = (this.ctx as AudioContext & { outputLatency?: number }).outputLatency;
    return (ol && ol > 0 ? ol : this.ctx.baseLatency) || 0.02;
  }

  /* ---------------- buffers ---------------- */

  private makeNoise(sec: number): AudioBuffer {
    const n = Math.floor(this.ctx.sampleRate * sec);
    const b = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  private makeIR(seconds: number, curve: number): AudioBuffer {
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * seconds);
    const buf = this.ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, curve);
      }
      // early reflections make it a room rather than a wash
      [0.011, 0.019, 0.031, 0.043, 0.062, 0.081].forEach((tp, k) => {
        const idx = Math.floor((tp + ch * 0.0035) * sr);
        if (idx < len) d[idx] += (k % 2 ? -1 : 1) * 0.42 / (k + 1);
      });
    }
    return buf;
  }

  /* ---------------- playback ---------------- */

  setReverb(amount: number) {
    if (!this.ready) return;
    this.verbSend.gain.setTargetAtTime(amount, this.ctx.currentTime, 0.4);
  }

  setPad(on: boolean) {
    if (!this.ready) return;
    this.padBus.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.25);
  }

  /**
   * @param when audio-clock time the note should sound
   * @param tag  grouping label, so a chord can be damped as a unit
   */
  note(midi: number, vel: number, when: number, ringSeconds: number, tag = "mel") {
    if (!this.ready) return;
    const at = Math.max(when, this.ctx.currentTime + 0.002);
    this.reap();
    if (this.active.length >= this.maxVoices) this.steal();

    const gains = this.sampler.play(midi, vel, at, this.dry, ringSeconds);
    if (gains) {
      // parallel send keeps the reverb tail even after the dry note is damped
      gains.forEach((g) => g.connect(this.verbSend));
      this.active.push({ g: gains, at, tag });
    } else {
      this.synthNote(midi, vel, at, ringSeconds);
    }
  }

  /** Fallback voice used only before the first samples finish decoding. */
  private synthNote(midi: number, vel: number, when: number, ring: number) {
    const ctx = this.ctx;
    const f0 = 440 * Math.pow(2, (midi - 69) / 12);
    if (f0 < 20 || f0 > 7000) return;
    const bright = 0.35 + 0.65 * vel;
    const nyq = ctx.sampleRate / 2;
    const decay = Math.min(ring, 1.5 + 9.5 * Math.exp(-(midi - 21) / 25));
    const nP = midi > 84 ? 3 : midi > 72 ? 4 : 6;
    const B = 0.00006 * Math.pow(2, (midi - 60) / 16);
    const peak = 0.2 * Math.pow(vel, 1.25);

    const vg = ctx.createGain();
    vg.connect(this.dry);
    vg.connect(this.verbSend);

    for (let n = 1; n <= nP; n++) {
      const f = f0 * n * Math.sqrt(1 + B * n * n);
      if (f > nyq * 0.9) break;
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f;
      o.detune.value = (Math.random() - 0.5) * 4;
      const a = (peak / Math.pow(n, 1.42)) * Math.pow(bright, n - 1);
      const d = decay / (1 + 0.62 * (n - 1));
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(a, when + 0.004);
      g.gain.exponentialRampToValueAtTime(Math.max(a * 0.0008, 1e-5), when + d);
      o.connect(g);
      g.connect(vg);
      o.start(when);
      o.stop(when + d + 0.05);
    }

    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = Math.min(nyq * 0.8, f0 * 4.5);
    const hg = ctx.createGain();
    const hAmp = 0.035 * Math.pow(vel, 1.9);
    hg.gain.setValueAtTime(hAmp, when);
    hg.gain.exponentialRampToValueAtTime(1e-4, when + 0.055);
    s.connect(bp);
    bp.connect(hg);
    hg.connect(vg);
    s.start(when, Math.random() * 0.4);
    s.stop(when + 0.09);
  }

  pad(midis: number[], when: number, dur: number, amt: number) {
    if (!this.ready || amt <= 0) return;
    const ctx = this.ctx;
    const at = Math.max(when, ctx.currentTime + 0.002);
    for (const m of midis) {
      const f = 440 * Math.pow(2, (m - 69) / 12);
      for (const k of [0, 1]) {
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = f;
        o.detune.value = k ? 7 : -7;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, at);
        g.gain.linearRampToValueAtTime(0.012 * amt, at + dur * 0.4);
        g.gain.linearRampToValueAtTime(0, at + dur);
        o.connect(g);
        g.connect(this.padBus);
        o.start(at);
        o.stop(at + dur + 0.05);
      }
    }
  }

  /** Automatic pedalling: lift the sustain on a tagged group. */
  damp(tag: string, at?: number, over = 0.45) {
    if (!this.ready) return;
    const t = at ?? this.ctx.currentTime;
    for (const v of this.active) {
      if (v.tag !== tag) continue;
      for (const g of v.g) {
        try {
          g.gain.cancelScheduledValues(t);
          g.gain.setValueAtTime(Math.max(g.gain.value, 0.0001), t);
          g.gain.exponentialRampToValueAtTime(0.0001, t + over);
        } catch {
          /* node already finished */
        }
      }
    }
  }

  private reap() {
    const now = this.ctx.currentTime;
    this.active = this.active.filter((v) => now - v.at < 14);
  }

  private steal() {
    const v = this.active.shift();
    if (!v) return;
    const t = this.ctx.currentTime;
    for (const g of v.g) {
      try {
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(Math.max(g.gain.value, 0.0001), t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      } catch {
        /* already gone */
      }
    }
  }

  /* ---------------- recording ---------------- */

  recordingStream(): MediaStream {
    if (!this.recDest) {
      this.recDest = this.ctx.createMediaStreamDestination();
      this.outGain.connect(this.recDest);
    }
    return this.recDest.stream;
  }
}
