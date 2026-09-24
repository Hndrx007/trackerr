// YOLOv8n person detection: letterbox pre-processing, [1, 84, 8400] decoding, NMS.
// Boxes are [x, y, w, h, conf] normalised to 0..1 of the source frame, top-left origin.

import { UserError } from "../errors.js";

export const INPUT = 640;
const ANCHORS = 8400;

/** Letterbox geometry: the frame scaled to fit `size`², centred, grey padding. */
export function letterbox(width, height, size = INPUT) {
  const s = Math.min(size / width, size / height);
  const dw = Math.round(width * s), dh = Math.round(height * s);
  return { size, s, dw, dh, dx: (size - dw) >> 1, dy: (size - dh) >> 1, width, height };
}

/** RGBA (size² × 4) → NCHW float32 in 0..1. */
export function toNCHW(rgba, size = INPUT, out = new Float32Array(3 * size * size)) {
  const P = size * size;
  for (let i = 0, j = 0; i < P; i++, j += 4) {
    out[i] = rgba[j] / 255; out[i + P] = rgba[j + 1] / 255; out[i + 2 * P] = rgba[j + 2] / 255;
  }
  return out;
}

export function iou(a, b) {
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

/** Greedy NMS by confidence (index 4). Returns the kept boxes, highest confidence first. */
export function nms(boxes, threshold = 0.5) {
  const sorted = [...boxes].sort((a, b) => b[4] - a[4]);
  const keep = [];
  for (const b of sorted) if (keep.every(k => iou(k, b) < threshold)) keep.push(b);
  return keep;
}

/**
 * Decodes YOLOv8 output (channel-major [1, 84, 8400]: cx, cy, w, h, then 80 class scores)
 * into person boxes normalised to the source frame, clamped to it.
 */
export function decodePersons(out, lb, { conf = 0.35, iouThreshold = 0.5 } = {}) {
  const N = ANCHORS, cand = [];
  for (let i = 0; i < N; i++) {
    const c = out[4 * N + i];                 // class 0 = person
    if (c < conf) continue;
    const cx = (out[i] - lb.dx) / lb.s, cy = (out[N + i] - lb.dy) / lb.s;
    const w = out[2 * N + i] / lb.s, h = out[3 * N + i] / lb.s;
    let x0 = Math.max(0, (cx - w / 2) / lb.width), y0 = Math.max(0, (cy - h / 2) / lb.height);
    let x1 = Math.min(1, (cx + w / 2) / lb.width), y1 = Math.min(1, (cy + h / 2) / lb.height);
    if (x1 <= x0 || y1 <= y0) continue;
    cand.push([x0, y0, x1 - x0, y1 - y0, c]);
  }
  return nms(cand, iouThreshold);
}

/**
 * Loads the model on WebGPU, falling back to WASM. Returns
 * { backend, adapter, warning, detect(rgba640) → Promise<boxes>, release() }.
 */
export async function createDetector({ modelUrl, lb, conf = 0.35, iouThreshold = 0.5, prefer = "webgpu" }) {
  const { ort, ORT_DIST } = await import("../lib-ort.js");
  ort.env.wasm.wasmPaths = ORT_DIST;
  ort.env.webgpu.powerPreference = "high-performance";
  ort.env.logLevel = "error";
  const res = await fetch(modelUrl);
  if (!res.ok) throw new UserError(`Couldn't load the person detector (models/yolov8n.onnx, HTTP ${res.status}). Check the file is in the project's models folder, then reload the page.`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  let session = null, backend = null, warning = null, adapter = null;
  if (prefer === "webgpu" && self.navigator?.gpu) {
    try {
      session = await ort.InferenceSession.create(bytes, { executionProviders: ["webgpu"], graphOptimizationLevel: "all" });
      backend = "webgpu";
      const i = ort.env.webgpu.adapter?.info;
      adapter = i ? [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(" · ") : null;
    } catch (e) {
      warning = `WebGPU detection failed to start (${e.message}), so detection runs on the CPU, about 5× slower.`;
    }
  }
  if (!session) {
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;
    session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    backend = "wasm";
    warning ??= "WebGPU isn't available, so person detection runs on the CPU, about 5× slower. Use Chrome or Edge with hardware acceleration on.";
  }
  const inName = session.inputNames[0], outName = session.outputNames[0];
  const input = new Float32Array(3 * INPUT * INPUT);
  return {
    backend, adapter, warning,
    async detect(rgba) {
      toNCHW(rgba, INPUT, input);
      const r = await session.run({ [inName]: new ort.Tensor("float32", input, [1, 3, INPUT, INPUT]) });
      const t = r[outName];
      try { return decodePersons(t.data, lb, { conf, iouThreshold }); } finally { t.dispose?.(); }
    },
    release: () => session.release(),
  };
}
