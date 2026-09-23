/**
 * The golden test: our motion must match `surface_spoilboard.py`'s, exactly.
 *
 * The fixture is that script's real output for 80 x 60 x 0.3 in MDF, the job
 * this machine has run successfully. Diffing against it pins down the path, the
 * coordinate convention, the feed words and the G1-not-G0 stepover all at once,
 * and it is the test that would catch a "harmless" refactor of facing.ts.
 *
 * Only the MOTION is compared, not the whole file. The header differs on purpose
 * -- different CAM id, tool suffix, material name, a real time estimate instead
 * of the script's cutting-length approximation, and a thumbnail the script never
 * emitted. Those are choices; the motion is not. The structural properties of
 * the header (field order, CRLF, one-line tool change) are asserted separately
 * in mkr.test.ts and gcode.test.ts rather than frozen into a byte diff that
 * would have to be regenerated every time a comment changes.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildJob } from "../src/gcode.ts";

const FIXTURE = "test/fixtures/surface_spoilboard-80x60x0.3.nc";

/** Motion and modal lines: everything that is not a comment or a blank. */
function motion(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith(";") && !l.startsWith("("));
}

describe("golden: surface_spoilboard.py 80 x 60 x 0.3 MDF", () => {
  const reference = motion(readFileSync(FIXTURE, "latin1"));
  const built = buildJob(
    { width: 80, height: 60, depth: 0.3, material: "mdf", stepover: 0.45 },
    { thumbnail: false },
  );
  if (!built.ok) throw new Error(JSON.stringify(built.refusals));
  const ours = motion(built.gcode);

  test("the fixture is the proven file, not something we generated", () => {
    // 41 passes at 1.43mm stepover -- the numbers the script printed when it ran.
    expect(reference.filter((l) => l.startsWith("G1 X")).length).toBe(41);
  });

  test("every motion line is identical", () => {
    expect(ours).toEqual(reference);
  });

  test("and there are no extra or missing lines", () => {
    expect(ours.length).toBe(reference.length);
  });
});
