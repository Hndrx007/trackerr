// Thermal palettes as 256-entry RGB lookup tables (the renderer uploads them as 256×1 textures).
// Each is defined by a few control points and interpolated linearly in sRGB.

const STOPS = {
  // Close to matplotlib's inferno: black → purple → red-orange → yellow-white.
  inferno: [
    [0, 0, 0, 4], [0.1, 22, 11, 57], [0.2, 66, 10, 104], [0.3, 106, 23, 110], [0.4, 147, 38, 103],
    [0.5, 188, 55, 84], [0.6, 221, 81, 58], [0.7, 243, 118, 27], [0.8, 252, 165, 10], [0.9, 246, 215, 70], [1, 252, 255, 164],
  ],
  // The classic "iron" / ironbow look of FLIR cameras.
  iron: [
    [0, 0, 0, 10], [0.15, 32, 0, 100], [0.35, 145, 0, 157], [0.55, 229, 64, 45], [0.75, 250, 164, 10], [0.9, 255, 230, 110], [1, 255, 255, 240],
  ],
  whitehot: [[0, 8, 8, 8], [1, 250, 250, 250]],
};

const cache = new Map();

/** Uint8Array(256 × 4) RGBA for `name`. */
export function paletteLUT(name) {
  if (cache.has(name)) return cache.get(name);
  const stops = STOPS[name] ?? STOPS.inferno, out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && stops[k + 1][0] < t) k++;
    const [t0, ...a] = stops[k], [t1, ...b] = stops[k + 1];
    const u = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(a[c] + (b[c] - a[c]) * u);
    out[i * 4 + 3] = 255;
  }
  cache.set(name, out);
  return out;
}

export const PALETTES = Object.keys(STOPS);
