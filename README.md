# Hero Tracker

A client-side browser tool that bakes a surveillance-HUD tracking effect (a thermal hero plus a composed swarm of tracked boxes) into H.264 footage graded in DaVinci Resolve, and exports a frame-exact MP4 for the timeline.

The full spec is in [docs/hero-tracker-spec.md](docs/hero-tracker-spec.md).

## Status: M0 capability spike

Only `spike.html` exists so far. It measures whether the editor's laptop can run the browser approach. The go/no-go decision is made from its numbers before any app code is written.

## Run it

It needs Chrome or Edge on Windows, and must be served over HTTP. Opening it from `file://` breaks the module imports and the model fetch.

```bash
python -m http.server 8000
```

Then open <http://localhost:8000/spike.html>.

1. Before opening the browser, set it to use the discrete GPU: **Windows Settings → System → Display → Graphics**, then choose Chrome or Edge and **High performance**. Restart the browser afterwards.
2. Click **Open clip…** and pick a 60-second 4K H.264 MP4 rendered from Resolve.
3. Click **Run all**. The full run takes a few minutes: it decodes the clip twice, then transcodes it once.
4. Click **Copy results (JSON)** and send the text back.

What it measures:

| Test | Number |
|---|---|
| 1 Environment | WebCodecs, WebGPU adapter name, whether 4K H.264 High 5.1/5.2 hardware encode is supported |
| 2 Clip info | container, codec, size, frame count, frame rate, CFR check (a preview of M1 validation) |
| 3 Decode | full-speed decode fps over the whole clip |
| 4 YOLO WebGPU | 640 px inference fps, then end-to-end fps on 300 real frames |
| 5 YOLO WASM | the same numbers for the fallback, single-threaded, because this server sends no COOP/COEP headers |
| 6 Encode | 4K H.264 encode fps (synthetic frames), then a decode → 4K canvas → encode transcode of the whole clip |

The optional **Also save transcode to disk** checkbox streams the transcode to a file you choose, which tests the File System Access path.

## Layout

```
spike.html              M0 capability spike
models/yolov8n.onnx     person detector (yolo export model=yolov8n.pt format=onnx imgsz=640)
docs/                   build spec
reference/tracker-v2.html  earlier prototype (point tracking only is reused)
```

`reference/tracker.ipynb` (the original Colab prototype) hasn't been added to the repo yet.

## Libraries

These are pinned on jsDelivr. There's no build step.

- [Mediabunny](https://mediabunny.dev) 1.59.1
- [onnxruntime-web](https://onnxruntime.ai) 1.30.0 (WebGPU bundle, WASM fallback)
