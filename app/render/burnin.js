// M1 test overlay: the frame index as large text, plus a machine-readable marker that the
// export verifier reads back from the encoded file. Proves "frame N of the output shows N"
// for every frame, not just the ones a person checks by eye.
//
// Marker: a row of square blocks at the bottom left on a black backing.
//   [white][black] calibration, then 20 data bits (index, MSB first), then 4 check bits.

const DATA_BITS = 20, CHECK_BITS = 4, BLOCKS = 2 + DATA_BITS + CHECK_BITS;
export const MAX_MARKER_INDEX = (1 << DATA_BITS) - 1;

const checksum = v => ((v ^ (v >> 4) ^ (v >> 8) ^ (v >> 12) ^ (v >> 16)) & 0xf) ^ 0x5;

export function markerBits(index) {
  const v = index & MAX_MARKER_INDEX, c = checksum(v), bits = [1, 0];
  for (let b = DATA_BITS - 1; b >= 0; b--) bits.push((v >> b) & 1);
  for (let b = CHECK_BITS - 1; b >= 0; b--) bits.push((c >> b) & 1);
  return bits;
}

/** Block geometry in output pixels, top-left origin. Sized from the frame so it survives any resolution. */
export function markerLayout(width, height) {
  const s = Math.max(4, Math.floor(Math.min(height / 36, width / (BLOCKS + 4))));
  return { s, x: s * 2, y: height - s * 3, blocks: BLOCKS };
}

/** Draws the burn-in through the renderer's overlay API. */
export function drawBurnIn(o, index) {
  const { width: W, height: H } = o;
  // Frame number, top left, on a dark backing so it reads on any footage.
  const px = Math.round(H * 0.12), m = Math.round(H * 0.04);
  const label = String(index);
  const tw = o.textWidth(label, px);
  o.rect(m, m, tw + px * 0.5, px * 1.25, [0, 0, 0, 0.75]);
  o.text(label, m + px * 0.25, m + px * 0.12, px, [1, 1, 1, 1]);

  const L = markerLayout(W, H);
  o.rect(L.x - L.s, L.y - L.s, (L.blocks + 2) * L.s, L.s * 3, [0, 0, 0, 1]);
  markerBits(index).forEach((bit, i) => {
    if (bit) o.rect(L.x + i * L.s, L.y, L.s, L.s, [1, 1, 1, 1]);
  });
}

/**
 * Reads the marker from RGBA pixels of a frame scaled to pw×ph (a small proxy; never 4K).
 * Returns the frame index, or null if the marker is unreadable or fails its check bits.
 */
export function readMarker(rgba, pw, ph, width, height) {
  const L = markerLayout(width, height), k = pw / width;
  const luma = i => {
    // Mean of the central half of block i.
    const cx = (L.x + (i + 0.5) * L.s) * k, cy = (L.y + 0.5 * L.s) * k, r = Math.max(0.5, L.s * k * 0.25);
    let sum = 0, n = 0;
    for (let y = Math.round(cy - r); y <= Math.round(cy + r); y++)
      for (let x = Math.round(cx - r); x <= Math.round(cx + r); x++) {
        if (x < 0 || y < 0 || x >= pw || y >= ph) continue;
        const j = (y * pw + x) * 4;
        sum += rgba[j] * 0.299 + rgba[j + 1] * 0.587 + rgba[j + 2] * 0.114; n++;
      }
    return n ? sum / n : 0;
  };
  const white = luma(0), black = luma(1);
  if (white - black < 64) return null;
  const thr = (white + black) / 2;
  let v = 0, c = 0;
  for (let b = 0; b < DATA_BITS; b++) v = (v << 1) | (luma(2 + b) > thr ? 1 : 0);
  for (let b = 0; b < CHECK_BITS; b++) c = (c << 1) | (luma(2 + DATA_BITS + b) > thr ? 1 : 0);
  return c === checksum(v) ? v : null;
}
