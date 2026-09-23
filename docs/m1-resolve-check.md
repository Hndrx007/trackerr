# M1 manual check: the export lines up in Resolve

The export check in the tool already proves this for every frame:
- the exported file has the source's frame count, frame rate and resolution;
- every frame sits on its time slot;
- every frame's burn-in marker reads back its own index.

This manual check confirms the last link: that **Resolve** places the export frame-for-frame on top of the source. It takes about five minutes.

## 1. Export

1. Start the tool with `python -m http.server 8000` in the project folder, and open <http://localhost:8000> in Chrome or Edge.
2. **Open** a graded shot rendered from Resolve as H.264 MP4. Use 4K if you have it; any length works.
   Write down the frame count from the header, e.g. `1,442 fr`.
3. Click **Export clip** and save it next to the source (the tool suggests `<name>_hud.mp4`).
4. Wait for **Export verified**. Every line should have a ✓. If any line has a ✗, stop there and report it: that's a bug.

## 2. Stack them in Resolve

1. Import the source and the export into the Media Pool.
2. Check that the two clips' **frame rate** and **duration** in the Media Pool metadata are identical.
3. Right-click the source → **Create New Timeline Using Selected Clips**. The timeline takes the clip's frame rate.
4. Drag the export onto **V2**, directly above the source, with snapping on (`N`). Its start must snap to the source's first frame.
   The export has no embedded timecode, so it starts at `00:00:00:00` in the Media Pool. Line it up by position, not by timecode.

## 3. Check

**Frame numbers (start, middle, end).** The burn-in shows the frame's position in the clip.
- Put the playhead on the **first** frame of the clip. The burn-in shows **0**.
- Step with `→` a few times. The burn-in goes 1, 2, 3, one per frame, with no repeats or skips.
- Move to the **middle** of the clip, then step a few frames. It still goes up by one per frame.
- Put the playhead on the **last** frame of the clip. The burn-in shows **frame count − 1** (for example 1441 for a 1,442-frame clip).
- The V2 clip ends on exactly the same frame as V1.

**Picture alignment (Difference blend).**
- Select the V2 clip. In the **Inspector**, under **Composite**, set **Composite Mode: Difference**.
- At the start, middle and end, the frame goes **black everywhere except the burn-in**: the number (top left) and the marker strip (bottom left).
- If the export were one frame out, every moving edge would light up. Step through a section with motion to see this clearly.
- With the clip playing, the Difference image should stay black. Faint noise is fine: that's H.264 re-compression, about 1 level.
- There should be no colour cast in the black areas. A tint would mean the colours shifted.

## 4. Record the result

Add a row to the table in [m1-results.md](m1-results.md): the clip, its frame rate and count, and pass or fail for start, middle, end and Difference. Note anything odd, especially:
- a clip whose first frame isn't at 0 s. The tool's side panel shows "First frame at 0.040 s" when that happens, and the export always starts at 0;
- 29.97 or 59.94 material;
- MOV sources.
