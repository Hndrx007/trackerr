import { group, test, assert, eq, rejects, fixture, opfsFile } from "./harness.js";
import { openSource } from "../app/media.js";
import { defaultBitrate } from "../app/env.js";
import { exportClip, verifyExport } from "../app/export.js";
import { drawBurnIn } from "../app/render/burnin.js";

group("M1 round trip: decode → burn in → encode → disk → verify");

/** Exports `file` with the burn-in to OPFS, verifies it, and returns a summary. Throws on any failed check. */
export async function roundTrip(file, { onProgress, signal } = {}) {
  const source = await openSource(file);
  try {
    const handle = await opfsFile(`roundtrip-${file.name.replace(/\W+/g, "_")}.mp4`);
    const res = await exportClip({
      source, fileHandle: handle, overlay: drawBurnIn, onProgress, signal,
      bitrate: defaultBitrate(source.info.width, source.info.height, source.info.fps),
    });
    const report = await verifyExport(await handle.getFile(), source, { marker: true, signal });
    const failed = report.checks.filter(c => !c.pass);
    const lines = report.checks.map(c => `${c.pass ? "✓" : c.level === "warn" ? "!" : "✗"} ${c.name}: ${c.detail}`);
    if (!report.pass) throw new Error("verification failed:\n" + lines.join("\n"));
    return {
      res, report, warnings: failed,
      text: `${res.fps.toFixed(1)} fps · ${res.accel} · ${(res.bytes / 1e6).toFixed(2)} MB\n` + lines.join("\n"),
    };
  } finally { source.dispose(); }
}

for (const name of ["h264_2398_bframes.mp4", "h264_25_offset.mp4", "h264_2997.mov", "h264_5994.mp4"])
  test(`${name}: output passes verification, and frame N shows N on every frame`, async () => {
    const { text } = await roundTrip(await fixture(name));
    return text;
  }, { slow: true });

// The synthetic clips above are saturated test patterns, where 4:2:0 → RGB → 4:2:0 legitimately
// moves chroma at hard edges. Natural footage must come back with no colour shift at all.
test("h264_24_natural.mp4: natural footage comes back with no colour shift (every check passes, warnings included)", async () => {
  const { text, warnings } = await roundTrip(await fixture("h264_24_natural.mp4"));
  eq(warnings.map(w => w.name), [], "checks with warnings");
  return text;
}, { slow: true });

test("Cancelling mid-export stops with an AbortError and leaves no half-written file behind", async () => {
  const source = await openSource(await fixture("h264_2398_bframes.mp4"));
  try {
    const handle = await opfsFile("roundtrip-cancel.mp4");
    const ac = new AbortController();
    const e = await rejects(exportClip({
      source, fileHandle: handle, overlay: drawBurnIn, signal: ac.signal, bitrate: 1e6,
      onProgress: ({ done }) => { if (done >= 10) ac.abort(); },
    }));
    eq(e.name, "AbortError");
    // The writable was aborted, so nothing was committed to the file.
    eq((await handle.getFile()).size, 0, "bytes committed");
  } finally { source.dispose(); }
}, { slow: true });

test("Verification catches a wrong file: a different clip fails frame count, rate and marker checks", async () => {
  const a = await openSource(await fixture("h264_2398_bframes.mp4"));
  try {
    const report = await verifyExport(await fixture("h264_2997.mov"), a, { marker: true });
    assert(!report.pass, "should fail");
    const failed = report.checks.filter(c => !c.pass).map(c => c.name);
    for (const n of ["Frame count", "Frame rate", "Frame N shows N (burn-in marker on every frame)"])
      assert(failed.includes(n), `expected "${n}" to fail; failed: ${failed.join(", ")}`);
  } finally { a.dispose(); }
}, { slow: true });

// Audio. The fixtures flash white on frames 12 and 30 with a beep starting on each, and their video
// starts one frame after their audio. In the export every beep must still start on its white frame.
async function beepOnsets(file) {
  const { Input, ALL_FORMATS, BlobSource, AudioSampleSink } = await import("../app/lib.js");
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const onsets = [];
    let buf = new Float32Array(0), quietUntil = -Infinity;
    for await (const s of new AudioSampleSink(await input.getPrimaryAudioTrack()).samples()) {
      try {
        if (buf.length < s.numberOfFrames) buf = new Float32Array(s.numberOfFrames);
        s.copyTo(buf, { planeIndex: 0, format: "f32-planar" });
        for (let i = 0; i < s.numberOfFrames; i++) {
          const t = s.timestamp + i / s.sampleRate;
          if (Math.abs(buf[i]) > 0.4 && t > quietUntil) { onsets.push(t); quietUntil = t + 0.2; }
        }
      } finally { s.close(); }
    }
    return onsets;
  } finally { input.dispose(); }
}

for (const [name, ext, tolerance] of [["av_sync.mp4", "mp4", 0.003], ["av_sync_pcm.mov", "mov", 0.0002]])
  test(`${name}: with audio on, the audio is copied and every beep still starts on its white frame`, async () => {
    const { exportExtension } = await import("../app/export.js");
    const file = await fixture(name);
    const source = await openSource(file);
    try {
      eq(exportExtension(source.info, true), ext, "container");
      const handle = await opfsFile(`roundtrip-audio-${name.replace(/\W+/g, "_")}.${ext}`);
      const res = await exportClip({ source, fileHandle: handle, overlay: drawBurnIn, audio: true, bitrate: 2e6 });
      const out = await handle.getFile();
      const report = await verifyExport(out, source, { marker: true, audio: true, compare: false });
      const lines = report.checks.map(c => `${c.pass ? "✓" : "✗"} ${c.name}: ${c.detail}`);
      assert(report.pass, "verification failed:\n" + lines.join("\n"));
      assert(report.checks.some(c => c.name === "Audio in sync with the picture" && c.pass), "audio sync was checked");
      const src = (await beepOnsets(file)).map(t => t - source.info.startTime), got = await beepOnsets(out);
      const want = [12 / 24, 30 / 24];
      eq(got.length, 2, `beeps found in the export (${got.map(t => t.toFixed(4)).join(", ")})`);
      got.forEach((t, i) => {
        assert(Math.abs(t - want[i]) < tolerance, `beep ${i + 1} at ${(t * 1000).toFixed(2)} ms, its white frame at ${(want[i] * 1000).toFixed(2)} ms`);
        assert(Math.abs(t - src[i]) < 1e-4, `beep ${i + 1} moved against the source: ${(t * 1000).toFixed(3)} vs ${(src[i] * 1000).toFixed(3)} ms`);
      });
      return `${res.audio.packets} ${res.audio.codec} packets · beeps at ${got.map(t => (t * 1000).toFixed(2) + " ms").join(", ")} (frames at 500.00, 1250.00 ms)\n` + lines.join("\n");
    } finally { source.dispose(); }
  }, { slow: true });

test("Verification catches audio out of sync: the source itself, whose audio isn't shifted, fails the audio check", async () => {
  const source = await openSource(await fixture("av_sync.mp4"));
  try {
    const report = await verifyExport(await fixture("av_sync.mp4"), source, { audio: true, compare: false });
    const sync = report.checks.find(c => c.name === "Audio in sync with the picture");
    assert(sync && !sync.pass, `audio check should fail: ${sync?.detail}`);
    return sync.detail;
  } finally { source.dispose(); }
}, { slow: true });

test("Audio is off by default: the export has no audio track, and a clip without audio exports fine with it on", async () => {
  const { exportExtension } = await import("../app/export.js");
  const withAudio = await openSource(await fixture("av_sync_pcm.mov"));
  try {
    eq(exportExtension(withAudio.info, false), "mp4", "container with audio off");
    const handle = await opfsFile("roundtrip-noaudio.mp4");
    const res = await exportClip({ source: withAudio, fileHandle: handle, overlay: drawBurnIn, bitrate: 2e6 });
    eq(res.audio, null, "audio in the result");
    const out = await openSource(await handle.getFile());
    try { eq(out.info.audio, null, "audio track in the export"); } finally { out.dispose(); }
  } finally { withAudio.dispose(); }

  const silent = await openSource(await fixture("h264_24_natural.mp4"));
  try {
    eq(silent.info.audio, null, "fixture has no audio");
    eq(exportExtension(silent.info, true), "mp4");
    const handle = await opfsFile("roundtrip-silent.mp4");
    const res = await exportClip({ source: silent, fileHandle: handle, overlay: drawBurnIn, audio: true, bitrate: 2e6 });
    eq(res.audio, null, "audio in the result");
  } finally { silent.dispose(); }
}, { slow: true });

test("Output colour tags: primaries and transfer from the source, matrix and range from the encoder", async () => {
  const { outputColorSpace } = await import("../app/export.js");
  // What Chrome sometimes reports for canvas frames: the sRGB transfer curve.
  eq(outputColorSpace({ primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false },
    { primaries: "bt709", transfer: "iec61966-2-1", matrix: "bt709", fullRange: false }),
    { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false });
  // Encoder converted with BT.601: keep that matrix so the file decodes correctly.
  eq(outputColorSpace({ primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false },
    { matrix: "smpte170m", fullRange: false }).matrix, "smpte170m");
  // Untagged source: Rec.709, as Resolve assumes.
  eq(outputColorSpace({}, {}), { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false });
});
