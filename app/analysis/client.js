// Main-thread side of analysis: runs the worker and assembles track data, then derives what can
// be rebuilt cheaply from it (person tracks from cached detections, the cluster pass).
import { sourceOf, cutFrames, TRACKDATA_VERSION } from "../trackdata.js";
import { trackPersons } from "./persons.js";
import { clusterPass } from "./swarm.js";
import { UserError } from "../errors.js";

export const MODEL_URL = new URL("../../models/yolov8n.onnx", import.meta.url).href;

/**
 * Analyses `file`. Manual cuts and removed auto cuts from `previous` track data survive.
 * @returns {Promise<object>} track data
 */
export function analyse(file, info, { previous = null, options = {}, onProgress, onBackend, onStatus, signal } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    const finish = () => worker.terminate();
    const manualCuts = previous?.cuts.filter(c => c.origin === "manual").map(c => c.frame) ?? [];
    const removedCuts = previous?.cutsRemoved ?? [];
    signal?.addEventListener("abort", () => worker.postMessage({ type: "cancel" }), { once: true });
    worker.onerror = e => { finish(); reject(new Error(`Analysis worker failed: ${e.message}`)); };
    worker.onmessage = ({ data: m }) => {
      if (m.type === "progress") onProgress?.(m);
      else if (m.type === "backend") onBackend?.(m);
      else if (m.type === "status") onStatus?.(m.text);
      else if (m.type === "cancelled") { finish(); reject(new DOMException("Analysis cancelled", "AbortError")); }
      else if (m.type === "error") {
        finish();
        const e = m.user ? new UserError(m.message) : new Error(m.message);
        if (m.stack) e.stack = m.stack;
        reject(e);
      } else if (m.type === "done") {
        finish();
        const r = m.result;
        const td = {
          version: TRACKDATA_VERSION,
          source: sourceOf(info),
          proxy: r.proxy,
          analysis: r.analysis,
          cuts: [...r.autoCuts.map(frame => ({ frame, origin: "auto" })), ...manualCuts.map(frame => ({ frame, origin: "manual" }))]
            .sort((a, b) => a.frame - b.frame),
          cutsRemoved: removedCuts.filter(f => r.autoCuts.includes(f)),
          cutSignal: r.cutSignal, cutThreshold: r.cutThreshold, cutFlash: r.cutFlash,
          detections: r.detections,
          persons: {}, swarm: r.swarm, clusters: {}, layout: {}, hero: previous?.hero ?? [],
        };
        rebuildDerived(td);
        resolve(td);
      }
    };
    worker.postMessage({ type: "start", file, options: { modelUrl: MODEL_URL, manualCuts, removedCuts, ...options } });
  });
}

/** Re-derives person tracks and cluster candidates. Milliseconds; run after any cut edit. */
export function rebuildDerived(td) {
  td.persons = trackPersons(td.detections, { cuts: cutFrames(td), fps: td.source.fps });
  td.clusters = clusterPass(td);
  return td;
}
