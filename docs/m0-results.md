# M0 results: capability spike

**Decision: go.** The browser approach meets the spec on the weakest hardware it will ever run on, a laptop with integrated graphics. The editors use dedicated GPUs, so these numbers are a floor, not a target.

## Test machine

- HP ProBook 450 G10, Intel Iris Xe (integrated; WebGPU reports `intel · gen-12lp`), 12 threads, 16 GB.
- Microsoft Edge 153 on Windows 11, served by `python -m http.server`, so the page isn't cross-origin isolated.
- Clip: 960×720 H.264 High, 30 fps, 623 frames, constant frame rate. No 4K clip was available.

## Numbers (Edge, 2026-09-23)

| Test | Result |
|---|---|
| WebGPU adapter | `intel · gen-12lp` (integrated; the warning showed) |
| 4K H.264 High 5.1 / 5.2 encoder support | hardware and no-preference both supported |
| Decode, 960×720 | 2,608 fps; 623 of 623 frames, in presentation order |
| YOLOv8n on WebGPU, inference only | 65 ms median, **15.3 fps** |
| YOLOv8n on WebGPU, end to end (decode, 640 letterbox, infer, NMS) | **13.2 fps**; 8 ms prep, 64 ms infer |
| YOLOv8n on WASM (1 thread), inference only | 562 ms median, 1.8 fps |
| YOLOv8n on WASM, end to end | 1.9 fps |
| 4K H.264 encode, synthetic 3840×2160 | **27.3 fps**, prefer-hardware, 300 frames in and 300 packets out |
| Transcode 960×720 (decode → canvas → encode) | 209 fps; 623 in and 623 out |
| JS heap during the transcode | 78 → 82 MB, stable |

Detection was checked for correctness against Python ultralytics on `bus.jpg`: the same 4 people, with boxes within 0.001.

## What it means

- **Analysis:** at 13 fps, a 60 s clip at 24 fps (1,440 frames) takes about 2 min to analyse, detecting every frame. `detectStride` stays at 1 by default.
- **WASM fallback:** 1.8–3.8 fps, which is too slow to be comfortable. When it's in use, the app should warn and default `detectStride` to 3.
- **Export:** 4K encode runs faster than real time for 24/25 fps footage.
- **Firefox is out.** It has no `showSaveFilePicker` (needed for streaming export), it refuses `prefer-hardware` for H.264, and it hides the adapter name. Its WebGPU detection was 6.6 fps against Edge's 13.2 on the same machine. The app should tell Firefox users to switch to Chrome or Edge.
- **Hybrid-graphics laptops** may run the browser on the integrated GPU by default. The environment check shows the High performance instruction when that happens.

## Not proven by M0, covered by M1 acceptance

- Real 4K decode and full-pipeline speed (only synthetic 4K encode was measured).
- Streaming the export to disk through `showSaveFilePicker`.
- Frame-for-frame alignment in Resolve.

## Firefox run, same laptop, for comparison

- WebGPU detection: 8.8 fps inference only, 6.6 fps end to end.
- WASM: 3.8 fps.
- Decode at 1666×1080: 508 fps.
- The encode test failed on `prefer-hardware`. The spike now falls back to `no-preference` and reports which it used.

The source clip in that run started at a timestamp of 0.04 s, not 0. The export keeps source timestamps, and M1 tests this case.
