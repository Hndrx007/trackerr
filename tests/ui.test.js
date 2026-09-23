import { group, test, eq } from "./harness.js";
import { timecode } from "../app/ui/timeline.js";

group("UI helpers");

test("Timecode is non-drop at the nominal rate", () => {
  eq(timecode(0, [24000, 1001]), "00:00:00:00");
  eq(timecode(23, [24000, 1001]), "00:00:00:23");
  eq(timecode(24, [24000, 1001]), "00:00:01:00");
  eq(timecode(292, [24, 1]), "00:00:12:04");          // the spec's example: 00:00:12:04 f 292
  eq(timecode(25 * 3600 + 25 * 61 + 3, [25, 1]), "01:01:01:03");
  eq(timecode(59, [60000, 1001]), "00:00:00:59");
});
