// App state machine and wiring. States: empty → loading → ready → exporting → ready.
// (Analysing arrives in M2.)
import { checkEnvironment, defaultBitrate } from "./env.js";
import { openSource, fpsLabel } from "./media.js";
import { exportClip, verifyExport, assertCanExport } from "./export.js";
import { drawBurnIn } from "./render/burnin.js";
import { Viewer } from "./ui/viewer.js";
import { Timeline, timecode } from "./ui/timeline.js";
import { UserError, isAbort } from "./errors.js";

const $ = id => document.getElementById(id);

const state = {
  phase: "empty",       // empty | loading | ready | exporting
  env: null,
  source: null,         // { input, track, info, dispose }
  handle: null,         // FileSystemFileHandle of the source, when the browser gives one
  bitrate: null,        // bits per second
};

// The M1 overlay. M3 replaces this with the composed HUD.
const overlay = drawBurnIn;

const viewer = new Viewer({ stage: $("stage"), canvas: $("view"), overlay });
viewer.onError = e => showError(e, "Couldn't show that frame");
const timeline = new Timeline({ root: $("transport"), onSeek: i => viewer.show(i) });

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
    state.handle = handle;
    state.bitrate = defaultBitrate(source.info.width, source.info.height, source.info.fps);
    viewer.setSource(source);
    timeline.setClip(source.info);
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
  assertCanExport();
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
      marker: overlay === drawBurnIn, signal: ac.signal,
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

/* ---------------- dialog ---------------- */

function openDialog(title) {
  const d = $("exportDlg");
  const api = {
    onCancel: null,
    title: t => { $("dlgTitle").textContent = t; },
    body: t => { $("dlgBody").replaceChildren(Object.assign(document.createElement("p"), { textContent: t })); },
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
  d.oncancel = e => { if (state.phase === "exporting") e.preventDefault(); };  // Esc doesn't hide a running export
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
  if (e.target.closest?.("input, textarea, dialog[open]") || state.phase !== "ready") return;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    e.preventDefault();
    timeline.step(e.key === "ArrowLeft" ? -1 : 1, e.shiftKey);
  } else if (e.key === "Home") timeline.seek(0);
  else if (e.key === "End") timeline.seek(Infinity);
});

function setPhase(phase) {
  state.phase = phase;
  render();
}

function render() {
  const { source, env, phase } = state;
  const info = source?.info;
  $("drop").hidden = !!source;
  $("open").disabled = phase === "exporting" || phase === "loading";
  $("export").disabled = phase !== "ready" || !env || !env.fsa || !env.webcodecs;
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
