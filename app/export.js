// Export: decode → renderer at source resolution → H.264 encode → MP4 streamed to disk.
// Verification: reopen the written file and check it against the source, frame by frame.
import { Output, Mp4OutputFormat, StreamTarget, VideoSampleSource, VideoSample } from "./lib.js";
import { openSource, frames, frameReader, fpsLabel } from "./media.js";
import { pickEncoder } from "./env.js";
import { Renderer } from "./render/renderer.js";
import { readMarker } from "./render/burnin.js";
import { UserError } from "./errors.js";

/**
 * Renders and encodes every frame of `source` into `fileHandle` (a FileSystemFileHandle from
 * showSaveFilePicker, or an OPFS handle in tests). Output frame i is stamped i × den/num seconds:
 * the same frame count and rate as the source, starting at 0.
 *
 * @param {object} p
 * @param {(o, index) => void} p.overlay  draws on top of each frame (renderer overlay API)
 * @param {number} p.bitrate  bits per second
 * @param {(s: {done, total, fps, eta}) => void} [p.onProgress]
 * @param {AbortSignal} [p.signal]
 */
export async function exportClip({ source, fileHandle, overlay, bitrate, onProgress, signal }) {
  const { width, height, fps, frameCount } = source.info;
  const enc = await pickEncoder({ width, height, fps, bitrate });
  let writable = null, bytes = 0;
  const target = new StreamTarget(new WritableStream({
    async write(chunk) {
      bytes = Math.max(bytes, chunk.position + chunk.data.byteLength);
      await writable.write({ type: "write", position: chunk.position, data: chunk.data });
    },
    close: () => writable.close(),
    abort: reason => writable?.abort(reason),
  }), { chunked: true });

  // fastStart stays off: moving the index to the front would hold the whole file in memory.
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
  const video = new VideoSampleSource({
    codec: "avc", fullCodecString: enc.codec, bitrate, keyFrameInterval: 1,
    hardwareAcceleration: enc.accel, latencyMode: "quality",
  });
  output.addVideoTrack(video, { frameRate: fps[0] / fps[1] });

  // Everything that can fail on setup happens above; the file is opened last.
  const renderer = new Renderer(new OffscreenCanvas(width, height));
  const frameUs = 1e6 * fps[1] / fps[0];
  const t0 = performance.now();
  let done = 0, lastReport = 0;
  try {
    writable = await fileHandle.createWritable({ keepExistingData: false });
    await output.start();
    for await (const { index, sample } of frames(source, { signal })) {
      renderer.render(sample, o => overlay?.(o, index));
      const out = new VideoSample(new VideoFrame(renderer.canvas, {
        timestamp: Math.round(index * frameUs), duration: Math.round(frameUs),
      }));
      try { await video.add(out); } finally { out.close(); }
      done = index + 1;
      const now = performance.now();
      if (onProgress && (now - lastReport > 250 || done === frameCount)) {
        lastReport = now;
        const rate = done / ((now - t0) / 1000);
        onProgress({ done, total: frameCount, fps: rate, eta: (frameCount - done) / rate });
      }
    }
    signal?.throwIfAborted();
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => {});
    await writable?.abort().catch(() => {});
    throw e;
  } finally {
    renderer.dispose();
  }
  const seconds = (performance.now() - t0) / 1000;
  return { codec: enc.codec, accel: enc.accel, bitrate, bytes, seconds, fps: frameCount / seconds };
}

/**
 * Reopens the export and checks it against the source. A failed check is a bug.
 * Returns { pass, checks: [{ name, pass, detail, level: "error" | "warn" }] }.
 *
 * @param {File} file  the written export (fileHandle.getFile())
 * @param {object} [o]
 * @param {boolean} [o.marker]  read the burn-in marker on every frame (M1 test overlay)
 */
export async function verifyExport(file, source, { marker = false, onProgress, signal } = {}) {
  const checks = [];
  const add = (name, pass, detail, level = "error") => checks.push({ name, pass, detail, level });
  const src = source.info;

  let out;
  try { out = await openSource(file); }
  catch (e) {
    add("Output opens as a valid H.264 clip", false, e.message);
    return { pass: false, checks };
  }
  try {
    const o = out.info;
    add("Output opens as a valid H.264 clip", true, `${o.container}, ${o.codecString}`);
    add("Resolution", o.width === src.width && o.height === src.height,
      `${o.width}×${o.height} (source ${src.width}×${src.height})`);
    add("Frame count", o.frameCount === src.frameCount,
      `${o.frameCount.toLocaleString("en-US")} (source ${src.frameCount.toLocaleString("en-US")})`);
    add("Frame rate", o.fps[0] * src.fps[1] === src.fps[0] * o.fps[1],
      `${fpsLabel(o.fps)} = ${o.fps.join("/")} (source ${src.fps.join("/")})`);

    // Every frame sits exactly on the grid i × den/num, starting at 0.
    const dt = o.fps[1] / o.fps[0];
    let worst = 0, worstAt = 0;
    o.timestamps.forEach((t, i) => { const e = Math.abs(t - i * dt); if (e > worst) { worst = e; worstAt = i; } });
    add("Frame timing", worst < 1e-4,
      worst < 1e-4 ? `every frame on its slot, first at ${o.startTime.toFixed(3)} s`
        : `frame ${worstAt} is ${(worst * 1000).toFixed(2)} ms off its slot`);

    const cs = k => o.colorSpace[k] ?? "unset", ss = k => src.colorSpace[k] ?? "unset";
    const keys = ["primaries", "transfer", "matrix", "fullRange"];
    const same = keys.every(k => cs(k) === ss(k));
    add("Colour tags match the source", same,
      keys.map(k => `${k} ${cs(k)}${cs(k) === ss(k) ? "" : ` (source ${ss(k)})`}`).join(", "), "warn");

    // Decode the output at proxy size: read the burn-in marker, and compare colour against the source.
    const pw = Math.min(480, o.width), ph = Math.round(pw * o.height / o.width);
    const ctx = new OffscreenCanvas(pw, ph).getContext("2d", { willReadFrequently: true });
    const ctxSrc = new OffscreenCanvas(pw, ph).getContext("2d", { willReadFrequently: true });
    const readSrc = frameReader(source);
    const probeAt = new Set([0, 1, Math.floor(o.frameCount / 2), o.frameCount - 2, o.frameCount - 1]
      .filter(i => i >= 0 && i < Math.min(o.frameCount, src.frameCount)));
    let bad = 0, firstBad = null;
    const colour = { n: 0, bias: [0, 0, 0], mad: 0 };
    let decodeError = null;
    try {
      for await (const { index, sample } of frames(out, { signal })) {
        if (!marker && !probeAt.has(index)) continue;
        sample.draw(ctx, 0, 0, pw, ph);
        const px = ctx.getImageData(0, 0, pw, ph).data;
        if (marker) {
          const got = readMarker(px, pw, ph, o.width, o.height);
          if (got !== index) { bad++; firstBad ??= { index, got }; }
        }
        if (probeAt.has(index)) {
          const s = await readSrc(index);
          try { s.draw(ctxSrc, 0, 0, pw, ph); } finally { s.close(); }
          compareRight(ctxSrc.getImageData(0, 0, pw, ph).data, px, pw, ph, colour);
        }
        if (index % 30 === 0) onProgress?.({ done: index + 1, total: o.frameCount });
      }
    } catch (e) {
      if (e.name === "AbortError") throw e;
      decodeError = e;
    }
    add("Every frame decodes in order", !decodeError, decodeError ? decodeError.message : "no gaps, duplicates or reordering");
    if (marker)
      add("Frame N shows N (burn-in marker on every frame)", bad === 0,
        bad === 0 ? `all ${o.frameCount.toLocaleString("en-US")} frames read back their own index`
          : `${bad} frames wrong; first at frame ${firstBad.index}, which shows ${firstBad.got ?? "an unreadable marker"}`);
    if (colour.n) {
      const bias = colour.bias.map(b => b / colour.n), mad = colour.mad / colour.n;
      const ok = bias.every(b => Math.abs(b) < 3) && mad < 10;
      add("Picture matches the source outside the overlay", ok,
        `mean difference ${mad.toFixed(2)} levels; bias R ${bias[0].toFixed(2)} G ${bias[1].toFixed(2)} B ${bias[2].toFixed(2)} (${probeAt.size} frames)`,
        "warn");
    }
  } finally {
    out.dispose();
  }
  return { pass: checks.every(c => c.pass || c.level !== "error"), checks };
}

// Compares the right half of two RGBA proxies (the M1 overlay sits on the left).
function compareRight(a, b, w, h, acc) {
  let n = 0, mad = 0;
  const bias = [0, 0, 0];
  for (let y = 0; y < h; y++)
    for (let x = w >> 1; x < w; x++) {
      const j = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) { const d = b[j + c] - a[j + c]; bias[c] += d; mad += Math.abs(d); }
      n++;
    }
  acc.n++;
  acc.mad += mad / (n * 3);
  for (let c = 0; c < 3; c++) acc.bias[c] += bias[c] / n;
}

/** Throws a UserError if the browser can't do export at all (checked before the save dialog). */
export function assertCanExport() {
  if (!("showSaveFilePicker" in self))
    throw new UserError("This browser can't save files straight to disk. Open the tool in Chrome or Edge to export.");
}
