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

/**
 * Refinements tried *after* permission is granted, best first. These go
 * through applyConstraints rather than a second getUserMedia, so a device
 * that cannot honour them just keeps the profile it already gave us.
 */
const CANDIDATES: MediaTrackConstraints[] = [
  { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60, min: 30 } },
  { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 60, min: 30 } },
  { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60, min: 24 } },
  { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  { width: { ideal: 640 }, height: { ideal: 480 } },
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
    // iOS Safari keys inline playback off the *attribute*, and refuses to
    // decode a stream into an element that was never attached to a document.
    this.video.setAttribute("playsinline", "");
    this.video.setAttribute("muted", "");
    this.video.setAttribute("autoplay", "");
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
    Object.assign(this.video.style, {
      position: "fixed",
      left: "-10000px",
      top: "0",
      width: "1px",
      height: "1px",
      opacity: "0",
      pointerEvents: "none",
    } satisfies Partial<CSSStyleDeclaration>);
  }

  /**
   * Open the camera.
   *
   * MUST be called synchronously from a user gesture. iOS Safari only shows
   * the permission prompt while the tap that led here still counts as user
   * activation; anything awaited first (sample downloads, model fetches)
   * spends that activation and getUserMedia then rejects with NotAllowedError
   * having never asked the user anything.
   *
   * For the same reason there is exactly one getUserMedia call, with the
   * loosest constraint that still selects the front camera. Walking a list of
   * increasingly specific constraint sets — as this used to — turns one prompt
   * into several attempts, and an OverconstrainedError on a phone that cannot
   * do 720p60 would previously read as "no camera".
   */
  async start(): Promise<void> {
    if (!globalThis.isSecureContext) {
      throw new Error("Camera needs a secure connection (https)");
    }
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) {
      throw new Error("This browser exposes no camera API");
    }
    // start() is re-entered by the retry button; never leave a stream behind.
    if (this.stream) this.stop();

    this.stream = await md.getUserMedia({ video: { facingMode: "user" }, audio: false });

    // Permission is granted; now negotiate upward for frame rate. A rejected
    // applyConstraints leaves the track on its current, working profile.
    const track = this.stream.getVideoTracks()[0];
    if (track) {
      for (const c of CANDIDATES) {
        try {
          await track.applyConstraints(c);
          break;
        } catch {
          /* device cannot do this profile — try the next, or keep the default */
        }
      }
    }

    if (!this.video.isConnected) document.body.appendChild(this.video);
    this.video.srcObject = this.stream;
    try {
      await this.video.play();
    } catch {
      // A muted stream should always be allowed to play; if the promise
      // rejects the frame loop below still recovers once videoWidth appears.
    }
    this.settings = track?.getSettings() ?? null;
    this.running = true;
    this.loop();
  }

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.video.remove();
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
  /** Safari only learned createImageBitmap's resize options in 17. */
  private canResizeBitmap = true;
  private scratch: HTMLCanvasElement | null = null;

  private grab(captureTMs: number) {
    if (this.grabbing || !this.onFrame) return;
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return;

    this.grabbing = true;
    const scale = Math.min(1, this.inferenceSize / Math.max(vw, vh));
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);

    const done = (bmp: ImageBitmap) => {
      this.grabbing = false;
      this.onFrame?.(bmp, captureTMs);
    };

    if (this.canResizeBitmap) {
      void createImageBitmap(this.video, {
        resizeWidth: w,
        resizeHeight: h,
        resizeQuality: "low",
      })
        .then(done)
        .catch(() => {
          // Downscale by hand from here on rather than shipping full frames
          // to the tracker, which would roughly triple inference cost.
          this.canResizeBitmap = false;
          this.grabbing = false;
        });
      return;
    }

    const cv = (this.scratch ??= document.createElement("canvas"));
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d");
    if (!ctx) {
      this.grabbing = false;
      return;
    }
    ctx.drawImage(this.video, 0, 0, w, h);
    void createImageBitmap(cv)
      .then(done)
      .catch(() => {
        this.grabbing = false;
      });
  }

  dispose() {
    cancelAnimationFrame(this.rafId);
    this.stop();
  }
}
