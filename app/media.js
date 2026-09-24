// Mediabunny input: validation, the frame table, and the one frame iterator that analysis
// and export both use, so that frame N means the same image everywhere.
import {
  Input, ALL_FORMATS, BlobSource, EncodedPacketSink, VideoSampleSink,
  Mp4InputFormat, QuickTimeInputFormat,
} from "./lib.js";
import { UserError } from "./errors.js";

export const MAX_WIDTH = 3840, MAX_HEIGHT = 2160;

const STANDARD_RATES = [
  [24000, 1001], [24, 1], [25, 1], [30000, 1001], [30, 1], [48, 1], [50, 1],
  [60000, 1001], [60, 1], [100, 1], [120000, 1001], [120, 1],
];

const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
export const median = a => {
  const s = Float64Array.from(a).sort(), m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : NaN;
};
export const fpsValue = ([num, den]) => num / den;
export const fpsLabel = fps => {
  const v = fpsValue(fps);
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, "");
};

// Human name and bit depth from a codec parameter string, for error messages.
export function describeCodec(codec, str) {
  const names = { avc: "H.264", hevc: "HEVC", vp8: "VP8", vp9: "VP9", av1: "AV1", prores: "ProRes" };
  let bits = null;
  if (codec === "avc" && str) bits = [0x6e, 0x7a, 0xf4].includes(parseInt(str.slice(5, 7), 16)) ? 10 : 8;
  if (codec === "hevc" && str) bits = /^(hev1|hvc1)\.A?2\./.test(str) ? 10 : /^(hev1|hvc1)\.A?1\./.test(str) ? 8 : null;
  if ((codec === "vp9" || codec === "av1") && str) bits = +str.split(".")[3] || null;
  return { label: (names[codec] ?? codec ?? "an unknown codec") + (bits ? ` ${bits}-bit` : ""), bits };
}

// Exact frame rate as [num, den] from presentation timestamps in seconds, plus the
// constant-frame-rate check: every delta within ±1% of the median delta (spec § Hard constraints).
export function frameRateFromTimestamps(ts, timescale) {
  if (ts.length < 2) throw new UserError("The clip has fewer than two frames. Render a longer shot from Resolve.");
  const deltas = new Float64Array(ts.length - 1);
  for (let i = 1; i < ts.length; i++) deltas[i - 1] = ts[i] - ts[i - 1];
  const med = median(deltas);
  let worst = 0;
  for (const d of deltas) worst = Math.max(worst, Math.abs(d - med) / med);
  // The mean over the whole clip absorbs timescale rounding (e.g. 23.976 at 90 kHz alternates 3753/3754).
  const mean = (ts[ts.length - 1] - ts[0]) / (ts.length - 1);
  let fps = STANDARD_RATES.find(([n, d]) => Math.abs(mean * n / d - 1) < 5e-4);
  if (!fps) {
    const ticks = Math.max(1, Math.round(mean * timescale)), g = gcd(timescale, ticks);
    fps = [timescale / g, ticks / g];
  }
  return { fps, cfr: worst <= 0.01, worstDeviation: worst };
}

// Presentation-order timestamps read from packet metadata, without decoding.
async function packetTimestamps(track) {
  const ts = [];
  for await (const p of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true }))
    ts.push(p.timestamp);
  return Float64Array.from(ts).sort();
}

/**
 * Opens and validates a clip. Throws UserError with a message that says what to do.
 * Returns { input, track, audioTrack (or null), info, dispose }. `info` is plain data:
 * { name, byteSize, container, quicktime, codecString, width, height, fps: [num, den], frameCount,
 *   timestamps: Float64Array (presentation order), startTime, colorSpace,
 *   audio: { codec, sampleRate, channels } or null }
 */
export async function openSource(file) {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    let format;
    try { format = await input.getFormat(); }
    catch { throw new UserError(`${file.name} isn't a video this tool can read. Open an H.264 MP4 or MOV rendered from Resolve.`); }
    if (!(format instanceof Mp4InputFormat || format instanceof QuickTimeInputFormat))
      throw new UserError(`${file.name} is a ${format.name} file. Render the shot from Resolve as H.264 in an MP4 or MOV and open that.`);

    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new UserError(`${file.name} has no video track. Open the H.264 MP4 rendered from Resolve.`);

    const codec = await track.getCodec();
    const codecString = await track.getCodecParameterString();
    const desc = describeCodec(codec, codecString);
    if (codec !== "avc" || desc.bits !== 8)
      throw new UserError(`This file is ${desc.label}. Render the shot from Resolve as H.264 8-bit and open that.`);
    if (!(await track.canDecode()))
      throw new UserError("This browser can't decode this H.264 file. Update Chrome or Edge, or re-render from Resolve as H.264 High profile.");

    const width = await track.getDisplayWidth(), height = await track.getDisplayHeight();
    if (width > MAX_WIDTH || height > MAX_HEIGHT)
      throw new UserError(`The frame is ${width}×${height}. The limit is ${MAX_WIDTH}×${MAX_HEIGHT}: render from Resolve at UHD or smaller.`);
    if (width % 2 || height % 2)
      throw new UserError(`The frame is ${width}×${height}. H.264 export needs even dimensions: render from Resolve at an even width and height.`);
    if (await track.getRotation())
      throw new UserError("This file is rotated in its metadata. Render it from Resolve with the rotation baked in and open that.");
    const par = await track.getPixelAspectRatio();
    if (par.num !== par.den)
      throw new UserError("This file uses non-square pixels. Render it from Resolve with square pixels and open that.");

    const timestamps = await packetTimestamps(track);
    const { fps, cfr, worstDeviation } = frameRateFromTimestamps(timestamps, await track.getTimeResolution());
    if (!cfr)
      throw new UserError(`The frame rate varies (frame timing is up to ${(worstDeviation * 100).toFixed(1)}% off). Render from Resolve with a constant frame rate and open that.`);

    const audioTrack = await input.getPrimaryAudioTrack();
    const info = {
      name: file.name, byteSize: file.size, container: format.name, codecString,
      quicktime: format instanceof QuickTimeInputFormat,
      width, height, fps, frameCount: timestamps.length, timestamps, startTime: timestamps[0],
      colorSpace: { ...(await track.getColorSpace()) },
      audio: audioTrack && {
        codec: await audioTrack.getCodec(), sampleRate: await audioTrack.getSampleRate(),
        channels: await audioTrack.getNumberOfChannels(),
      },
    };
    return { input, track, audioTrack, info, dispose: () => input.dispose() };
  } catch (e) {
    input.dispose();
    throw e;
  }
}

/**
 * Decodes frames [start, end) in presentation order and yields { index, sample }.
 * The sample is closed when the loop body finishes, so don't keep it.
 * Checks every decoded timestamp against the frame table, so a decoder that skips,
 * duplicates or reorders frames is caught here rather than in Resolve.
 */
export async function* frames(source, { start = 0, end = source.info.frameCount, signal } = {}) {
  const { timestamps: ts, frameCount, fps } = source.info;
  const tol = fps[1] / fps[0] / 2;
  const sink = new VideoSampleSink(source.track);
  let i = start;
  for await (const sample of sink.samples(ts[start], end < frameCount ? ts[end] : undefined)) {
    try {
      signal?.throwIfAborted();
      if (sample.timestamp < ts[start] - tol) continue; // decoder warm-up before the range
      if (i >= end) break;
      if (Math.abs(sample.timestamp - ts[i]) > tol)
        throw new UserError(
          `Frame ${i} decoded at ${sample.timestamp.toFixed(4)} s but the file lists it at ${ts[i].toFixed(4)} s, so frames would not line up. Re-render the file from Resolve and try again.`,
          "decoder timestamp mismatch");
      yield { index: i, sample };
      i++;
    } finally {
      sample.close();
    }
  }
  signal?.throwIfAborted();
  if (i !== end)
    throw new UserError(
      `The decoder produced ${i - start} frames but the file lists ${end - start}. Re-render the file from Resolve and try again.`,
      "decoded frame count mismatch");
}

/** Random access to one frame by index, for the viewer. Caller closes the returned sample. */
export function frameReader(source) {
  const sink = new VideoSampleSink(source.track);
  return index => sink.getSample(source.info.timestamps[index]);
}
