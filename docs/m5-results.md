# M5 results: 4K export

**Status: automated acceptance passes. The Resolve alignment check is yours** (the same procedure as M1: [m1-resolve-check.md](m1-resolve-check.md)).

## Multi-shot 4K sequence

The test sequence is frames 1871–2253 of the music video, upscaled to 3840×2160 and hardware-encoded at 60 Mbps with B-frames, as a stand-in for a Resolve render:
- 383 frames at 23.976 fps;
- 7 shots, since analysis finds 6 cuts in the range, including the jump cut at 2029 that the 1080p run missed;
- an AAC audio track, as a Resolve render has. The tool ignores it.

| Step | Result (Iris Xe laptop) |
|---|---|
| Analysis at 4K | 7.4 fps. Detection 116 ms; proxies 62 ms, where drawing a 4K frame into a small canvas is the cost; swarm 20 ms. |
| Export with the Surveillance HUD and burn-in | **21.3 fps**, hardware encoder, 139 MB at 0.35 bpp |
| Verification in the tool | ✓ 383/383 frames · ✓ 24000/1001 · ✓ every frame on its slot · ✓ bt709 tags · ✓ decodes in order · ✓ marker = index on all 383 frames, read through the HUD |
| Independent check (ffmpeg and a Python marker reader) | 383 frames, 24000/1001, bt709; marker = index on all 383 frames |

## Earlier 4K and 1080p runs

- **M1:** 60 s of UHD at 23.976, 1,440 frames, 19.5 fps, all checks pass.
- **1080p music video:** 5,109 frames, 66.5 fps, all checks pass, bt709 tags written explicitly.

## What's left

Stack a 4K export on its source in Resolve, following [m1-resolve-check.md](m1-resolve-check.md). Tick **Burn in frame numbers** in the Clip tab first, so the frame numbers can be read in Resolve.
