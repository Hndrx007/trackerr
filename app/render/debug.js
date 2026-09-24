// M2 debug overlay: what analysis found, drawn over the frame. Raw detections, person tracks
// with IDs, swarm points and cluster candidates. Sizes are fractions of frame height.
import { shotsOf, shotAt } from "../trackdata.js";
import { personBoxAt } from "../analysis/persons.js";

// Distinct, deterministic colours per ID (golden-angle hues). Never pure red: red is the HUD's.
export function idColour(id, alpha = 1) {
  const h = ((id * 137.508) % 360 + 360) % 360, s = 0.65, l = 0.6;
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4), alpha];
}

export const DEBUG_DEFAULTS = { detections: true, persons: true, swarm: true, clusters: false, info: true };

/**
 * Draws the debug overlay for frame `f`. `cache` holds per-td lookups (shots, points by frame)
 * so scrubbing stays fast; pass the same object between calls for the same track data.
 */
export function drawDebug(o, f, td, show = DEBUG_DEFAULTS, cache = {}) {
  const W = o.width, H = o.height, lw = Math.max(1, H * 0.002), px = Math.max(10, Math.round(H * 0.022));
  if (cache.td !== td) { cache.td = td; cache.shots = shotsOf(td); cache.points = null; }

  if (show.clusters) {
    const lv = [[0.55, 0.85, 1, 0.55], [0.55, 0.85, 1, 0.8], [0.55, 0.85, 1, 1]];
    for (const c of Object.values(td.clusters)) {
      const i = f - c.start;
      if (i < 0 || i >= c.boxes.length) continue;
      const [x, y, w, h] = c.boxes[i];
      o.strokeRect(x * W, y * H, w * W, h * H, lw * (c.level + 1) * 0.6, lv[c.level]);
    }
  }
  if (show.swarm) {
    const pts = pointsAt(td, f, cache), d = Math.max(2, H * 0.004);
    for (let i = 0; i < pts.length; i += 2) o.rect(pts[i] * W - d / 2, pts[i + 1] * H - d / 2, d, d, [0.4, 1, 0.85, 0.9]);
  }
  if (show.detections) {
    for (const [x, y, w, h, c] of td.detections[f] ?? []) {
      o.strokeRect(x * W, y * H, w * W, h * H, lw, [1, 1, 1, 0.45]);
      o.text(c.toFixed(2), x * W + lw * 2, (y + h) * H - px * 1.1, px * 0.8, [1, 1, 1, 0.6]);
    }
  }
  if (show.persons) {
    for (const [id, p] of Object.entries(td.persons)) {
      const b = personBoxAt(p, f);
      if (!b) continue;
      const col = idColour(+id);
      o.strokeRect(b[0] * W, b[1] * H, b[2] * W, b[3] * H, lw * 2, col);
      const label = `P${id}`;
      o.rect(b[0] * W, b[1] * H - px * 1.3, o.textWidth(label, px) + px * 0.5, px * 1.3, [0, 0, 0, 0.7]);
      o.text(label, b[0] * W + px * 0.25, b[1] * H - px * 1.15, px, col);
    }
  }
  if (show.info) {
    const s = shotAt(cache.shots, f), shot = cache.shots[s];
    const tags = [];
    if (f === shot.start && f > 0) tags.push("CUT");
    if (td.cutFlash?.[f]) tags.push("flash");
    if (td.detections[f] === null) tags.push("no detect");
    const text = `shot ${s + 1}/${cache.shots.length}  ·  d ${(td.cutSignal?.[f] ?? 0).toFixed(3)} / ${(td.cutThreshold?.[f] ?? 0).toFixed(3)}${tags.length ? "  ·  " + tags.join(" ") : ""}`;
    const tw = o.textWidth(text, px);
    o.rect(W - tw - px * 1.2, H * 0.04, tw + px * 0.8, px * 1.35, [0, 0, 0, 0.7]);
    o.text(text, W - tw - px * 0.8, H * 0.04 + px * 0.12, px, f === shot.start && f > 0 ? [1, 0.85, 0.3, 1] : [1, 1, 1, 0.9]);
  }
}

// Swarm points for one frame. Built lazily per frame from the per-track arrays and memoised.
function pointsAt(td, f, cache) {
  cache.points ??= new Map();
  let p = cache.points.get(f);
  if (!p) {
    const out = [];
    for (const t of Object.values(td.swarm)) {
      const i = f - t.start;
      if (i >= 0 && 2 * i + 1 < t.pts.length) out.push(t.pts[2 * i], t.pts[2 * i + 1]);
    }
    p = out;
    if (cache.points.size > 64) cache.points.clear();
    cache.points.set(f, p);
  }
  return p;
}

/**
 * Pickable people (M4): every tracked person at frame f, faint, with their ID; the hero marked.
 * Drawn in the viewer only while paused, never in the export.
 */
export function drawPickables(o, f, td, heroId, hoverId = null) {
  const W = o.width, H = o.height, lw = Math.max(1, H * 0.0015), px = Math.max(10, Math.round(H * 0.02));
  for (const [id, p] of Object.entries(td.persons)) {
    const b = personBoxAt(p, f);
    if (!b) continue;
    const isHero = +id === heroId, hot = +id === hoverId;
    const c = isHero ? [0.44, 0.66, 0.86, 0.9] : [1, 1, 1, hot ? 0.9 : 0.4];
    o.strokeRect(b[0] * W, b[1] * H, b[2] * W, b[3] * H, lw * (hot || isHero ? 2 : 1), c);
    const label = isHero ? `P${id} · HERO` : `P${id}`;
    const tw = o.textWidth(label, px);
    o.rect(b[0] * W, (b[1] + b[3]) * H - px * 1.3, tw + px * 0.5, px * 1.3, [0, 0, 0, 0.6]);
    o.text(label, b[0] * W + px * 0.25, (b[1] + b[3]) * H - px * 1.15, px, c);
  }
}

/** The person under normalised point (x, y) at frame f: the smallest box containing it, or null. */
export function personAt(td, f, x, y) {
  let best = null, area = Infinity;
  for (const [id, p] of Object.entries(td.persons)) {
    const b = personBoxAt(p, f);
    if (!b || x < b[0] || y < b[1] || x > b[0] + b[2] || y > b[1] + b[3]) continue;
    if (b[2] * b[3] < area) { area = b[2] * b[3]; best = +id; }
  }
  return best;
}
