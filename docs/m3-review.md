# M3.5 look review

**Status: ready for your review.** Nothing in M4 onwards depends on the look, so work continues while the looks are reviewed. Change anything here and it's a parameter edit.

## How to review

1. Run `python tools/serve.py`.
2. Open <http://localhost:8000/_local/review/>. The review files are in `_local/`, which isn't committed, because they're renders of the test video.
3. Each row is one section of the test video rendered in all five looks, exported at 1080p through the real export path. **Play all** plays every video in sync. Contact sheets follow at the bottom.

| Section | Frames | What it tests |
|---|---|---|
| Single subject | 19–163 | The shot-start sequence on one person in a close-up. |
| Hero with others | 591–735 | Face locks on other people, and connectors. |
| Wide shot, crowd | 1043–1178 | Density and hierarchy when the hero is small. |
| Two shots with a cut | 2108–2253 | The sequence restarting at a cut, and how auto-pick behaves. |

## The looks

They differ in composition and choreography, not only colour.

| Look | What it's for | Composition | Choreography |
|---|---|---|---|
| **Surveillance** (default) | The notebook's red look, done well. | Up to 10 boxes: mostly scan boxes with scanlines, 3 locks with ticking telemetry, thin connectors, camera frame marks and REC. On average 6.6 boxes on screen. | Boxes cascade in; the shot-start sequence runs: scan tier, then hero acquired at 0.35 s, thermal wipe at 0.8 s, then the label types on. |
| **Lock-on** | Sparse and deliberate. | 3–4 heavy lock brackets gathered around the hero (Focus 0.9), strong connectors, no frame marks. On average 3.4 boxes on screen. | Slower acquire; signal pulses travel along each connector into the hero; a longer sequence with a slower wipe. |
| **Scan** | Density that reads as a sweep of the whole frame. | Up to 24 faint scan boxes with corner marks, about 75 trace ticks on tracked points, a frame sweep line, at most 1 lock, no connectors. On average 9.1 boxes on screen. | Fast acquire and release; no sequence, so the thermal is on from the first frame. |
| **Minimal** | For shots where the swarm would be too much. | Hero, thermal and a small label only. | The sequence only. |
| **Target** (proposal) | Multi-person shots. | One reticle lock, strongly weighted to the nearest other person, with a light scan field and point trace. | As Surveillance. |

### Rules that hold in every look

These are tested on every frame in `tests/compose.test.js`:
- **Budget:** at most Amount boxes.
- **Hero dominance:**
  - no box inside the hero rectangle plus a margin;
  - none taller than 45% of the hero box.
- **Spacing:** a minimum gap on every frame, with 1.5× the gap required for new boxes; boxes never nest.
- **Stability:** a new box must outscore an incumbent for 0.4 s before replacing it, boxes stay on screen at least 0.75 s, and nothing changes tier more than once in 0.5 s.
- **Determinism:** the same inputs always produce the same output.
- **Resolution independence:** a look renders identically at 1080p and 4K, 0.16 levels apart once scaled to the same size.

## Design decisions made along the way

- **Other people are locked by the head,** a square at the top of their box. Their full body boxes break the "no swarm box larger than a fraction of the hero" rule. A face lock is what a surveillance HUD would show anyway.
- **Candidates are ranked by meaning, not cluster size.** Focus moves the weight from spread across the frame to near the hero. Motion, persistence, a preferred size, and other people add to the score.
- **Auto-pick continues a hero only through a re-detection** (a new track starting near the lost one within 1 s). It never switches to someone else, because that was the notebook's hero-swapping bug. Real gaps are left for you to fill; M4 shows them in red on the hero lane.
- **If the hero box fills the frame** (a close-up), the label goes just inside its top-left corner.

## What I'd like from you

1. **Which look is the default,** and whether Target earns its place.
2. **Density:** Surveillance averages 6.6 boxes. Should it be busier or calmer?
3. **Sequence timing:** hero at 0.35 s, thermal at 0.8 s, wipe 0.3 s. Does that hit the beat you want for a music video?
4. **Auto-pick rule.** The spec says "nearest the frame centre", and that's what it does. In the two-shots section the detector takes a marble bust for a person, and because the bust is nearest the centre it becomes the hero. Weighting the pick by box size and detection confidence would avoid most of these. It's a small change, but it changes a spec rule, so it's your call. In the meantime, M4's click-to-pick fixes it per shot.
5. **Anything that looks generic or cluttered.** That's where the previous prototype failed.
