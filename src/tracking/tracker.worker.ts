/// <reference lib="webworker" />
/**
 * Hand tracking worker.
 *
 * Inference is 5–40 ms depending on device and delegate. On the main thread
 * that would stall the render loop and the note scheduler, so it lives here,
 * following Google's own web sample pattern: model supplied as a buffer,
 * frames in as ImageBitmap, results posted back, bitmap closed.
 */
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

interface InitMsg {
  type: "init";
  wasmPath: string;
  modelPath: string;
  numHands: number;
}
interface FrameMsg {
  type: "frame";
  bitmap: ImageBitmap;
  stamp: number;
  captureTMs: number;
}
type InMsg = InitMsg | FrameMsg;

let landmarker: HandLandmarker | null = null;
let delegateUsed: "GPU" | "CPU" = "GPU";

async function init(msg: InitMsg) {
  const fileset = await FilesetResolver.forVisionTasks(msg.wasmPath);
  const modelBuffer = new Uint8Array(await (await fetch(msg.modelPath)).arrayBuffer());

  const build = (delegate: "GPU" | "CPU") =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: modelBuffer, delegate },
      runningMode: "VIDEO",
      numHands: msg.numHands,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

  try {
    landmarker = await build("GPU");
    delegateUsed = "GPU";
  } catch {
    landmarker = await build("CPU");
    delegateUsed = "CPU";
  }
  (self as DedicatedWorkerGlobalScope).postMessage({ type: "ready", delegate: delegateUsed });
}

function handle(msg: FrameMsg) {
  if (!landmarker) {
    msg.bitmap.close();
    return;
  }
  const t0 = performance.now();
  let res;
  try {
    res = landmarker.detectForVideo(msg.bitmap, msg.stamp);
  } catch {
    msg.bitmap.close();
    (self as DedicatedWorkerGlobalScope).postMessage({ type: "miss" });
    return;
  }
  const inferMs = performance.now() - t0;
  msg.bitmap.close();

  const hands: Array<{
    side: string;
    score: number;
    world: Float32Array;
    normed: Float32Array;
  }> = [];

  const n = res.landmarks?.length ?? 0;
  for (let i = 0; i < n; i++) {
    const lm = res.landmarks[i];
    const wl = res.worldLandmarks[i];
    const handed = res.handednesses?.[i]?.[0];
    const normed = new Float32Array(63);
    const world = new Float32Array(63);
    for (let k = 0; k < 21; k++) {
      normed[k * 3] = lm[k].x;
      normed[k * 3 + 1] = lm[k].y;
      normed[k * 3 + 2] = lm[k].z;
      world[k * 3] = wl[k].x;
      world[k * 3 + 1] = wl[k].y;
      world[k * 3 + 2] = wl[k].z;
    }
    hands.push({
      side: handed?.categoryName ?? "Right",
      score: handed?.score ?? 0.5,
      world,
      normed,
    });
  }

  const transfers = hands.flatMap((h) => [h.world.buffer, h.normed.buffer]);
  (self as DedicatedWorkerGlobalScope).postMessage(
    { type: "result", hands, inferMs, captureTMs: msg.captureTMs },
    transfers
  );
}

self.onmessage = (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  if (msg.type === "init") {
    void init(msg);
  } else if (msg.type === "frame") {
    handle(msg);
  }
};
