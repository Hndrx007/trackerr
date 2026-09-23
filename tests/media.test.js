import { group, test, assert, eq, rejects, fixture } from "./harness.js";
import { frameRateFromTimestamps, describeCodec, openSource, frames } from "../app/media.js";
import { h264CodecString, defaultBitrate } from "../app/env.js";

group("Media: frame rate and validation rules");

const grid = (n, [num, den], start = 0, tick = null) =>
  Float64Array.from({ length: n }, (_, i) => {
    const t = start + i * den / num;
    return tick ? Math.round(t * tick) / tick : t;
  });

test("23.976 at timescale 24000 is exactly 24000/1001", () => {
  eq(frameRateFromTimestamps(grid(100, [24000, 1001], 0, 24000), 24000).fps, [24000, 1001]);
});
test("23.976 at a 90 kHz timescale (alternating 3753/3754 ticks) is still 24000/1001 and constant", () => {
  const r = frameRateFromTimestamps(grid(500, [24000, 1001], 0, 90000), 90000);
  eq(r.fps, [24000, 1001]); assert(r.cfr, "should be constant frame rate");
});
test("25 fps at timescale 12800 with a 0.04 s start is 25/1", () => {
  eq(frameRateFromTimestamps(grid(100, [25, 1], 0.04, 12800), 12800).fps, [25, 1]);
});
test("59.94 and 29.97 are recognised", () => {
  eq(frameRateFromTimestamps(grid(100, [60000, 1001]), 60000).fps, [60000, 1001]);
  eq(frameRateFromTimestamps(grid(100, [30000, 1001]), 30000).fps, [30000, 1001]);
});
test("A non-standard constant rate falls back to the exact timescale ratio", () => {
  eq(frameRateFromTimestamps(grid(100, [15, 1], 0, 1500), 1500).fps, [15, 1]);
  eq(frameRateFromTimestamps(grid(100, [12, 1], 0, 1200), 1200).fps, [12, 1]);
});
test("One late frame (>1% off the median delta) makes it variable frame rate", () => {
  const ts = grid(100, [24, 1]); for (let i = 50; i < 100; i++) ts[i] += 0.0005;
  assert(!frameRateFromTimestamps(ts, 24000).cfr, "0.0005 s on a 0.0417 s delta is 1.2%: should be VFR");
});
test("Jitter within ±1% is still constant frame rate", () => {
  const ts = grid(100, [24, 1]); for (let i = 1; i < 100; i += 2) ts[i] += 0.0002;
  assert(frameRateFromTimestamps(ts, 24000).cfr, "0.48% jitter should pass");
});
test("Codec descriptions name the codec and bit depth", () => {
  eq(describeCodec("avc", "avc1.640028"), { label: "H.264 8-bit", bits: 8 });
  eq(describeCodec("avc", "avc1.6e0028"), { label: "H.264 10-bit", bits: 10 });
  eq(describeCodec("hevc", "hev1.2.4.L120.90").label, "HEVC 10-bit");
  eq(describeCodec("hevc", "hvc1.1.6.L93.B0").label, "HEVC 8-bit");
  eq(describeCodec("prores", null).label, "ProRes");
});
test("Encoder level: 5.1 up to 30 fps, 5.2 above; 0.35 bits per pixel", () => {
  eq(h264CodecString(24000 / 1001), "avc1.640033");
  eq(h264CodecString(30), "avc1.640033");
  eq(h264CodecString(60000 / 1001), "avc1.640034");
  eq(defaultBitrate(3840, 2160, [24, 1]), 69672960);
});

group("Media: fixtures open or are rejected with a useful message");

const accepted = [
  ["h264_2398_bframes.mp4", 320, 180, [24000, 1001], 72, 0],
  ["h264_25_offset.mp4", 320, 180, [25, 1], 50, 0.08],
  ["h264_2997.mov", 320, 180, [30000, 1001], 45, 0],
  ["h264_5994.mp4", 320, 180, [60000, 1001], 60, 0],
  ["h264_24_natural.mp4", 640, 360, [24, 1], 48, 0],
];
for (const [name, w, h, fps, count, start] of accepted)
  test(`${name} opens: ${w}×${h}, ${fps.join("/")}, ${count} frames, starts at ${start} s`, async () => {
    const src = await openSource(await fixture(name));
    try {
      const i = src.info;
      eq([i.width, i.height, i.fps, i.frameCount], [w, h, fps, count]);
      assert(Math.abs(i.startTime - start) < 1e-6, `start ${i.startTime}`);
      eq(i.colorSpace.transfer, "bt709", "colour tags read");
    } finally { src.dispose(); }
  });

const rejected = [
  ["hevc_10bit.mp4", "This file is HEVC 10-bit. Render the shot from Resolve as H.264 8-bit"],
  ["h264_10bit.mp4", "This file is H.264 10-bit"],
  ["h264_vfr.mp4", "Render from Resolve with a constant frame rate"],
  ["vp9.webm", "Render the shot from Resolve as H.264 in an MP4 or MOV"],
];
for (const [name, msg] of rejected)
  test(`${name} is rejected: "${msg}…"`, async () => {
    const e = await rejects(openSource(await fixture(name)), msg);
    eq(e.name, "UserError", "message is written for the editor");
  });

test("frames() yields every frame in presentation order with the table's timestamps (B-frames)", async () => {
  const src = await openSource(await fixture("h264_2398_bframes.mp4"));
  try {
    let n = 0;
    for await (const { index, sample } of frames(src)) {
      eq(index, n, "index");
      assert(Math.abs(sample.timestamp - src.info.timestamps[index]) < 1e-6, `timestamp at ${index}`);
      n++;
    }
    eq(n, 72);
  } finally { src.dispose(); }
});
test("frames() over a sub-range starts and stops exactly", async () => {
  const src = await openSource(await fixture("h264_2398_bframes.mp4"));
  try {
    const got = [];
    for await (const { index } of frames(src, { start: 30, end: 40 })) got.push(index);
    eq(got, [30, 31, 32, 33, 34, 35, 36, 37, 38, 39]);
  } finally { src.dispose(); }
});
test("frames() stops promptly on abort", async () => {
  const src = await openSource(await fixture("h264_2398_bframes.mp4"));
  try {
    const ac = new AbortController();
    const e = await rejects((async () => { for await (const { index } of frames(src, { signal: ac.signal })) if (index === 5) ac.abort(); })());
    eq(e.name, "AbortError");
  } finally { src.dispose(); }
});
