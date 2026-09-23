// Person tracking over cached detections. A pure function of (detections, cuts, fps, options),
// so editing a cut re-runs it in milliseconds without touching the video.
//
// Per shot: predict each track with constant velocity, match detections greedily by IoU
// (≥ iouMin, ties broken by centre distance), start tracks only from confident detections,
// keep lost tracks for maxAge frames. Tracks never cross a cut.
import { iou } from "./detector.js";

/** Shot index for every frame, from sorted cut frames (frame 0 implicit). */
export function shotRanges(cuts, frameCount) {
  const starts = [0, ...cuts.filter(f => f > 0 && f < frameCount)].sort((a, b) => a - b)
    .filter((f, i, a) => i === 0 || f !== a[i - 1]);
  return starts.map((start, i) => ({ shot: i, start, end: i + 1 < starts.length ? starts[i + 1] : frameCount }));
}

const centre = b => [b[0] + b[2] / 2, b[1] + b[3] / 2];

/**
 * @param {(number[][]|null)[]} detections  per frame [[x,y,w,h,conf],...]; null = frame not run (detect stride)
 * @param {object} o
 * @param {number[]} o.cuts  first frames of new shots
 * @returns {Object<string, {shot, start, boxes: number[][]}>} contiguous per-frame boxes, one shot each
 */
export function trackPersons(detections, { cuts = [], fps = [24, 1], iouMin = 0.3, startConf = 0.5, maxAge, minHits = 3 } = {}) {
  const frameCount = detections.length;
  maxAge ??= Math.round(0.5 * fps[0] / fps[1]);
  const persons = {};
  let nextId = 1;

  for (const { shot, start, end } of shotRanges(cuts, frameCount)) {
    let active = [];
    const finished = [];
    for (let f = start; f < end; f++) {
      const dets = detections[f];
      if (!dets) continue;                         // not a detection frame
      const pred = active.map(t => {
        const dt = f - t.lastFrame, b = t.last;
        return [b[0] + t.vx * dt, b[1] + t.vy * dt, b[2], b[3]];
      });
      const pairs = [];
      active.forEach((t, ti) => dets.forEach((d, di) => {
        const v = iou(pred[ti], d);
        if (v >= iouMin) {
          const [pc, dc] = [centre(pred[ti]), centre(d)];
          pairs.push([v, Math.hypot(pc[0] - dc[0], pc[1] - dc[1]), ti, di]);
        }
      }));
      pairs.sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
      const usedT = new Set(), usedD = new Set();
      for (const [, , ti, di] of pairs) {
        if (usedT.has(ti) || usedD.has(di)) continue;
        usedT.add(ti); usedD.add(di);
        const t = active[ti], d = dets[di], dt = f - t.lastFrame;
        const [c0, c1] = [centre(t.last), centre(d)];
        const vx = (c1[0] - c0[0]) / dt, vy = (c1[1] - c0[1]) / dt;
        t.vx = t.hits > 1 ? 0.5 * t.vx + 0.5 * vx : vx;
        t.vy = t.hits > 1 ? 0.5 * t.vy + 0.5 * vy : vy;
        t.last = d.slice(0, 4); t.lastFrame = f; t.hits++;
        t.matches.push([f, t.last]);
      }
      dets.forEach((d, di) => {
        if (!usedD.has(di) && d[4] >= startConf)
          active.push({ last: d.slice(0, 4), lastFrame: f, vx: 0, vy: 0, hits: 1, matches: [[f, d.slice(0, 4)]] });
      });
      active = active.filter(t => {
        if (f - t.lastFrame > maxAge) { finished.push(t); return false; }
        return true;
      });
    }
    finished.push(...active);
    // IDs in order of first appearance, so the numbering is deterministic.
    finished.filter(t => t.hits >= minHits)
      .sort((a, b) => a.matches[0][0] - b.matches[0][0] || a.matches[0][1][0] - b.matches[0][1][0])
      .forEach(t => { persons[nextId++] = { shot, start: t.matches[0][0], boxes: fillGaps(t.matches) }; });
  }
  return persons;
}

// Matched boxes → one box per frame from first to last match, linear between matches.
function fillGaps(matches) {
  const out = [];
  for (let k = 0; k < matches.length; k++) {
    const [f, b] = matches[k];
    out.push(b);
    const next = matches[k + 1];
    if (!next) break;
    const [g, c] = next;
    for (let i = f + 1; i < g; i++) {
      const u = (i - f) / (g - f);
      out.push(b.map((v, j) => v + (c[j] - v) * u));
    }
  }
  return out;
}

/** Box of person `p` at frame `f`, or null. */
export const personBoxAt = (p, f) => (f >= p.start && f < p.start + p.boxes.length) ? p.boxes[f - p.start] : null;
