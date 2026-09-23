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
