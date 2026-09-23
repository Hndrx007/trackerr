import { shotsOf, smoothSeries } from "../trackdata.js";

// Swarm points: the part of tracker-v2 that measured well, rebuilt.
//
//  1. Persistent point set, seeded with Shi-Tomasi corners (5×5 structure tensor, minimum
//     eigenvalue, quality 0.012 of the peak, greedy 9 px minimum distance). Seed once, then track.
//  2. Pyramidal Lucas-Kanade: 3 levels, 17×17 window, up to 6 iterations, coarse to fine, flow
//     guess starting at zero. Unlike v2, the template and its gradients are sampled bilinearly
//     at the point's sub-pixel position; v2 rounded them, which costs up to half a pixel once
//     points stop sitting on integer coordinates.
//  3. Top up, don't replace: below 75% of the target, or every 12 frames, detect new corners
//     away from existing points and append them with fresh IDs.
//  Optional forward-backward check: track back and drop points that don't return within 1 px.
//
// Then the cluster pass (steps 4-7), run offline over the stored point tracks: single-linkage
// clusters at three distances, identity by member-set Jaccard overlap, boxes from the cluster
// extent snapped to a size ladder, and size hysteresis. All pixel values are in 320 px space.

export const SWARM_DEFAULTS = {
  target: 140, quality: 0.012, minDist: 9, win: 8, levels: 3, iters: 6,
  // Forward-backward check: measured on the synthetic pan it dropped no points and left the box
  // drop rate unchanged (0.31% either way), so per the spec it stays off. Kept as an option.
  topUpBelow: 0.75, topUpEvery: 12, fb: false, fbMax: 1,
};

/* ---------------- image pyramid with gradients ---------------- */

function level(d, w, h) {
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gx[i] = (d[i + 1] - d[i - 1]) * 0.5;
      gy[i] = (d[i + w] - d[i - w]) * 0.5;
    }
  return { d, gx, gy, w, h };
}

export function pyramid(gray, w, h, levels = 3) {
  const out = [level(gray, w, h)];
  for (let l = 1; l < levels; l++) {
    const p = out[l - 1], nw = p.w >> 1, nh = p.h >> 1;
    if (nw < 16 || nh < 16) break;
    const d = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++)
      for (let x = 0; x < nw; x++) {
        const a = 2 * y * p.w + 2 * x;
        d[y * nw + x] = (p.d[a] + p.d[a + 1] + p.d[a + p.w] + p.d[a + p.w + 1]) * 0.25;
      }
    out.push(level(d, nw, nh));
  }
  return out;
}

// Bilinear sample with the border replicated outward, so windows near the edge still work
// (the same idea as OpenCV's border handling). h is implied by the array length.
const bil = (a, w, x, y) => {
  const h = a.length / w;
  x = x < 0 ? 0 : x > w - 1.001 ? w - 1.001 : x;
  y = y < 0 ? 0 : y > h - 1.001 ? h - 1.001 : y;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
  return a[i] * (1 - fx) * (1 - fy) + a[i + 1] * fx * (1 - fy) + a[i + w] * (1 - fx) * fy + a[i + w + 1] * fx * fy;
};

/* ---------------- Shi-Tomasi corners ---------------- */

/**
 * Corners in `gray`, strongest first, at least minDist apart and at least minDist from `existing`.
 * Returns [[x, y], ...].
 */
export function corners(gray, w, h, { max = 140, quality = 0.012, minDist = 9, existing = [] } = {}) {
  if (max <= 0) return [];
  const Ix = new Float32Array(w * h), Iy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      Ix[i] = (gray[i + 1] - gray[i - 1]) * 0.5;
      Iy[i] = (gray[i + w] - gray[i - w]) * 0.5;
    }
  // Structure tensor summed over 5×5 via separable box sums.
  const R = 2, xx = new Float32Array(w * h), xy = new Float32Array(w * h), yy = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) { xx[i] = Ix[i] * Ix[i]; xy[i] = Ix[i] * Iy[i]; yy[i] = Iy[i] * Iy[i]; }
  const box = a => {
    const t = new Float32Array(w * h), o = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = R; x < w - R; x++) {
      let s = 0; for (let k = -R; k <= R; k++) s += a[y * w + x + k]; t[y * w + x] = s;
    }
    for (let y = R; y < h - R; y++) for (let x = 0; x < w; x++) {
      let s = 0; for (let k = -R; k <= R; k++) s += t[(y + k) * w + x]; o[y * w + x] = s;
    }
    return o;
  };
  const A = box(xx), B = box(xy), C = box(yy);
  const score = new Float32Array(w * h);
  let peak = 0;
  const m = R + 1;
  for (let y = m; y < h - m; y++)
    for (let x = m; x < w - m; x++) {
      const i = y * w + x, a = A[i], b = B[i], c = C[i];
      const s = (a + c) * 0.5 - Math.sqrt(Math.max(0, ((a - c) * 0.5) ** 2 + b * b));
      score[i] = s;
      if (s > peak) peak = s;
    }
  if (peak <= 0) return [];
  const thr = peak * quality, cand = [];
  for (let y = m; y < h - m; y++)
    for (let x = m; x < w - m; x++) {
      const s = score[y * w + x];
      // local maximum in 3×3 keeps one candidate per corner instead of a blob
      if (s > thr && s >= score[y * w + x - 1] && s >= score[y * w + x + 1] &&
          s >= score[(y - 1) * w + x] && s >= score[(y + 1) * w + x]) cand.push(s, x, y);
    }
  const order = Array.from({ length: cand.length / 3 }, (_, k) => k).sort((p, q) => cand[q * 3] - cand[p * 3] || p - q);
  // Greedy minimum-distance suppression on a grid of minDist cells (exact distances inside).
  const cell = minDist, gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const grid = Array.from({ length: gw * gh }, () => []);
  const put = (x, y) => grid[((y / cell) | 0) * gw + ((x / cell) | 0)].push(x, y);
  const near = (x, y) => {
    const gx = (x / cell) | 0, gy = (y / cell) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = gx + dx, ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const g = grid[ny * gw + nx];
      for (let k = 0; k < g.length; k += 2) if (Math.hypot(g[k] - x, g[k + 1] - y) < minDist) return true;
    }
    return false;
  };
  for (const [x, y] of existing) if (x >= 0 && y >= 0 && x < w && y < h) put(x, y);
  const pts = [];
  for (const k of order) {
    if (pts.length >= max) break;
    const x = cand[k * 3 + 1], y = cand[k * 3 + 2];
    if (near(x, y)) continue;
    put(x, y);
    pts.push([x, y]);
  }
  return pts;
}

/* ---------------- pyramidal Lucas-Kanade ---------------- */

// Samples an n×n window centred on (cx, cy) bilinearly into `out`. Every pixel of the window
// shares the same fractional offset, so the four weights are computed once; windows fully inside
// the image take a fast path with no bounds checks. Near the border the edge is replicated.
function sampleWindow(a, w, h, cx, cy, win, out) {
  const x0f = cx - win, y0f = cy - win, n = 2 * win + 1;
  if (x0f >= 0 && y0f >= 0 && x0f + n < w - 1 && y0f + n < h - 1) {
    const ix = x0f | 0, iy = y0f | 0, fx = x0f - ix, fy = y0f - iy;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
    let k = 0;
    for (let y = 0; y < n; y++) {
      let i = (iy + y) * w + ix;
      for (let x = 0; x < n; x++, i++) out[k++] = a[i] * w00 + a[i + 1] * w10 + a[i + w] * w01 + a[i + w + 1] * w11;
    }
  } else {
    let k = 0;
    for (let y = -win; y <= win; y++) for (let x = -win; x <= win; x++) out[k++] = bil(a, w, cx + x, cy + y);
  }
}

/**
 * Tracks points from pyramid A to pyramid B. Returns an array of [x, y] or null (lost).
 */
export function lucasKanade(A, B, pts, { win = 8, iters = 6, minEig = 1e-2 } = {}) {
  const top = Math.min(A.length, B.length) - 1, n = 2 * win + 1, area = n * n;
  const T = new Float32Array(area), GX = new Float32Array(area), GY = new Float32Array(area), I = new Float32Array(area);
  const out = new Array(pts.length);
  for (let p = 0; p < pts.length; p++) {
    let gx = 0, gy = 0, ok = true;
    for (let L = top; L >= 0 && ok; L--) {
      const a = A[L], b = B[L], sc = 1 / (1 << L);
      const px = pts[p][0] * sc, py = pts[p][1] * sc;
      // Template and gradients at the sub-pixel point.
      sampleWindow(a.d, a.w, a.h, px, py, win, T);
      sampleWindow(a.gx, a.w, a.h, px, py, win, GX);
      sampleWindow(a.gy, a.w, a.h, px, py, win, GY);
      let sxx = 0, sxy = 0, syy = 0;
      for (let k = 0; k < area; k++) { const ix = GX[k], iy = GY[k]; sxx += ix * ix; sxy += ix * iy; syy += iy * iy; }
      const det = sxx * syy - sxy * sxy;
      const eig = ((sxx + syy) - Math.sqrt((sxx - syy) ** 2 + 4 * sxy * sxy)) / (2 * area);
      if (eig < minEig || det <= 0) { ok = false; break; }
      let vx = gx, vy = gy;
      for (let it = 0; it < iters; it++) {
        sampleWindow(b.d, b.w, b.h, px + vx, py + vy, win, I);
        let ex = 0, ey = 0;
        for (let k = 0; k < area; k++) { const e = T[k] - I[k]; ex += e * GX[k]; ey += e * GY[k]; }
        const ux = (syy * ex - sxy * ey) / det, uy = (sxx * ey - sxy * ex) / det;
        vx += ux; vy += uy;
        if (ux * ux + uy * uy < 1e-6) break;
      }
      gx = vx; gy = vy;
      if (L > 0) { gx *= 2; gy *= 2; }
    }
    if (!ok) { out[p] = null; continue; }
    const nx = pts[p][0] + gx, ny = pts[p][1] + gy;
    const w0 = A[0].w, h0 = A[0].h;
    out[p] = nx < 0 || ny < 0 || nx > w0 - 1 || ny > h0 - 1 ? null : [nx, ny];   // left the frame
  }
  return out;
}

/* ---------------- the persistent point set ---------------- */

export class SwarmTracker {
  constructor(opts = {}) {
    this.o = { ...SWARM_DEFAULTS, ...opts };
    this.nextId = 1;
    this.reset();
  }

  /** Clears every point. Called at a cut; the next frame reseeds fully. */
  reset() {
    this.pts = []; this.ids = []; this.prev = null; this.sinceSeed = 0;
    this.stats = { tracked: 0, lostLK: 0, lostFB: 0 };
  }

  /** Advances one frame of 320 px luma. Returns { ids, pts } after tracking and top-up. */
  step(gray, w, h) {
    const o = this.o, pyr = pyramid(gray, w, h, o.levels);
    if (this.prev && this.pts.length) {
      const fwd = lucasKanade(this.prev, pyr, this.pts, o);
      let back = null;
      if (o.fb) {
        const moved = fwd.map(p => p ?? [-1e9, -1e9]);
        back = lucasKanade(pyr, this.prev, moved, o);
      }
      const np = [], ni = [];
      for (let i = 0; i < fwd.length; i++) {
        if (!fwd[i]) { this.stats.lostLK++; continue; }
        if (back && (!back[i] || Math.hypot(back[i][0] - this.pts[i][0], back[i][1] - this.pts[i][1]) > o.fbMax)) {
          this.stats.lostFB++; continue;
        }
        np.push(fwd[i]); ni.push(this.ids[i]);
      }
      this.stats.tracked += np.length;
      this.pts = np; this.ids = ni;
    }
    this.sinceSeed++;
    if (!this.prev || this.pts.length < o.target * o.topUpBelow || this.sinceSeed >= o.topUpEvery) {
      const fresh = corners(gray, w, h, { max: o.target - this.pts.length, quality: o.quality, minDist: o.minDist, existing: this.pts });
      for (const p of fresh) { this.pts.push(p); this.ids.push(this.nextId++); }
      this.sinceSeed = 0;
    }
    this.prev = pyr;
    return { ids: this.ids.slice(), pts: this.pts.map(p => p.slice()) };
  }
}

/* ---------------- cluster pass (candidates) ---------------- */

export const CLUSTER_DEFAULTS = {
  thresholds: [11, 24, 52], minMembers: [1, 3, 6], caps: [22, 10, 4],
  jaccard: 0.34, widthK: 1.55, heightK: 1.27,
};
export const LADDER = [12, 16, 24, 32, 48, 64, 96, 128, 192, 256];
export const snap = v => LADDER.reduce((a, b) => Math.abs(b - v) < Math.abs(a - v) ? b : a);

/** Single-linkage union-find at distance `thresh`. Returns arrays of point indices. */
export function linkage(xs, ys, thresh) {
  const n = xs.length, parent = new Int32Array(n).map((_, i) => i);
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const t2 = thresh * thresh;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const dx = xs[i] - xs[j], dy = ys[i] - ys[j];
      if (dx * dx + dy * dy < t2) { const a = find(i), b = find(j); if (a !== b) parent[a] = b; }
    }
  const m = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!m.has(r)) m.set(r, []); m.get(r).push(i); }
  return [...m.values()];
}

/**
 * Cluster pass over one shot. `frames` is an array, one entry per frame of the shot, of
 * { ids: Int32Array|number[], xs, ys } in 320 px space. Returns cluster tracks:
 * [{ id, level, start (offset within the shot), boxes: [[cx, cy, w, h], ...] }], box centres
 * raw (zero-lag smoothing is applied later) and sizes with hysteresis.
 */
export function clusterShot(frames, opts = {}, idStart = 1) {
  const o = { ...CLUSTER_DEFAULTS, ...opts };
  let nextId = idStart;
  const done = [];
  const live = [new Map(), new Map(), new Map()];   // level → id → track
  frames.forEach((fr, f) => {
    for (let lvl = 0; lvl < 3; lvl++) {
      if (o.caps[lvl] <= 0) continue;
      const groups = linkage(fr.xs, fr.ys, o.thresholds[lvl])
        .filter(g => g.length >= o.minMembers[lvl])
        .sort((a, b) => b.length - a.length || Math.min(...a) - Math.min(...b))
        .slice(0, o.caps[lvl]);
      const prev = live[lvl], next = new Map(), taken = new Set();
      for (const g of groups) {
        const members = new Set(g.map(i => fr.ids[i]));
        let best = null, bestJ = 0;
        for (const [id, t] of prev) {
          if (taken.has(id)) continue;
          let inter = 0;
          for (const m of members) if (t.members.has(m)) inter++;
          if (!inter) continue;
          const j = inter / (members.size + t.members.size - inter);
          if (j > bestJ || (j === bestJ && best !== null && id < best)) { bestJ = j; best = id; }
        }
        let cx = 0, cy = 0, x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        for (const i of g) {
          const x = fr.xs[i], y = fr.ys[i]; cx += x; cy += y;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        cx /= g.length; cy /= g.length;
        const ext = Math.max(x1 - x0, y1 - y0);
        let bw = snap(Math.max(ext * o.widthK, 14)), bh = snap(Math.max(ext * o.heightK, 12));
        let t;
        if (best !== null && bestJ > o.jaccard) {
          t = prev.get(best); taken.add(best);
          // Size hysteresis: hold the size unless the new one is two or more ladder steps away.
          if (Math.abs(LADDER.indexOf(bw) - LADDER.indexOf(t.w)) < 2) { bw = t.w; bh = t.h; }
        } else {
          t = { id: nextId++, level: lvl, start: f, boxes: [] };
        }
        t.members = members; t.w = bw; t.h = bh;
        t.boxes.push([cx, cy, bw, bh]);
        next.set(t.id, t);
      }
      for (const [id, t] of prev) if (!next.has(id)) done.push(t);
      live[lvl] = next;
    }
  });
  for (const l of live) done.push(...l.values());
  return done.sort((a, b) => a.id - b.id).map(({ id, level, start, boxes }) => ({ id, level, start, boxes }));
}

/**
 * Runs the cluster pass over a whole clip's track data, one shot at a time, from empty state at
 * every cut. Centres get zero-lag smoothing (sigma in frames); sizes keep their hysteresis.
 * Returns { [id]: { shot, level, start, boxes: [[x, y, w, h], ...] } } normalised to the frame.
 */
export function clusterPass(td, { smoothing = 1.5, ...opts } = {}) {
  const { width: pw, height: ph } = td.proxy;
  const out = {};
  let nextId = 1;
  for (const { shot, start, end } of shotsOf(td)) {
    const n = end - start;
    const frames = Array.from({ length: n }, () => ({ ids: [], xs: [], ys: [] }));
    for (const [id, t] of Object.entries(td.swarm)) {
      // By frame range, not by the shot number stored at analysis time: cut edits renumber shots.
      const k = t.pts.length / 2;
      if (t.start >= end || t.start + k <= start) continue;
      for (let i = 0; i < k; i++) {
        const f = t.start + i - start;
        if (f < 0 || f >= n) continue;
        frames[f].ids.push(+id); frames[f].xs.push(t.pts[2 * i] * pw); frames[f].ys.push(t.pts[2 * i + 1] * ph);
      }
    }
    for (const c of clusterShot(frames, opts, nextId)) {
      nextId = Math.max(nextId, c.id + 1);
      const centres = smoothSeries(c.boxes.map(b => [b[0], b[1]]), smoothing);
      out[c.id] = {
        shot, level: c.level, start: start + c.start,
        boxes: c.boxes.map((b, i) => [(centres[i][0] - b[2] / 2) / pw, (centres[i][1] - b[3] / 2) / ph, b[2] / pw, b[3] / ph]),
      };
    }
  }
  return out;
}
