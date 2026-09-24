// The HUD: draws exactly what the composition layout says, in the spec's layer order:
//   thermal on the hero → connectors → swarm (trace, scan, lock) → hero box, brackets, label.
// Every size is a fraction of frame height, so a look is the same at 1080p and 4K. Any variation
// comes from a hash of an ID or of the frame index for readouts that tick; never from loop order.
import { itemsAt, itemBox, TIER } from "./compose.js";
import { rgb } from "./params.js";

const hash = (n, salt = 0) => {
  let x = (Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0;
  return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
};
const clamp01 = v => Math.max(0, Math.min(1, v));
const easeOut = t => 1 - (1 - t) ** 3;
const pad = (n, w) => String(Math.floor(n)).padStart(w, "0");

/**
 * Draws the HUD for frame f. `o` is the renderer overlay API; `layout` comes from compose().
 */
export function drawHud(o, f, td, layout, params) {
  const W = o.width, H = o.height, u = H / 1080, I = params.intensity;
  const C = rgb(params.colour), col = a => [C[0], C[1], C[2], clamp01(a * I)];
  const dark = a => [0.02, 0.02, 0.02, clamp01(a * I)];
  const px = b => [b[0] * W, b[1] * H, b[2] * W, b[3] * H];
  const hero = layout.heroAt(f);
  const hr = hero ? px(hero.box) : null;
  const seg = hero?.seg;

  // 1. Thermal on the hero rectangle, wiped on from the top.
  if (hr && f >= seg.thermal) {
    const wipe = seg.wipeEnd > seg.thermal ? clamp01((f - seg.thermal + 1) / (seg.wipeEnd - seg.thermal)) : 1;
    o.thermal(hr[0], hr[1], hr[2], hr[3], { palette: params.palette, gain: params.gain, contrast: params.contrast, wipe, alpha: I, lines: Math.max(1, 2 * u) });
    if (wipe < 1) {
      const y = hr[1] + hr[3] * wipe;
      o.rect(hr[0], y - 6 * u, hr[2], 12 * u, col(0.18));
      o.rect(hr[0], y - 1.5 * u, hr[2], 3 * u, col(0.95));
    }
  }

  const items = itemsAt(layout, f);
  const heroOn = hr && f >= seg.acquire;

  // 2. Connectors from the hero to lock boxes (and scan boxes, if the look says so).
  if (params.connectors && heroOn) {
    const [hx, hy] = [hr[0] + hr[2] / 2, hr[1] + hr[3] / 2], range = params.connectRange * W;
    for (const { it, tier, acquire, release } of items) {
      if (!(tier === TIER.lock || (tier === TIER.scan && params.connectTiers === "lockscan"))) continue;
      const b = px(itemBox(it, f)), [bx, by] = [b[0] + b[2] / 2, b[1] + b[3] / 2];
      const d = Math.hypot(bx - hx, by - hy), fall = clamp01(1 - d / range);
      if (fall <= 0) continue;
      const a = fall * (1 - release) * clamp01(acquire * 1.5 - 0.3) * (tier === TIER.lock ? 0.85 : 0.45);
      const p0 = edgePoint(hr, bx, by), p1 = edgePoint(b, hx, hy);
      const lw = Math.max(1, params.connectWeight * H * (0.6 + 0.4 * fall));
      if (tier === TIER.lock) o.line(p0[0], p0[1], p1[0], p1[1], lw, col(a));
      else dashed(o, p0, p1, lw, 10 * u, 7 * u, col(a));
      o.rect(p1[0] - 2.5 * u, p1[1] - 2.5 * u, 5 * u, 5 * u, col(a * 1.2));
    }
  }

  // 3. Swarm: trace, then scan, then lock.
  if (params.trace !== "off") {
    const s = (params.trace === "ticks" ? 5 : 2.2) * u;
    for (const t of layout.trace) {
      if (f < t.start || f >= t.end) continue;
      const pt = td.swarm[t.id], i = f - pt.start;
      const x = pt.pts[2 * i] * W, y = pt.pts[2 * i + 1] * H;
      const a = 0.4 * clamp01((f - t.start + 1) / 4) * clamp01((t.end - f) / 4);
      if (params.trace === "ticks") { o.rect(x - s, y - 0.6 * u, 2 * s, 1.2 * u, col(a)); o.rect(x - 0.6 * u, y - s, 1.2 * u, 2 * s, col(a)); }
      else o.rect(x - s / 2, y - s / 2, s, s, col(a));
    }
  }
  for (const pass of [TIER.scan, TIER.lock])
    for (const e of items) if (e.tier === pass) drawItem(o, e, f, px, col, dark, u, params, hr, td);

  // 4. Hero: acquire, box and brackets, label.
  if (hr && f >= seg.acquire) drawHero(o, hr, f, seg, layout, params, col, dark, u, td);

  // Frame marks and a REC readout: the camera around the picture.
  if (params.chrome) drawChrome(o, f, layout, col, u, W, H);
}

/* ---------------- swarm items ---------------- */

function drawItem(o, { it, tier, acquire, release, score }, f, px, col, dark, u, params, hr, td) {
  const b0 = px(itemBox(it, f));
  // Acquire: draws on from larger and snaps in, blinking for its first frames. Release: collapses and fades.
  const a = easeOut(acquire), scale = (1 + 0.45 * (1 - a)) * (1 - 0.35 * release);
  const blink = acquire < 0.5 ? ((f + it.id) % 2 ? 1 : 0.35) : 1;
  const alpha = clamp01(acquire * 1.6) * (1 - release) * blink;
  const cx = b0[0] + b0[2] / 2, cy = b0[1] + b0[3] / 2, w = b0[2] * scale, h = b0[3] * scale;
  const x = cx - w / 2, y = cy - h / 2, m = Math.min(w, h);
  if (alpha <= 0.01) return;

  if (tier === TIER.scan) {
    const lw = Math.max(1, 1.3 * u);
    if (params.scanStyle === "corners") corners(o, x, y, w, h, m * 0.28, lw * 1.2, col(0.85 * alpha));
    else o.strokeRect(x, y, w, h, lw, col((params.scanStyle === "plain" ? 0.8 : 0.75) * alpha));
    if (params.scanStyle !== "plain" && params.scanlines > 0) {
      const gapPx = (11 - 7.5 * params.scanlines) * u, lh = Math.max(1, 1.1 * u);
      for (let yy = y + gapPx; yy < y + h - lw; yy += gapPx) o.rect(x + lw, yy, w - 2 * lw, lh, col(0.3 * alpha));
      // A brighter sweep line travelling down the box, phase from the ID.
      const period = Math.max(12, Math.round(h / (2.2 * u))), ph = ((f + Math.floor(hash(it.id) * period)) % period) / period;
      o.rect(x + lw, y + h * ph, w - 2 * lw, Math.max(1, 1.4 * u), col(0.55 * alpha));
    }
    return;
  }

  // Lock tier: heavy, labelled.
  const lw = Math.max(1.5, 3 * u);
  if (params.lockStyle === "box") o.strokeRect(x, y, w, h, lw * 0.8, col(0.95 * alpha));
  else {
    o.strokeRect(x, y, w, h, Math.max(1, u), col(0.35 * alpha));
    corners(o, x - 3 * u, y - 3 * u, w + 6 * u, h + 6 * u, m * 0.3, lw, col(alpha));
  }
  if (params.lockStyle === "reticle") {
    const r = m * 0.2, g = r * 0.45, t = Math.max(1, 1.4 * u);
    o.rect(cx - r, cy - t / 2, r - g, t, col(alpha)); o.rect(cx + g, cy - t / 2, r - g, t, col(alpha));
    o.rect(cx - t / 2, cy - r, t, r - g, col(alpha)); o.rect(cx - t / 2, cy + g, t, r - g, col(alpha));
  } else {
    // Mid-edge ticks.
    const tk = 6 * u, t = Math.max(1, 1.4 * u);
    o.rect(cx - t / 2, y - tk, t, tk, col(0.8 * alpha)); o.rect(cx - t / 2, y + h, t, tk, col(0.8 * alpha));
    o.rect(x - tk, cy - t / 2, tk, t, col(0.8 * alpha)); o.rect(x + w, cy - t / 2, tk, t, col(0.8 * alpha));
  }
  const text = readout(params.readout, it, f, score, hr, cx, cy, td);
  if (text && acquire > 0.6) {
    const fpx = Math.max(9, 15 * u), reveal = Math.ceil(text.length * clamp01((acquire - 0.6) / 0.4));
    const shown = text.slice(0, reveal), tw = o.textWidth(text, fpx);
    const ty = y - 3 * u - fpx * 1.5 >= 0 ? y - 3 * u - fpx * 1.5 : y + h + 3 * u + fpx * 0.2;
    o.rect(x - 3 * u, ty, tw + fpx * 0.6, fpx * 1.3, dark(0.55 * alpha));
    o.text(shown, x - 3 * u + fpx * 0.3, ty + fpx * 0.1, fpx, col(alpha));
  }
}

function readout(kind, it, f, score, hr, cx, cy, td) {
  const tick = Math.floor(f / 3);
  switch (kind) {
    case "off": return "";
    case "id": return `${it.kind === "person" ? "P" : "T"}-${pad(it.id % 10000, 4)}`;
    case "class": return it.kind === "person" ? "PERSON" : ["POINT", "OBJ", "OBJ", "GROUP"][it.level] ?? "OBJ";
    case "distance": {
      if (!hr) return "D --";
      const d = Math.hypot(cx - (hr[0] + hr[2] / 2), cy - (hr[1] + hr[3] / 2)) / Math.hypot(hr[2], hr[3]);
      return `D ${d.toFixed(2)}`;
    }
    case "confidence": return `CONF ${(0.62 + 0.36 * clamp01(score / 5) + 0.02 * hash(it.id, tick)).toFixed(2)}`;
    default: {   // telemetry: stable per ID, ticking every few frames
      const id = pad(it.id % 1000, 3), a = 40 + Math.floor(hash(it.id, 1) * 320);
      const drift = (hash(it.id, tick) - 0.5) * 6;
      return `TRK ${id}  ${pad(a + drift + 1000, 4).slice(1)}.${Math.floor(hash(it.id, tick + 7) * 10)}`;
    }
  }
}

/* ---------------- hero ---------------- */

function drawHero(o, r, f, seg, layout, params, col, dark, u, td) {
  const acqFrames = layout.P.acquire;
  const a = seg.cont ? 1 : clamp01((f - seg.acquire + 1) / acqFrames), e = easeOut(a);
  const blink = a < 1 ? ((f - seg.acquire) % 2 ? 1 : 0.4) : 1;
  const grow = 1 + 0.3 * (1 - e);
  const cx = r[0] + r[2] / 2, cy = r[1] + r[3] / 2, w = r[2] * grow, h = r[3] * grow;
  const x = cx - w / 2, y = cy - h / 2, m = Math.min(w, h);
  const lw = Math.max(1.5, params.heroStroke * o.height);
  if (params.heroBox !== "brackets") o.strokeRect(x, y, w, h, params.heroBox === "box" ? lw : Math.max(1, lw * 0.4), col((params.heroBox === "box" ? 1 : 0.55) * blink));
  if (params.heroBox !== "box") corners(o, x - lw, y - lw, w + 2 * lw, h + 2 * lw, m * params.bracket, lw * 1.4, col(blink));

  // Label tab: typed on once the thermal is in.
  if (f >= seg.labelAt && params.label) {
    const fpx = Math.max(9, params.labelSize * o.height), text = params.label.toUpperCase();
    const n = seg.cont ? text.length : Math.ceil(text.length * clamp01((f - seg.labelAt + 1) / Math.max(1, acqFrames)));
    const tw = o.textWidth(text, fpx), th = fpx * 1.35;
    const above = r[1] - lw * 2 - th >= 0;
    const ty = above ? r[1] - lw * 2 - th : r[1] + r[3] + lw * 2;
    const tx = Math.min(Math.max(0, r[0] - lw), o.width - tw - fpx);
    o.rect(tx, ty, tw + fpx * 0.7, th, col(0.92));
    o.text(text.slice(0, n), tx + fpx * 0.35, ty + fpx * 0.12, fpx, dark(1));
    if (params.readout !== "off") {
      const spx = fpx * 0.62;
      const info = `TGT P${pad(seg.personId, 2)}  X ${(cx / o.width).toFixed(3)}  Y ${(cy / o.height).toFixed(3)}`;
      o.text(info, tx + 1, above ? ty - spx * 1.35 : ty + th + spx * 0.25, spx, col(0.85));
    }
  }
}

/* ---------------- frame chrome ---------------- */

function drawChrome(o, f, layout, col, u, W, H) {
  const m = 28 * u, L = 46 * u, t = Math.max(1, 2 * u);
  corners(o, m, m, W - 2 * m, H - 2 * m, L, t, col(0.55));
  const fpx = Math.max(9, 16 * u), fps = layout.fps;
  const s = Math.floor(f / Math.round(fps)), ff = f % Math.round(fps);
  const tc = `${pad(s / 3600, 2)}:${pad(s / 60 % 60, 2)}:${pad(s % 60, 2)}:${pad(ff, 2)}`;
  o.text(`CAM 01  ${tc}`, m + 10 * u, m + 8 * u, fpx, col(0.75));
  const rec = "REC", tw = o.textWidth(rec, fpx);
  if (Math.floor(f / Math.round(fps / 2)) % 2 === 0) o.rect(W - m - tw - 30 * u, m + 8 * u + fpx * 0.3, fpx * 0.7, fpx * 0.7, col(0.9));
  o.text(rec, W - m - tw - 10 * u, m + 8 * u, fpx, col(0.75));
}

/* ---------------- shapes ---------------- */

function corners(o, x, y, w, h, len, lw, c) {
  len = Math.min(len, w / 2, h / 2);
  o.rect(x, y, len, lw, c); o.rect(x, y + lw, lw, len - lw, c);
  o.rect(x + w - len, y, len, lw, c); o.rect(x + w - lw, y + lw, lw, len - lw, c);
  o.rect(x, y + h - lw, len, lw, c); o.rect(x, y + h - len, lw, len - lw, c);
  o.rect(x + w - len, y + h - lw, len, lw, c); o.rect(x + w - lw, y + h - len, lw, len - lw, c);
}

function dashed(o, [x0, y0], [x1, y1], lw, on, off, c) {
  const L = Math.hypot(x1 - x0, y1 - y0);
  if (!L) return;
  const dx = (x1 - x0) / L, dy = (y1 - y0) / L;
  for (let s = 0; s < L; s += on + off) {
    const e = Math.min(L, s + on);
    o.line(x0 + dx * s, y0 + dy * s, x0 + dx * e, y0 + dy * e, lw, c);
  }
}

// Where the line from the rectangle's centre towards (tx, ty) leaves the rectangle.
function edgePoint(r, tx, ty) {
  const cx = r[0] + r[2] / 2, cy = r[1] + r[3] / 2, dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  const k = Math.min(dx ? (r[2] / 2) / Math.abs(dx) : Infinity, dy ? (r[3] / 2) / Math.abs(dy) : Infinity);
  return [cx + dx * Math.min(1, k), cy + dy * Math.min(1, k)];
}
