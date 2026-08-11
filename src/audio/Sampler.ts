/**
 * Progressive multi-sampled piano.
 *
 * Source: Salamander Grand Piano V3 (Yamaha C5), CC BY 3.0, Alexander Holm.
 * Samples are every minor third across A1–A6 in three velocity layers, so a
 * played note is at most one semitone from a real sample — transparent on
 * piano, unlike the wide pitch shifts cheaper samplers use.
 *
 * Loading is staged so the first note happens fast:
 *   1. mid register of the mid layer  (blocking — ~12 files)
 *   2. rest of the mid layer          (background)
 *   3. loud then soft layers          (background)
 * Until a sample exists the sampler falls back to the nearest one it has,
 * and below that to a synthesised voice, so the app is never silent.
 */

export const SAMPLE_STEP = 3;
export const LOWEST_SAMPLE = 33; // A1
export const HIGHEST_SAMPLE = 93; // A6

/** Salamander velocity layers we ship, and where each sits on a 0..1 scale. */
const LAYERS = [
  { v: 4, center: 0.22 },
  { v: 9, center: 0.56 },
  { v: 14, center: 0.88 },
];

const MID_LAYER = 9;

function sampleMidis(): number[] {
  const out: number[] = [];
  for (let m = LOWEST_SAMPLE; m <= HIGHEST_SAMPLE; m += SAMPLE_STEP) out.push(m);
  return out;
}

export class Sampler {
  private ctx: AudioContext;
  private buffers = new Map<string, AudioBuffer>();
  private inflight = new Set<string>();
  /** 0..1, for the loading indicator */
  progress = 0;
  private totalFiles = LAYERS.length * sampleMidis().length;
  private loadedFiles = 0;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  private key(layer: number, midi: number) {
    return `${layer}:${midi}`;
  }

  private url(layer: number, midi: number) {
    return `${import.meta.env.BASE_URL}audio/piano/v${layer}/${midi}.mp3`;
  }

  private async fetchOne(layer: number, midi: number): Promise<void> {
    const k = this.key(layer, midi);
    if (this.buffers.has(k) || this.inflight.has(k)) return;
    this.inflight.add(k);
    try {
      const res = await fetch(this.url(layer, midi));
      if (!res.ok) throw new Error(`${res.status}`);
      const bytes = await res.arrayBuffer();
      const buf = await this.ctx.decodeAudioData(bytes);
      this.buffers.set(k, buf);
      this.loadedFiles++;
      this.progress = this.loadedFiles / this.totalFiles;
    } catch {
      // a missing sample is survivable: nearest-sample fallback covers it
    } finally {
      this.inflight.delete(k);
    }
  }

  /** Blocking stage — enough to play immediately. */
  async loadCore(): Promise<void> {
    const core = sampleMidis().filter((m) => m >= 48 && m <= 81);
    await Promise.all(core.map((m) => this.fetchOne(MID_LAYER, m)));
  }

  /** Everything else, in the background. Never awaited by the UI. */
  async loadRest(): Promise<void> {
    const all = sampleMidis();
    const rest = all.filter((m) => m < 48 || m > 81);
    for (const m of rest) await this.fetchOne(MID_LAYER, m);
    for (const layer of [14, 4]) {
      for (const m of all) await this.fetchOne(layer, m);
    }
  }

  get ready(): boolean {
    return this.buffers.size > 0;
  }

  /** Nearest sampled pitch we actually hold for this layer. */
  private nearest(layer: number, midi: number): number | null {
    let best: number | null = null;
    let bestD = Infinity;
    for (let m = LOWEST_SAMPLE; m <= HIGHEST_SAMPLE; m += SAMPLE_STEP) {
      if (!this.buffers.has(this.key(layer, m))) continue;
      const d = Math.abs(m - midi);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  /**
   * Velocity layer weights. Crossfading between adjacent layers avoids the
   * audible timbre steps that give cheap sample libraries away.
   */
  private layerWeights(vel: number): Array<{ layer: number; w: number }> {
    const v = Math.min(1, Math.max(0, vel));
    const out: Array<{ layer: number; w: number }> = [];
    for (let i = 0; i < LAYERS.length; i++) {
      const a = LAYERS[i];
      let w = 0;
      if (i === 0 && v <= a.center) w = 1;
      else if (i === LAYERS.length - 1 && v >= a.center) w = 1;
      else {
        const prev = LAYERS[i - 1];
        const next = LAYERS[i + 1];
        if (prev && v > prev.center && v <= a.center) {
          w = (v - prev.center) / (a.center - prev.center);
        } else if (next && v > a.center && v < next.center) {
          w = 1 - (v - a.center) / (next.center - a.center);
        }
      }
      if (w > 0.02) out.push({ layer: a.v, w });
    }
    return out.length ? out : [{ layer: MID_LAYER, w: 1 }];
  }

  /**
   * Schedule a note. Returns the gain nodes created so the caller can damp
   * them later (automatic pedalling), or null if no sample was available.
   */
  play(
    midi: number,
    vel: number,
    when: number,
    dest: AudioNode,
    ringSeconds: number
  ): GainNode[] | null {
    const weights = this.layerWeights(vel);
    const made: GainNode[] = [];

    for (const { layer, w } of weights) {
      let src = this.nearest(layer, midi);
      // if this layer hasn't loaded yet, borrow the mid layer
      if (src == null) src = this.nearest(MID_LAYER, midi);
      if (src == null) continue;
      const buf =
        this.buffers.get(this.key(layer, src)) ?? this.buffers.get(this.key(MID_LAYER, src));
      if (!buf) continue;

      const node = this.ctx.createBufferSource();
      node.buffer = buf;
      node.playbackRate.value = Math.pow(2, (midi - src) / 12);

      const g = this.ctx.createGain();
      const amp = w * Math.pow(Math.min(1, Math.max(0.02, vel)), 0.8);
      g.gain.setValueAtTime(amp, when);

      // natural decay is in the sample; this only bounds how long it rings
      const ring = Math.max(0.35, ringSeconds);
      g.gain.setValueAtTime(amp, when + ring);
      g.gain.exponentialRampToValueAtTime(0.0001, when + ring + 0.7);

      node.connect(g);
      g.connect(dest);
      node.start(when);
      node.stop(when + ring + 0.8);
      node.onended = () => {
        try {
          g.disconnect();
        } catch {
          /* already torn down */
        }
      };
      made.push(g);
    }

    return made.length ? made : null;
  }
}
