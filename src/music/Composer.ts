/**
 * The composition engine.
 *
 * Principle: the player controls the SHAPE (contour, dynamics, rhythm,
 * density, register, hand role); this module controls the SPELLING. Every
 * note it can emit is correct in the current key and chord, which is what
 * makes a mistracked finger sound like an embellishment rather than a
 * mistake.
 *
 * Deliberately dependency-free — no audio, no DOM, no tracking — so it can
 * be unit tested and driven from a mouse, a keyboard or a test fixture.
 */
import { QUAL, SCALES, NOTE_NAMES, type Genre } from "./theory";

export interface Chord {
  root: number;
  quality: string;
  ivals: number[];
}

export class Composer {
  genre: Genre;
  chordIdx = 0;
  voicing: number[] = [];
  lastMel: number;
  contour: 1 | -1 | 0 = 1;
  motif: number[] = [];
  assist = 0.75;

  constructor(genre: Genre) {
    this.genre = genre;
    this.lastMel = genre.melOct * 12 + genre.tonic;
  }

  setGenre(g: Genre) {
    this.genre = g;
    this.chordIdx = 0;
    this.voicing = [];
    this.lastMel = g.melOct * 12 + g.tonic;
  }

  chord(i: number): Chord {
    const g = this.genre;
    const p = g.prog[((i % g.prog.length) + g.prog.length) % g.prog.length];
    return { root: (g.tonic + p[0]) % 12, quality: p[1], ivals: QUAL[p[1]] };
  }

  current(): Chord {
    return this.chord(this.chordIdx);
  }

  chordTones(c: Chord): number[] {
    return c.ivals.map((x) => (c.root + x) % 12);
  }

  scaleTones(): number[] {
    const g = this.genre;
    return SCALES[g.scale].map((x) => (g.tonic + x) % 12);
  }

  label(): string {
    const c = this.current();
    const map: Record<string, string> = {
      min: "m", maj: "", min7: "m7", maj7: "maj7", dom7: "7",
      min9: "m9", maj9: "maj9", sus2: "sus2", sus4: "sus4", add9: "add9",
    };
    return NOTE_NAMES[c.root] + (map[c.quality] ?? c.quality);
  }

  /**
   * Choose a voicing for `c` that moves as little as possible from the
   * previous one. Smooth voice leading is most of the difference between
   * "chords are playing" and "a pianist is playing".
   */
  voiceLead(c: Chord, center: number): number[] {
    const style = this.genre.voicing;
    let pcs: number[];

    if (style === "quartal") {
      const sc = SCALES[this.genre.scale];
      const rel = (((c.root - this.genre.tonic) % 12) + 12) % 12;
      let base = sc.indexOf(rel);
      if (base < 0) base = 0;
      const degAt = (d: number) => sc[(base + d) % sc.length];
      const steps = [0, 3, 6];
      // a diatonic fourth is a tritone at some scale positions; nudge rather
      // than voice it
      for (let i = 1; i < steps.length; i++) {
        const lo = degAt(steps[i - 1]);
        const hi = degAt(steps[i]);
        if ((((hi - lo) % 12) + 12) % 12 === 6) steps[i] += 1;
      }
      pcs = steps.map((d) => (this.genre.tonic + degAt(d)) % 12);
    } else {
      let sel = c.ivals.slice();
      if (style === "rootless" && sel.length > 3) sel = sel.slice(1);
      pcs = sel.map((x) => (c.root + x) % 12);
    }

    const prev = this.voicing.length ? this.voicing : null;

    let out = pcs.map((pc, i) => {
      let best: number | null = null;
      let bestCost = Infinity;
      for (let oct = -2; oct <= 2; oct++) {
        const m = pc + 12 * (Math.round((center - pc) / 12) + oct);
        if (m < 34 || m > 80) continue;
        const ref = prev && prev[i] != null ? prev[i] : center;
        let cost = Math.abs(m - ref);
        // shape preference is a nudge; it must not out-vote voice leading or
        // the voicing climbs the keyboard chord by chord
        if (style === "spread") cost += Math.abs(m - (center + i * 4)) * 0.16;
        if (style === "open") cost += Math.abs(m - (center + i * 6)) * 0.16;
        if (m < 48 && i > 0) cost += 6;
        if (cost < bestCost) {
          bestCost = cost;
          best = m;
        }
      }
      return best == null ? pc + 48 : best;
    });

    out.sort((a, b) => a - b);

    for (let i = 1; i < out.length; i++) {
      // displace by octave, never by a fixed interval — adding +7 invents
      // notes that aren't in the chord
      while (out[i] <= out[i - 1]) out[i] += 12;
      if (out[i - 1] < 48 && out[i] - out[i - 1] < 7) out[i] += 12;
    }
    out = out.filter((m) => m <= 88);
    while (out.length > 3 && out[out.length - 1] - out[0] > 17) out.pop();
    while (out.length > 1 && out[out.length - 1] - out[0] > 17 && out[0] + 12 < out[1]) {
      out[0] += 12;
    }
    if (!out.length) out = [pcs[0] + 48];

    this.voicing = out;
    return out;
  }

  /**
   * Melody note. `dir` is the player's gesture contour, `zone` their
   * horizontal position (register), `strong` whether it lands accented.
   * Chord tones on strong beats guarantee consonance; passing tones
   * elsewhere keep the line moving.
   */
  nextMelody(dir: number, strong: boolean, zone: number): number {
    const sc = this.scaleTones();
    const ct = this.chordTones(this.current());
    const pool = strong ? ct : sc;
    const target = this.genre.melOct * 12 + this.genre.tonic + Math.round(zone * 19) - 7;

    let base = this.lastMel + dir * (2 + Math.floor(Math.random() * 3));
    base = base * 0.55 + target * 0.45;

    let best: number | null = null;
    let bestD = Infinity;
    for (let m = Math.round(base) - 9; m <= Math.round(base) + 9; m++) {
      if (m < 55 || m > 93) continue;
      if (!pool.includes(((m % 12) + 12) % 12)) continue;
      const d = Math.abs(m - base) + (dir !== 0 && Math.sign(m - this.lastMel) !== dir ? 5 : 0);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    if (best == null) best = this.lastMel;
    this.lastMel = best;
    this.motif.push(best);
    if (this.motif.length > 16) this.motif.shift();
    return best;
  }

  bassNote(): number {
    return this.current().root + 12 * this.genre.bassOct + 12;
  }

  advance() {
    // voicing is deliberately NOT cleared — carrying it across the chord
    // change is what makes voiceLead smooth
    this.chordIdx++;
  }
}
