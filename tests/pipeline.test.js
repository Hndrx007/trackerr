import { group, test, assert, eq, fixture } from "./harness.js";
import { openSource } from "../app/media.js";
import { analyse } from "../app/analysis/client.js";
import { cutFrames } from "../app/trackdata.js";
import { personBoxAt } from "../app/analysis/persons.js";

group("M2 analysis pipeline (the real worker)");

async function run(name, options = {}) {
  const file = await fixture(name);
  const src = await openSource(file);
  const info = src.info;
  src.dispose();
  return analyse(file, info, { options });
}

/** Precision / recall of detected cuts against the truth, exact frames. */
export function scoreCuts(found, truth) {
  const t = new Set(truth), f = new Set(found);
  const tp = found.filter(x => t.has(x)).length;
  return {
    precision: found.length ? tp / found.length : 1, recall: truth.length ? tp / truth.length : 1,
    falseCuts: found.filter(x => !t.has(x)), missed: truth.filter(x => !f.has(x)),
  };
}

test("Labelled cut clip: every cut on its exact frame; no false cuts from the flash, strobe or whip pan", async () => {
  const truth = await (await fetch(new URL("./fixtures/cuts_test.json", import.meta.url))).json();
  const td = await run("cuts_test.mp4", { detect: false });
  const s = scoreCuts(cutFrames(td), truth.cuts);
  const inRange = ([a, b]) => s.falseCuts.filter(f => f >= a && f <= b);
  const text = `precision ${(s.precision * 100).toFixed(0)}%, recall ${(s.recall * 100).toFixed(0)}%` +
    `; false ${JSON.stringify(s.falseCuts)}, missed ${JSON.stringify(s.missed)}` +
    `; false in strobe ${inRange(truth.strobe).length}, at the flash ${inRange([truth.flashFrames[0], truth.flashFrames[0] + 1]).length}, in the whip pan ${inRange(truth.whipPan).length}`;
  eq(s.missed, [], text);
  eq(s.falseCuts, [], text);
  return text + `\nanalysis ${td.analysis.fps.toFixed(1)} fps without detection`;
}, { slow: true });

test("Natural clip with two people: both tracked on every frame, IDs never swap", async () => {
  const td = await run("h264_24_natural.mp4");
  const ids = Object.keys(td.persons);
  eq(ids.length, 2, "person tracks");
  // Zidane stays on the left, the other man on the right, for the whole clip.
  const [a, b] = ids.map(id => td.persons[id]);
  for (let f = 1; f < 48; f++) {
    const ba = personBoxAt(a, f), bb = personBoxAt(b, f);
    assert(ba && bb, `both present at frame ${f}`);
    assert((ba[0] < bb[0]) === (personBoxAt(a, 1)[0] < personBoxAt(b, 1)[0]), `order kept at frame ${f}`);
  }
  return `tracks ${ids.join(", ")}; backend ${td.analysis.backend}, ${td.analysis.fps.toFixed(1)} fps, detection ${td.analysis.detectMs?.toFixed(0)} ms median`;
}, { slow: true });
