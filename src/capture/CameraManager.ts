/**
 * Camera capture and the frame clock.
 *
 * Frame rate matters more than resolution here: it lowers latency and gives
 * the onset predictor more samples per keystroke, and hand tracking gains
 * nothing from 1080p. So we negotiate downward through fps-first options and
 * downscale hard before inference.
 *
 * Frames are driven by requestVideoFrameCallback rather than
 * requestAnimationFrame, because it fires once per *video* frame and carries
 * `captureTime` — a live, per-device measurement of capture latency, which is
 * exactly the quantity the predictor needs to cancel.
 */
import { RunningMedian } from "../perception/filters";

interface RVFCMeta {
  captureTime?: number;
  expectedDisplayTime: number;
  mediaTime: number;
  presentationTime: number;
}
type VideoWithRVFC = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: RVFCMeta) => void) => number;
};

const CANDIDATES: MediaTrackConstraints[] = [
  { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60, min: 30 } },
  { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 60, min: 30 } },
  { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60, min: 24 } },
  { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  { width: { ideal: 640 }, height: { ideal: 480 } },
  {},
];

/** When captureTime is unavailable, assume a typical webcam pipeline. */
const ASSUMED_CAPTURE_LATENCY_MS = 35;

export class CameraManager {
  video: HTMLVideoElement;
  stream: MediaStream | null = null;
  running = false;

  achievedFps = 0;
  settings: MediaTrackSettings | null = null;
  private captureLatency = new RunningMedian(31);
  private hasCaptureTime = false;
  private frameTimes: number[] = [];
  private rafId = 0;

  /** Long edge fed to the tracker. More pixels buys nothing and costs ms. */
  inferenceSize = 448;

  onFrame: ((bitmap: ImageBitmap, captureTMs: number) => void) | null = null;

  constructor() {
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
  }

  async start(): Promise<void> {
    let lastErr: unknown = null;
    for (const c of CANDIDATES) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", ...c },
          audio: false,
        });
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!this.stream) throw lastErr ?? new Error("No camera available");

    this.video.srcObject = this.stream;
    await this.video.play();
    this.settings = this.stream.getVideoTracks()[0]?.getSettings() ?? null;
    this.running = true;
    this.loop();
  }

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  /** Measured capture-side latency in seconds. */
  get captureLatencySec(): number {
    const v = this.captureLatency.value;
    return (v ?? ASSUMED_CAPTURE_LATENCY_MS) / 1000;
  }

  get captureTimeSupported(): boolean {
    return this.hasCaptureTime;
  }

  private loop() {
    const v = this.video as VideoWithRVFC;
    const useRVFC = typeof v.requestVideoFrameCallback === "function";

    const onFrame = (now: number, meta?: RVFCMeta) => {
      if (!this.running) return;

      // achieved fps, for the tracking-quality readout and device tiering
      this.frameTimes.push(now);
      while (this.frameTimes.length > 1 && now - this.frameTimes[0] > 1000) {
        this.frameTimes.shift();
      }
      this.achievedFps = this.frameTimes.length;

      let captureTMs: number;
      if (meta && typeof meta.captureTime === "number" && meta.captureTime > 0) {
        this.hasCaptureTime = true;
        this.captureLatency.push(now - meta.captureTime);
        captureTMs = meta.captureTime;
      } else {
        captureTMs = now - ASSUMED_CAPTURE_LATENCY_MS;
      }

      this.grab(captureTMs);

      if (useRVFC) v.requestVideoFrameCallback!(onFrame);
      else this.rafId = requestAnimationFrame((t) => onFrame(t));
    };

    if (useRVFC) v.requestVideoFrameCallback!(onFrame);
    else this.rafId = requestAnimationFrame((t) => onFrame(t));
  }

  private grabbing = false;
  private grab(captureTMs: number) {
    if (this.grabbing || !this.onFrame) return;
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return;

    this.grabbing = true;
    const scale = Math.min(1, this.inferenceSize / Math.max(vw, vh));
    void createImageBitmap(this.video, {
      resizeWidth: Math.round(vw * scale),
      resizeHeight: Math.round(vh * scale),
      resizeQuality: "low",
    })
      .then((bmp) => {
        this.grabbing = false;
        this.onFrame?.(bmp, captureTMs);
      })
      .catch(() => {
        this.grabbing = false;
      });
  }

  dispose() {
    cancelAnimationFrame(this.rafId);
    this.stop();
  }
}
