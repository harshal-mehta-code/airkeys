/**
 * Main-thread side of the tracking worker.
 *
 * Applies backpressure by dropping frames rather than queueing them: a stale
 * frame is worse than no frame, because it poisons the velocity estimates the
 * onset predictor depends on.
 */
import { RunningMedian } from "../perception/filters";

export interface TrackedHand {
  side: string;
  score: number;
  world: Float32Array;
  normed: Float32Array;
}

export interface TrackResult {
  hands: TrackedHand[];
  captureTMs: number;
}

export class TrackerClient {
  private worker: Worker;
  private busy = false;
  private stamp = 0;
  private inferMedian = new RunningMedian(21);

  ready = false;
  delegate: "GPU" | "CPU" | "?" = "?";
  droppedFrames = 0;
  onResult: ((r: TrackResult) => void) | null = null;

  constructor() {
    // classic worker on purpose — see the note in vite.config.ts
    this.worker = new Worker(new URL("./tracker.worker.ts", import.meta.url));
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "ready") {
        this.ready = true;
        this.delegate = m.delegate;
      } else if (m.type === "result") {
        this.busy = false;
        this.inferMedian.push(m.inferMs);
        this.onResult?.({ hands: m.hands, captureTMs: m.captureTMs });
      } else if (m.type === "miss") {
        this.busy = false;
      }
    };
  }

  init(numHands = 2) {
    const base = import.meta.env.BASE_URL;
    this.worker.postMessage({
      type: "init",
      wasmPath: `${base}mediapipe/wasm`,
      modelPath: `${base}models/hand_landmarker.task`,
      numHands,
    });
  }

  /** Measured inference cost, seconds. Part of the latency we must cancel. */
  get inferenceSec(): number {
    return (this.inferMedian.value ?? 12) / 1000;
  }

  get canAccept(): boolean {
    return this.ready && !this.busy;
  }

  send(bitmap: ImageBitmap, captureTMs: number) {
    if (!this.canAccept) {
      bitmap.close();
      this.droppedFrames++;
      return;
    }
    this.busy = true;
    // MediaPipe requires monotonically increasing timestamps
    this.stamp += 1000 / 90;
    this.worker.postMessage(
      { type: "frame", bitmap, stamp: Math.round(this.stamp), captureTMs },
      [bitmap]
    );
  }

  dispose() {
    this.worker.terminate();
  }
}
