// onnxruntime-web, pinned. Kept apart from lib.js so pages that don't detect don't load it.
export * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.webgpu.min.mjs";
export const ORT_DIST = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
