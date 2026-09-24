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
