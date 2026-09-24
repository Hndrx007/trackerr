// The analysis pass, off the main thread. Decodes every frame once, in order, through the same
// frame iterator export uses, and makes three small proxies per frame:
//   640 px letterboxed RGB for person detection, 320 px luma for the swarm, 160 px for cuts.
// Pixels are only read back at these proxy sizes.
//
// Per frame, in this order: cut detection (3 frames of lookahead, so everything else runs 3
// frames behind the decoder), person detection, swarm points. A cut resets the swarm before it
// sees the first frame of the new shot. Person tracking runs afterwards, on the main thread, from
// the cached detections: it's cheap and has to re-run whenever a cut is edited.
import { openSource, frames } from "../media.js";
import { UserError } from "../errors.js";
import { hsvHistogram, CutDetector } from "./cuts.js";
import { createDetector, letterbox, INPUT } from "./detector.js";
import { SwarmTracker } from "./swarm.js";

let ac = null;
const post = (msg, transfer) => self.postMessage(msg, transfer ?? []);

self.onmessage = ({ data: m }) => {
  if (m.type === "start") {
    (m.options.range ? runRange(m) : run(m)).catch(e => post({
      type: e.name === "AbortError" ? "cancelled" : "error",
      message: e.message, user: e instanceof UserError, stack: e.stack,
    }));
  } else if (m.type === "cancel") ac?.abort();
};

async function run({ file, options: o }) {
  ac = new AbortController();
  const signal = ac.signal;
  const t0 = performance.now();
  const source = await openSource(file);
  try {
    const { width: W, height: H, fps, frameCount } = source.info;
    const lb = letterbox(W, H);

    let detector = null;
    if (o.detect !== false) {
      post({ type: "status", text: "Loading the person detector…" });
      detector = await createDetector({ modelUrl: o.modelUrl, lb, conf: o.conf ?? 0.35, prefer: o.prefer ?? "webgpu" });
      post({ type: "backend", backend: detector.backend, adapter: detector.adapter, warning: detector.warning });
    }
    const stride = o.detectStride ?? (detector?.backend === "wasm" ? 3 : 1);

    // Proxy canvases. GPU-backed 2D contexts: the draw scales on the GPU, then a small readback.
    const mk = (w, h) => { const c = new OffscreenCanvas(w, h).getContext("2d"); c.imageSmoothingQuality = "high"; return c; };
    const c640 = mk(INPUT, INPUT);
    // Landscape frames fill the 640 letterbox's width, so the 320 and 160 proxies are 2×2 and 4×4
    // box averages of the 640 image: one readback per frame instead of three.
    const derive = lb.dw === INPUT;
    const sw = 320, sh = derive ? lb.dh >> 1 : Math.max(16, Math.round(320 * H / W));
    const cw = 160, ch = derive ? lb.dh >> 2 : Math.max(8, Math.round(160 * H / W));
    const c320 = derive ? null : mk(sw, sh), c160 = derive ? null : mk(cw, ch);

    const manual = new Set(o.manualCuts ?? []), removed = new Set(o.removedCuts ?? []);
    const cut = new CutDetector({ fps, ...(o.cut ?? {}) });
    const swarm = new SwarmTracker(o.swarm ?? {});
    const cutSignal = new Float32Array(frameCount), cutThreshold = new Float32Array(frameCount);
    const cutFlash = new Uint8Array(frameCount);
    const autoCuts = [], detections = new Array(frameCount).fill(null);
    const tracks = new Map();   // point id → { shot, start, xy: number[] }
    const pending = [];
    let shot = 0, shotStart = 0, done = 0, lastPost = 0;
    let inflight = null;   // the detection running on the GPU while the CPU does the rest
    const detectTimes = [], ms = { proxies: 0, cuts: 0, swarm: 0 };   // time per stage, for the report
    const end = Math.min(frameCount, o.limit ?? frameCount);   // o.limit: benchmarking only

    const process = async (dec, entry) => {
      const f = dec.frame;
      cutSignal[f] = dec.d; cutThreshold[f] = dec.threshold; cutFlash[f] = dec.flash ? 1 : 0;
      if (dec.cut) autoCuts.push(f);
      const isCut = f > 0 && ((dec.cut && !removed.has(f)) || manual.has(f));
      if (isCut) { shot++; shotStart = f; swarm.reset(); }
      if (detector && (f - shotStart) % stride === 0) {
        if (inflight) detections[inflight.f] = await inflight.p;   // one run at a time per session
        const t = performance.now();
        inflight = { f, p: detector.detect(entry.rgba).then(r => { detectTimes.push(performance.now() - t); return r; }) };
      }
      let t1 = performance.now();
      const { ids, pts } = swarm.step(entry.luma, sw, sh);
      ms.swarm += performance.now() - t1;
      for (let i = 0; i < ids.length; i++) {
        let t = tracks.get(ids[i]);
        if (!t) tracks.set(ids[i], t = { shot, start: f, xy: [] });
        t.xy.push(pts[i][0] / sw, pts[i][1] / sh);
      }
      done = f + 1;
      const now = performance.now();
      if (now - lastPost > 250 || done === end) {
        lastPost = now;
        const rate = done / ((now - t0) / 1000);
        post({ type: "progress", done, total: end, fps: rate, eta: (end - done) / rate, shots: shot + 1 });
      }
    };

    for await (const { index, sample } of frames(source, { end, signal })) {
      let t1 = performance.now();
      c640.fillStyle = "rgb(114,114,114)";
      c640.fillRect(0, 0, INPUT, INPUT);
      sample.draw(c640, lb.dx, lb.dy, lb.dw, lb.dh);
      const rgba = c640.getImageData(0, 0, INPUT, INPUT).data;
      let luma, px160;
      if (derive) ({ luma, px160 } = downsample(rgba, lb.dy, sw, sh, cw, ch));
      else {
        sample.draw(c320, 0, 0, sw, sh);
        sample.draw(c160, 0, 0, cw, ch);
        const px320 = c320.getImageData(0, 0, sw, sh).data;
        luma = new Float32Array(sw * sh);
        for (let i = 0, j = 0; i < luma.length; i++, j += 4) luma[i] = px320[j] * 0.299 + px320[j + 1] * 0.587 + px320[j + 2] * 0.114;
        px160 = c160.getImageData(0, 0, cw, ch).data;
      }
      pending.push({ index, rgba, luma });
      let t2 = performance.now(); ms.proxies += t2 - t1;
      const decisions = cut.push(hsvHistogram(px160, cw, ch));
      ms.cuts += performance.now() - t2;
      for (const dec of decisions) {
        await process(dec, pending.shift());
        signal.throwIfAborted();
      }
    }
    for (const dec of cut.flush()) await process(dec, pending.shift());
    if (inflight) detections[inflight.f] = await inflight.p;

    const swarmOut = {}, transfer = [cutSignal.buffer, cutThreshold.buffer, cutFlash.buffer];
    for (const [id, t] of tracks) {
      const pts = Float32Array.from(t.xy);
      swarmOut[id] = { shot: t.shot, start: t.start, pts };
      transfer.push(pts.buffer);
    }
    const seconds = (performance.now() - t0) / 1000;
    post({
      type: "done",
      result: {
        proxy: { width: sw, height: sh },
        analysis: {
          backend: detector?.backend ?? "none", adapter: detector?.adapter ?? null, warning: detector?.warning ?? null,
          detectStride: stride, conf: o.conf ?? 0.35, seconds, fps: end / seconds, frames: end,
          detectMs: detectTimes.length ? [...detectTimes].sort((a, b) => a - b)[detectTimes.length >> 1] : null,
          detectFirstMs: detectTimes[0] ?? null,
          msPerFrame: Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, +(v / end).toFixed(2)])),
          cut: { ...cut.o }, swarm: { ...swarm.o }, date: new Date().toISOString(),
        },
        autoCuts, cutSignal, cutThreshold, cutFlash, detections, swarm: swarmOut,
      },
    }, transfer);
    await detector?.release();
  } finally {
    source.dispose();
  }
}

/**
 * Re-tracks swarm points over frames [a, b) with a given cut list, after the editor changed a
 * cut. Detections are cut-independent and stay cached, so this is the swarm alone: no detector,
 * no cut detection. Point IDs start at `idStart` so they never collide with the rest of the clip.
 */
async function runRange({ file, options: o }) {
  ac = new AbortController();
  const signal = ac.signal, t0 = performance.now();
  const source = await openSource(file);
  try {
    const { width: W, height: H } = source.info;
    const [a, b] = o.range;
    const sw = 320, sh = o.proxyHeight ?? Math.max(16, Math.round(320 * H / W));
    const c320 = new OffscreenCanvas(sw, sh).getContext("2d");
    c320.imageSmoothingQuality = "high";
    const cuts = new Set(o.cuts ?? []);
    const swarm = new SwarmTracker(o.swarm ?? {});
    swarm.nextId = o.idStart ?? 1;
    const tracks = new Map();
    let shot = o.shotStart ?? 0, lastPost = 0;
    for await (const { index: f, sample } of frames(source, { start: a, end: b, signal })) {
      if (f > a && cuts.has(f)) { shot++; swarm.reset(); }
      sample.draw(c320, 0, 0, sw, sh);
      const px = c320.getImageData(0, 0, sw, sh).data, luma = new Float32Array(sw * sh);
      for (let i = 0, j = 0; i < luma.length; i++, j += 4) luma[i] = px[j] * 0.299 + px[j + 1] * 0.587 + px[j + 2] * 0.114;
      const { ids, pts } = swarm.step(luma, sw, sh);
      for (let i = 0; i < ids.length; i++) {
        let t = tracks.get(ids[i]);
        if (!t) tracks.set(ids[i], t = { shot, start: f, xy: [] });
        t.xy.push(pts[i][0] / sw, pts[i][1] / sh);
      }
      const now = performance.now();
      if (now - lastPost > 250) { lastPost = now; post({ type: "progress", done: f - a + 1, total: b - a, fps: (f - a + 1) / ((now - t0) / 1000), eta: 0, shots: shot + 1 }); }
    }
    const out = {}, transfer = [];
    for (const [id, t] of tracks) { const pts = Float32Array.from(t.xy); out[id] = { shot: t.shot, start: t.start, pts }; transfer.push(pts.buffer); }
    post({ type: "done", result: { range: [a, b], swarm: out, seconds: (performance.now() - t0) / 1000 } }, transfer);
  } finally {
    source.dispose();
  }
}

// 640-wide letterboxed RGBA (picture rows from y0) → 320-wide luma (2×2 means) and 160-wide RGBA (4×4 means).
function downsample(rgba, y0, sw, sh, cw, ch) {
  const S = 640 * 4, luma = new Float32Array(sw * sh), px160 = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      const i = (y0 + 2 * y) * S + 8 * x;
      let r = 0, g = 0, b = 0;
      for (const o of [0, 4, S, S + 4]) { r += rgba[i + o]; g += rgba[i + o + 1]; b += rgba[i + o + 2]; }
      luma[y * sw + x] = (r * 0.299 + g * 0.587 + b * 0.114) / 4;
    }
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < 4; dy++) {
        let i = (y0 + 4 * y + dy) * S + 16 * x;
        for (let dx = 0; dx < 4; dx++, i += 4) { r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; }
      }
      const j = (y * cw + x) * 4;
      px160[j] = r / 16; px160[j + 1] = g / 16; px160[j + 2] = b / 16; px160[j + 3] = 255;
    }
  return { luma, px160 };
}
