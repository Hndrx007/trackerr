# Hero Tracker

A client-side browser tool that bakes a surveillance-HUD tracking effect (a thermal hero plus a composed swarm of tracked boxes) into H.264 footage graded in DaVinci Resolve. It exports a frame-exact MP4 for the timeline. The video never leaves the machine.

The full spec is in [docs/hero-tracker-spec.md](docs/hero-tracker-spec.md).

## Status

| Milestone | State |
|---|---|
| M0 capability spike | done: **go** ([results](docs/m0-results.md)) |
| M1 frame-exact round trip | automated acceptance passes; manual Resolve check pending ([results](docs/m1-results.md), [Resolve check](docs/m1-resolve-check.md)) |
| M2 analysis | next |

## Run it

It needs Chrome or Edge on Windows, and must be served over HTTP. Opening it from `file://` breaks the module imports.

```bash
python -m http.server 8000
```

| Page | What it is |
|---|---|
| <http://localhost:8000/> | The app: open a clip, step through it, **Export clip**. |
| <http://localhost:8000/tests.html> | In-browser tests. **Run all** runs about 40 tests in a few seconds. **Round trip on my own clip…** exports any clip to browser storage and verifies it, with no save dialog. |
| <http://localhost:8000/spike.html> | The M0 capability spike. |

For the discrete GPU, set the browser to **High performance** in Windows Settings → System → Display → Graphics.

## Layout

```
index.html               app shell
app/
  main.js                state machine and wiring
  env.js                 capability checks, encoder selection
  media.js               Mediabunny input, validation, frame table, the shared frame iterator
  export.js              render → encode → stream to disk; verification of the written file
  errors.js              UserError: messages written for the editor
  lib.js                 pinned third-party imports (change versions here only)
  render/renderer.js     WebGL2 renderer shared by preview and export
  render/glyphs.js       glyph atlas for text
  render/burnin.js       M1 test overlay: frame number and a machine-readable marker
  ui/viewer.js           frame viewer
  ui/timeline.js         timecode, frame stepping, scrubber
  ui/style.css
tests.html, tests/       in-browser tests; fixtures in tests/fixtures (see tools/make-fixtures.sh)
spike.html               M0 capability spike
models/yolov8n.onnx      person detector (M2)
docs/                    spec and milestone results
reference/tracker-v2.html  earlier prototype (point tracking only is reused)
```

`reference/tracker.ipynb` (the original Colab prototype) hasn't been added to the repo yet.

## Libraries

These are pinned on jsDelivr in `app/lib.js`. There's no build step.

- [Mediabunny](https://mediabunny.dev) 1.59.1: demux, decode, encode, mux.
- [onnxruntime-web](https://onnxruntime.ai) 1.30.0: person detection (M2).

The test fixture `tests/fixtures/zidane.jpg` is an Ultralytics sample image (AGPL-3.0).
