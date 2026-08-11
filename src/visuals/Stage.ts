/**
 * Stage renderer: camera, hands-as-light, particles, note ribbon.
 *
 * Visual feedback is emitted at the *predicted* note time, in lockstep with
 * the scheduled audio. Synchronised sight and sound reinforce the illusion of
 * zero latency; feedback that fired on the video frame instead would sit
 * ahead of the note and quietly destroy it.
 */

const CONNECTIONS: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const TIPS = [4, 8, 12, 16, 20];

export interface RenderHand {
  side: "L" | "R";
  /** 21 × 3 normalised landmarks in image space */
  normed: Float32Array;
  /** per-finger flash energy 0..1 */
  flash: number[];
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
}

export interface RibbonNote {
  midi: number;
  vel: number;
  t: number;
  hand: "L" | "R";
}

export class Stage {
  showParticles = true;
  showRibbon = true;
  silhouette = false;

  private ctx: CanvasRenderingContext2D;
  private rctx: CanvasRenderingContext2D | null;
  private w = 0;
  private h = 0;
  private rw = 0;
  private rh = 0;
  private dpr = 1;
  private particles: Particle[] = [];
  private glow: HTMLCanvasElement | null = null;
  private accent: [number, number, number] = [127, 178, 229];
  private reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  hands: RenderHand[] = [];
  ribbon: RibbonNote[] = [];
  video: HTMLVideoElement | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private ribbonCanvas: HTMLCanvasElement
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.rctx = ribbonCanvas.getContext("2d");
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  setAccent(rgb: [number, number, number]) {
    this.accent = rgb;
    this.buildGlow();
  }

  resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = this.canvas.getBoundingClientRect();
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const rr = this.ribbonCanvas.getBoundingClientRect();
    this.rw = rr.width;
    this.rh = rr.height;
    this.ribbonCanvas.width = Math.max(1, Math.round(rr.width * this.dpr));
    this.ribbonCanvas.height = Math.max(1, Math.round(rr.height * this.dpr));
    this.rctx?.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** Baking one sprite beats allocating a radial gradient per particle. */
  private buildGlow() {
    const [r, g, b] = this.accent;
    const S = 96;
    const c = document.createElement("canvas");
    c.width = c.height = S;
    const x = c.getContext("2d")!;
    const grd = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grd.addColorStop(0, `rgba(${r},${g},${b},1)`);
    grd.addColorStop(0.28, `rgba(${r},${g},${b},0.42)`);
    grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
    x.fillStyle = grd;
    x.fillRect(0, 0, S, S);
    this.glow = c;
  }

  private blit(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, alpha: number) {
    if (!this.glow) return;
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.drawImage(this.glow, x - size / 2, y - size / 2, size, size);
    ctx.globalAlpha = 1;
  }

  burst(nx: number, ny: number, strength = 1) {
    if (!this.showParticles || this.reduceMotion) return;
    const n = Math.round(8 + strength * 8);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (20 + Math.random() * 85) * (0.6 + strength * 0.6);
      this.particles.push({
        x: nx * this.w,
        y: ny * this.h,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 26,
        life: 1,
      });
    }
    if (this.particles.length > 380) this.particles.splice(0, this.particles.length - 380);
  }

  pushNote(n: RibbonNote) {
    this.ribbon.push(n);
    if (this.ribbon.length > 110) this.ribbon.shift();
  }

  draw(dt: number) {
    const ctx = this.ctx;
    const [ar, ag, ab] = this.accent;
    const { w, h } = this;

    ctx.fillStyle = "#04050A";
    ctx.fillRect(0, 0, w, h);

    // ---- camera, mirrored and graded. Raw webcam footage of yourself is
    // unflattering and breaks the spell; a treated field does not.
    if (this.video && !this.silhouette && this.video.videoWidth) {
      ctx.save();
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      ctx.globalAlpha = 0.75;
      const vw = this.video.videoWidth;
      const vh = this.video.videoHeight;
      const scale = Math.max(w / vw, h / vh);
      const dw = vw * scale;
      const dh = vh * scale;
      ctx.drawImage(this.video, (w - dw) / 2, (h - dh) / 2, dw, dh);
      ctx.restore();

      // Grade toward the accent, but gently — alpha, tint and scrim multiply
      // together, and stacking them hard leaves the player invisible.
      ctx.globalCompositeOperation = "multiply";
      const tint = (c: number) => Math.round(255 - (255 - c) * 0.45);
      ctx.fillStyle = `rgb(${tint(ar)},${tint(ag)},${tint(ab)})`;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "rgba(4,5,10,0.24)";
      ctx.fillRect(0, 0, w, h);
    }

    // ---- play-volume guide with register-zone ticks
    ctx.save();
    ctx.setLineDash([3, 8]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(${ar},${ag},${ab},0.20)`;
    ctx.beginPath();
    ctx.moveTo(w * 0.1, h * 0.72);
    ctx.lineTo(w * 0.9, h * 0.72);
    ctx.stroke();
    ctx.setLineDash([]);
    for (let i = 0; i <= 6; i++) {
      ctx.fillStyle = `rgba(${ar},${ag},${ab},0.16)`;
      ctx.fillRect(w * (0.1 + 0.8 * (i / 6)) - 0.5, h * 0.72 - 4, 1, 8);
    }
    ctx.restore();

    // ---- particles
    if (this.showParticles) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        p.life -= dt * 1.5;
        if (p.life <= 0) {
          this.particles.splice(i, 1);
          continue;
        }
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 42 * dt;
        p.vx *= 0.985;
        p.vy *= 0.985;
        this.blit(ctx, p.x, p.y, (1 + p.life * 2.6) * 8, p.life * p.life * 0.85);
      }
      ctx.restore();
    } else {
      this.particles.length = 0;
    }

    // ---- hands as light
    for (const hand of this.hands) this.drawHand(ctx, hand);

    // ---- vignette
    const vg = ctx.createRadialGradient(
      w * 0.5, h * 0.5, Math.min(w, h) * 0.28,
      w * 0.5, h * 0.5, Math.max(w, h) * 0.72
    );
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,0.7)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);

    if (this.showRibbon) this.drawRibbon();
  }

  private drawHand(ctx: CanvasRenderingContext2D, hand: RenderHand) {
    const [ar, ag, ab] = this.accent;
    const { w, h } = this;
    const L = hand.normed;
    // mirror for a selfie view
    const px = (i: number) => (1 - L[i * 3]) * w;
    const py = (i: number) => L[i * 3 + 1] * h;

    const fingerOf: Record<number, number> = {};
    [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]].forEach(
      (chain, f) => chain.forEach((idx) => (fingerOf[idx] = f))
    );

    ctx.save();
    ctx.lineCap = "round";
    for (const [a, b] of CONNECTIONS) {
      const f = fingerOf[b];
      const fl = f != null ? hand.flash[f] : 0;
      ctx.strokeStyle = `rgba(${ar},${ag},${ab},${0.16 + fl * 0.5})`;
      ctx.lineWidth = 1 + fl * 1.6;
      ctx.beginPath();
      ctx.moveTo(px(a), py(a));
      ctx.lineTo(px(b), py(b));
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 21; i++) {
      const isTip = TIPS.includes(i);
      const f = fingerOf[i];
      const fl = f != null ? hand.flash[f] : 0;
      const base = i === 0 ? 0.5 : isTip ? 0.6 : 0.34;
      const size = (i === 0 ? 30 : isTip ? 26 : 16) + fl * 30;
      this.blit(ctx, px(i), py(i), size, base + fl * 0.4);
      ctx.fillStyle = `rgba(255,255,255,${Math.min(0.95, base + fl * 0.4)})`;
      ctx.beginPath();
      ctx.arc(px(i), py(i), isTip ? 1.6 + fl * 2 : 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    ctx.save();
    ctx.font = "500 9px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillStyle = `rgba(${ar},${ag},${ab},0.45)`;
    ctx.textAlign = "center";
    ctx.fillText(hand.side === "L" ? "HARMONY" : "MELODY", px(0), py(0) + 22);
    ctx.restore();
  }

  private drawRibbon() {
    const ctx = this.rctx;
    if (!ctx) return;
    const [ar, ag, ab] = this.accent;
    const { rw, rh } = this;
    ctx.clearRect(0, 0, rw, rh);
    ctx.fillStyle = "#0A0C12";
    ctx.fillRect(0, 0, rw, rh);
    ctx.strokeStyle = "#1A1E2B";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (rh / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(rw, y);
      ctx.stroke();
    }

    const now = performance.now();
    const span = 6000;
    for (const n of this.ribbon) {
      const age = now - n.t;
      if (age > span || age < 0) continue;
      const x = rw - (age / span) * rw;
      const rel = Math.min(1, Math.max(0, (n.midi - 30) / 62));
      const y = rh - rel * (rh - 12) - 6;
      const a = (1 - age / span) * 0.9;
      const bw = 3 + n.vel * 7;
      ctx.fillStyle =
        n.hand === "L" ? `rgba(${ar},${ag},${ab},${a * 0.45})` : `rgba(255,255,255,${a * 0.55})`;
      ctx.fillRect(x - bw / 2, y - 2, bw, 3.5);
      if (n.hand === "R" && age < 400) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        this.blit(ctx, x, y, 28, a * 0.5);
        ctx.restore();
      }
    }

    ctx.fillStyle = `rgba(${ar},${ag},${ab},0.55)`;
    ctx.fillRect(rw - 1.5, 0, 1.5, rh);
  }
}
