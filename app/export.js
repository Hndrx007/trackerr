// Export: decode → renderer at source resolution → H.264 encode → MP4 streamed to disk.
// Verification: reopen the written file and check it against the source, frame by frame.
import {
  Output, Mp4OutputFormat, MovOutputFormat, StreamTarget, EncodedVideoPacketSource, EncodedAudioPacketSource,
  EncodedPacketSink, EncodedPacket,
} from "./lib.js";
import { openSource, frames, frameReader, fpsLabel } from "./media.js";
import { pickEncoder } from "./env.js";
import { Renderer } from "./render/renderer.js";
import { readMarker } from "./render/burnin.js";
import { UserError } from "./errors.js";

/**
 * Colour tags for the output. The pipeline passes primaries and transfer through untouched
 * (no gamma or gamut conversion happens anywhere), so those come from the source. Matrix and
 * range describe the RGB→YUV conversion the encoder actually did, so those come from the encoder.
 * Untagged sources are treated as Rec.709, which is what Resolve assumes for them too.
 */
export function outputColorSpace(src = {}, encoderReported = {}) {
  return {
    primaries: src.primaries ?? "bt709",
    transfer: src.transfer ?? "bt709",
    matrix: encoderReported.matrix ?? src.matrix ?? "bt709",
    fullRange: encoderReported.fullRange ?? src.fullRange ?? false,
  };
}

/**
 * The export's container. With audio, a MOV source gives a MOV: Resolve renders MOVs with PCM
 * audio, which belongs in MOV. Everything else is MP4.
 */
export const exportExtension = (info, audio) => audio && info.audio && info.quicktime ? "mov" : "mp4";

const isPcm = codec => /^pcm-|^ulaw$|^alaw$/.test(codec);

/**
 * Copies the source's audio packets into `output` unchanged (no re-encode), shifted so they keep
 * their place against the picture: source time `offset` becomes 0. `feed(t)` adds every packet that
 * starts before t, so the caller can interleave audio with the video as it goes rather than
 * making the muxer hold a whole track. Must be created before output.start().
 *
 * Compressed audio (AAC) can only be cut between packets. The packet playing at `offset` usually
 * starts a little before it, and is kept with a negative timestamp, the way AAC encoder priming is
 * stored, so the first frame of picture has its sound. PCM can be cut at any sample, so it's
 * trimmed to start at exactly 0 and to end with the picture.
 */
async function audioCopier(source, output, offset, duration) {
  const track = source.audioTrack, codec = await track.getCodec();
  if (!output.format.getSupportedAudioCodecs().includes(codec))
    throw new UserError(`The clip's audio is ${codec}, which can't be copied into the export. Untick Include audio, or render the audio from Resolve as AAC.`);
  const src = new EncodedAudioPacketSource(codec);
  output.addAudioTrack(src);
  const decoderConfig = await track.getDecoderConfig();
  const sink = new EncodedPacketSink(track), pcm = isPcm(codec), rate = await track.getSampleRate();
  const first = await sink.getPacket(offset) ?? await sink.getFirstPacket();
  const it = first && sink.packets(first);
  let next = first && (await it.next()).value, count = 0;
  return {
    codec,
    get count() { return count; },
    async feed(until) {
      while (next && next.timestamp - offset < Math.min(until, duration)) {
        const t = next.timestamp - offset;
        const packet = t + next.duration <= 0 ? null : pcm ? trimPcm(next, t, duration, rate) : next.clone({ timestamp: t });
        if (packet) {
          await src.add(packet, count ? undefined : { decoderConfig });
          count++;
        }
        const r = await it.next();
        next = r.done ? null : r.value;
      }
    },
  };
}

// Cuts a PCM packet (placed at time t) to the samples inside [0, duration).
function trimPcm(p, t, duration, rate) {
  const frames = Math.round(p.duration * rate), bytesPerFrame = p.data.byteLength / frames;
  const a = Math.max(0, Math.round(-t * rate)), b = Math.min(frames, Math.round((duration - t) * rate));
  if (b <= a) return null;
  if (a === 0 && b === frames) return p.clone({ timestamp: t });
  return new EncodedPacket(p.data.subarray(a * bytesPerFrame, b * bytesPerFrame), "key", t + a / rate, (b - a) / rate);
}

/**
 * Renders and encodes every frame of `source` into `fileHandle` (a FileSystemFileHandle from
 * showSaveFilePicker, or an OPFS handle in tests). Output frame i is stamped i × den/num seconds:
 * the same frame count and rate as the source, starting at 0.
 *
 * WebCodecs' VideoEncoder is driven directly, not through Mediabunny's encoder wrapper, so the
 * colour tags written to the file are ours rather than whatever the browser reports: Chrome
 * sometimes tags canvas frames with the sRGB transfer curve, which Resolve would honour.
 *
 * @param {object} p
 * @param {(o, index) => void} p.overlay  draws on top of each frame (renderer overlay API)
 * @param {number} p.bitrate  bits per second
 * @param {(s: {done, total, fps, eta}) => void} [p.onProgress]
 * @param {AbortSignal} [p.signal]
 * @param {boolean} [p.audio]  copy the source's audio track (exportExtension gives the container)
 */
export async function exportClip({ source, fileHandle, overlay, bitrate, onProgress, signal, audio = false, start = 0, end = source.info.frameCount }) {
  const { width, height, fps } = source.info;
  const frameCount = end - start;   // a range is for review renders; the app always exports the whole clip
  const enc = await pickEncoder({ width, height, fps, bitrate });
  let writable = null, bytes = 0;
  const target = new StreamTarget(new WritableStream({
    async write(chunk) {
      bytes = Math.max(bytes, chunk.position + chunk.data.byteLength);
      await writable.write({ type: "write", position: chunk.position, data: chunk.data });
    },
    close: () => writable?.close(),
    abort: reason => writable?.abort(reason),
  }), { chunked: true });

  // fastStart stays off: moving the index to the front would hold the whole file in memory.
  const container = exportExtension(source.info, audio);
  const format = container === "mov" ? new MovOutputFormat({ fastStart: false }) : new Mp4OutputFormat({ fastStart: false });
  const output = new Output({ format, target });
  const video = new EncodedVideoPacketSource("avc");
  output.addVideoTrack(video, { frameRate: fps[0] / fps[1] });
  const frameS = fps[1] / fps[0];
  const sound = audio && source.audioTrack
    ? await audioCopier(source, output, source.info.timestamps[start], frameCount * frameS) : null;

  // Packets go to the muxer in order; `muxing` is the tail of that chain.
  let muxing = Promise.resolve(), queued = 0, encoderError = null, reported = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig) {
        reported = meta.decoderConfig.colorSpace ?? {};
        meta = { ...meta, decoderConfig: { ...meta.decoderConfig, colorSpace: outputColorSpace(source.info.colorSpace, reported) } };
      }
      const packet = EncodedPacket.fromEncodedChunk(chunk);
      queued++;
      muxing = muxing.then(() => video.add(packet, meta)).finally(() => queued--);
      muxing.catch(e => { encoderError ??= e; });
    },
    error: e => { encoderError ??= e; },
  });

  // Everything that can fail on setup happens above; the file is opened last.
  const renderer = new Renderer(new OffscreenCanvas(width, height));
  const frameUs = 1e6 * fps[1] / fps[0];
  const gop = Math.max(1, Math.round(fps[0] / fps[1]));   // a keyframe every second
  const t0 = performance.now();
  let done = 0, lastReport = 0;
  try {
    encoder.configure({
      codec: enc.codec, width, height, bitrate, framerate: fps[0] / fps[1],
      hardwareAcceleration: enc.accel, latencyMode: "quality", bitrateMode: "variable",
      avc: { format: "avc" },
    });
    writable = await fileHandle.createWritable({ keepExistingData: false });
    await output.start();
    for await (const { index, sample } of frames(source, { start, end, signal })) {
      renderer.render(sample, o => overlay?.(o, index));
      const k = index - start;
      const frame = new VideoFrame(renderer.canvas, {
        timestamp: Math.round(k * frameUs), duration: Math.round(frameUs),
      });
      try { encoder.encode(frame, { keyFrame: k % gop === 0 }); } finally { frame.close(); }
      // Backpressure: keep the encoder and the muxer from running far behind the decoder.
      while ((encoder.encodeQueueSize > 4 || queued > 16) && !encoderError)
        await (encoder.encodeQueueSize > 4 ? new Promise(r => encoder.addEventListener("dequeue", r, { once: true })) : muxing);
      if (encoderError) throw encoderError;
      done = k + 1;
      await sound?.feed(done * frameS);
      const now = performance.now();
      if (onProgress && (now - lastReport > 250 || done === frameCount)) {
        lastReport = now;
        const rate = done / ((now - t0) / 1000);
        onProgress({ done, total: frameCount, fps: rate, eta: (frameCount - done) / rate });
      }
    }
    signal?.throwIfAborted();
    await encoder.flush();
    await sound?.feed(Infinity);
    await muxing;
    if (encoderError) throw encoderError;
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => {});
    await writable?.abort().catch(() => {});
    throw e;
  } finally {
    if (encoder.state !== "closed") encoder.close();
    renderer.dispose();
  }
  const seconds = (performance.now() - t0) / 1000;
  return {
    codec: enc.codec, accel: enc.accel, bitrate, bytes, seconds, fps: frameCount / seconds, encoderColorSpace: reported,
    container, audio: sound && { codec: sound.codec, packets: sound.count },
  };
}

/**
 * Reopens the export and checks it against the source. A failed check is a bug.
 * Returns { pass, checks: [{ name, pass, detail, level: "error" | "warn" }] }.
 *
 * @param {File} file  the written export (fileHandle.getFile())
 * @param {object} [o]
 * @param {boolean} [o.marker]  read the burn-in marker on every frame (M1 test overlay)
 * @param {boolean} [o.compare]  compare the picture with the source (only meaningful when the overlay leaves part of it alone)
 * @param {boolean} [o.audio]  the export should carry the source's audio, copied and in sync
 */
export async function verifyExport(file, source, { marker = false, compare = true, audio = false, onProgress, signal } = {}) {
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

    if (audio && source.audioTrack) await checkAudio(out, source, add);

    // Primaries and transfer must match (an sRGB transfer tag would make Resolve change the gamma).
    // Matrix and range may legitimately differ: they describe how this file's YUV was made.
    const want = outputColorSpace(src.colorSpace, {});
    const cs = k => o.colorSpace[k] ?? "unset";
    const tagOk = cs("primaries") === want.primaries && cs("transfer") === want.transfer;
    add("Colour tags match the source", tagOk,
      ["primaries", "transfer", "matrix", "fullRange"].map(k =>
        `${k} ${cs(k)}${k in src.colorSpace && src.colorSpace[k] !== undefined && cs(k) !== src.colorSpace[k] ? ` (source ${src.colorSpace[k]})` : ""}`).join(", "));

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
    if (colour.n && compare) {
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

/**
 * The export's audio must be the source's audio, byte for byte, at its source time minus the
 * picture's start time, with nothing missing up to the end of the picture.
 */
async function checkAudio(out, source, add) {
  const src = source.info.audio, o = out.info.audio;
  add("Audio copied from the source", !!o && o.codec === src.codec && o.sampleRate === src.sampleRate && o.channels === src.channels,
    o ? `${describeAudio(o)} (source ${describeAudio(src)})` : `no audio track (source ${describeAudio(src)})`);
  if (!o) return;
  const offset = source.info.startTime, picture = out.info.frameCount * out.info.fps[1] / out.info.fps[0];
  const r = await (isPcm(src.codec) ? comparePcm : comparePackets)(out.audioTrack, source.audioTrack, offset, src.sampleRate);
  // Nothing may be missing at the end: the source's audio either runs past the picture or ends where the export's does.
  const srcEnd = (await source.audioTrack.computeDuration()) - offset;
  const complete = r.end >= Math.min(picture, srcEnd) - 1e-4;
  add("Audio in sync with the picture", r.n > 0 && !r.differ && r.worst < 1e-4 && complete,
    !r.n ? "no audio packets"
      : r.differ ? `${r.differ} of ${r.n} audio packets differ from the source`
      : r.worst >= 1e-4 ? `audio is up to ${(r.worst * 1000).toFixed(2)} ms off its place against the picture`
      : !complete ? `audio stops at ${r.end.toFixed(3)} s, before the picture ends at ${picture.toFixed(3)} s`
      : `identical to the source and at its source time, ${r.start.toFixed(3)} to ${r.end.toFixed(3)} s (picture 0 to ${picture.toFixed(3)} s)`);
}

// Compressed audio: packet i of the export is a source packet, same bytes, at its source time.
async function comparePackets(outTrack, srcTrack, offset) {
  const srcSink = new EncodedPacketSink(srcTrack);
  let n = 0, worst = 0, differ = 0, start = 0, end = 0, srcIt = null;
  for await (const p of new EncodedPacketSink(outTrack).packets()) {
    if (!srcIt) { srcIt = srcSink.packets(await srcSink.getPacket(p.timestamp + offset) ?? undefined); start = p.timestamp; }
    const s = (await srcIt.next()).value;
    if (!s) { differ++; break; }
    worst = Math.max(worst, Math.abs(p.timestamp + offset - s.timestamp));
    if (!sameBytes(p.data, s.data)) differ++;
    n++; end = p.timestamp + p.duration;
  }
  return { n, worst, differ, start, end };
}

// PCM: the muxer regroups samples into its own chunks, so compare the sample stream. It must
// start at the right source sample, run without gaps and match byte for byte.
async function comparePcm(outTrack, srcTrack, offset, rate) {
  const srcSink = new EncodedPacketSink(srcTrack);
  let n = 0, worst = 0, differ = 0, start = 0, end = null, srcIt = null, buf = null, pos = 0;
  for await (const p of new EncodedPacketSink(outTrack).packets()) {
    if (!srcIt) {
      const s = await srcSink.getPacket(p.timestamp + offset) ?? await srcSink.getFirstPacket();
      const bytesPerFrame = s.data.byteLength / Math.round(s.duration * rate);
      const skip = Math.max(0, Math.round((p.timestamp + offset - s.timestamp) * rate));
      worst = Math.abs(p.timestamp + offset - (s.timestamp + skip / rate));
      srcIt = srcSink.packets(s);
      buf = (await srcIt.next()).value.data; pos = skip * bytesPerFrame;
      start = p.timestamp;
    } else worst = Math.max(worst, Math.abs(p.timestamp - end));   // no gaps between chunks
    n++; end = p.timestamp + p.duration;
    let same = true;
    for (let i = 0; i < p.data.length && same;) {
      if (pos >= buf.length) {
        const r = await srcIt.next();
        if (r.done) { same = false; break; }
        buf = r.value.data; pos = 0;
      }
      const k = Math.min(p.data.length - i, buf.length - pos);
      for (let j = 0; j < k; j++) if (p.data[i + j] !== buf[pos + j]) { same = false; break; }
      i += k; pos += k;
    }
    if (!same) differ++;
  }
  return { n, worst, differ, start, end: end ?? 0 };
}

export const describeAudio = a => `${a.codec}, ${(a.sampleRate / 1000).toLocaleString("en-US")} kHz, ${a.channels === 1 ? "mono" : a.channels === 2 ? "stereo" : `${a.channels} channels`}`;

function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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
