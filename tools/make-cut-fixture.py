"""Builds tests/fixtures/cuts_test.mp4 and cuts_test.json: a labelled cut-detection clip.

Shots are pans over the two Ultralytics sample photos (bus.jpg is fetched from the ultralytics
package if present) plus synthetic sources, joined with hard cuts. The clip contains the hard
cases the spec names: a flash frame, a strobe run, a whip pan, a 2-frame shot, and a 2-frame
insert that cuts back to the same shot. The JSON lists the true cut frames and the ranges.

Needs ffmpeg with libx264. Run from the repo root: python tools/make-cut-fixture.py
"""
import json, os, subprocess, tempfile

FIX = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures")
ZIDANE = os.path.join(FIX, "zidane.jpg")
BUS = os.path.join(FIX, "bus.jpg")
W, H, FPS = 320, 180, 24
TAGS = "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv"

def still(img, frames, x0, y0, vx, vy, zoom=1.0, extra=""):
    """A pan over a photo: crop window moving vx, vy px per frame (in the scaled image)."""
    sw = int(W * 2 * zoom)
    return (["-loop", "1", "-framerate", str(FPS), "-i", img],
            f"scale={sw}:-2,crop={W}:{H}:x='{x0}+n*{vx}':y='{y0}+n*{vy}'{extra},format=yuv420p", frames)

def synth(src, frames):
    sep = ":" if "=" in src else "="
    return (["-f", "lavfi", "-i", f"{src}{sep}size={W}x{H}:rate={FPS}"], "format=yuv420p", frames)

# (label, generator) in order. Frame numbers are assigned as the clip is built.
PLAN = [
    ("zidane pan", still(ZIDANE, 40, 60, 60, 1.5, 0)),
    ("bus pan, flash frame at +20", still(BUS, 44, 40, 200, 0.8, 0.3,
        extra=",drawbox=x=0:y=0:w=iw:h=ih:color=white@1:t=fill:enable='eq(n,20)'")),
    ("mandelbrot, 2-frame shot", synth("mandelbrot", 2)),
    ("zidane close-up", still(ZIDANE, 36, 300, 120, -1.0, 0.2, zoom=1.6)),
    ("bus: strobe on every other frame from +10 to +40", still(BUS, 52, 120, 260, 0.6, 0,
        extra=",eq=brightness='if(between(n,10,40)*mod(n,2),0.35,0)':eval=frame")),
    ("zidane whip pan (fast, no cut)", still(ZIDANE, 30, 10, 40, 22, 0)),
    ("cellauto, 2-frame insert", synth("cellauto=rule=110", 2)),
    ("zidane whip pan, continued after the insert", still(ZIDANE, 30, 10 + 30 * 22, 40, -4, 0)),
    ("smptebars", synth("smptebars", 24)),
    ("bus wide", still(BUS, 40, 0, 100, 0.5, 0.5, zoom=1.0)),
]

def main():
    if not os.path.exists(BUS):
        import glob
        cand = glob.glob(os.path.expanduser("~") + "/**/ultralytics/assets/bus.jpg", recursive=True)
        if not cand:
            raise SystemExit("bus.jpg not found: copy it from the ultralytics package into tests/fixtures/")
        import shutil; shutil.copy(cand[0], BUS)
    tmp = tempfile.mkdtemp()
    parts, cuts, ranges, f = [], [], {}, 0
    for i, (label, (inp, vf, n)) in enumerate(PLAN):
        out = os.path.join(tmp, f"{i:02d}.mp4")
        subprocess.run(["ffmpeg", "-v", "error", "-y", *inp, "-frames:v", str(n), "-vf", vf + "," + TAGS,
                        "-r", str(FPS), "-c:v", "libx264", "-crf", "18", "-g", "24", out], check=True)
        if f > 0:
            cuts.append(f)
        ranges[label] = [f, f + n - 1]
        parts.append(out)
        f += n
    lst = os.path.join(tmp, "list.txt")
    with open(lst, "w") as fh:
        fh.writelines(f"file '{p}'\n" for p in parts)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst,
                    "-vf", TAGS, "-c:v", "libx264", "-profile:v", "high", "-crf", "18", "-g", "24", "-bf", "2",
                    "-pix_fmt", "yuv420p", os.path.join(FIX, "cuts_test.mp4")], check=True)
    bus_flash = ranges["bus pan, flash frame at +20"][0] + 20
    strobe0 = ranges["bus: strobe on every other frame from +10 to +40"][0]
    manifest = {
        "clip": "cuts_test.mp4", "frames": f, "fps": [FPS, 1],
        "cuts": cuts,
        "flashFrames": [bus_flash],
        "strobe": [strobe0 + 10, strobe0 + 40],
        "whipPan": ranges["zidane whip pan (fast, no cut)"],
        "shots": ranges,
    }
    with open(os.path.join(FIX, "cuts_test.json"), "w") as fh:
        json.dump(manifest, fh, indent=2)
    print(json.dumps(manifest, indent=2))

if __name__ == "__main__":
    main()
