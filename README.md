# Hero Tracker

A browser tool that bakes a surveillance-HUD tracking effect into H.264 footage graded in DaVinci Resolve:
- one person, the hero, gets a thermal-palette rectangle, brackets and a label;
- a composed swarm of tracked boxes, with connectors, fills the rest of the frame.

It exports a frame-exact MP4 that lines up with the source on the Resolve timeline. Everything runs locally, and the video never leaves the machine.

The full spec is in [docs/hero-tracker-spec.md](docs/hero-tracker-spec.md). Where things stand, and what needs your input: [docs/status.md](docs/status.md).

## Run it

**Hosted:** <https://hndrx007.github.io/trackerr/>. Editors start with the [quick start](help.html), which is also linked from **Help** in the app.

**Locally:** it needs Chrome or Edge on Windows. For detection on the discrete GPU, set the browser to **High performance** in Windows Settings → System → Display → Graphics.

```bash
python tools/serve.py
```

Then open <http://localhost:8000/>. `tools/serve.py` is `python -m http.server` with no-cache headers, so the browser never runs a stale copy of the app after an update.

## Workflow

1. **Open** a graded H.264 render from Resolve: MP4 or MOV, 8-bit, constant frame rate, up to 3840×2160.
2. **Analyse.** The tool finds cuts, people and swarm points. It takes minutes, so use **Save project** (Analysis tab) afterwards; **Open project…** restores it, including your edits and your look.
3. **Check the cuts.** Use `[` `]` to step through them, `C` to add a missed cut, and click a marker then `Delete` to remove a false one. The shots either side of an edited cut are re-analysed in the background.
4. **Check the hero.** The lane under the scrubber is blue where there's a hero and red where people are detected but there's no hero. `G` jumps to the next red gap. Pause, click a person to make them the hero, and use `X` to clear.
5. **Choose a look** in the Look tab: Surveillance, Lock-on, Scan, Minimal or Target. Hover a look to preview it on the current frame. Every setting is a slider; double-click one to reset it. Save your own looks, and import or export them as JSON.
6. **Play** (`Space`) to see it moving, and **Check frame** to see the current frame at full resolution through the export path.
7. **Export clip.** The file streams to disk, then the tool reopens it and checks it frame by frame against the source.
   - Audio is off by default, because the export goes over the song in Resolve.
   - **Include audio** (Clip tab) copies the source's audio track unchanged, shifted to stay in sync with the picture. It's checked against the source packet by packet.
   - A MOV source with audio exports as a MOV, since Resolve renders MOVs with PCM audio.
8. In Resolve, put the export on V2 over the source; see [docs/m1-resolve-check.md](docs/m1-resolve-check.md) for how to confirm the alignment.

The **Keys** button lists every shortcut.

## Tests

<http://localhost:8000/tests.html>. **Run all** runs about 90 in-browser tests in under a minute:
- validation and frame-rate maths;
- the renderer, and the frame-exact export round trips;
- cut detection on a labelled clip;
- person tracking and the swarm regression tests;
- the composition floor for every look, and hero picking;
- partial re-analysis after a cut edit.

**Round trip on my own clip…** exports any clip to browser storage and verifies it.

## Layout

```
index.html                 app shell
app/
  main.js                  state machine and wiring
  env.js                   capability checks, encoder selection
  media.js                 Mediabunny input, validation, the frame table, the shared frame iterator
  export.js                render → encode → stream to disk; verification of the written file
  trackdata.js             track data model, save/load, zero-lag smoothing
  analysis/                worker (the analysis pass), cuts, detector, persons, swarm, client
  render/                  renderer (WebGL2), compose (the composition pass), hud, params (settings
                           and looks), palettes, glyphs, burnin (frame-number test overlay), debug
  ui/                      viewer (playback), timeline (scrubber, cut markers, hero lane, cut graph),
                           panel (settings generated from params.js), style.css
tests.html, tests/         in-browser tests; fixtures in tests/fixtures (tools/make-*.{sh,py} rebuild them)
tools/serve.py             local server
spike.html                 M0 capability spike
models/yolov8n.onnx        person detector
docs/                      spec, milestone results, look review, Resolve check
```

## Libraries

These are pinned on jsDelivr in `app/lib.js` and `app/lib-ort.js`. There's no build step.

- [Mediabunny](https://mediabunny.dev) 1.59.1: demux, decode, mux.
- [onnxruntime-web](https://onnxruntime.ai) 1.30.0: person detection on WebGPU, with a WASM fallback.

`tests/fixtures/zidane.jpg` and `bus.jpg` are Ultralytics sample images (AGPL-3.0).
