# Build spec: Hero Tracker — browser video effect tool

## What we're building

A browser tool that applies a surveillance-HUD tracking effect to music-video footage and exports a finished 4K clip. One person (the "hero") gets a thermal-palette rectangle with a heavy box, corner brackets and a label. A swarm of smaller tracked boxes with scanlines sits on the rest of the frame, with connector lines running from nearby swarm boxes to the hero.

The user is one video editor on a Windows gaming laptop (discrete GPU, assume ≥2 GB VRAM) who cuts in DaVinci Resolve. Their workflow:

1. Grade the shot or sequence in Resolve.
2. Render it out as H.264 MP4, 8-bit, constant frame rate, up to 4K.
3. Open it in this tool, analyse, pick the hero, adjust the look.
4. Export an H.264 MP4 with the effect baked in.
5. Drop it back on the Resolve timeline, where it must line up frame-for-frame with the original.

The effect is baked in, so it comes after the grade. This is the reason input is restricted to H.264. Don't add support for other input codecs.

### Where the creative work is

Most of this spec is plumbing and is deliberately exact: decoding, frame exactness, tracking, export. **Composition** — which boxes are shown, how they are ranked, how they move in time, how they relate to the hero — is deliberately open. That's where the previous prototype failed. Its motion was fine, but it drew every cluster it found with equal weight, so it looked cluttered and generic, with no hierarchy and no thermal. The composition section below sets a floor (tests) and a direction, and asks you to design above it. There is a review gate before anything is built on top.

## Reference material in the repo

- `reference/tracker.ipynb` is the original Colab prototype. Port its **look**, not its code. Its structural bugs are listed under "Do not replicate" below.
- `reference/tracker-v2.html` is the earlier browser prototype. **Take only its point tracking** (Shi-Tomasi seeding, pyramidal Lucas-Kanade, top-up, cluster identity by member overlap), which measured well; see "Swarm tracking" below. **Do not take its look, its UI or its composition.** It drew every cluster at three nested levels with equal weight, which is what made it cluttered. Its controls exposed algorithm internals (point count, sensitivity, cluster caps) instead of look decisions, and it had no thermal and no hero.
- `models/yolov8n.onnx` is the person detector. It's exported once with `yolo export model=yolov8n.pt format=onnx imgsz=640`, and its output tensor is `[1, 84, 8400]` (raw, no NMS).

## Hard constraints

- **Client-side only.** No server and no uploads; the video never leaves the machine. The target browsers are Chrome and Edge on Windows.
- **No build step.** Plain ES modules, with third-party libraries imported from jsDelivr at pinned exact versions. It runs locally via `python -m http.server` and gets deployed as static files to GitHub Pages. No TypeScript, bundler, framework or npm install.
- **Libraries:**
  - Mediabunny for demux, decode, encode and mux. Check the API against the current docs at mediabunny.dev; don't guess method names.
  - onnxruntime-web with the WebGPU execution provider, falling back to WASM with a visible warning.
  - Nothing else unless a milestone cannot be met without it. Justify any addition in the PR description.
- **Frame exactness is the top priority.**
  - The output has the same resolution, the same frame rate and exactly the same frame count as the input.
  - Frame index = position in presentation order of the decoded samples.
  - Analysis and export must use the same decode path, so frame N means the same image in both.
- **Input validation.** Accept H.264 in MP4 or MOV only, up to 3840×2160.
  - Detect variable frame rate by checking that every timestamp delta is within ±1% of the median delta.
  - Reject anything else with a message that says what to do, e.g. "This file is HEVC 10-bit. Render the shot from Resolve as H.264 and open that."
- **No 4K pixel readback.** Never call `getImageData` or `readPixels` at output resolution. All full-resolution work stays on the GPU. CPU pixel access is only allowed on the small analysis proxies.
- **Streaming output.** Write the export straight to disk through the File System Access API (`showSaveFilePicker`). A 4K file must never sit in RAM in full.

## File layout

```
index.html
app/
  main.js            app state machine, wiring
  env.js             capability checks (WebCodecs, WebGPU adapter, encoder support)
  media.js           Mediabunny input/output, frame iteration, validation
  trackdata.js       track data model, save/load, smoothing
  analysis/
    worker.js        runs the analysis pass off the main thread
    cuts.js          cut detection
    detector.js      YOLO pre/post-processing, NMS
    persons.js       person tracker (IDs)
    swarm.js         point tracking (from tracker-v2) → candidates
  render/
    compose.js       composition + choreography pass (see Composition)
    renderer.js      WebGL2 renderer (shared by preview and export)
    palettes.js      thermal palette LUTs
    params.js        parameter schema, defaults, presets
  ui/
    viewer.js        video viewer, click-to-pick
    timeline.js      scrubber, cut markers, hero lane, cut-signal debug graph
    panel.js         settings panel generated from params.js
models/yolov8n.onnx
reference/
spike.html           milestone 0
tests.html           in-browser unit tests, no framework needed
```

## Architecture

There are four app states: **Empty → Analysing → Ready → Exporting.**

The central rule is that **analysis and rendering are separate.** Analysis runs once and produces track data. Rendering is a pure function of `(source frame, frame index, track data, params, output size) → pixels`. Preview and export call the same renderer at different sizes.

### Track data

All coordinates are normalised to 0..1 of the source frame.

```js
{
  version: 1,
  source: { name, byteSize, width, height, fps: [num, den], frameCount },
  proxy: { width, height },
  cuts: [ { frame, origin: "auto" | "manual" } ],     // frame = first frame of a new shot; frame 0 implicit
  cutSignal: Float32Array,                             // per-frame distance, for the debug graph
  detections: [ [ [x, y, w, h, conf], ... ], ... ],    // raw per-frame person boxes, cut-independent
  persons: { [id]: { shot, start, boxes: [[x,y,w,h], ...] } }, // contiguous per-frame boxes, one shot only
  swarm:   { [id]: { shot, start, pts: [[x,y], ...] } },     // point tracks from analysis
  clusters:{ [id]: { shot, level, start, boxes: [[x,y,w,h], ...] } }, // cluster pass output, rebuildable
  layout:  { [id]: { shot, start, tier: [...], appear, exit } },      // composition pass output, rebuildable
  hero:    [ { start, end, personId } ]
}
```

Save and load it as JSON, with typed arrays encoded compactly. On load, check the name, byte size and frame count against the open video, and warn on a mismatch. Reopening a project must not require re-analysis.

## Analysis pass

The pass runs in a Worker. It decodes every frame in order and makes three proxies:
- 640 px wide (RGB) for person detection;
- 320 px wide (luma) for the swarm. The swarm algorithm's thresholds are tuned in 320 px space, so keep this size;
- 160 px wide for cut detection.

The UI shows progress, frames per second and time remaining, and has a Cancel button.

Per frame, run these steps **in this order**:

1. **Cut detection** (see the next section). A cut on frame N resets the person tracker and the swarm before step 3 runs on frame N.
2. **Person detection.**
   - Letterbox the proxy to 640, convert to RGB, divide by 255, lay out as NCHW float32.
   - Run YOLO and keep class 0 (person) only.
   - Confidence threshold default 0.35; NMS at IoU 0.5.
   - Undo the letterbox and normalise the boxes.
   - Store the raw boxes in `detections`.
   - `detectStride` defaults to 1. If the spike shows detection is too slow, use 2–3 and linearly interpolate boxes for matched tracks between detection frames.
3. **Person tracking.**
   - Predict each track with constant velocity, then match detections greedily by IoU (≥ 0.3), breaking ties by centre distance.
   - Start new tracks only from detections with conf ≥ 0.5.
   - Keep lost tracks for `maxAge = round(0.5 × fps)` frames.
   - **Never match across a cut.**
4. **Swarm points** (steps 1–3 of the swarm algorithm below).
   - Store every point's ID and position per frame in `swarm`.
   - Add a forward-backward LK check (track back and drop points that don't return within ~1 px). It isn't in v2; if it lowers the drop-rate numbers below, keep it, otherwise leave it out.
   - Clear all points and reseed fully at a cut.

Clustering (steps 4–7 of the algorithm) is **not** part of this pass. It runs as a separate cluster pass, described below.

**Detections don't depend on cuts, but tracks and the swarm do.** When the editor adds or removes a cut, re-run person tracking over the affected shots from the cached `detections` (cheap). The swarm for those shots needs those frames decoded again, so re-analyse only the shots on either side of the edited cut, not the whole file.

## Swarm tracking (from tracker-v2)

This is the one part of v2 to keep: its point tracking measured well and its motion wasn't the problem. Port steps 1–3 and 5. Steps 4, 6 and 7 produce **candidates** for the composition pass, not the final picture. The per-level caps are no longer the thing that decides what's on screen. All pixel values are in 320 px analysis space. If you find a better way to produce stable candidates, you may replace steps 4–7, but the regression tests must still pass.

1. **Persistent point set.** Seed with Shi-Tomasi corners: structure tensor over a 5×5 window, minimum eigenvalue, quality 0.012 of the peak score, greedy minimum-distance suppression at 9 px. Seed once, then track. Never re-detect the whole set.
2. **Pyramidal Lucas-Kanade.** 3 pyramid levels, 17×17 window, up to 6 iterations, coarse-to-fine. The flow guess starts at zero. (v2 once had a bug initialising it to the point's position, which made nothing track.) Drop points whose structure tensor is singular or that leave the frame.
3. **Top up, don't replace.** When fewer than 75% of the target (default 140) survive, or every 12 frames, detect new corners masked against existing points and append them with fresh IDs.
4. **Cluster at three levels.** Single-linkage union-find at distance thresholds 11, 24 and 52 px, with minimum member counts 1, 3 and 6. Keep the largest clusters per level, up to caps of 22, 10 and 4.
5. **Stable cluster identity.** Match each cluster's member-ID set to the previous frame's clusters at the same level by Jaccard overlap; accept above 0.34. Never key identity on a single point.
6. **Box from cluster extent.** Width = extent × 1.55, height = extent × 1.27. Snap both to the size ladder 12/16/24/32/48/64/96/128/192/256.
7. **Size hysteresis.** Keep the previous size unless the new one is two or more ladder steps away.

Measured on a slow-pan test clip with the pan at 1.73 px/frame in analysis space:

| | feature clusters | saliency peaks | quadtree |
|---|---|---|---|
| jitter | 1.69 px | 2.00 px | 0.00 px |
| dropped boxes | 0.8% | 9% | 3% |
| nesting | 0.84 | 0.01 | 0.00 |
| distinct sizes | 12.7 | 3.0 | 2.0 |
| grid score | 0.46 | 0.47 | 1.00 |

Jitter matching the pan speed means the boxes are locked to the content. Quadtree's 0.00 means its boxes sit still while the image pans underneath: they're locked to the screen, which is why it reads as a mosaic filter.

These parameters were tuned on synthetic footage and have not been judged by eye on real footage. Expose them as parameters and expect to retune point count and caps on real music-video footage.

### Cluster pass (candidates)

Clustering (steps 4–7) runs over the stored point tracks, one shot at a time and in frame order, starting from empty state at every cut. It is cheap (milliseconds per frame) and **re-runs whenever a density parameter changes**, so the editor can adjust box density without re-analysing.
- Output: cluster boxes with a stable ID and level, stored in `clusters` in the track data.
- v2's causal EMA on box centres is **replaced** by the zero-lag smoothing below. Size hysteresis stays.
- Boxes are converted to normalised coordinates on output.
- Generate generously (for example the v2 caps or more). The composition pass does the choosing.
- Non-hero person tracks are candidates too, tagged `person`. Other people in the frame are natural secondary targets.
- For each candidate and frame, record the features composition needs: centre, size, age, speed (from point velocities), and distance to the hero.

## Composition — the creative core

Composition is an offline pass (`compose.js`). It runs one shot at a time, after the cluster pass and whenever a composition parameter changes. It decides, for every frame, which candidates are visible, in which **tier**, and at what stage of their appearance or exit animation. The renderer then only draws what `layout` says. Keep it deterministic and fast enough to re-run live while a slider is dragged (target under 200 ms for a 10-second shot).

### The floor (these are tests, not suggestions)

- **A budget.** The number of visible swarm boxes never exceeds the Amount setting. Default to sparse: about 8–12 at 1080p framing, not 30+.
- **Hierarchy.** At least two visually distinct tiers:
  - **lock:** few, heavy, with a label or readout and a connector to the hero;
  - **scan:** more, light, scanlines, no label.
  Optionally a third, faint **trace** tier (points or ticks). Tiers must differ in more than colour.
- **The hero dominates.** No swarm box enters an exclusion zone around the hero (the hero rectangle plus a margin), and no swarm box is larger than a set fraction of the hero box.
- **No crowding.** Visible boxes keep a minimum spacing. Nesting is allowed only as a deliberate lock-tier treatment, at most one child per box, never three levels everywhere.
- **Tier stability.** Rank candidates with hysteresis: a candidate must outscore the one it replaces for several frames before it's promoted, and it stays visible for a minimum time. Composition must not reintroduce flicker. Test it: no candidate changes tier more than once in any 0.5 s window.
- **Deterministic.** Everything is a function of frame index, track data and parameters.

### Direction (design above the floor)

- **Rank by meaning, not by cluster size.** Suggested score inputs: proximity to the hero, motion, age/persistence, size preference, and a person bonus. Expose the weights through a few look-level controls rather than raw weights.
- **Focus.** A single control from "spread across the frame" to "gathered around the hero".
- **Choreography.** Things happen over time, and the timing is part of the look:
  - boxes acquire (draw on over a few frames, then settle) and release (collapse or fade), rather than popping in and out;
  - readouts count, tick or update;
  - an optional **shot-start sequence**: the scan tier appears first, the hero is acquired after a short delay, then thermal switches on with a wipe or scanline sweep and the label appears. This is the music-video moment. Make the timing adjustable.
  - All timing is in frames derived from seconds × fps, so it's frame-rate independent.
- **Readout content options:** track ID, fabricated telemetry, class label (`PERSON`) for person candidates, distance to hero, confidence.
- **Looks, not skins.** Built-in presets must differ in composition and choreography, not only colour. At minimum:
  - **Surveillance:** the notebook's red look, done well. Scanlines, connectors to the hero, moderate density.
  - **Lock-on:** sparse. Three to five lock boxes, heavy brackets, readouts, strong hero connectors, shot-start sequence on.
  - **Scan:** denser and fainter. Mostly scan and trace tiers, few locks, no connectors.
  - **Minimal:** hero and thermal only, small readout.
- You're free to propose more rules, tiers or presets. Show them at the review gate, with a sentence on what each is for.

## Cut detection

This is music-video footage: fast cuts, whip pans, strobes and flash frames. The detector has to reject flashes, and the editor has to be able to correct it.

- **Signal.** For each frame, compute an HSV histogram (16 H × 4 S × 4 V) of the 160 px proxy. `d(i)` is the chi-square distance between frame i−1 and frame i. Hue and saturation should dominate, so a brightness-only change (a strobe) scores low.
- **Adaptive threshold.** Frame i is a cut candidate if `d(i) > max(absMin, k × median(d over the previous ~1 s))`. Defaults: `k = 3`, `absMin` tuned on test footage.
- **Flash rejection.** Needs lookahead of up to 3 frames. Reject a candidate at i if, for some k in 1..3, frame i+k is close to frame i−1 (`chi2(hist(i−1), hist(i+k)) < lowThreshold`). That means the picture came back, so it was a flash, not a cut.
- **Minimum shot length** defaults to 2 frames, because music videos really do have 2-frame shots.
- **Not detected in v1:** dissolves and fades. The editor adds those by hand.
- **Manual editing.**
  - Cut markers show on the timeline.
  - `C` adds a cut at the playhead.
  - Select a marker and press `Delete` to remove it.
  - Manual cuts are stored with `origin: "manual"` and survive re-analysis.
- **Debug graph.** A toggle on the timeline plots `d(i)` and the live threshold under the scrubber. This is how the thresholds get tuned on real footage, so build it with the detector, not later.

## Hero selection

- **Auto-pick.** When a shot starts, and wherever a person appears in a shot that has no hero yet, auto-pick the person track nearest the frame centre at its first frame. This is a toggle, on by default.
- **Click to pick.** In Ready state, the viewer shows every person box faintly, with its ID. Clicking one sets `hero = { start: currentFrame, end: end of that track, personId }`. It replaces any overlapping hero segment from the current frame onwards.
- **Clear.** `X` clears the hero from the current frame to the end of the current segment.
- **Hero lane** under the scrubber:
  - solid where there is a hero;
  - red where people are detected in the shot but there is no hero (a gap to fix);
  - grey where nobody is detected.
- **Navigation.** `G` jumps to the next red gap. `[` and `]` jump to the previous and next cut.

The editor never edits individual boxes. If tracking loses the person, they click again at the gap.

## Smoothing

Analysis is offline, so use **non-causal (zero-lag) smoothing**: a centred Savitzky-Golay or Gaussian filter over each track's coordinates, applied to the track data before rendering.
- The window never crosses a cut or a track boundary.
- Hero and swarm have separate strength sliders.
- Hero default: moderate. YOLO boxes jitter a few pixels per frame, and the brackets amplify it.

## Renderer

The renderer is WebGL2. It uploads the source frame as a texture from a `VideoFrame`, renders at the requested size, and at export produces a `VideoFrame` from the canvas carrying the source timestamp and duration.

Layers, bottom to top:

1. **Source frame.**
2. **Thermal on the hero rectangle.** A shader takes luma, applies gain and contrast, then looks up a 256×1 palette texture. Palettes: inferno (default), iron, white-hot. Rectangle only; no segmentation.
3. **Connector lines.** From the hero to lock-tier boxes (and scan tier, if the preset says so). Weight falls off with distance.
4. **Swarm boxes by tier**, as `layout` specifies: trace, then scan, then lock, each with its own style and its appear/exit animation state.
5. **Hero box, corner brackets, label and the shot-start sequence** (acquire, thermal wipe).

The renderer draws only what `layout` says. It never chooses boxes itself.

Rules:
- **Resolution independence.** Every size is a fraction of frame height: stroke widths, bracket length, scanline gap, font size, box sizes, spacing. A preset must look the same at 1080p and 4K.
- **Determinism.** Any variation (box size, style offsets) is seeded from a hash of the track or point ID. Never use frame index or loop order. The same inputs must give byte-identical output.
- **Text.** Draw it via a glyph atlas texture or an OffscreenCanvas composited as a texture. Whichever you choose, stay within the no-4K-readback rule.

## Parameters

Parameters are defined as data in `params.js`, and `panel.js` generates the UI from them. Each entry has `key`, `label`, `type`, `default`, `min`, `max`, `step`, `group` and `advanced` (true = shown only in the collapsed Advanced section). The main panel holds **look decisions** — what the editor thinks in. Algorithm internals go in Advanced. The last prototype's panel was all internals, which is a large part of why it felt crude. Defaults reproduce the notebook's look:

| Group | Main panel | Advanced |
|---|---|---|
| Look | preset, colour, overall intensity | |
| Hero | thermal palette, gain, contrast, box style, bracket length, label text ("THERMAL: ON"), label size | smoothing strength |
| Swarm | amount (budget), focus (spread ↔ around hero), lock count, tier styles, scanline density, readout content | point count, sensitivity, cluster thresholds, score weights, smoothing strength |
| Motion | acquire speed, release speed, shot-start sequence on/off, sequence timing | tier hysteresis frames, minimum visible time |
| Connectors | on/off, which tiers, range, weight | |
| Tracking | auto-pick hero per shot | detection confidence, detect stride |

Presets are named parameter sets. Save, load, and import/export them as JSON. Ship the four built-in looks from the Composition section, with Surveillance as the default. Changing any setting marks the preset as modified, and the editor can save it as their own.

## Preview

- Uses a `<video>` element with `requestVideoFrameCallback`. Map `mediaTime` to a frame index through the source's timestamp table, not by multiplying by the frame rate.
- Renders at display size. It may drop frames during playback, but the overlay shown must always belong to the frame on screen.
- `←`/`→` step one frame; `Shift+←/→` step 1 second; `Space` plays and pauses.
- **Check frame.** Renders the current frame at full resolution through the export path and shows it at 1:1 in a pannable view, so the editor can confirm the preview matches the export.

## Export

- The pipeline is Mediabunny decode → renderer at source resolution → H.264 encode (`hardwareAcceleration: "prefer-hardware"`) → MP4 streamed to disk.
- Choose the codec string by probing `VideoEncoder.isConfigSupported`: High profile, level 5.1 for 4K up to 30 fps, level 5.2 above that. If nothing is supported, stop and say so.
- **Bitrate:** 0.35 bits per pixel per frame (about 70 Mbps at 4K 24 fps), editable, with a keyframe every 1 s.
- **No audio in v1.** The clip sits above the song on the Resolve timeline.
- Shows progress, frames per second and time remaining, with Cancel.
- **Verification.** Afterwards, reopen the output with Mediabunny and check the frame count, resolution and frame rate against the source. Show the result as pass or fail. A fail is a bug.

## Environment check

This runs on load and appears in a small status panel:

- WebCodecs present.
- WebGPU adapter name. If it looks like an integrated GPU, show: "Detection is running on the integrated GPU. In Windows Settings → System → Display → Graphics, set your browser to High performance."
- H.264 4K encode supported.
- Analysis backend in use: WebGPU or WASM.

## UI

This is a work tool used in dim rooms next to a grading monitor, which drives the look:

- **Chrome is true neutral grey.** No tinted darks, because a tinted UI biases how the editor judges the picture.
- **The UI accent must not be red.** Red belongs to the HUD, and a red UI accent would be confused with it.
- **Quiet chrome.** The video is the loud thing on screen.
- Timecode and frame number are both shown, with tabular numerals.
- Plain, specific labels: "Analyse", "Export clip", "Check frame".
- Errors say what happened and what to do next.
- **Controls feel good to use.** Sliders show their value and reset on double-click. Every change previews instantly on the paused frame, and while playing. Presets can be compared by hovering over them in the Look menu (hover shows the look on the current frame, click applies it).

```
┌──────────────────────────────────────────────────────────────┐
│ Open   file.mp4 · 3840×2160 · 23.976 · 1,442 fr   Analyse  Export clip │
├───────────────────────────────────────────────┬──────────────┤
│                                               │ Look   [▾]   │
│                                               │ Hero         │
│                 viewer                        │ Swarm        │
│        (click a person box = hero)            │ Motion       │
│                                               │ Connectors   │
│                                               │ ▸ Advanced   │
├───────────────────────────────────────────────┴──────────────┤
│ 00:00:12:04  f 292   ◀ ▶  Check frame                        │
│ scrubber  ───|────────|──────|──────────  (cut markers)       │
│ hero lane ████░░░░████████   ████▓▓▓▓████                     │
│ cut signal (toggle)                                           │
└──────────────────────────────────────────────────────────────┘
```

Empty state: a drop zone that says which files are accepted and why (H.264 rendered from Resolve).

## Milestones

Deliver them in order. Each one must meet its acceptance criteria before the next starts.

**M0 — Capability spike (`spike.html`). Stop after this and report the numbers.**
- Measures, on a user-supplied 4K clip:
  - full-speed decode frames per second;
  - YOLO frames per second at 640 on WebGPU, then on WASM;
  - 4K H.264 encode frames per second;
  - WebGPU adapter name.
- Acceptance: all numbers printed on the page, with no crashes on a 60-second 4K clip. The user runs this on the editor's laptop. The go/no-go for the browser approach is decided from these numbers, not assumed.

**M1 — Frame-exact round trip.**
- Decode, burn in the frame index (large text), encode, stream to disk.
- Acceptance:
  - automated verification passes;
  - frame N of the output shows N;
  - documented manual check: in Resolve, stack it on the source clip, and the frame numbers match at the start, middle and end.

**M2 — Analysis.**
- Cuts, detection, person tracking, swarm, running in the Worker; save and load of track data.
- A debug overlay shows raw boxes, IDs, swarm points, cut markers and the cut-signal graph.
- Acceptance: on the user's labelled cut test clip, report cut precision and recall and the false cuts in the strobe section. Person IDs stay stable through a single-dancer shot with no swaps.

**M3 — Renderer, composition, preview and parameter panel.**
- Acceptance:
  - the composition floor tests pass;
  - the same preset looks the same at 1080p and 4K;
  - Check frame matches the preview.

**M3.5 — Look review. Stop here.**
- Render every built-in look (plus any you propose) on the user's three test clips as short 1080p MP4s, plus a contact sheet of stills.
- The user reviews them. Composition and presets get revised until they're approved. Nothing in M4+ depends on the look, so iterate here freely.

**M4 — Hero picking, hero lane and cut editing.**
- Acceptance:
  - click-to-pick, auto-pick, gap navigation and `C`/`Delete` all work;
  - editing a cut re-analyses only the neighbouring shots.

**M5 — 4K export.**
- Acceptance: a 4K export of a multi-shot test sequence passes verification and lines up in Resolve.

**M6 — Polish.**
- Built-in presets, environment check panel, every error message reviewed against the UI rules.

## Tests

`tests.html` runs in-browser unit tests covering:
- IoU and NMS;
- the person tracker on synthetic box sequences, including a crossing and a cut;
- the cut detector on synthetic signals, including a flash frame, a 2-frame shot and a strobe run;
- smoothing not crossing cuts;
- renderer determinism (hash two renders of the same frame);
- **composition floor:** the budget is never exceeded; the hero exclusion zone is never entered; minimum spacing holds; no candidate changes tier more than once in any 0.5 s window; the same inputs give the same layout;
- **swarm regression**, ported from v2's harness:
  - on a synthetic textured image shifted by 1, 3 and 6 px, LK median displacement is exact to 0.01 px and at least 95% of points are tracked;
  - on the synthetic pan (1.73 px/frame), jitter is within 0.1 px of the pan speed and fewer than 2% of boxes drop.

The user supplies test clips:
- a single-dancer 4K shot;
- a multi-person shot;
- a multi-shot sequence with a known cut list, including strobes and flash frames.

## Out of scope for v1

Alpha or overlay export, audio, segmentation or silhouettes, dissolve detection, editing individual boxes, HEVC/ProRes/BRAW input, other effects. Keep `params.js` and `renderer.js` general enough that a second effect could be added later, but don't build a plugin system.

## Do not replicate (bugs in the notebook)

- Picking the hero per frame by distance to centre: it swaps people.
- Re-detecting swarm points every frame: they flicker.
- Tying box size to loop index: sizes flicker.
- Sizes in pixels: the look changes with resolution.
- A full-frame copy per swarm box for scanlines.
- `mp4v` output, frame rate taken from container metadata, dropped audio.
- Detecting on frames that already have the overlay drawn on them.
