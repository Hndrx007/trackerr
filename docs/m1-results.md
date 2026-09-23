# M1 results: frame-exact round trip

**Status: automated acceptance passes. The manual Resolve check is pending.** See [m1-resolve-check.md](m1-resolve-check.md).

Pipeline: Mediabunny decode → WebGL2 renderer at source resolution (frame index burned in) → WebCodecs H.264 encode → MP4 streamed to disk → reopened and verified.

## Automated verification

Measured on the Iris Xe laptop in Edge/Chromium, 2026-09-24. Each export is reopened and checked. "Frame N shows N" means the burn-in marker was read back from every frame.

| Clip | Frames | Rate | Frame count, rate, timing | Frame N shows N | Picture vs source |
|---|---|---|---|---|---|
| UHD 3840×2160, 60 s, B-frames, 60 Mbps | 1,440 | 24000/1001 | ✓ | ✓ all 1,440 | 0.35 levels, no bias |
| 640×360 natural footage | 48 | 24/1 | ✓ | ✓ | 0.68 levels, no bias |
| 320×180, B-frames | 72 | 24000/1001 | ✓ | ✓ | test pattern (see below) |
| 320×180, **first frame at 0.08 s** | 50 | 25/1 | ✓ (export starts at 0) | ✓ | test pattern |
| 320×180 MOV | 45 | 30000/1001 | ✓ | ✓ | test pattern |
| 320×180 | 60 | 60000/1001 (level 5.2) | ✓ | ✓ | test pattern |

The full in-browser suite (`tests.html`) has 39 tests, and all pass. It covers:
- validation;
- the exact frame-rate maths;
- the renderer (pixel-exact copy at source size, deterministic output, the overlay touching only its own pixels);
- marker read-back from 320×180 up to 4K and portrait;
- every round trip above;
- cancel;
- that the verifier catches a wrong file.

### Checked independently of Chrome

The outputs were decoded with ffmpeg/libavcodec instead of the browser:
- **ffprobe:** 1,440 frames at 24000/1001 for the 4K export; 50 frames at 25/1 starting at 0.000 for the offset clip. No edit list, and bt709 tags throughout.
- **Burn-in markers read by a Python port of the reader from ffmpeg-decoded frames:** marker = index on all 1,440 4K frames and all 50 offset-clip frames.
- **Per-frame luma PSNR by decode index,** comparing each output frame with its own source frame and with its neighbours:

| Clip | vs its own frame | vs previous or next frame |
|---|---|---|
| 0.08 s offset | 43.1 dB (worst 42.5) | 28.7 dB |
| natural | 48.9 dB (worst 48.5) | 21.8 dB |
| B-frames | 43.0 dB (worst 41.4) | 28.3 dB |

## Speed (Iris Xe, the floor)

- **Export, 4K 23.976 with burn-in:** 19.5 fps (0.81× real time). 1,440 frames took 74 s, plus 57 s for verification.
- **Output size:** 403 MB at the 0.35 bpp target (69.7 Mbps VBR).
- **Memory:** the JS heap peaked at 128 MB while writing that 403 MB file, so the file isn't held in memory.

## Decisions made in M1

- **Output timestamps are `i × den/num` starting at 0,** not the source's raw timestamps. Resolve renders sometimes start at 0.04 s, from B-frame composition offsets with no edit list. Copying that offset makes Mediabunny write an empty edit at the start of the file, which some tools show as a black frame. The input is validated as constant frame rate, so frame i's slot is exact either way, and a clean 0-based file is the safer thing to put on a timeline.
- **The frame rate is an exact rational** (for example 24000/1001), derived from the whole clip and snapped to the broadcast rates. The MP4 timescale follows from it, so there's no rounding drift over long clips.
- **Colour:** checked stage by stage.
  - Chrome's YUV→RGB upload and its RGB→YUV encode are both exact BT.709 on flat patches.
  - Natural footage round-trips with no measurable bias.
  - The synthetic test patterns show chroma differences at hard saturated edges. That comes from the 4:2:0 → RGB → 4:2:0 round trip, which any RGB compositor has, and it doesn't depend on bitrate.
  - Verification warns (doesn't fail) on the picture comparison, and the natural clip must pass it strictly.
- **Export target:** `showSaveFilePicker` in the app; the origin-private file system (OPFS) in tests. Both are real disk streaming with `fastStart` off, so the file is never held in memory.

## Known limitations

- **No timecode track.** Mediabunny can't write one, so the export starts at `00:00:00:00` in Resolve. Stack it by position. Copying the source's start timecode could be added later.
- **The viewer steps frame by frame; there's no playback yet.** Playback on a `<video>` element with `requestVideoFrameCallback` is part of M3.

## Resolve check (manual)

| Date | Clip | Rate | Frames | Start | Middle | End | Difference blend | Notes |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |
