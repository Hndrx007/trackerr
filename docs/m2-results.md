# M2 results: analysis

**Status: done.** Cut detection was measured on a labelled clip and on the music video. Person-ID stability was checked on single-person shots.

## Speed (Iris Xe laptop, Edge, 1080p source)

On the whole 5,109-frame music video (3 min 33 s):
- **Full analysis:** 10.7 fps, 8 min, with detection on every frame.
- **Cut detection alone:** 27.7 fps.

| Stage (per frame) | Time |
|---|---|
| Person detection (YOLOv8n, WebGPU, 640 px) | 84 ms median; runs on the GPU while the CPU does the rest |
| Proxies (one small readback) | 17 ms |
| Swarm points (140 points, pyramidal LK) | 7.8 ms, down from 45 ms before the window-sampling rewrite |
| Cut signal | 0.4 ms |

On a dedicated GPU, detection drops to a fraction of this, so analysis is limited by the CPU stages at roughly 30–40 fps.

## Cut detection

**Labelled clip** (`tests/fixtures/cuts_test.mp4`, 300 frames, 9 true cuts). It includes a flash frame, a strobe run, a whip pan, a 2-frame shot, and a 2-frame black-and-white insert that cuts back to the same shot:
- precision **100%**, recall **100%**, and every cut on its exact frame;
- false cuts: **0 in the strobe run, 0 at the flash, 0 in the whip pan**.

**Music video** (`Out My Face`, 5,109 frames). There's no hand-made label list yet, so it was checked against ffmpeg's scene detector, and every disagreement was inspected by eye:

| | Frames | Verdict |
|---|---|---|
| Both detectors agree | 18 cuts | High ffmpeg scores; hard cuts. |
| Found by us, not ffmpeg | 4841 | Real cut, to a black end card. ffmpeg's score is low because the frames are mostly black. |
| Found by ffmpeg, not us | 1634 | Not a cut: one continuous camera move. |
| Found by ffmpeg, not us | 2029 | **Missed:** a jump cut on the same subject with the same colours. |

- **Result:** 19 detected, 0 false among those checked, 1 missed. That's precision 100% and recall 95% against the candidates either detector found.
- **Why 2029 is missed:** a hue-histogram signal can't see a same-scene jump cut. The spec chose that signal because anything structure-based fires on whip pans. The editor adds these with `C`. After a correction, the app's **Copy cut report** gives precision and recall against the corrected list.

For your labelled cut test clip: open it, analyse it, correct the cuts with `[` `]` `C` `Delete`, and copy the cut report.

## Detection rules beyond the spec, and why

- **The flash test checks the frames in between.** The spec's rule treats "the picture comes back within 3 frames" as a flash. On its own, that rule throws away a real 2-frame insert that cuts back to the same shot. So frames in between only count as a flash if their colour content didn't change, or if they're flat white or black.
- **Brightness-only changes are never cuts.** A frame whose hue content matches the previous frame is a strobe or an exposure change.
- **The adaptive threshold ignores frames already judged to be flashes.** Otherwise a strobe run lifts the threshold above a real cut inside it; the labelled clip tests exactly this.

## People

- **Single-person shots keep one ID for the whole shot.** Shot 1 is one track for 560 of its 572 frames; shots 3 and 7 are each one track.
- **The long roaming takes produce many tracks.** Shot 9 (693 frames) has 29 tracks and shot 17 (a 100-second take) has 100. These aren't swaps: the camera whip-pans between different people, and guests and waiters walk in and out of frame. For the hero, this shows as red gaps in the hero lane (M4), which you fill with a click.
- **YOLOv8n misses small, partly hidden people in wide shots:** about 2 of 6 people at the tea-party table are tracked. It also detects painted and sculpted figures as people.

## Swarm (the spec's regression tests)

| | Spec | Measured | tracker-v2 |
|---|---|---|---|
| LK, 1 / 3 / 6 px shift: median displacement | exact to 0.01 px | −1.0000 / −3.0000 / −6.0000 | — |
| LK: points tracked | ≥ 95% | 100% / 99% / 97% | — |
| Pan jitter at 1.73 px/frame | within 0.1 px | 1.660 px | 1.69 |
| Boxes dropping | < 2% | 0.31% | 0.8% |

- **Forward-backward check:** it dropped no points on the pan and didn't change the drop rate, so it's off by default, as the spec says, and kept as an option.
- **Sub-pixel accuracy:** v2 sampled the LK template at rounded positions, which costs up to half a pixel once points are sub-pixel. The rebuild samples bilinearly and replicates the image border.
