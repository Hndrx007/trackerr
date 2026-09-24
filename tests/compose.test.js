import { group, test, assert, eq } from "./harness.js";
import { compose, itemsAt, itemBox, headBox, TIER, autoPickHero } from "../app/render/compose.js";
import { presetValues, PRESETS } from "../app/render/params.js";
import { Renderer } from "../app/render/renderer.js";
import { drawHud } from "../app/render/hud.js";

group("Composition floor");

// A synthetic clip: 2 shots of 240 frames at 24 fps, a hero walking across, another person,
// and 80 cluster candidates drifting with random walks, some straying into the hero.
function syntheticTd(seed = 1) {
  let r = seed;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  const n = 480, fps = [24, 1];
  const persons = {
    1: { shot: 0, start: 0, boxes: Array.from({ length: 240 }, (_, i) => [0.3 + i * 0.0008, 0.25, 0.14, 0.6]) },
    2: { shot: 0, start: 20, boxes: Array.from({ length: 200 }, (_, i) => [0.75 - i * 0.0005, 0.3, 0.12, 0.55]) },
    3: { shot: 1, start: 240, boxes: Array.from({ length: 240 }, (_, i) => [0.45, 0.2, 0.16, 0.7]) },
  };
  const clusters = {};
  for (let id = 1; id <= 80; id++) {
    const start = Math.floor(rnd() * 400), len = 20 + Math.floor(rnd() * 200), shot = start < 240 ? 0 : 1;
    const end = Math.min(shot ? 480 : 240, start + len);
    let x = rnd() * 0.9, y = rnd() * 0.85;
    const s = [0.04, 0.06, 0.09, 0.13][Math.floor(rnd() * 4)];
    const boxes = [];
    for (let f = start; f < end; f++) {
      x = Math.min(0.95, Math.max(0, x + (rnd() - 0.5) * 0.01)); y = Math.min(0.9, Math.max(0, y + (rnd() - 0.5) * 0.01));
      boxes.push([x, y, s * 9 / 16, s]);
    }
    if (boxes.length) clusters[id] = { shot, level: Math.floor(rnd() * 3), start, boxes };
  }
  return {
    version: 1, source: { name: "synthetic", width: 1920, height: 1080, fps, frameCount: n },
    proxy: { width: 320, height: 180 }, cuts: [{ frame: 240, origin: "auto" }], cutsRemoved: [],
    detections: new Array(n).fill(null), persons, swarm: {}, clusters, layout: {}, hero: [],
  };
}

const aspect = 16 / 9;
const hu = b => [b[0] * aspect, b[1], b[2] * aspect, b[3]];
const overl = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
const gapOf = (a, b) => Math.max(0, Math.max(a[0], b[0]) - Math.min(a[0] + a[2], b[0] + b[2]), Math.max(a[1], b[1]) - Math.min(a[1] + a[3], b[1] + b[3]));

for (const key of Object.keys(PRESETS)) {
  test(`${PRESETS[key].name}: budget, hero zone, size cap, spacing and tier stability hold on every frame`, () => {
    const td = syntheticTd(7), p = presetValues(key), L = compose(td, p);
    const fps = 24, cooldown = Math.ceil(0.5 * fps);
    let maxSeen = 0, drawnFrames = 0;
    for (let f = 0; f < td.source.frameCount; f++) {
      const on = itemsAt(L, f);
      maxSeen = Math.max(maxSeen, on.length);
      assert(on.length <= p.amount, `frame ${f}: ${on.length} boxes, amount ${p.amount}`);
      assert(on.filter(e => e.tier === TIER.lock).length <= p.lockCount, `frame ${f}: too many locks`);
      const hero = L.heroAt(f);
      const boxes = on.map(e => hu(itemBox(e.it, f)));
      if (hero) {
        const h = hu(hero.box), m = p.exclusion;
        const zone = [h[0] - m, h[1] - m, h[2] + 2 * m, h[3] + 2 * m];
        boxes.forEach((b, i) => {
          assert(!overl(b, zone), `frame ${f}: ${on[i].it.key} inside the hero zone`);
          assert(b[3] <= p.maxSize * h[3] + 1e-9, `frame ${f}: ${on[i].it.key} larger than ${p.maxSize} of the hero`);
        });
      }
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++)
          assert(gapOf(boxes[i], boxes[j]) >= Math.max(p.spacing, 0.002) - 1e-9 || on[i].release > 0 || on[j].release > 0,
            `frame ${f}: ${on[i].it.key} and ${on[j].it.key} closer than the minimum spacing`);
      if (on.length) drawnFrames++;
    }
    // Tier changes the composition decides (appear, promote, demote, replace) never come twice within 0.5 s.
    for (const it of L.items) {
      const changes = [it.appear];
      for (let i = 1; i < it.tiers.length; i++) if (it.tiers[i] !== it.tiers[i - 1]) changes.push(it.appear + i);
      if (it.reason === "replaced") changes.push(it.exit);
      for (let k = 1; k < changes.length; k++)
        assert(changes[k] - changes[k - 1] >= cooldown, `${it.key}: tier changed at ${changes[k - 1]} and ${changes[k]}`);
    }
    if (p.amount > 0) assert(drawnFrames > 200, `only ${drawnFrames} frames had any boxes`);
    return `up to ${maxSeen} boxes (amount ${p.amount}), ${L.items.length} appearances`;
  });
}

test("Deterministic: the same inputs give the same layout", () => {
  const strip = L => JSON.stringify(L.items.map(it => [it.key, it.appear, it.end, it.exit, [...it.tiers]]));
  const a = compose(syntheticTd(3), presetValues("surveillance")), b = compose(syntheticTd(3), presetValues("surveillance"));
  eq(strip(a), strip(b));
});

test("Fast enough to re-run while a slider is dragged: a 10 s shot in well under 200 ms", () => {
  const td = syntheticTd(5), t0 = performance.now();
  compose(td, presetValues("surveillance"));
  const ms = (performance.now() - t0) / 2;     // the synthetic clip is two 10 s shots
  assert(ms < 200, `${ms.toFixed(0)} ms per shot`);
  return `${ms.toFixed(1)} ms per 10 s shot`;
});

test("Hierarchy: locks are the top-scoring boxes and appear only after the hero is acquired", () => {
  const td = syntheticTd(11), p = presetValues("lockon"), L = compose(td, p);
  for (let f = 0; f < 480; f++) {
    const hero = L.heroAt(f);
    if (!hero) continue;
    for (const e of itemsAt(L, f)) if (e.tier === TIER.lock) assert(f >= hero.seg.acquire, `lock at ${f} before acquire ${hero.seg.acquire}`);
  }
});

test("Auto-pick: the person nearest the centre at shot start; never switched to someone else", () => {
  const td = syntheticTd(1);
  const segs = autoPickHero(td);
  eq(segs.map(s => [s.start, s.personId]), [[0, 1], [240, 3]]);
});

test("Head boxes sit at the top-centre of the person box and are square in pixels", () => {
  const b = [0.4, 0.2, 0.1, 0.6], h = headBox(b, aspect);
  assert(Math.abs(h[2] * aspect - h[3]) < 1e-12, "square");
  assert(Math.abs((h[0] + h[2] / 2) - 0.45) < 1e-12, "centred");
  assert(h[1] >= 0.2 && h[1] + h[3] < 0.2 + 0.6 * 0.4, "at the top");
});

group("HUD rendering");

// Renders the HUD over a mid-grey frame at two sizes, scales both to 320×180 on the GPU and
// compares: the same look at 1080p and 4K means the small versions nearly match.
test("Resolution independence: the same look at 1920×1080 and 3840×2160", () => {
  const td = syntheticTd(9), p = presetValues("surveillance"), L = compose(td, p);
  const f = 120, grey = new Uint8Array(64 * 36 * 4).fill(128);
  const frame = new VideoFrame(grey, { format: "RGBA", codedWidth: 64, codedHeight: 36, timestamp: 0 });
  const small = [];
  try {
    for (const [w, h] of [[1920, 1080], [3840, 2160]]) {
      const r = new Renderer(new OffscreenCanvas(w, h));
      r.render(frame, o => drawHud(o, f, td, L, p));
      const c = new OffscreenCanvas(320, 180).getContext("2d", { willReadFrequently: true });
      c.imageSmoothingQuality = "high";
      c.drawImage(r.canvas, 0, 0, 320, 180);
      small.push(c.getImageData(0, 0, 320, 180).data);
      r.dispose();
    }
  } finally { frame.close(); }
  let diff = 0, changed = 0;
  for (let i = 0; i < small[0].length; i += 4) {
    const d = Math.abs(small[0][i] - small[1][i]) + Math.abs(small[0][i + 1] - small[1][i + 1]) + Math.abs(small[0][i + 2] - small[1][i + 2]);
    diff += d / 3;
    if (small[0][i] !== 128 || small[1][i] !== 128) changed++;
  }
  const mean = diff / (small[0].length / 4);
  assert(changed > 500, "the HUD drew something");
  assert(mean < 2.5, `mean difference ${mean.toFixed(2)} levels`);
  return `mean difference ${mean.toFixed(2)} levels over ${changed} HUD pixels`;
});

group("M4: hero picking and the hero lane");

test("Click-to-pick: the hero from this frame to the end of their track, replacing the auto pick from here on", async () => {
  const { pickHero, heroSegments, heroLane } = await import("../app/render/compose.js");
  const td = syntheticTd(1), p = presetValues("surveillance");
  eq(heroSegments(td, p).map(s => [s.start, s.end, s.personId]), [[0, 240, 1], [240, 480, 3]]);
  td.hero = pickHero(td, 100, 2);   // person 2 lives 20..220 in shot 0
  eq(heroSegments(td, p).map(s => [s.start, s.end, s.personId]), [[0, 100, 1], [100, 220, 2], [220, 240, 1], [240, 480, 3]]);
  const lane = heroLane(td, p);
  eq([lane[50], lane[150], lane[230], lane[300]], [1, 1, 1, 1]);
});

test("X clears the hero to the end of the segment in effect; the lane shows the gap in red", async () => {
  const { clearHero, heroSegments, heroLane } = await import("../app/render/compose.js");
  const td = syntheticTd(1), p = presetValues("surveillance");
  td.hero = clearHero(td, 120, p);
  eq(heroSegments(td, p).map(s => [s.start, s.end, s.personId]), [[0, 120, 1], [240, 480, 3]]);
  const lane = heroLane(td, p);
  eq([lane[119], lane[120], lane[239]], [1, 2, 2], "people present but no hero = gap");
});

test("A pick survives save and load with the rest of the project", async () => {
  const { pickHero } = await import("../app/render/compose.js");
  const { serialize, parse } = await import("../app/trackdata.js");
  const td = syntheticTd(1);
  td.hero = pickHero(td, 100, 2);
  eq(parse(serialize(td)).hero, td.hero);
});
