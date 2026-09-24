# Status

Last updated 2026-09-24. Every milestone in the spec is built. The remaining items are checks only you can do, and design decisions that are yours to make.

| Milestone | State | Details |
|---|---|---|
| M0 capability spike | done: go | [m0-results.md](m0-results.md) |
| M1 frame-exact round trip | done; you checked a 1080p export | [m1-results.md](m1-results.md) |
| M2 analysis | done | [m2-results.md](m2-results.md) |
| M3 renderer, composition, preview, panel | done | the commit log, and [m3-review.md](m3-review.md) |
| M3.5 look review | **waiting for you** | [m3-review.md](m3-review.md) |
| M4 hero picking, hero lane, cut editing | done | the commit log |
| M5 4K export | done; the Resolve check is yours | [m5-results.md](m5-results.md) |
| M6 polish | done | error messages reviewed, environment panel, shortcut list, unsaved-work guard |

## What needs you

1. **The look review.** Run `python tools/serve.py`, then open <http://localhost:8000/_local/review/>. Answer the questions at the end of [m3-review.md](m3-review.md). The most important is whether auto-pick may weigh box size and detection confidence rather than only "nearest the centre": in one test shot it picked a marble bust.
2. **Resolve alignment.** Tick **Burn in frame numbers** (Clip tab), export, and stack the export on its source in Resolve following [m1-resolve-check.md](m1-resolve-check.md). Do it once at 1080p and once at 4K if you can.
3. **Your labelled cut test clip.** Analyse it, correct the cuts, and use **Copy cut report** (Analysis tab) for the precision and recall the M2 acceptance asks for.

## Changes from the spec

- **Audio (2026-09-24, your decision).** The spec said "No audio in v1". There's now an **Include audio** option in the Clip tab, off by default.
  - It copies the source's audio unchanged, shifted by the video's start time so the two stay in sync.
  - The export check compares every audio packet with the source, and a MOV source with audio exports as a MOV.
  - On your music video, whose picture starts 0.042 s after its sound, ffmpeg found the export's audio sample-exact against the picture from start to end.

## Known limitations

- **No timecode track in the export.** Mediabunny can't write one, so line the export up by position in Resolve.
- **Missed jump cuts.** A jump cut within the same scene and colours isn't detected; add it with `C`.
- **YOLOv8n misreads some scenes.** It misses small, partly hidden people in wide shots, and it counts statues and painted figures as people.
- **Slow proxies at 4K.** Analysing a 4K clip spends about 60 ms per frame just scaling the frame down for analysis. 1080p clips analyse faster.

## Measured on the Iris Xe laptop (the slowest machine this will run on)

| | Result |
|---|---|
| Analysis | 10.7 fps at 1080p, 7.4 fps at 4K |
| Playback with the HUD | 24 fps for 23.976 footage, no frames dropped |
| Export | 66 fps at 1080p; 19.5–21.3 fps at 4K with the hardware encoder |
| Composition | about 10 ms per 10-second shot, so sliders feel instant |
