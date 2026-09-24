// Composition: decides, for every frame, which candidates are on screen, in which tier, and
// where each is in its acquire or release animation. Offline, one shot at a time, deterministic
// (a function of frame index, track data and parameters only), fast enough to re-run while a
// slider is dragged. The renderer draws only what this says.
//
// Floor (tested in tests/compose.test.js):
//  - budget: visible swarm boxes (appearing, visible or releasing) never exceed `amount`;
//  - hierarchy: a lock tier (few, heavy, labelled, connected) and a scan tier (light, scanlines);
//  - the hero dominates: no box inside the hero rectangle plus a margin, none larger than a
//    fraction of the hero box;
//  - no crowding: boxes keep a minimum spacing, and never nest;
//  - tier stability: promotion needs a challenger to outscore the incumbent for a while, boxes
//    stay a minimum time, and no candidate changes tier more than once in any 0.5 s;
//  - deterministic.
//
// Direction: candidates are ranked by meaning (proximity to the hero, steered by Focus; motion;
// persistence; a size preference; other people get a bonus), not by cluster size. New boxes
// cascade in rather than all popping at once, and each shot can open with a sequence: the scan
// tier first, then the hero is acquired, then the thermal wipes on and the label appears.
import { shotsOf, smoothTrack } from "../trackdata.js";

export const TIER = { none: 0, trace: 1, scan: 2, lock: 3 };
const TIER_COOLDOWN_S = 0.5;

/* ---------------- hero ---------------- */

/**
 * Auto-pick. When a shot starts, or when the first person appears in a shot that has no hero
 * yet, pick the person nearest the frame centre. When the hero's track ends mid-shot, a track
 * that starts within a second near where they were last seen is taken to be them, re-detected,
 * and continues the hero. Nobody else is ever substituted: switching to whoever is nearest the
 * centre is the notebook's hero-swapping bug. The editor fills real gaps by clicking.
 */
export function autoPickHero(td) {
  const segs = [];
  const fps = td.source.fps[0] / td.source.fps[1];
  const persons = Object.entries(td.persons).map(([id, p]) => ({ id: +id, ...p, end: p.start + p.boxes.length }));
  const ctr = b => [b[0] + b[2] / 2, b[1] + b[3] / 2];
  for (const { start, end } of shotsOf(td)) {
    const inShot = persons.filter(p => p.start >= start && p.start < end);
    let f = start, last = null;
    while (f < end) {
      const present = inShot.filter(p => p.start <= f && p.end > f);
      if (!present.length) {
        const next = inShot.filter(p => p.start > f).map(p => p.start);
        if (!next.length) break;
        f = Math.min(...next);
        continue;
      }
      const at = p => p.boxes[f - p.start];
      let pick = null, cont = false;
      if (last && f - last.frame > fps) break;          // the hero is gone: leave the gap
      if (last) {
        // Re-detection: the new track nearest the hero's last position, if close enough.
        const near = present.filter(p => p.start >= last.frame - 1)
          .map(p => ({ p, d: Math.hypot(ctr(at(p))[0] - last.c[0], ctr(at(p))[1] - last.c[1]) }))
          .filter(x => x.d < 0.15).sort((a, b) => a.d - b.d || a.p.id - b.p.id);
        pick = near[0]?.p ?? null;
        cont = !!pick;
        if (!pick) { f++; continue; }                    // wait for a re-detection
      }
      if (!pick) {
        present.sort((a, b) => Math.hypot(ctr(at(a))[0] - 0.5, ctr(at(a))[1] - 0.5) - Math.hypot(ctr(at(b))[0] - 0.5, ctr(at(b))[1] - 0.5) || a.id - b.id);
        pick = present[0];
      }
      const segEnd = Math.min(end, pick.end);
      segs.push({ start: f, end: segEnd, personId: pick.id, auto: true, cont });
      last = { frame: segEnd - 1, c: ctr(pick.boxes[segEnd - 1 - pick.start]) };
      f = segEnd;
    }
  }
  return segs;
}

/** Hero segments in effect: manual picks override auto ones where they overlap. */
export function heroSegments(td, params) {
  const manual = (td.hero ?? []).filter(s => !s.auto);
  const auto = params.autoPick ? autoPickHero(td) : [];
  const out = [...manual];
  for (const a of auto) {
    // Keep the parts of an auto segment no manual segment covers.
    let pieces = [[a.start, a.end]];
    for (const m of manual) pieces = pieces.flatMap(([s, e]) => m.end <= s || m.start >= e ? [[s, e]]
      : [[s, m.start], [m.end, e]].filter(([x, y]) => y > x));
    for (const [s, e] of pieces) out.push({ ...a, start: s, end: e });
  }
  return out.sort((x, y) => x.start - y.start);
}

/* ---------------- geometry helpers (height units: x scaled by aspect) ---------------- */

const toHU = (b, aspect) => [b[0] * aspect, b[1], b[2] * aspect, b[3]];
const gap = (a, b) => Math.max(0, Math.max(a[0], b[0]) - Math.min(a[0] + a[2], b[0] + b[2]),
  Math.max(a[1], b[1]) - Math.min(a[1] + a[3], b[1] + b[3]));   // Chebyshev gap between rects; 0 when touching or overlapping
const overlaps = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
const grow = (r, m) => [r[0] - m, r[1] - m, r[2] + 2 * m, r[3] + 2 * m];
const centre = r => [r[0] + r[2] / 2, r[1] + r[3] / 2];

/* ---------------- the pass ---------------- */

/**
 * @returns layout:
 *  { params, fps, heroes: [{ start, end, personId, acquire, thermal, wipeEnd, labelAt }],
 *    items: [{ key, kind, id, shot, appear, exit, end, releaseFrames, tiers: Uint8Array, scores: Float32Array }],
 *    trace: [{ id, start, end }], byFrame: (f) → item indices }
 *  `tiers[f - appear]` is the tier at frame f (0 = not drawn). exit = first frame of the release
 *  animation (or null), end = first frame no longer drawn.
 */
export function compose(td, params) {
  const fps = td.source.fps[0] / td.source.fps[1];
  const aspect = td.source.width / td.source.height;
  const sec = s => Math.max(1, Math.round(s * fps));
  const P = {
    acquire: sec(params.acquire), release: sec(params.release), hyst: sec(params.hysteresis),
    minVis: sec(params.minVisible), cooldown: Math.ceil(TIER_COOLDOWN_S * fps), stagger: Math.max(1, Math.round(sec(params.acquire) / 4)),
  };
  const heroes = heroSegments(td, params).map(h => ({ ...h, ...sequenceTimes(h, td, params, fps) }));
  const heroPersons = new Map();   // smoothed hero tracks
  const smoothP = id => {
    if (!heroPersons.has(id)) heroPersons.set(id, smoothTrack(td.persons[id], params.heroSmoothing));
    return heroPersons.get(id);
  };
  const heroAt = f => {
    for (const h of heroes) if (f >= h.start && f < h.end) {
      const p = smoothP(h.personId), b = p.boxes[f - p.start];
      if (b) return { seg: h, box: heroBox(b, params) };
    }
    return null;
  };

  const items = [];
  const trace = [];
  for (const shot of shotsOf(td)) composeShot(shot);
  return { params, fps, P, heroes, items, trace, heroAt, aspect, shots: shotsOf(td) };

  function composeShot({ shot, start, end }) {
    // Candidates in this shot: clusters, and people other than the hero.
    const cands = [];
    for (const [id, c] of Object.entries(td.clusters)) {
      if (c.start >= end || c.start + c.boxes.length <= start) continue;
      cands.push({ key: `c${id}`, kind: "cluster", id: +id, level: c.level, start: c.start, boxes: c.boxes });
    }
    // Other people are natural secondary targets: they are locked by the head, a small square at
    // the top of their box, so they stay within the size cap and read as a face lock.
    for (const [id, p] of Object.entries(td.persons)) {
      if (p.start >= end || p.start + p.boxes.length <= start) continue;
      cands.push({ key: `p${id}`, kind: "person", id: +id, level: 3, start: p.start,
        boxes: smoothTrack(p, params.heroSmoothing).boxes.map(b => headBox(b, aspect)) });
    }
    cands.sort((a, b) => a.key < b.key ? -1 : 1);

    const active = new Map();            // key → state
    const lead = new Map();              // challenger key → frames spent outscoring the weakest
    let lastAppear = -1e9;

    for (let f = start; f < end; f++) {
      const hero = heroAt(f);
      const hr = hero ? toHU(hero.box, aspect) : null;
      const zone = hr ? grow(hr, params.exclusion) : null;
      const maxH = hr ? Math.min(0.3, params.maxSize * hr[3]) : 0.18;
      const locksAllowed = !hero || f >= hero.seg.acquire;

      // Candidate boxes and features at f.
      const now = [];
      for (const c of cands) {
        const i = f - c.start;
        if (i < 0 || i >= c.boxes.length) continue;
        if (hero && c.kind === "person" && c.id === hero.seg.personId) continue;
        const r = toHU(c.boxes[i], aspect);
        const prev = c.boxes[Math.max(0, i - 2)], pr = toHU(prev, aspect);
        const speed = Math.hypot(centre(r)[0] - centre(pr)[0], centre(r)[1] - centre(pr)[1]) / Math.max(1, Math.min(2, i));
        const ok = r[3] >= params.minBox && r[3] <= maxH && r[0] >= 0.005 && r[1] >= 0.005 &&
          r[0] + r[2] <= aspect - 0.005 && r[1] + r[3] <= 0.995 && !(zone && overlaps(r, zone)) && i >= 2;
        now.push({ c, r, speed, age: i, ok, score: ok ? score(c, r, speed, i, hr) : -Infinity });
      }
      const byKey = new Map(now.map(n => [n.c.key, n]));

      // 1. Active boxes: start releasing those whose candidate ended or became ineligible.
      for (const [key, s] of active) {
        const n = byKey.get(key);
        if (n) s.r = n.r;
        if (s.exit === null) {
          if (!n) { s.exit = f; s.releaseFrames = P.release; s.reason = "gone"; }
          else if (zone && overlaps(n.r, zone)) { s.exit = f; s.releaseFrames = 0; s.reason = "zone"; }   // never inside the hero zone
          else if (!n.ok) { s.exit = f; s.releaseFrames = P.release; s.reason = "ineligible"; }
        } else if (n && zone && overlaps(n.r, zone)) s.releaseFrames = Math.min(s.releaseFrames, f - s.exit);
        if (s.exit !== null && f >= s.exit + s.releaseFrames) { finish(s, f); active.delete(key); }
      }

      // 1b. Crowding: boxes that drifted closer than the minimum spacing. The lower-scoring one
      // releases (a box that changed tier in the last 0.5 s is kept if possible).
      const minGap = Math.max(params.spacing, 0.002);
      const live0 = [...active.values()].filter(s => s.exit === null);
      for (let i = 0; i < live0.length; i++)
        for (let j = i + 1; j < live0.length; j++) {
          const a = live0[i], b = live0[j];
          if (a.exit !== null || b.exit !== null || gap(a.r, b.r) >= minGap) continue;
          const sa = byKey.get(a.key)?.score ?? 0, sb = byKey.get(b.key)?.score ?? 0;
          const settledA = f - a.tierAt >= P.cooldown, settledB = f - b.tierAt >= P.cooldown;
          const loser = settledA !== settledB ? (settledA ? a : b) : (sa < sb || (sa === sb && a.key > b.key) ? a : b);
          loser.exit = f; loser.releaseFrames = P.release; loser.reason = "crowded";
        }

      // 2. Replacement: a challenger that outscores the weakest settled box for long enough.
      const settled = [...active.values()].filter(s => s.exit === null && f - s.appear >= P.minVis && f - s.tierAt >= P.cooldown);
      const free = now.filter(n => n.ok && !active.has(n.c.key)).sort((a, b) => b.score - a.score || (a.c.key < b.c.key ? -1 : 1));
      if (active.size >= params.amount && settled.length && free.length) {
        const weakest = settled.reduce((w, s) => (byKey.get(s.key)?.score ?? -Infinity) < (byKey.get(w.key)?.score ?? -Infinity) ? s : w);
        const ws = byKey.get(weakest.key)?.score ?? -Infinity;
        const best = free.find(n => spaced(n.r, weakest.key));
        if (best && best.score > ws * 1.15 + 0.05) {
          const k = (lead.get(best.c.key) ?? 0) + 1;
          lead.clear(); lead.set(best.c.key, k);
          if (k >= P.hyst) { weakest.exit = f; weakest.releaseFrames = P.release; weakest.reason = "replaced"; lead.clear(); }
        } else lead.clear();
      }

      // 3. Fill free slots, one new box every `stagger` frames so they cascade in.
      if (f - lastAppear >= P.stagger && active.size < params.amount) {
        const best = free.find(n => !active.has(n.c.key) && spaced(n.r, null));
        if (best) {
          active.set(best.c.key, { key: best.c.key, kind: best.c.kind, id: best.c.id, c: best.c, shot, appear: f, exit: null,
            releaseFrames: P.release, reason: null, r: best.r, tier: TIER.scan, tierAt: f, tiers: [], scores: [] });
          lastAppear = f;
        }
      }

      // 4. Tiers among settled, non-releasing boxes: the top `lockCount` by score are locks.
      const live = [...active.values()].filter(s => s.exit === null)
        .sort((a, b) => (byKey.get(b.key)?.score ?? 0) - (byKey.get(a.key)?.score ?? 0) || (a.key < b.key ? -1 : 1));
      const want = new Set(locksAllowed ? live.slice(0, params.lockCount).map(s => s.key) : []);
      let locks = [...active.values()].filter(s => s.tier === TIER.lock).length;   // releasing locks count too
      for (const s of live) {
        if (f - s.tierAt < P.cooldown) continue;
        if (s.tier === TIER.lock && !want.has(s.key)) { s.tier = TIER.scan; s.tierAt = f; locks--; }
      }
      for (const s of live) {
        if (f - s.tierAt < P.cooldown || locks >= params.lockCount) continue;
        if (s.tier === TIER.scan && want.has(s.key)) { s.tier = TIER.lock; s.tierAt = f; locks++; }
      }

      // 5. Record.
      for (const s of active.values()) { s.tiers.push(s.tier); s.scores.push(byKey.get(s.key)?.score ?? 0); }

      // Minimum spacing to every box on screen, releasing ones included (at their last position).
      // Never zero, so boxes can't overlap or nest. New boxes need half as much again, so boxes
      // drifting a little don't immediately crowd.
      function spaced(r, except) {
        const min = Math.max(params.spacing, 0.002) * 1.5;
        for (const [k, s] of active) {
          if (k === except) continue;
          if (gap(r, byKey.get(k)?.r ?? s.r) < min) return false;
        }
        return true;
      }
    }
    for (const s of active.values()) { s.reason ??= "shotEnd"; finish(s, s.exit !== null ? Math.min(end, s.exit + s.releaseFrames) : end); }
    if (params.trace !== "off") traceShot(start, end);
  }

  function finish(s, endFrame) {
    const n = endFrame - s.appear;
    items.push({ key: s.key, kind: s.kind, id: s.id, shot: s.shot, appear: s.appear, exit: s.exit, end: endFrame,
      releaseFrames: s.releaseFrames, reason: s.reason, level: s.c.level, boxes: s.c.boxes, cstart: s.c.start, tiers: Uint8Array.from(s.tiers.slice(0, n)), scores: Float32Array.from(s.scores.slice(0, n)) });
  }

  // Score: meaning, not size. Focus moves weight from "anywhere" to "near the hero".
  function score(c, r, speed, age, hr) {
    const [cx, cy] = centre(r);
    let prox = 0.5, spread = 0.5;
    if (hr) {
      const [hx, hy] = centre(hr);
      const d = Math.hypot(cx - hx, cy - hy);
      prox = Math.exp(-d / 0.35);
      spread = Math.min(1, d / 0.8);
    }
    const f = params.focus;
    const motion = Math.min(1, speed / 0.008);
    const persist = Math.min(1, age / fps);
    const target = hr ? 0.22 * hr[3] : 0.12, sizePref = Math.exp(-(((r[3] - target) / (0.6 * target)) ** 2));
    return 2 * f * prox + 1.2 * (1 - f) * spread + params.wMotion * motion + params.wAge * persist +
      params.wSize * sizePref + (c.kind === "person" ? params.wPerson : 0) - 0.15 * (c.level === 0 ? 1 : 0);
  }

  // Trace tier: long-lived swarm points outside the hero zone, a stable subset (by ID) per frame.
  function traceShot(start, end) {
    const cap = Math.max(12, params.amount * 4);
    const pts = Object.entries(td.swarm).map(([id, t]) => ({ id: +id, t }))
      .filter(({ t }) => t.start < end && t.start + t.pts.length / 2 > start && t.pts.length / 2 >= 12)
      .sort((a, b) => a.id - b.id);
    const open = new Map();
    for (let f = start; f < end; f++) {
      const hero = heroAt(f), zone = hero ? grow(toHU(hero.box, aspect), params.exclusion) : null;
      const on = new Set();
      for (const { id, t } of pts) {
        if (on.size >= cap) break;
        const i = f - t.start;
        if (i < 6 || 2 * i + 1 >= t.pts.length) continue;
        const x = t.pts[2 * i] * aspect, y = t.pts[2 * i + 1];
        if (zone && x > zone[0] && x < zone[0] + zone[2] && y > zone[1] && y < zone[1] + zone[3]) continue;
        on.add(id);
      }
      for (const id of on) if (!open.has(id)) open.set(id, f);
      for (const [id, s] of open) if (!on.has(id)) { trace.push({ id, start: s, end: f }); open.delete(id); }
    }
    for (const [id, s] of open) trace.push({ id, start: s, end });
  }
}

/** A person's head as a square at the top-centre of their box (normalised coords in and out). */
export function headBox(b, aspect) {
  const bw = b[2] * aspect, bh = b[3];                      // height units
  const side = Math.max(0.02, Math.min(0.5 * bw, 0.24 * bh));
  const cx = (b[0] + b[2] / 2) * aspect, y = b[1] + 0.02 * bh;
  return [(cx - side / 2) / aspect, y, side / aspect, side];
}

/** Hero rectangle from the tracked person box: padded, clamped to the frame. */
export function heroBox(b, params) {
  const p = params.heroPad;
  const x0 = Math.max(0, b[0] - b[2] * p), y0 = Math.max(0, b[1] - b[3] * p);
  const x1 = Math.min(1, b[0] + b[2] * (1 + p)), y1 = Math.min(1, b[1] + b[3] * (1 + p));
  return [x0, y0, x1 - x0, y1 - y0];
}

// Shot-start sequence, relative to the first frame the hero is on screen in this segment.
function sequenceTimes(h, td, params, fps) {
  const s = h.start;
  // A re-detected hero carries on: no sequence, thermal stays on.
  if (!params.sequence || h.cont) return { acquire: s, thermal: s, wipeEnd: s, labelAt: s };
  const acquire = s + Math.round(params.seqHero * fps);
  const thermal = s + Math.round(params.seqThermal * fps);
  const wipeEnd = thermal + Math.max(1, Math.round(params.seqWipe * fps));
  return { acquire, thermal, wipeEnd, labelAt: wipeEnd };
}

/** Items drawn at frame f, as [item, tier, phase] with phase in { acquire: 0..1, release: 0..1 }. */
export function itemsAt(layout, f) {
  const out = [];
  for (const it of layout.items) {
    if (f < it.appear || f >= it.end) continue;
    const i = f - it.appear, tier = it.tiers[i];
    if (!tier) continue;
    const acq = Math.min(1, (i + 1) / layout.P.acquire);
    const rel = it.exit !== null && f >= it.exit ? (it.releaseFrames ? (f - it.exit + 1) / (it.releaseFrames + 1) : 1) : 0;
    out.push({ it, tier, acquire: acq, release: rel, score: it.scores[i] });
  }
  return out;
}

/** The item's box at frame f (normalised), holding the last known box while it releases. */
export function itemBox(it, f) {
  const i = Math.max(0, Math.min(it.boxes.length - 1, f - it.cstart));
  return it.boxes[i];
}
