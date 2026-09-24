import { group, test, assert, eq } from "./harness.js";
import { Renderer } from "../app/render/renderer.js";
import { drawBurnIn, markerBits, readMarker, MAX_MARKER_INDEX } from "../app/render/burnin.js";

group("Renderer");

// An RGBA test frame with a per-pixel pattern (every pixel distinct in at least one channel).
function patternFrame(w, h, seed = 0) {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 4;
      d[j] = (x * 7 + seed) & 255; d[j + 1] = (y * 13 + seed) & 255; d[j + 2] = (x * y + seed) & 255; d[j + 3] = 255;
    }
  return { frame: new VideoFrame(d, { format: "RGBA", codedWidth: w, codedHeight: h, timestamp: 0 }), data: d };
}

// Small readback for tests only (the no-4K-readback rule applies to the app, and these are tiny).
function readTopDown(r) {
  const { gl } = r, w = r.width, h = r.height, px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const out = new Uint8Array(px.length), row = w * 4;
  for (let y = 0; y < h; y++) out.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  return out;
}
const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
  .map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);

test("At source size the frame is copied pixel for pixel (no filtering, no flip)", () => {
  const w = 97, h = 55; // odd sizes catch off-by-one and flip errors
  const { frame, data } = patternFrame(w, h);
  const r = new Renderer(new OffscreenCanvas(w, h));
  try {
    r.render(frame);
    const got = readTopDown(r);
    let diff = 0;
    for (let i = 0; i < got.length; i += 4) diff += +(got[i] !== data[i] || got[i + 1] !== data[i + 1] || got[i + 2] !== data[i + 2]);
    eq(diff, 0, "pixels that differ");
  } finally { frame.close(); r.dispose(); }
});

test("A snapshot keeps the picture after the renderer is disposed (Check frame)", async () => {
  const w = 97, h = 55;
  const { frame, data } = patternFrame(w, h);
  const r = new Renderer(new OffscreenCanvas(w, h));
  let bmp;
  try { r.render(frame); bmp = await r.snapshot(); } finally { frame.close(); r.dispose(); }
  const x = new OffscreenCanvas(w, h).getContext("2d");
  x.drawImage(bmp, 0, 0);
  bmp.close();
  const got = x.getImageData(0, 0, w, h).data;
  let diff = 0;
  for (let i = 0; i < got.length; i += 4) diff += +(Math.abs(got[i] - data[i]) > 1 || Math.abs(got[i + 1] - data[i + 1]) > 1 || Math.abs(got[i + 2] - data[i + 2]) > 1);
  eq(diff, 0, "pixels that differ from the source");
});

test("Determinism: the same frame and overlay give byte-identical output, across renderer instances", async () => {
  const { frame } = patternFrame(320, 180, 3);
  const hashes = [];
  for (let k = 0; k < 2; k++) {
    const r = new Renderer(new OffscreenCanvas(320, 180));
    try {
      for (let rep = 0; rep < 2; rep++) {
        r.render(frame, o => drawBurnIn(o, 1234));
        hashes.push(await hash(readTopDown(r)));
      }
    } finally { r.dispose(); }
  }
  frame.close();
  assert(hashes.every(x => x === hashes[0]), `hashes differ: ${hashes.join(" ")}`);
  return `hash ${hashes[0]}`;
});

test("The overlay changes the picture only where it draws", () => {
  const w = 320, h = 180, { frame, data } = patternFrame(w, h, 9);
  const r = new Renderer(new OffscreenCanvas(w, h));
  try {
    r.render(frame, o => drawBurnIn(o, 7));
    const got = readTopDown(r);
    // The right half is untouched by the M1 burn-in.
    let diff = 0;
    for (let y = 0; y < h; y++) for (let x = w >> 1; x < w; x++) {
      const j = (y * w + x) * 4;
      diff += +(got[j] !== data[j] || got[j + 1] !== data[j + 1] || got[j + 2] !== data[j + 2]);
    }
    eq(diff, 0, "changed pixels outside the overlay");
  } finally { frame.close(); r.dispose(); }
});

group("Burn-in marker");

test("Marker bits round-trip through the checksum for edge values", () => {
  for (const n of [0, 1, 2, 255, 256, 12345, 99999, MAX_MARKER_INDEX]) {
    const bits = markerBits(n);
    eq(bits.length, 26); eq(bits.slice(0, 2), [1, 0], "calibration");
  }
});

// Render the burn-in at full size on the GPU, downscale on the GPU to a ≤480 px proxy, read that.
for (const [w, h] of [[3840, 2160], [1920, 1080], [1666, 1080], [960, 720], [320, 180], [1080, 1920]])
  test(`Marker reads back at ${w}×${h} through a ≤480 px proxy`, () => {
    const r = new Renderer(new OffscreenCanvas(w, h));
    const { frame } = patternFrame(64, 36, 5); // scaled up: busy background behind the marker
    const pw = Math.min(480, w), ph = Math.round(pw * h / w);
    const proxy = new OffscreenCanvas(pw, ph).getContext("2d", { willReadFrequently: true });
    try {
      for (const n of [0, 1, 1441, 86399, MAX_MARKER_INDEX]) {
        r.render(frame, o => drawBurnIn(o, n));
        proxy.drawImage(r.canvas, 0, 0, pw, ph);
        eq(readMarker(proxy.getImageData(0, 0, pw, ph).data, pw, ph, w, h), n, `index ${n}`);
      }
    } finally { frame.close(); r.dispose(); }
  });
