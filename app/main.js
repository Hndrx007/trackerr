// App state machine and wiring. States: empty → loading → ready ⇄ analysing / exporting.
import { checkEnvironment, defaultBitrate } from "./env.js";
import { openSource, fpsLabel } from "./media.js";
import { exportClip, verifyExport, assertCanExport } from "./export.js";
import { drawBurnIn } from "./render/burnin.js";
import { Viewer } from "./ui/viewer.js";
import { Timeline, timecode } from "./ui/timeline.js";
import { UserError, isAbort } from "./errors.js";
import { analyse, rebuildDerived, reanalyseRange } from "./analysis/client.js";
import { serialize, parse, mismatches, cutFrames, shotsOf } from "./trackdata.js";
import { drawDebug, DEBUG_DEFAULTS, drawPickables, personAt } from "./render/debug.js";
import { compose, pickHero, clearHero, heroLane } from "./render/compose.js";
import { drawHud } from "./render/hud.js";
import { presetValues, sanitize } from "./render/params.js";
import { clusterPass } from "./analysis/swarm.js";
import { Panel } from "./ui/panel.js";
import { Renderer } from "./render/renderer.js";

const $ = id => document.getElementById(id);

const state = {
  phase: "empty",       // empty | loading | ready | analysing | exporting
  env: null,
  source: null,         // { input, track, info, dispose }
  file: null,           // the source File, handed to the analysis worker
  handle: null,         // FileSystemFileHandle of the source, when the browser gives one
  bitrate: null,        // bits per second
  td: null,             // track data, once analysed or loaded
  tdSavedAs: null,
  debug: { ...DEBUG_DEFAULTS },
  debugCache: {},
  showGraph: true,
  params: loadLastLook(),   // the look
  layout: null,             // composition of the look over the track data
  preview: null,            // { params, layout } while hovering a look in the menu
  clusterSmoothing: null,   // smoothing the current cluster candidates were built with
  view: "hud",              // hud | debug
  burnIn: false,
  showPeople: true,         // pickable person boxes while paused
  hoverPerson: null,
  pendingCutEdits: new Set(),   // frames whose neighbouring shots need their swarm re-tracked
  reanalysing: null,            // status text while that runs
};

// What the export draws: the HUD once there's track data, the frame-number burn-in before (or
// on top, for alignment checks in Resolve).
function exportOverlay() {
  const { td, layout, params } = state;
  if (!td || !layout) return drawBurnIn;
  return state.burnIn ? (o, i) => { drawHud(o, i, td, layout, params); drawBurnIn(o, i); } : (o, i) => drawHud(o, i, td, layout, params);
}
// What the viewer draws: the same as the export, or the analysis debug view.
function viewOverlay(o, i) {
  const { td } = state;
  if (!td) return drawBurnIn(o, i);
  if (state.view === "debug") return drawDebug(o, i, td, state.debug, state.debugCache);
  const pv = state.preview;
  if (pv) return drawHud(o, i, td, pv.layout, pv.params);
  if (state.layout) exportOverlay()(o, i);
  // Paused: every person faintly, with their ID, so the editor can click one to make them the hero.
  if (!viewer.playing && state.phase === "ready" && state.showPeople)
    drawPickables(o, i, td, state.layout?.heroAt(i)?.seg.personId ?? null, state.hoverPerson);
}

const viewer = new Viewer({ stage: $("stage"), canvas: $("view"), overlay: viewOverlay });
viewer.onError = e => showError(e, "Couldn't show that frame");
viewer.onPlayFrame = i => timeline.show(i);
viewer.onPlayState = playing => { $("play").textContent = playing ? "Pause" : "Play"; render(); };
const timeline = new Timeline({ root: $("transport"), onSeek: i => viewer.show(i), onSelectCut: () => render() });

const panel = new Panel($("settings"), {
  params: state.params,
  onChange: params => { state.params = params; saveLastLook(params); scheduleRecompose(); },
  onPreview: params => {
    const i = Math.max(0, timeline.index), shots = state.td ? shotsOf(state.td) : [];
    state.preview = params && state.td ? { params, layout: compose(state.td, params, { shot: shots.findIndex(s => i >= s.start && i < s.end) }) } : null;
    viewer.draw();
  },
});
// For inspection from DevTools: heroTracker.state.td is the current track data.
globalThis.heroTracker = { state, viewer, timeline, panel };

/* ---------------- the look: composition ---------------- */

function loadLastLook() {
  try { const v = JSON.parse(localStorage.getItem("heroTracker.look.v1")); if (v) return sanitize(v); } catch { /* none saved */ }
  return presetValues("surveillance");
}
function saveLastLook(p) { try { localStorage.setItem("heroTracker.look.v1", JSON.stringify(p)); } catch { /* private mode */ } }

// Composition re-runs whenever the look or the track data changes; it takes milliseconds per shot.
function recompose() {
  const td = state.td;
  if (!td) { state.layout = null; return; }
  if (state.clusterSmoothing !== state.params.swarmSmoothing) {
    td.clusters = clusterPass(td, { smoothing: state.params.swarmSmoothing });
    state.clusterSmoothing = state.params.swarmSmoothing;
  }
  state.layout = compose(td, state.params);
  timeline.setLane(heroLane(td, state.params));
}
// While a control moves: the shot under the playhead re-composes at once (milliseconds), and the
// whole clip follows once the control has been still for a moment.
let fullTimer = 0;
function scheduleRecompose() {
  const td = state.td;
  if (!td) return;
  // (A new swarm smoothing rebuilds the candidates for the whole clip: that waits for the full pass.)
  const shots = shotsOf(td), i = Math.max(0, timeline.index);
  const shot = shots.findIndex(s => i >= s.start && i < s.end);
  state.layout = compose(td, state.params, { shot });
  viewer.draw();
  clearTimeout(fullTimer);
  fullTimer = setTimeout(() => { recompose(); viewer.draw(); render(); }, 180);
}
/** Makes sure the whole-clip composition is current (before export or check frame). */
function settleLayout() {
  if (fullTimer) { clearTimeout(fullTimer); fullTimer = 0; recompose(); }
}

/* ---------------- panel tabs, view mode, playback, check frame ---------------- */

document.querySelectorAll(".tabs [data-tab]").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll(".tabs [data-tab]").forEach(x => x.setAttribute("aria-selected", x === b));
  document.querySelectorAll(".tab[data-tab]").forEach(t => t.hidden = t.dataset.tab !== b.dataset.tab);
}));
document.querySelectorAll("#viewMode [data-mode]").forEach(b => b.addEventListener("click", () => {
  state.view = b.dataset.mode;
  document.querySelectorAll("#viewMode [data-mode]").forEach(x => x.setAttribute("aria-pressed", x === b));
  viewer.draw();
}));
$("play").onclick = () => viewer.toggle();
$("burnIn").onchange = e => { state.burnIn = e.target.checked; viewer.draw(); };
$("checkFrame").onclick = () => checkFrame().catch(e => showError(e, "Couldn't render the check frame"));

// Renders the current frame at full resolution through the export path (same renderer, same
// overlay, source size) and shows it 1:1 in a pannable view. The pixels go GPU → bitmap → screen.
async function checkFrame() {
  const { source } = state;
  if (!source) return;
  viewer.pause();
  settleLayout();
  const f = Math.max(0, timeline.index), { width: W, height: H } = source.info;
  const r = new Renderer(new OffscreenCanvas(W, H));
  const sample = await (await import("./media.js")).frameReader(source)(f);
  try { r.render(sample, (o => exportOverlay()(o, f))); } finally { sample.close(); }
  const bmp = r.canvas.transferToImageBitmap();
  r.dispose();
  const c = $("checkCanvas");
  c.width = W; c.height = H;
  c.getContext("bitmaprenderer").transferFromImageBitmap(bmp);
  $("checkInfo").textContent = `frame ${f.toLocaleString("en-US")} · ${W}×${H} at 1:1 · rendered through the export path · drag to pan`;
  const d = $("checkDlg");
  d.showModal();
  const pan = $("checkPan");
  pan.scrollLeft = (W - pan.clientWidth) / 2; pan.scrollTop = (H - pan.clientHeight) / 2;
}
$("checkClose").onclick = () => $("checkDlg").close();
{
  const pan = $("checkPan");
  let drag = null;
  pan.addEventListener("pointerdown", e => { drag = { x: e.clientX, y: e.clientY, l: pan.scrollLeft, t: pan.scrollTop }; pan.classList.add("dragging"); pan.setPointerCapture(e.pointerId); });
  pan.addEventListener("pointermove", e => { if (drag) { pan.scrollLeft = drag.l - (e.clientX - drag.x); pan.scrollTop = drag.t - (e.clientY - drag.y); } });
  pan.addEventListener("pointerup", () => { drag = null; pan.classList.remove("dragging"); });
}

/* ---------------- environment ---------------- */

(async () => {
  const env = state.env = await checkEnvironment();
  const items = [
    [env.chromium ? "ok" : "bad", `Browser: ${env.browser}`],
    [env.webcodecs ? "ok" : "bad", env.webcodecs ? "WebCodecs video decode and encode" : "No WebCodecs"],
    [env.fsa ? "ok" : "bad", env.fsa ? "Saves straight to disk" : "Can't save straight to disk"],
    [env.gpu ? (env.gpuKind === "integrated" ? "warn" : "ok") : "warn",
      env.gpu ? `GPU: ${env.gpu} (${env.gpuKind})` : "No WebGPU adapter"],
    [env.encoder ? (env.encoder.hardware ? "ok" : "warn") : "bad",
      env.encoder ? `4K H.264 encode: ${env.encoder.hardware ? "hardware" : "software (slow)"}` : "4K H.264 encode unavailable"],
  ];
  const list = $("envList");
  list.replaceChildren(...items.map(([cls, text]) => {
    const li = document.createElement("li");
    li.append(Object.assign(document.createElement("span"), { className: "dot " + cls }), text);
    return li;
  }), ...[...env.problems, ...env.warnings].map(t => {
    const li = document.createElement("li");
    li.append(Object.assign(document.createElement("span"), { className: "dot " + (env.problems.includes(t) ? "bad" : "warn") }), t);
    return li;
  }));
  const level = env.problems.length ? "bad" : env.warnings.length ? "warn" : "ok";
  $("sysDot").className = "dot " + level;
  $("sysText").textContent = env.problems.length ? "Browser can't export" : env.gpu ? env.gpu.split(" · ").slice(0, 2).join(" ") : "Ready";
  if (env.problems.length) {
    const box = document.createElement("div");
    box.className = "problems";
    box.append(...env.problems.map(p => Object.assign(document.createElement("p"), { textContent: p })));
    $("dropMsg").replaceChildren(box);
  }
  render();
})();

/* ---------------- opening a clip ---------------- */

$("open").onclick = async () => {
  if ("showOpenFilePicker" in self) {
    try {
      const [handle] = await showOpenFilePicker({
        types: [{ description: "H.264 video", accept: { "video/mp4": [".mp4"], "video/quicktime": [".mov"] } }],
      });
      await load(await handle.getFile(), handle);
    } catch (e) { if (!isAbort(e)) showError(e, "Couldn't open the clip"); }
  } else $("file").click();
};
$("file").onchange = () => { const f = $("file").files[0]; $("file").value = ""; if (f) load(f, null); };

const stage = $("stage");
stage.addEventListener("dragover", e => { e.preventDefault(); stage.classList.add("dragging"); });
stage.addEventListener("dragleave", () => stage.classList.remove("dragging"));
stage.addEventListener("drop", async e => {
  e.preventDefault();
  stage.classList.remove("dragging");
  const item = [...e.dataTransfer.items].find(i => i.kind === "file");
  if (!item) return;
  const handle = await item.getAsFileSystemHandle?.().catch(() => null);
  load(item.getAsFile(), handle?.kind === "file" ? handle : null);
});

async function load(file, handle) {
  if (state.phase === "exporting") return;
  const previous = state.source;
  setPhase("loading");
  $("dropMsg").replaceChildren(Object.assign(document.createElement("p"), { className: "busy", textContent: `Reading ${file.name}…` }));
  try {
    const source = await openSource(file);
    previous?.dispose();
    state.source = source;
    state.file = file;
    state.handle = handle;
    state.td = null;
    state.tdSavedAs = null;
    state.debugCache = {};
    state.layout = null;
    state.clusterSmoothing = null;
    state.bitrate = defaultBitrate(source.info.width, source.info.height, source.info.fps);
    viewer.setSource(source, file);
    timeline.setClip(source.info);
    syncTimeline();
    viewer.show(0);
    setPhase("ready");
  } catch (e) {
    if (previous) { setPhase("ready"); showError(e, `Couldn't open ${file.name}`); return; }
    state.source = null;
    viewer.setSource(null);
    timeline.setClip(null);
    setPhase("empty");
    showError(e, `Couldn't open ${file.name}`);
  }
}

/* ---------------- export ---------------- */

$("export").onclick = () => runExport().catch(e => showError(e, "Couldn't export"));

async function runExport() {
  const { source } = state;
  if (!source || state.phase !== "ready") return;
  viewer.pause();
  settleLayout();
  assertCanExport();
  const overlay = exportOverlay(), hud = !!state.layout, marker = !hud || state.burnIn;
  const base = source.info.name.replace(/\.[^.]+$/, "");
  let handle;
  try {
    handle = await showSaveFilePicker({
      suggestedName: `${base}_hud.mp4`,
      types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }],
    });
  } catch (e) { if (isAbort(e)) return; throw e; }
  if (state.handle && await state.handle.isSameEntry(handle))
    throw new UserError("That's the source clip. Choose a different name so the original isn't overwritten.");

  const dlg = openDialog("Exporting");
  const ac = new AbortController();
  dlg.onCancel = () => ac.abort();
  setPhase("exporting");
  const { info } = source;
  let result;
  try {
    dlg.body(`${info.width}×${info.height} · ${fpsLabel(info.fps)} fps · ${info.frameCount.toLocaleString("en-US")} frames → ${handle.name}`);
    result = await exportClip({
      source, fileHandle: handle, overlay, bitrate: state.bitrate, signal: ac.signal,
      onProgress: ({ done, total, fps, eta }) => {
        dlg.progress(done / total);
        dlg.stats(`frame ${done.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} · ${fps.toFixed(1)} fps · ${formatDuration(eta)} left`);
      },
    });
  } catch (e) {
    setPhase("ready");
    if (isAbort(e)) {
      // Aborting discards everything written. Remove the file only if it's the empty one we created.
      const f = await handle.getFile().catch(() => null);
      if (f && f.size === 0) await handle.remove?.().catch(() => {});
      dlg.done("Export cancelled", "Nothing was written.", "warn");
    } else {
      dlg.close();
      showError(e, "Export stopped");
    }
    return;
  }

  dlg.title("Checking the exported file");
  dlg.body("Reopening the file and comparing it with the source, frame by frame.");
  dlg.progress(0);
  let report;
  try {
    report = await verifyExport(await handle.getFile(), source, {
      marker, compare: !hud, signal: ac.signal,
      onProgress: ({ done, total }) => { dlg.progress(done / total); dlg.stats(`checked ${done.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} frames`); },
    });
  } catch (e) {
    setPhase("ready");
    if (isAbort(e)) dlg.done("Check skipped", `The export was saved to ${handle.name}, but it wasn't checked.`, "warn");
    else { dlg.close(); showError(e, "Couldn't check the export"); }
    return;
  }
  setPhase("ready");
  const summary = `${handle.name} · ${(result.bytes / 2 ** 20).toFixed(1)} MB · exported at ${result.fps.toFixed(1)} fps ` +
    `(${result.accel === "prefer-hardware" ? "hardware" : "software"} encoder, ${(result.bitrate / 1e6).toFixed(1)} Mbps) in ${formatDuration(result.seconds)}`;
  dlg.done(report.pass ? "Export verified" : "Export failed its check", summary, report.pass ? "ok" : "bad", report.checks);
}

/* ---------------- analysis ---------------- */

$("analyse").onclick = () => runAnalyse().catch(e => showError(e, "Analysis stopped"));

async function runAnalyse() {
  const { source, file } = state;
  if (!source || state.phase !== "ready") return;
  const dlg = openDialog("Analysing");
  const ac = new AbortController();
  dlg.onCancel = () => ac.abort();
  setPhase("analysing");
  const { info } = source;
  const lines = [`${info.name} · ${info.frameCount.toLocaleString("en-US")} frames`];
  dlg.body(lines[0]);
  let td;
  try {
    td = await analyse(file, info, {
      previous: state.td, signal: ac.signal,
      onStatus: t => dlg.stats(t),
      onBackend: b => {
        lines.push(b.backend === "webgpu" ? `Person detection on the GPU (WebGPU${b.adapter ? ", " + b.adapter : ""})` : "Person detection on the CPU (WASM): slower");
        if (b.warning) lines.push(b.warning);
        dlg.body(lines.join("\n"));
      },
      onProgress: ({ done, total, fps, eta, shots }) => {
        dlg.progress(done / total);
        dlg.stats(`frame ${done.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} · ${fps.toFixed(1)} fps · ${formatDuration(eta)} left · ${shots} shots`);
      },
    });
  } catch (e) {
    setPhase("ready");
    if (isAbort(e)) dlg.done("Analysis cancelled", state.td ? "The previous analysis is still loaded." : "Nothing was changed.", "warn");
    else { dlg.close(); showError(e, "Analysis stopped"); }
    return;
  }
  state.td = td;
  state.tdSavedAs = null;
  state.debugCache = {};
  state.clusterSmoothing = 1.5;   // what rebuildDerived used
  recompose();
  setPhase("ready");
  syncTimeline();
  viewer.draw();
  const a = td.analysis;
  dlg.done("Analysis finished",
    `${shotsOf(td).length} shots · ${Object.keys(td.persons).length} person tracks · ${Object.keys(td.swarm).length.toLocaleString("en-US")} swarm points · ${a.fps.toFixed(1)} fps, ${formatDuration(a.seconds)}`,
    "ok", a.warning ? [{ name: "Detection ran on the CPU", pass: false, level: "warn", detail: a.warning }] : []);
}

/* ---------------- track data: save and load ---------------- */

$("saveTracks").onclick = () => saveTracks().catch(e => showError(e, "Couldn't save the track data"));
$("loadTracks").onclick = () => loadTracks().catch(e => showError(e, "Couldn't load the track data"));

async function saveTracks() {
  if (!state.td) return;
  const base = state.source.info.name.replace(/\.[^.]+$/, "");
  let handle;
  try {
    handle = await showSaveFilePicker({ suggestedName: `${base}.tracks.json`, types: [{ description: "Track data", accept: { "application/json": [".json"] } }] });
  } catch (e) { if (isAbort(e)) return; throw e; }
  state.td.look = state.params;   // the project remembers its look
  const w = await handle.createWritable();
  await w.write(serialize(state.td));
  await w.close();
  state.tdSavedAs = handle.name;
  render();
}

async function loadTracks() {
  if (!state.source) return;
  let handle;
  try {
    [handle] = await showOpenFilePicker({ types: [{ description: "Track data", accept: { "application/json": [".json"] } }] });
  } catch (e) { if (isAbort(e)) return; throw e; }
  let td;
  try { td = parse(await (await handle.getFile()).text()); }
  catch { throw new UserError(`${handle.name} isn't track data saved by this tool. Choose a .tracks.json file saved with “Save track data”.`); }
  const diff = mismatches(td, state.source.info);
  const fatal = diff.filter(d => d.fatal);
  if (fatal.length)
    throw new UserError(`This track data belongs to a different clip (${fatal.map(d => `${d.field}: saved ${d.saved}, open clip ${d.open}`).join("; ")}). Open ${td.source.name} first, or analyse this clip.`);
  adoptTrackData(td, handle.name);
  if (diff.length)
    openDialog("Loaded, with a warning").done("Loaded, with a warning",
      `The track data was saved for a file that differs from the open one (${diff.map(d => `${d.field}: saved ${d.saved}, open ${d.open}`).join("; ")}). The frame count matches, so it has been loaded. If the clip was re-rendered, analyse it again.`, "warn");
}

/** Makes loaded track data current: restores its look, recomposes, redraws. */
function adoptTrackData(td, name = null) {
  state.td = td;
  state.tdSavedAs = name;
  state.debugCache = {};
  state.clusterSmoothing = null;
  if (td.look) { state.params = sanitize(td.look); panel.setParams(state.params); }
  recompose();
  syncTimeline();
  viewer.draw();
  render();
}
globalThis.heroTracker.adoptTrackData = adoptTrackData;

/* ---------------- cuts: markers, editing, accuracy ---------------- */

function cutMarkers(td) {
  if (!td) return [];
  const removed = new Set(td.cutsRemoved);
  return td.cuts.map(c => ({ frame: c.frame, origin: c.origin, removed: c.origin === "auto" && removed.has(c.frame) }));
}

function syncTimeline() {
  const td = state.td;
  timeline.setCuts(cutMarkers(td));
  timeline.setSignal(td && state.showGraph ? { d: td.cutSignal, threshold: td.cutThreshold, flash: td.cutFlash } : null);
}

function afterCutEdit(frame) {
  if (frame !== undefined) { state.pendingCutEdits.add(frame); scheduleReanalysis(); }
  rebuildDerived(state.td);   // person tracks and clusters follow the new cuts at once
  state.clusterSmoothing = 1.5;
  recompose();
  state.td.edited = true;
  state.debugCache = {};
  syncTimeline();
  viewer.draw();
  render();
}

function addCut(f) {
  const td = state.td;
  if (!td || f <= 0) return;
  if (td.cutsRemoved.includes(f)) td.cutsRemoved = td.cutsRemoved.filter(x => x !== f);   // restore an auto cut
  else if (!td.cuts.some(c => c.frame === f)) {
    td.cuts.push({ frame: f, origin: "manual" });
    td.cuts.sort((a, b) => a.frame - b.frame);
  } else return;
  timeline.select(f);
  afterCutEdit(f);
}

function removeCut(f) {
  const td = state.td, c = td?.cuts.find(c => c.frame === f);
  if (!c) return;
  if (c.origin === "manual") td.cuts = td.cuts.filter(x => x !== c);
  else if (!td.cutsRemoved.includes(f)) td.cutsRemoved.push(f);
  else return;
  afterCutEdit(f);
}

/* ---------------- re-analysing the shots either side of an edited cut ---------------- */

let reanalyseTimer = 0;
function scheduleReanalysis() {
  clearTimeout(reanalyseTimer);
  reanalyseTimer = setTimeout(() => runReanalysis().catch(e => showError(e, "Couldn't update the swarm after the cut edit")), 700);
}

// The swarm resets at every cut, so an edited cut only affects the shots touching it. Those are
// decoded again (swarm only; detections are cached) and spliced in; the rest of the clip stays.
async function runReanalysis() {
  if (state.reanalysing || !state.pendingCutEdits.size || !state.td) return;
  const td = state.td, shots = shotsOf(td);
  const edited = [...state.pendingCutEdits];
  state.pendingCutEdits.clear();
  let ranges = edited.flatMap(f => shots.filter(s => (f >= s.start && f < s.end) || (f - 1 >= s.start && f - 1 < s.end)))
    .map(s => [s.start, s.end]).sort((x, y) => x[0] - y[0]);
  ranges = ranges.reduce((acc, r) => { const last = acc.at(-1); if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else acc.push([...r]); return acc; }, []);
  for (const [a, b] of ranges) {
    state.reanalysing = `Re-tracking swarm points for frames ${a.toLocaleString("en-US")}–${(b - 1).toLocaleString("en-US")}…`;
    render();
    await reanalyseRange(state.file, td, [a, b]);
  }
  state.reanalysing = null;
  if (td !== state.td) return;
  state.clusterSmoothing = null;   // candidates rebuild from the new points
  recompose();
  viewer.draw();
  render();
  if (state.pendingCutEdits.size) scheduleReanalysis();
}
globalThis.heroTracker.runReanalysis = runReanalysis;

/* ---------------- hero picking ---------------- */

function afterHeroEdit() {
  state.td.edited = true;
  recompose();
  viewer.draw();
  render();
}

$("view").addEventListener("click", e => {
  const td = state.td;
  if (!td || viewer.playing || state.phase !== "ready" || state.view !== "hud") return;
  const r = e.currentTarget.getBoundingClientRect(), f = timeline.index;
  const id = personAt(td, f, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  if (id === null) return;
  td.hero = pickHero(td, f, id);
  afterHeroEdit();
});
$("view").addEventListener("pointermove", e => {
  const td = state.td;
  if (!td || viewer.playing || state.view !== "hud") return;
  const r = e.currentTarget.getBoundingClientRect();
  const id = personAt(td, timeline.index, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  e.currentTarget.style.cursor = id === null ? "" : "pointer";
  if (id !== state.hoverPerson) { state.hoverPerson = id; viewer.draw(); }
});

function jumpCut(dir) {
  if (!state.td) return;
  const cuts = cutFrames(state.td), i = timeline.index;
  const f = dir < 0 ? [...cuts].reverse().find(c => c < i) : cuts.find(c => c > i);
  if (f === undefined) return;
  timeline.select(f);
  timeline.seek(f);
}

/** Accuracy of the automatic cuts against the editor's corrections. */
function cutReport(td) {
  const auto = td.cuts.filter(c => c.origin === "auto").map(c => c.frame);
  const removed = auto.filter(f => td.cutsRemoved.includes(f));
  const added = td.cuts.filter(c => c.origin === "manual").map(c => c.frame);
  const kept = auto.length - removed.length;
  return {
    clip: td.source.name, frames: td.source.frameCount,
    autoCuts: auto.length, falseCuts: removed, missedCuts: added,
    precision: auto.length ? kept / auto.length : 1,
    recall: kept + added.length ? kept / (kept + added.length) : 1,
    settings: td.analysis?.cut,
  };
}

$("copyCuts").onclick = async () => {
  if (!state.td) return;
  const text = JSON.stringify(cutReport(state.td), null, 2);
  try {
    await navigator.clipboard.writeText(text);
    $("copyCuts").textContent = "Copied";
    setTimeout(() => { $("copyCuts").textContent = "Copy cut report"; }, 1500);
  } catch { console.log(text); }
};

document.querySelectorAll("[data-debug]").forEach(cb => cb.addEventListener("change", () => {
  state.debug[cb.dataset.debug] = cb.checked;
  viewer.draw();
}));
$("showGraph").addEventListener("change", e => { state.showGraph = e.target.checked; syncTimeline(); });

/* ---------------- dialog ---------------- */

function openDialog(title) {
  const d = $("exportDlg");
  const api = {
    onCancel: null,
    title: t => { $("dlgTitle").textContent = t; },
    body: t => { $("dlgBody").replaceChildren(...t.split("\n").map(l => Object.assign(document.createElement("p"), { textContent: l }))); },
    progress: f => { $("dlgBar").style.width = (f * 100).toFixed(1) + "%"; },
    stats: t => { $("dlgStats").textContent = t; },
    close: () => d.close(),
    done(t, text, level, checks = []) {
      api.title(t);
      const verdict = Object.assign(document.createElement("p"), { className: "verdict " + level, textContent: text });
      const ul = document.createElement("ul");
      ul.className = "checks";
      for (const c of checks) {
        const li = document.createElement("li");
        const cls = c.pass ? "ok" : c.level === "warn" ? "warn" : "bad";
        li.append(Object.assign(document.createElement("span"), { className: cls, textContent: c.pass ? "✓" : c.level === "warn" ? "!" : "✗" }),
          Object.assign(document.createElement("span"), { textContent: c.name }),
          Object.assign(document.createElement("span"), { className: "d", textContent: c.detail }));
        ul.append(li);
      }
      const tail = level === "bad" && checks.length
        ? [Object.assign(document.createElement("p"), { className: "note", textContent: "A failed check is a bug in the tool, not in your clip. Keep the file and the source, and report which check failed." })]
        : [];
      $("dlgBody").replaceChildren(verdict, ul, ...tail);
      $("dlgBarWrap").hidden = true;
      $("dlgStats").textContent = "";
      $("dlgCancel").hidden = true;
      $("dlgClose").hidden = false;
      $("dlgClose").focus();
    },
  };
  $("dlgBarWrap").hidden = false;
  $("dlgBar").style.width = "0";
  $("dlgStats").textContent = "";
  $("dlgCancel").hidden = false;
  $("dlgClose").hidden = true;
  $("dlgCancel").onclick = () => { $("dlgCancel").disabled = true; api.stats("Cancelling…"); api.onCancel?.(); };
  $("dlgCancel").disabled = false;
  $("dlgClose").onclick = () => d.close();
  d.oncancel = e => { if (state.phase === "exporting" || state.phase === "analysing") e.preventDefault(); };  // Esc doesn't hide running work
  api.title(title);
  $("dlgBody").replaceChildren();
  d.showModal();
  return api;
}

/* ---------------- side panel, header, keys ---------------- */

const bitrateInput = $("bitrate");
bitrateInput.addEventListener("change", () => {
  const v = parseFloat(bitrateInput.value);
  if (Number.isFinite(v) && v > 0) state.bitrate = Math.round(v * 1e6);
  render();
});
bitrateInput.addEventListener("dblclick", () => {
  if (!state.source) return;
  const { width, height, fps } = state.source.info;
  state.bitrate = defaultBitrate(width, height, fps);
  render();
});

addEventListener("keydown", e => {
  if (e.target.closest?.("input[type=number], input[type=text], select, textarea, dialog[open]") || state.phase !== "ready") return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    timeline.step(e.key === "ArrowLeft" ? -1 : 1, e.shiftKey);
  } else if (e.key === "Home") timeline.seek(0);
  else if (e.key === "End") timeline.seek(Infinity);
  else if (e.key === " ") { e.preventDefault(); viewer.toggle(); }
  else if (e.key === "[" || e.key === "]") jumpCut(e.key === "[" ? -1 : 1);
  else if (e.key === "c" || e.key === "C") addCut(timeline.index);
  else if ((e.key === "x" || e.key === "X") && state.td) { state.td.hero = clearHero(state.td, timeline.index, state.params); afterHeroEdit(); }
  else if ((e.key === "g" || e.key === "G") && state.td) { const g = timeline.nextGap(); if (g !== null) timeline.seek(g); }
  else if ((e.key === "Delete" || e.key === "Backspace") && timeline.selected !== null) { e.preventDefault(); removeCut(timeline.selected); }
});

function setPhase(phase) {
  state.phase = phase;
  render();
}

function render() {
  const { source, env, phase } = state;
  const info = source?.info;
  $("drop").hidden = !!source;
  const busy = phase === "exporting" || phase === "loading" || phase === "analysing";
  $("open").disabled = busy;
  $("export").disabled = phase !== "ready" || !env || !env.fsa || !env.webcodecs;
  $("analyse").disabled = phase !== "ready" || !env?.webcodecs;
  $("analyse").textContent = state.td ? "Analyse again" : "Analyse";
  $("saveTracks").disabled = !state.td || busy;
  $("loadTracks").disabled = !source || busy;
  $("copyCuts").disabled = !state.td;
  $("play").disabled = !source || busy;
  $("checkFrame").disabled = !source || busy;
  renderAnalysis();
  $("export").title = env && !env.fsa ? "This browser can't save straight to disk. Use Chrome or Edge." : "";
  bitrateInput.disabled = !source || phase === "exporting";
  if (!info) {
    $("clipInfo").textContent = "";
    $("clipDetails").replaceChildren(Object.assign(document.createElement("dt"), { textContent: "No clip open" }));
    return;
  }
  $("clipInfo").innerHTML = "";
  $("clipInfo").append(Object.assign(document.createElement("b"), { textContent: info.name }),
    ` · ${info.width}×${info.height} · ${fpsLabel(info.fps)} · ${info.frameCount.toLocaleString("en-US")} fr`);
  const cs = info.colorSpace;
  const rows = [
    ["File", info.name], ["Size", `${(info.byteSize / 2 ** 20).toFixed(1)} MB`],
    ["Container", info.container], ["Codec", info.codecString],
    ["Frame", `${info.width}×${info.height}`], ["Rate", `${fpsLabel(info.fps)} (${info.fps.join("/")})`],
    ["Frames", info.frameCount.toLocaleString("en-US")],
    ["Duration", timecode(info.frameCount, info.fps)],
    ["Colour", `${cs.primaries ?? "untagged"} / ${cs.transfer ?? "–"} / ${cs.fullRange ? "full" : "video"} range`],
  ];
  if (info.startTime > 0) rows.push(["First frame at", `${info.startTime.toFixed(3)} s (export starts at 0)`]);
  $("clipDetails").replaceChildren(...rows.flatMap(([k, v]) => [
    Object.assign(document.createElement("dt"), { textContent: k }),
    Object.assign(document.createElement("dd"), { textContent: v }),
  ]));
  if (document.activeElement !== bitrateInput) bitrateInput.value = (state.bitrate / 1e6).toFixed(1);
}

function renderAnalysis() {
  const td = state.td;
  const kv = rows => rows.flatMap(([k, v, cls]) => [
    Object.assign(document.createElement("dt"), { textContent: k }),
    Object.assign(document.createElement("dd"), { textContent: v, className: cls ?? "" }),
  ]);
  if (!td) {
    $("analysisDetails").replaceChildren(Object.assign(document.createElement("dt"), { textContent: state.source ? "Not analysed yet" : "No clip open" }));
    $("analysisNote").textContent = state.source ? "Analyse finds cuts, people and swarm points. It runs once; save the track data to skip it next time." : "";
    $("cutStats").replaceChildren();
    return;
  }
  const a = td.analysis ?? {};
  $("analysisDetails").replaceChildren(...kv([
    ["Detection", a.backend === "webgpu" ? "GPU (WebGPU)" : a.backend === "wasm" ? "CPU (WASM)" : "–", a.backend === "wasm" ? "warnline" : ""],
    ["Detect every", a.detectStride > 1 ? `${a.detectStride} frames` : "frame"],
    ["Speed", a.fps ? `${a.fps.toFixed(1)} fps · ${formatDuration(a.seconds)}` : "–"],
    ["Shots", shotsOf(td).length.toLocaleString("en-US")],
    ["Person tracks", Object.keys(td.persons).length.toLocaleString("en-US")],
    ["Swarm points", Object.keys(td.swarm).length.toLocaleString("en-US")],
    ["Cluster candidates", Object.keys(td.clusters).length.toLocaleString("en-US")],
    ...(state.tdSavedAs ? [["Track data file", state.tdSavedAs]] : []),
  ]));
  $("analysisNote").textContent = state.reanalysing
    ?? (td.edited ? "Edits are kept when you save the project, and survive analysing again." : "");
  const r = cutReport(td);
  $("cutStats").replaceChildren(...kv([
    ["Automatic cuts", r.autoCuts.toLocaleString("en-US")],
    ["Removed as false", r.falseCuts.length.toLocaleString("en-US")],
    ["Added as missed", r.missedCuts.length.toLocaleString("en-US")],
    ...(r.falseCuts.length || r.missedCuts.length ? [["Precision", (r.precision * 100).toFixed(1) + "%"], ["Recall", (r.recall * 100).toFixed(1) + "%"]] : []),
    ...(timeline.selected !== null ? [["Selected cut", `f ${timeline.selected.toLocaleString("en-US")}`]] : []),
  ]));
}

function showError(e, title = "Something went wrong") {
  console.error(e);
  const box = document.createElement("div");
  box.className = "err";
  const msg = e instanceof UserError ? e.message
    : `Something went wrong: ${e?.message ?? e}. This is a bug. Reload the page and try again; if it happens again, report this message.`;
  box.append(Object.assign(document.createElement("strong"), { textContent: title }),
    Object.assign(document.createElement("p"), { textContent: msg }));
  if (state.source) {
    // A clip is open: show the error in the dialog so it isn't hidden behind the frame.
    openDialog(title).done(title, msg, "bad");
  } else {
    $("dropMsg").replaceChildren(box);
  }
}

function formatDuration(s) {
  if (!Number.isFinite(s)) return "–";
  s = Math.max(0, Math.round(s));
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
}
