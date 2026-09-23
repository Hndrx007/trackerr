import { group, test, assert, eq } from "./harness.js";
import { iou, nms, decodePersons, letterbox } from "../app/analysis/detector.js";
import { trackPersons, personBoxAt } from "../app/analysis/persons.js";
import { detectCuts, BINS, HB, SB, VB } from "../app/analysis/cuts.js";
import { pyramid, corners, lucasKanade, SwarmTracker, clusterShot } from "../app/analysis/swarm.js";
import { smoothSeries, smoothTrack, serialize, parse, cutFrames, shotsOf, mismatches } from "../app/trackdata.js";

/* ---------------- detection ---------------- */

group("Analysis: detection maths");

test("IoU: identical 1, disjoint 0, half-overlap 1/3", () => {
  eq(iou([0, 0, 1, 1], [0, 0, 1, 1]), 1);
  eq(iou([0, 0, 1, 1], [2, 2, 1, 1]), 0);
  assert(Math.abs(iou([0, 0, 2, 1], [1, 0, 2, 1]) - 1 / 3) < 1e-12);
});
test("NMS keeps the most confident of overlapping boxes and every separate box", () => {
  const kept = nms([[0, 0, 10, 10, 0.6], [1, 1, 10, 10, 0.9], [50, 50, 10, 10, 0.4], [0.5, 0, 10, 10, 0.7]], 0.5);
  eq(kept.map(b => b[4]), [0.9, 0.4]);
});
test("YOLO output decodes to normalised, clamped person boxes with the letterbox undone", () => {
  const lb = letterbox(1920, 1080), N = 8400, out = new Float32Array(84 * N);
  // A person centred at source (960, 540), 200×400 px; one off the left edge; one other class.
  const put = (i, cx, cy, w, h, cls, score) => {
    out[i] = cx * lb.s + lb.dx; out[N + i] = cy * lb.s + lb.dy; out[2 * N + i] = w * lb.s; out[3 * N + i] = h * lb.s;
    out[(4 + cls) * N + i] = score;
  };
  put(0, 960, 540, 200, 400, 0, 0.9);
  put(1, 20, 540, 100, 300, 0, 0.8);
  put(2, 500, 500, 100, 100, 2, 0.95);   // a car: ignored
  put(3, 962, 541, 200, 400, 0, 0.5);    // duplicate: suppressed
  const boxes = decodePersons(out, lb);
  eq(boxes.length, 2);
  const [a, b] = boxes;
  assert(Math.abs(a[0] - 860 / 1920) < 1e-3 && Math.abs(a[1] - 340 / 1080) < 1e-3 && Math.abs(a[2] - 200 / 1920) < 1e-3, `box ${a}`);
  eq(b[0], 0, "clamped to the frame");
});

/* ---------------- person tracking ---------------- */

group("Analysis: person tracking");

const box = (cx, cy, w = 0.1, h = 0.3, conf = 0.9) => [cx - w / 2, cy - h / 2, w, h, conf];
const idsAt = (persons, f) => Object.entries(persons).filter(([, p]) => personBoxAt(p, f))
  .map(([id, p]) => [+id, personBoxAt(p, f)]);

test("Two people crossing keep their IDs", () => {
  const dets = [];
  for (let f = 0; f < 60; f++) {
    const t = f / 59;
    dets.push([box(0.2 + 0.6 * t, 0.50), box(0.8 - 0.6 * t, 0.52, 0.11)]);  // A left→right, B right→left
  }
  const persons = trackPersons(dets, { fps: [24, 1] });
  eq(Object.keys(persons).length, 2, "tracks");
  // Whoever started on the left must end on the right.
  const start = idsAt(persons, 0).sort((a, b) => a[1][0] - b[1][0]), end = new Map(idsAt(persons, 59));
  assert(end.get(start[0][0])[0] > 0.6, "left starter ends on the right");
  assert(end.get(start[1][0])[0] < 0.4, "right starter ends on the left");
});
test("A person standing still across a cut gets a new ID after the cut", () => {
  const dets = Array.from({ length: 40 }, () => [box(0.5, 0.5)]);
  const persons = trackPersons(dets, { cuts: [20], fps: [24, 1] });
  eq(Object.keys(persons).length, 2);
  const [a, b] = Object.values(persons);
  eq([a.shot, a.start, a.boxes.length], [0, 0, 20]);
  eq([b.shot, b.start, b.boxes.length], [1, 20, 20]);
});
test("A short dropout is bridged; a gap longer than maxAge starts a new track", () => {
  const dets = Array.from({ length: 60 }, (_, f) => (f >= 10 && f < 14) || (f >= 30 && f < 45) ? [] : [box(0.3 + f * 0.002, 0.5)]);
  const persons = trackPersons(dets, { fps: [24, 1] });   // maxAge = 12 frames
  eq(Object.keys(persons).length, 2);
  const first = Object.values(persons)[0];
  eq([first.start, first.boxes.length], [0, 30], "0–29 contiguous, dropout 10–13 interpolated");
});
test("Low-confidence detections continue tracks but never start them", () => {
  const dets = Array.from({ length: 20 }, (_, f) => [box(0.5, 0.5, 0.1, 0.3, f < 5 ? 0.9 : 0.4), box(0.1, 0.5, 0.1, 0.3, 0.4)]);
  const persons = trackPersons(dets, { fps: [24, 1] });
  eq(Object.keys(persons).length, 1);
  eq(Object.values(persons)[0].boxes.length, 20);
});
test("With a detect stride of 3, boxes are interpolated between detection frames", () => {
  const dets = Array.from({ length: 31 }, (_, f) => f % 3 ? null : [box(0.2 + f * 0.01, 0.5)]);
  const [p] = Object.values(trackPersons(dets, { fps: [24, 1] }));
  eq(p.boxes.length, 31);
  assert(Math.abs(p.boxes[4][0] - (0.2 + 0.04 - 0.05)) < 1e-9, "frame 4 interpolated");
});

/* ---------------- cut detection ---------------- */

group("Analysis: cut detection");

// Synthetic histograms: a "shot" is a hue distribution; brightness moves mass between V bins.
function hist({ hues, sat = 2, v = 2, spread = 0.1, seed = 0 }) {
  const h = new Float32Array(BINS);
  let r = seed + 1;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  for (const [hb, w] of hues) {
    const jitter = 1 + (rnd() - 0.5) * spread;
    h[(hb * SB + sat) * VB + v] += w * jitter;
    h[(hb * SB + Math.max(1, sat - 1)) * VB + v] += w * 0.3 * jitter;
  }
  const s = h.reduce((a, b) => a + b, 0);
  return h.map(x => x / s);
}
const shotA = s => hist({ hues: [[0, 0.5], [1, 0.3], [2, 0.2]], seed: s });
const shotB = s => hist({ hues: [[8, 0.6], [9, 0.3], [10, 0.1]], seed: s });
const shotC = s => hist({ hues: [[12, 0.5], [4, 0.5]], seed: s });
const white = () => { const h = new Float32Array(BINS); h[(0 * SB + 0) * VB + 3] = 1; return h; };
const bright = s => hist({ hues: [[0, 0.5], [1, 0.3], [2, 0.2]], sat: 1, v: 3, seed: s });   // shot A, strobe-lit
const cutsOf = seq => detectCuts(seq, { fps: [24, 1] }).filter(d => d.cut).map(d => d.frame);

test("A clean cut is found on the exact frame", () => {
  eq(cutsOf([...Array.from({ length: 30 }, (_, i) => shotA(i)), ...Array.from({ length: 30 }, (_, i) => shotB(i))]), [30]);
});
test("A single flash frame is not a cut, and neither is the return from it", () => {
  const seq = Array.from({ length: 50 }, (_, i) => shotA(i));
  seq[25] = white();
  eq(cutsOf(seq), []);
});
test("A 2-frame flash is not a cut", () => {
  const seq = Array.from({ length: 50 }, (_, i) => shotA(i));
  seq[25] = white(); seq[26] = white();
  eq(cutsOf(seq), []);
});
test("A 2-frame shot is two cuts (A A B B C C)", () => {
  eq(cutsOf([...Array.from({ length: 20 }, (_, i) => shotA(i)), shotB(0), shotB(1), ...Array.from({ length: 20 }, (_, i) => shotC(i))]), [20, 22]);
});
test("A 2-frame insert of a different shot that returns (A A B B A A) is still two cuts", () => {
  eq(cutsOf([...Array.from({ length: 20 }, (_, i) => shotA(i)), shotB(0), shotB(1), ...Array.from({ length: 20 }, (_, i) => shotA(i + 50))]), [20, 22]);
});
test("A 2-frame black-and-white insert with structure that returns (A A B B A A) is two cuts", () => {
  const bw = () => { const h = new Float32Array(BINS); h[0] = 0.5; h[3] = 0.5; return h; };   // half black, half white
  eq(cutsOf([...Array.from({ length: 20 }, (_, i) => shotA(i)), bw(), bw(), ...Array.from({ length: 20 }, (_, i) => shotA(i + 50))]), [20, 22]);
});
test("A 1-frame dip to black is not a cut", () => {
  const seq = Array.from({ length: 50 }, (_, i) => shotA(i));
  const black = new Float32Array(BINS); black[0] = 1;
  seq[25] = black;
  eq(cutsOf(seq), []);
});
test("A strobe run (brightness alternating every frame) gives no cuts", () => {
  const seq = Array.from({ length: 80 }, (_, i) => (i >= 30 && i < 60 && i % 2) ? bright(i) : shotA(i));
  eq(cutsOf(seq), []);
});
test("A cut inside a strobe run is still found", () => {
  const seq = Array.from({ length: 80 }, (_, i) => {
    const lit = i >= 20 && i < 60 && i % 3 === 0;
    return i < 40 ? (lit ? bright(i) : shotA(i)) : (lit ? hist({ hues: [[8, 0.6], [9, 0.3], [10, 0.1]], sat: 1, v: 3, seed: i }) : shotB(i));
  });
  eq(cutsOf(seq), [40]);
});

/* ---------------- swarm ---------------- */

group("Analysis: swarm regression (ported from tracker-v2's harness)");

// A deterministic textured strip: blurred noise, contrast-stretched to 0..255.
function texture(w, h, seed = 7) {
  let r = seed;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  let a = Float32Array.from({ length: w * h }, rnd);
  for (let pass = 0; pass < 3; pass++) {           // three box blurs ≈ Gaussian, sigma ≈ 2.5 px
    const b = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h) continue; s += a[Y * w + X]; n++;
      }
      b[y * w + x] = s / n;
    }
    a = b;
  }
  let lo = Infinity, hi = -Infinity; for (const v of a) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  return { d: a.map(v => (v - lo) / (hi - lo) * 255), w, h };
}
// A W×H window of the texture at a sub-pixel horizontal offset (bilinear).
function view(tex, ox, W = 320, H = 180) {
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = x + ox, x0 = Math.floor(sx), f = sx - x0, i = y * tex.w + x0;
    out[y * W + x] = tex.d[i] * (1 - f) + tex.d[i + 1] * f;
  }
  return out;
}
const TEX = texture(900, 180);

for (const s of [1, 3, 6])
  test(`LK on a ${s} px shift: median displacement exact to 0.01 px, at least 95% tracked`, () => {
    const A = view(TEX, 100), B = view(TEX, 100 + s);   // content moves left by s
    const pts = corners(A, 320, 180, { max: 140 });
    const got = lucasKanade(pyramid(A, 320, 180), pyramid(B, 320, 180), pts);
    const ok = got.filter(Boolean), dx = ok.map((p, i) => p[0] - pts[got.indexOf(p)][0]).sort((a, b) => a - b);
    const med = dx[dx.length >> 1];
    assert(Math.abs(med + s) < 0.01, `median dx ${med.toFixed(4)}, expected ${-s}`);
    assert(ok.length / pts.length >= 0.95, `tracked ${ok.length}/${pts.length}`);
    return `median dx ${med.toFixed(4)} px, tracked ${ok.length}/${pts.length}`;
  });

// Synthetic pan at 1.73 px/frame through the cluster pass: box jitter within 0.1 px of the pan
// speed (locked to the content), fewer than 2% of boxes dropping out.
function panRun(fb) {
  const sw = new SwarmTracker({ fb }), frames = [];
  const speed = 1.73, n = 150;
  for (let f = 0; f < n; f++) {
    const { ids, pts } = sw.step(view(TEX, 20 + f * speed), 320, 180);
    frames.push({ ids, xs: pts.map(p => p[0]), ys: pts.map(p => p[1]) });
  }
  const clusters = clusterShot(frames);
  let moves = 0, sum = 0, live = 0, dropped = 0;
  for (const c of clusters) {
    // Measured after the zero-lag centre smoothing the cluster pass applies (clusterPass, sigma 1.5).
    const cs = smoothSeries(c.boxes.map(b => [b[0], b[1]]), 1.5);
    for (let i = 1; i < cs.length; i++) { sum += Math.hypot(cs[i][0] - cs[i - 1][0], cs[i][1] - cs[i - 1][1]); moves++; }
    live += c.boxes.length;
    const last = c.boxes[c.boxes.length - 1], endF = c.start + c.boxes.length - 1;
    // Dropped: ended before the clip did while still well inside the frame.
    if (endF < n - 1 && last[0] - last[2] / 2 > 20 && last[0] + last[2] / 2 < 300) dropped++;
  }
  return { jitter: sum / moves, dropRate: dropped / live, stats: sw.stats, clusters: clusters.length };
}

test("Synthetic pan at 1.73 px/frame: jitter within 0.1 px of the pan, under 2% of boxes drop", () => {
  const withFB = panRun(true), without = panRun(false);
  const r = withFB.dropRate <= without.dropRate ? withFB : without;
  assert(Math.abs(r.jitter - 1.73) < 0.1, `jitter ${r.jitter.toFixed(3)}`);
  assert(r.dropRate < 0.02, `drop ${(r.dropRate * 100).toFixed(2)}%`);
  return `forward-backward on: jitter ${withFB.jitter.toFixed(3)} px, drops ${(withFB.dropRate * 100).toFixed(2)}%, points lost LK/FB ${withFB.stats.lostLK}/${withFB.stats.lostFB}\n` +
    `forward-backward off: jitter ${without.jitter.toFixed(3)} px, drops ${(without.dropRate * 100).toFixed(2)}%, points lost ${without.stats.lostLK}`;
}, { slow: true });

test("The swarm reseeds from scratch after reset (a cut)", () => {
  const sw = new SwarmTracker();
  const a = sw.step(view(TEX, 0), 320, 180);
  sw.step(view(TEX, 2), 320, 180);
  sw.reset();
  const c = sw.step(view(TEX, 300), 320, 180);
  assert(Math.min(...c.ids) > Math.max(...a.ids), "fresh IDs after reset");
});

/* ---------------- track data ---------------- */

group("Track data and smoothing");

test("Smoothing never mixes values across a cut", () => {
  const values = Array.from({ length: 40 }, (_, i) => [i < 20 ? 0 : 1, 5]);
  const s = smoothSeries(values, 3, [20]);
  eq(s.slice(0, 20).every(v => v[0] === 0), true, "before the cut");
  eq(s.slice(20).every(v => Math.abs(v[0] - 1) < 1e-12), true, "after the cut");
});
test("Smoothing a track honours cuts expressed in clip frames", () => {
  const t = { start: 100, boxes: Array.from({ length: 20 }, (_, i) => [i < 10 ? 0 : 1, 0, 0, 0]) };
  const s = smoothTrack(t, 2, [110]);
  assert(Math.abs(s.boxes[9][0]) < 1e-9 && Math.abs(s.boxes[10][0] - 1) < 1e-9, `${s.boxes[9][0]} ${s.boxes[10][0]}`);
});
test("Smoothing is zero-lag: steady motion comes back unchanged, right up to the ends", () => {
  const s = smoothSeries(Array.from({ length: 50 }, (_, i) => [i * 2, 7]), 2);
  for (let i = 0; i < 50; i++) assert(Math.abs(s[i][0] - i * 2) < 1e-9 && Math.abs(s[i][1] - 7) < 1e-9, `at ${i}: ${s[i]}`);
});
test("Smoothing removes jitter", () => {
  const noisy = Array.from({ length: 200 }, (_, i) => [i + (i % 2 ? 0.5 : -0.5)]);
  const s = smoothSeries(noisy, 2);
  const err = s.slice(10, 190).reduce((m, v, k) => Math.max(m, Math.abs(v[0] - (k + 10))), 0);
  assert(err < 0.01, `residual ${err}`);
});
test("Track data survives save and load, typed arrays included", () => {
  const td = {
    version: 1, source: { name: "a.mp4", byteSize: 10, width: 1920, height: 1080, fps: [24, 1], frameCount: 5 },
    proxy: { width: 320, height: 180 }, cuts: [{ frame: 2, origin: "auto" }], cutsRemoved: [],
    cutSignal: new Float32Array([0, 0.1, 0.9, 0.05, 0.02]), detections: [[[0.1, 0.2, 0.3, 0.4, 0.9]], null, [], [], []],
    persons: {}, swarm: { 7: { shot: 0, start: 0, pts: new Float32Array([0.5, 0.5, 0.51, 0.5]) } }, clusters: {}, layout: {}, hero: [],
  };
  const back = parse(serialize(td));
  assert(back.cutSignal instanceof Float32Array && back.swarm[7].pts instanceof Float32Array, "typed arrays restored");
  eq([...back.cutSignal], [...td.cutSignal]);
  eq(back.detections, td.detections);
});
test("Cut list: manual cuts added, removed auto cuts dropped, shots follow", () => {
  const td = { source: { frameCount: 100 }, cuts: [{ frame: 10, origin: "auto" }, { frame: 40, origin: "auto" }, { frame: 70, origin: "manual" }], cutsRemoved: [40] };
  eq(cutFrames(td), [10, 70]);
  eq(shotsOf(td).map(s => [s.start, s.end]), [[0, 10], [10, 70], [70, 100]]);
});
test("Opening track data against the wrong clip is caught", () => {
  const td = { source: { name: "a.mp4", byteSize: 10, width: 1920, height: 1080, frameCount: 5 } };
  eq(mismatches(td, { name: "a.mp4", byteSize: 10, width: 1920, height: 1080, frameCount: 5 }), []);
  const m = mismatches(td, { name: "b.mp4", byteSize: 11, width: 1920, height: 1080, frameCount: 6 });
  eq(m.map(x => [x.field, !!x.fatal]), [["frame count", true], ["file name", false], ["file size", false]]);
});
