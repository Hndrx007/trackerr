// Look development helper (not a test): renders frames of a clip with a look and returns PNG blobs.
// Used for the M3.5 look review contact sheets. Readback here is of preview-size stills only.
import { openSource, frameReader } from "../app/media.js";
import { Renderer } from "../app/render/renderer.js";
import { compose } from "../app/render/compose.js";
import { drawHud } from "../app/render/hud.js";
import { presetValues } from "../app/render/params.js";
import { clusterPass } from "../app/analysis/swarm.js";

export async function renderStills(file, td, frames, { preset = "surveillance", params = null, width = 1280 } = {}) {
  const src = await openSource(file);
  try {
    const p = params ?? presetValues(preset);
    td.clusters = clusterPass(td, { smoothing: p.swarmSmoothing });
    const t0 = performance.now();
    const layout = compose(td, p);
    const composeMs = performance.now() - t0;
    const H = Math.round(width * src.info.height / src.info.width);
    const r = new Renderer(new OffscreenCanvas(width, H));
    const read = frameReader(src);
    const out = [];
    for (const f of frames) {
      const s = await read(f);
      try { r.render(s, o => drawHud(o, f, td, layout, p)); } finally { s.close(); }
      const c = new OffscreenCanvas(width, H);
      c.getContext("2d").drawImage(r.canvas, 0, 0);
      out.push(await c.convertToBlob({ type: "image/png" }));
    }
    r.dispose();
    return { blobs: out, layout, composeMs };
  } finally { src.dispose(); }
}

/** Renders stills of the local look-dev clip and uploads them to the dev upload server (DevTools only). */
export async function lookRun(preset, frames, tag, params = null, { clip = "/_local/outmyface.mp4", tracks = "/_local/outmyface.tracks.json", width = 1280 } = {}) {
  const { parse } = await import("../app/trackdata.js");
  globalThis.__lookCache ??= {};
  const c = globalThis.__lookCache;
  if (c.clip !== clip) {
    c.clip = clip;
    c.td = parse(await (await fetch(tracks)).text());
    c.file = new File([await (await fetch(clip)).blob()], clip.split("/").pop());
  }
  const { blobs, layout, composeMs } = await renderStills(c.file, c.td, frames, { preset, params, width });
  for (let i = 0; i < blobs.length; i++) await fetch(`http://127.0.0.1:8001/${tag}_${frames[i]}.png`, { method: "PUT", body: blobs[i] });
  return { composeMs: +composeMs.toFixed(0), items: layout.items.length, heroes: layout.heroes.length };
}
globalThis.lookRun = lookRun;

/** Renders a range of the look-dev clip with a look to an MP4 (at `height`) and uploads it. */
export async function reviewClip(preset, start, end, name, { height = 1080 } = {}) {
  const { openSource } = await import("../app/media.js");
  const { exportClip } = await import("../app/export.js");
  const { opfsFile } = await import("./harness.js");
  const c = globalThis.__lookCache;
  const src = await openSource(c.file);
  try {
    const p = presetValues(preset);
    c.td.clusters = clusterPass(c.td, { smoothing: p.swarmSmoothing });
    const layout = compose(c.td, p);
    const handle = await opfsFile(`review-${name}.mp4`);
    const res = await exportClip({ source: src, fileHandle: handle, start, end, bitrate: 16e6,
      overlay: (o, i) => drawHud(o, i, c.td, layout, p) });
    await fetch(`http://127.0.0.1:8001/${name}.mp4`, { method: "PUT", body: await handle.getFile() });
    return res.fps;
  } finally { src.dispose(); }
}

/** M5 check: analyse a clip, export it at source resolution with a look and the burn-in, verify, upload. */
export async function m5Run(clipUrl, preset = "surveillance", onStage = () => {}) {
  const { openSource } = await import("../app/media.js");
  const { analyse } = await import("../app/analysis/client.js");
  const { exportClip, verifyExport } = await import("../app/export.js");
  const { drawBurnIn } = await import("../app/render/burnin.js");
  const { defaultBitrate } = await import("../app/env.js");
  const { opfsFile } = await import("./harness.js");
  const file = new File([await (await fetch(clipUrl)).blob()], clipUrl.split("/").pop());
  const src = await openSource(file);
  try {
    onStage("analysing");
    const td = await analyse(file, src.info, { onProgress: p => onStage(`analysing ${p.done}/${p.total} ${p.fps.toFixed(1)} fps`) });
    const p = presetValues(preset);
    td.clusters = clusterPass(td, { smoothing: p.swarmSmoothing });
    const layout = compose(td, p);
    onStage("exporting");
    const handle = await opfsFile(`m5-${file.name}`);
    const res = await exportClip({ source: src, fileHandle: handle, bitrate: defaultBitrate(src.info.width, src.info.height, src.info.fps),
      overlay: (o, i) => { drawHud(o, i, td, layout, p); drawBurnIn(o, i); },
      onProgress: q => onStage(`exporting ${q.done}/${q.total} ${q.fps.toFixed(1)} fps`) });
    onStage("verifying");
    const report = await verifyExport(await handle.getFile(), src, { marker: true, compare: false });
    onStage("uploading");
    await fetch(`http://127.0.0.1:8001/m5-${file.name}`, { method: "PUT", body: await handle.getFile() });
    return { analysis: td.analysis, shots: td.cuts.length + 1, export: res, report };
  } finally { src.dispose(); }
}
