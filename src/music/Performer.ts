/**
 * Turns predicted strikes into scheduled notes.
 *
 * This is the layer where "one gesture" can become "a musical phrase":
 * the left hand carries bass and harmony, the right hand melody, chord
 * gestures come from simultaneous fingers, and a firm directional strike can
 * earn a flourish. Everything is scheduled against the audio clock at the
 * predicted contact instant, so timing does not inherit the camera's jitter.
 */
import type { AudioEngine } from "../audio/AudioEngine";
import type { StrikeEvent } from "../perception/Perception";
import { Composer } from "./Composer";
import type { Genre } from "./theory";

export interface PlayedNote {
  midi: number;
  velocity: number;
  hand: "L" | "R";
  /** performance-clock ms at which it will sound, for the visuals */
  atPerfMs: number;
}

export class Performer {
  composer: Composer;
  assist = 0.75;
  band = true;
  private audio: AudioEngine;
  private lastZone = 0.5;
  private step = 0;
  private nextStepTime = 0;
  private timer: number | null = null;
  private pendingCluster: StrikeEvent[] = [];
  private clusterTimer: number | null = null;

  onNote: ((n: PlayedNote) => void) | null = null;
  onChord: (() => void) | null = null;

  constructor(audio: AudioEngine, genre: Genre) {
    this.audio = audio;
    this.composer = new Composer(genre);
  }

  get genre(): Genre {
    return this.composer.genre;
  }

  /* ---------------- transport ---------------- */

  start() {
    if (this.timer !== null) return;
    this.nextStepTime = this.audio.ctx.currentTime + 0.1;
    this.step = 0;
    this.timer = window.setInterval(() => this.tick(), 25);
  }

  stop() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  private stepDur(): number {
    return 60 / this.genre.bpm / 4; // 16th notes
  }

  private tick() {
    const ctx = this.audio.ctx;
    while (this.nextStepTime < ctx.currentTime + 0.12) {
      this.onStep(this.step, this.nextStepTime);
      const d = this.stepDur();
      const s = this.genre.swing;
      this.nextStepTime += s ? (this.step % 2 === 0 ? d * (1 + s) : d * (1 - s)) : d;
      this.step++;
    }
  }

  private onStep(step: number, when: number) {
    const g = this.genre;
    const perChord = 16 * g.barsPerChord;
    if (step % perChord !== 0) return;

    // Harmony advances on the grid, not on user input — otherwise it stutters
    // whenever the player pauses.
    if (step > 0) this.composer.advance();
    this.onChord?.();

    // automatic pedalling: sustain lifts on the chord change
    this.audio.damp("harmony", when);

    if (!this.band) return;
    const c = this.composer.current();
    const v = this.composer.voiceLead(c, 56);
    const barSec = (60 / g.bpm) * 4 * g.barsPerChord;
    this.audio.pad(v.map((m) => m + 12), when, barSec * 0.98, g.pad);
    this.emit(this.composer.bassNote(), 0.45, when, "L", "harmony", barSec * 0.9);
  }

  /* ---------------- strikes ---------------- */

  /**
   * Cluster near-simultaneous strikes so a chord gesture reads as a chord
   * rather than as a fast arpeggio. The window is short enough to stay
   * imperceptible.
   */
  strike(ev: StrikeEvent) {
    this.pendingCluster.push(ev);
    if (this.clusterTimer !== null) return;
    this.clusterTimer = window.setTimeout(() => {
      const batch = this.pendingCluster;
      this.pendingCluster = [];
      this.clusterTimer = null;
      this.flush(batch);
    }, 38);
  }

  private flush(batch: StrikeEvent[]) {
    if (!batch.length) return;
    for (const hand of ["L", "R"] as const) {
      const group = batch.filter((b) => b.hand === hand);
      if (!group.length) continue;
      const lead = group.reduce((a, b) => (b.velocity > a.velocity ? b : a));
      this.realise(lead, group.length);
    }
  }

  /** Snap toward the grid. Assist controls how much. */
  private quantize(t: number): number {
    const q = this.assist * 0.8;
    if (q < 0.05) return t;
    const d = this.stepDur();
    const grid = Math.round((t - this.nextStepTime) / d) * d + this.nextStepTime;
    return t + (grid - t) * q;
  }

  private emit(midi: number, vel: number, at: number, hand: "L" | "R", tag: string, ring: number) {
    this.audio.note(midi, vel, at, ring, tag);
    const perfMs = (at - this.audio.ctx.currentTime) * 1000 + performance.now();
    this.onNote?.({ midi, velocity: vel, hand, atPerfMs: perfMs });
  }

  private realise(ev: StrikeEvent, fingers: number) {
    const g = this.genre;
    const audioAt = this.audio.audioTimeFromPerf(ev.contactPerfMs) - this.audio.outputLatency;
    const at = this.quantize(Math.max(audioAt, this.audio.ctx.currentTime + 0.004));
    const ring = 1.5 + 9 * g.sustain;

    if (ev.hand === "L") {
      this.audio.damp("harmony", at);
      this.emit(this.composer.bassNote(), Math.min(1, ev.velocity), at, "L", "harmony", ring);
      if (fingers >= 2) {
        const v = this.composer.voiceLead(this.composer.current(), 55);
        v.forEach((m, i) =>
          this.emit(m, ev.velocity * (0.6 - i * 0.04), at + i * 0.006, "L", "harmony", ring)
        );
      }
      return;
    }

    const dir = ev.zoneX > this.lastZone + 0.035 ? 1 : ev.zoneX < this.lastZone - 0.035 ? -1 : 0;
    this.lastZone = ev.zoneX;
    const strong = ev.velocity > 0.6;

    if (fingers >= 3) {
      // chord gesture: density from finger count
      const v = this.composer.voiceLead(this.composer.current(), 68 + Math.round(ev.zoneX * 8));
      v.forEach((m, i) =>
        this.emit(m + 12, ev.velocity * (0.85 - i * 0.06), at + i * 0.008, "R", "mel", ring)
      );
      return;
    }

    const m = this.composer.nextMelody(dir, strong, ev.zoneX);
    this.emit(m, ev.velocity, at, "R", "mel", ring);

    // gesture amplification — a firm, directional strike earns a flourish
    if (dir !== 0 && ev.velocity > 0.55 && Math.random() < g.ornament * this.assist) {
      const n = 3 + Math.floor(Math.random() * 4);
      const sd = this.stepDur() * 0.5;
      for (let i = 1; i <= n; i++) {
        const mm = this.composer.nextMelody(dir, false, ev.zoneX);
        this.emit(mm, ev.velocity * (0.7 - i * 0.05), at + i * sd * (1 - i * 0.04), "R", "mel", 1.2);
      }
    }
  }
}
