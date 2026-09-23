// Track data: everything analysis produces, as plain data. Coordinates are normalised to
// 0..1 of the source frame. Saved as JSON with typed arrays packed as base64, so reopening a
// project never needs re-analysis.
//
// {
//   version: 1,
//   source: { name, byteSize, width, height, fps: [num, den], frameCount },
//   proxy: { width, height },                       // swarm analysis space (320 px wide)
//   analysis: { backend, adapter, detectStride, ... }, // how it was made
//   cuts: [{ frame, origin: "auto" | "manual" }],    // first frame of a new shot; 0 implicit
//   cutsRemoved: [frame, ...],                       // auto cuts the editor deleted (survive re-analysis)
//   cutSignal: Float32Array, cutThreshold: Float32Array,
//   detections: [[[x, y, w, h, conf], ...] | null, ...],  // null = frame not run (detect stride)
//   persons: { [id]: { shot, start, boxes: [[x, y, w, h], ...] } },
//   swarm:   { [id]: { shot, start, pts: Float32Array [x0, y0, x1, y1, ...] } },
//   clusters:{ [id]: { shot, level, start, boxes: [[x, y, w, h], ...] } },   // rebuildable
//   layout:  {},                                     // composition pass output (M3)
//   hero:    [{ start, end, personId }],             // M4
// }

export const TRACKDATA_VERSION = 1;

/* ---------------- shots ---------------- */

/** Effective cut frames: auto and manual cuts, minus the ones the editor removed. */
export function cutFrames(td) {
  const removed = new Set(td.cutsRemoved ?? []);
  return [...new Set(td.cuts.filter(c => c.origin === "manual" || !removed.has(c.frame)).map(c => c.frame))]
    .filter(f => f > 0 && f < td.source.frameCount).sort((a, b) => a - b);
}

/** Shots as [{ shot, start, end }] (end exclusive). */
export function shotsOf(td) {
  const starts = [0, ...cutFrames(td)];
  return starts.map((start, i) => ({ shot: i, start, end: i + 1 < starts.length ? starts[i + 1] : td.source.frameCount }));
}

/** Index of the shot containing `frame` (binary search over sorted starts). */
export function shotAt(shots, frame) {
  let lo = 0, hi = shots.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (shots[m].start <= frame) lo = m; else hi = m - 1; }
  return lo;
}

/* ---------------- zero-lag smoothing ---------------- */

/**
 * Zero-lag smoothing of a series of vectors (e.g. boxes), sigma in frames: a Gaussian-weighted
 * local linear fit, evaluated at each frame (Savitzky-Golay style). In the middle of a series it
 * equals a centred Gaussian; at the ends, where a Gaussian would pull a moving box back towards
 * the interior, the linear term keeps steady motion exact. Never reaches across a `break` (an
 * index where a new segment starts, e.g. a cut).
 */
export function smoothSeries(values, sigma, breaks = []) {
  if (!(sigma > 0) || values.length < 3) return values.map(v => v.slice());
  const r = Math.ceil(sigma * 3), kern = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const bounds = [0, ...breaks.filter(b => b > 0 && b < values.length).sort((a, b) => a - b), values.length];
  const out = new Array(values.length), dims = values[0].length;
  for (let s = 0; s + 1 < bounds.length; s++) {
    const a = bounds[s], b = bounds[s + 1];
    for (let i = a; i < b; i++) {
      const lo = Math.max(a, i - r), hi = Math.min(b - 1, i + r);
      // Weighted least squares of v ≈ c0 + c1·(k − i); the value at i is c0.
      let S0 = 0, S1 = 0, S2 = 0;
      for (let k = lo; k <= hi; k++) { const w = kern[k - i + r], t = k - i; S0 += w; S1 += w * t; S2 += w * t * t; }
      const det = S0 * S2 - S1 * S1;
      const acc = new Array(dims).fill(0);
      for (let k = lo; k <= hi; k++) {
        const w = kern[k - i + r], t = k - i;
        const coef = det > 1e-12 ? w * (S2 - S1 * t) / det : w / S0;
        for (let d = 0; d < dims; d++) acc[d] += values[k][d] * coef;
      }
      out[i] = acc;
    }
  }
  return out;
}

/** Smooths a track's per-frame boxes. The track lives inside one shot, but cuts are honoured anyway. */
export function smoothTrack(track, sigma, cuts = []) {
  const breaks = cuts.map(c => c - track.start).filter(b => b > 0 && b < track.boxes.length);
  return { ...track, boxes: smoothSeries(track.boxes, sigma, breaks) };
}

/* ---------------- save / load ---------------- */

const TYPED = { f32: Float32Array, f64: Float64Array, i32: Int32Array, u32: Uint32Array, u8: Uint8Array };
const tagOf = v => v instanceof Float32Array ? "f32" : v instanceof Float64Array ? "f64" : v instanceof Int32Array ? "i32"
  : v instanceof Uint32Array ? "u32" : v instanceof Uint8Array ? "u8" : null;

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64) {
  const s = atob(b64), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** JSON text with typed arrays packed as { "$t": "f32", "b64": "…" }. Little-endian, as every target platform is. */
export function serialize(td) {
  return JSON.stringify(td, (k, v) => {
    const t = tagOf(v);
    return t ? { $t: t, b64: toBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) } : v;
  });
}

export function parse(text) {
  const td = JSON.parse(text, (k, v) => {
    if (v && typeof v === "object" && typeof v.$t === "string" && typeof v.b64 === "string" && TYPED[v.$t]) {
      const bytes = fromBase64(v.b64);
      return new TYPED[v.$t](bytes.buffer, 0, bytes.byteLength / TYPED[v.$t].BYTES_PER_ELEMENT);
    }
    return v;
  });
  if (!td || td.version !== TRACKDATA_VERSION || !td.source || !Array.isArray(td.cuts))
    throw new Error("unrecognised track data");
  td.cutsRemoved ??= [];
  td.layout ??= {};
  td.hero ??= [];
  td.clusters ??= {};
  return td;
}

/** Differences between the track data's source and the open clip. Frame count mismatches make it unusable. */
export function mismatches(td, info) {
  const out = [];
  const s = td.source;
  if (s.frameCount !== info.frameCount) out.push({ field: "frame count", saved: s.frameCount, open: info.frameCount, fatal: true });
  if (s.width !== info.width || s.height !== info.height) out.push({ field: "frame size", saved: `${s.width}×${s.height}`, open: `${info.width}×${info.height}`, fatal: true });
  if (s.name !== info.name) out.push({ field: "file name", saved: s.name, open: info.name });
  if (s.byteSize !== info.byteSize) out.push({ field: "file size", saved: s.byteSize, open: info.byteSize });
  return out;
}

export const sourceOf = info => ({
  name: info.name, byteSize: info.byteSize, width: info.width, height: info.height,
  fps: info.fps.slice(), frameCount: info.frameCount,
});
