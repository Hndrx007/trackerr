// Cut detection for music-video footage: fast cuts, whip pans, strobes and flash frames.
//
// Signal: an HSV histogram (16 H × 4 S × 4 V) of the 160 px proxy per frame, and d(i), the
// distance between frames i−1 and i. Hue and saturation dominate the distance, so a
// brightness-only change (a strobe) scores low.
//
// Frame i is a candidate if d(i) > max(absMin, k × median(d over the previous ~1 s)).
// Flash rejection looks up to 3 frames ahead: if the picture comes back to what it was before
// frame i, it was a flash, not a cut. A refinement over the spec's plain rule: the frames in
// between must also look like a flash (their hue content didn't change). Otherwise a genuine
// 2-frame insert of a different shot (A A B B A A) would be thrown away as a "flash".

export const HB = 16, SB = 4, VB = 4, BINS = HB * SB * VB;
export const LOOKAHEAD = 3;

export const CUT_DEFAULTS = {
  k: 3,            // threshold = k × median of recent d
  absMin: 0.12,    // floor for the threshold
  low: 0.06,       // "the picture came back": distance to the pre-flash frame below this
  hueDistinct: 0.25, // intervening frames whose hue distance exceeds this are a real shot, not a flash
  hueSame: 0.05,   // a change with less hue difference than this is brightness only (strobe, exposure)
  windowSec: 1,
  minShot: 2,      // frames
};

/** Normalised HSV histogram of an RGBA image. Bin index = (h × SB + s) × VB + v. */
export function hsvHistogram(rgba, width, height, out = new Float32Array(BINS)) {
  out.fill(0);
  const n = width * height;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
    const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
    const c = max - min;
    let h = 0;
    if (c > 0) {
      if (max === r) h = ((g - b) / c + 6) % 6;
      else if (max === g) h = (b - r) / c + 2;
      else h = (r - g) / c + 4;
    }
    const hb = Math.min(HB - 1, (h / 6 * HB) | 0);
    const sb = max ? Math.min(SB - 1, (c / max * SB) | 0) : 0;
    const vb = Math.min(VB - 1, (max / 256 * VB) | 0);
    out[(hb * SB + sb) * VB + vb]++;
  }
  for (let i = 0; i < BINS; i++) out[i] /= n;
  return out;
}

const chi2 = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const t = a[i] + b[i]; if (t > 0) s += (a[i] - b[i]) ** 2 / t; }
  return s / 2;       // 0 (identical) … 1 (disjoint)
};

// Hue-saturation marginal. Pixels in the lowest saturation bin have unreliable hue, so they
// share one "achromatic" bin instead of 16 noisy hue bins.
function hsMarginal(h, out = new Float32Array(HB * (SB - 1) + 1)) {
  out.fill(0);
  for (let hb = 0; hb < HB; hb++)
    for (let sb = 0; sb < SB; sb++) {
      let m = 0;
      for (let vb = 0; vb < VB; vb++) m += h[(hb * SB + sb) * VB + vb];
      out[sb === 0 ? out.length - 1 : hb * (SB - 1) + sb - 1] += m;
    }
  return out;
}
function vMarginal(h, out = new Float32Array(VB)) {
  out.fill(0);
  for (let i = 0; i < BINS; i++) out[i % VB] += h[i];
  return out;
}
// Hue of chromatic pixels only, normalised; null when there's too little colour to tell.
function hueMarginal(h) {
  const out = new Float32Array(HB);
  let total = 0;
  for (let hb = 0; hb < HB; hb++)
    for (let sb = 1; sb < SB; sb++)
      for (let vb = 1; vb < VB; vb++) { const m = h[(hb * SB + sb) * VB + vb]; out[hb] += m; total += m; }
  if (total < 0.05) return null;
  for (let i = 0; i < HB; i++) out[i] /= total;
  return out;
}

/** d between two histograms: hue/saturation dominate, brightness counts a quarter. */
export function distance(a, b) {
  return chi2(hsMarginal(a), hsMarginal(b)) + 0.25 * chi2(vMarginal(a), vMarginal(b));
}

/**
 * A frame that looks like a flash or a dip: one brightness level holds most of the picture
 * (near-white, near-black, or flat). A black-and-white shot with real structure doesn't.
 */
export function flashLike(h, dominance = 0.7) {
  const v = vMarginal(h);
  return Math.max(...v) >= dominance;
}

/** How different the colour content is, ignoring brightness. null if either frame has little colour. */
export function hueDistance(a, b) {
  const x = hueMarginal(a), y = hueMarginal(b);
  return x && y ? chi2(x, y) : null;
}

const median = a => { const s = Float64Array.from(a).sort(); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * Streaming cut detector. push(hist) per frame in order; decisions come out LOOKAHEAD frames
 * behind. flush() at the end. A decision: { frame, d, threshold, cut, flash }.
 */
export class CutDetector {
  constructor({ fps = [24, 1], ...opts } = {}) {
    this.o = { ...CUT_DEFAULTS, ...opts };
    this.window = Math.max(3, Math.round(this.o.windowSec * fps[0] / fps[1]));
    this.hists = [];
    this.d = [];
    this.next = 0;          // next frame to decide
    this.lastCut = 0;
    this.flashUntil = -1;   // candidates up to here are the return from a flash
    this.flashy = new Set(); // frames judged to be flashes: kept out of the threshold's median
  }

  push(hist) {
    const i = this.hists.length;
    this.hists.push(Float32Array.from(hist));
    this.d.push(i ? distance(this.hists[i - 1], this.hists[i]) : 0);
    const out = [];
    while (this.next <= i - LOOKAHEAD) out.push(this.#decide(this.next++));
    return out;
  }

  flush() {
    const out = [];
    while (this.next < this.hists.length) out.push(this.#decide(this.next++));
    return out;
  }

  #decide(j) {
    const { o, d, hists } = this;
    // Median of recent d, leaving out flashes: a strobe run must not lift the threshold over a
    // real cut inside it.
    const prev = [];
    for (let m = Math.max(1, j - this.window); m < j; m++) if (!this.flashy.has(m)) prev.push(d[m]);
    const threshold = Math.max(o.absMin, prev.length >= 3 ? o.k * median(prev) : o.absMin);
    const res = { frame: j, d: d[j], threshold, cut: false, flash: false };
    if (j === 0 || d[j] <= threshold) return res;
    const flash = () => { res.flash = true; this.flashy.add(j); return res; };
    if (j <= this.flashUntil) return flash();
    // Brightness only: the colour content is the same, just lit differently.
    const hd = hueDistance(hists[j - 1], hists[j]);
    if (hd !== null && hd < o.hueSame) return flash();
    // Flash test: does the picture come back to frame j−1 within LOOKAHEAD frames?
    for (let k = 1; k <= LOOKAHEAD && j + k < hists.length; k++) {
      if (distance(hists[j - 1], hists[j + k]) >= o.low) continue;
      // Frames j … j+k−1 were different. A flash if their colour content didn't change, or if
      // they have no colour to compare and look like a flash (flat white or black).
      let distinct = true;
      for (let m = j; m < j + k; m++) {
        const hd = hueDistance(hists[j - 1], hists[m]);
        if (hd === null ? flashLike(hists[m]) : hd < o.hueDistinct) { distinct = false; break; }
      }
      if (!distinct) { this.flashUntil = j + k; return flash(); }
      break;
    }
    if (j - this.lastCut < o.minShot) return res;
    res.cut = true;
    this.lastCut = j;
    return res;
  }
}

/** Runs the detector over a whole sequence of histograms. */
export function detectCuts(hists, opts) {
  const det = new CutDetector(opts);
  const out = [];
  for (const h of hists) out.push(...det.push(h));
  out.push(...det.flush());
  return out;
}
