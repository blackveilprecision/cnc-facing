/**
 * The refusals. Each one names the offending value, because "invalid input" at
 * the laptop is no better than a soft endstop at the machine.
 */

import { describe, expect, test } from "bun:test";
import { buildJob } from "../src/gcode.ts";
import { ENVELOPE_X, ENVELOPE_Y, validate, type JobRequest } from "../src/validate.ts";

const OK: JobRequest = { width: 80, height: 60, depth: 0.3, material: "mdf", stepover: 0.45 };
const bad = (over: Partial<JobRequest>) => validate({ ...OK, ...over });

describe("validate", () => {
  test("a good job is accepted", () => {
    expect(bad({})).toEqual([]);
  });

  test("non-positive and non-numeric sizes are refused, with the value named", () => {
    expect(bad({ width: 0 })[0]!.message).toContain("greater than zero");
    expect(bad({ height: -5 })[0]!.message).toContain("-5");
    expect(bad({ depth: Number.NaN })[0]!.message).toContain("not a number");
    expect(bad({ stepover: Number.POSITIVE_INFINITY })[0]!.message).toContain("not a number");
  });

  test("a size smaller than the tool leaves no room for a pass", () => {
    const r = bad({ width: 2 });
    expect(r[0]!.field).toBe("width");
    expect(r[0]!.message).toContain("3.175mm tool");
    expect(bad({ width: 3.175 })).toEqual([]);
  });

  test("a size beyond the 200 x 200 envelope is refused", () => {
    expect(bad({ width: ENVELOPE_X + 0.1 })[0]!.message).toContain("X travel");
    expect(bad({ height: ENVELOPE_Y + 0.1 })[0]!.message).toContain("Y travel");
    expect(bad({ width: ENVELOPE_X, height: ENVELOPE_Y })).toEqual([]);
  });

  test("a depth past the flute length is refused", () => {
    expect(bad({ depth: 12.5 })[0]!.message).toContain("12mm flutes");
    expect(bad({ depth: 12 })).toEqual([]);
  });

  test("a stepover wider than the tool would leave uncut ridges", () => {
    expect(bad({ stepover: 1.2 })[0]!.field).toBe("stepover");
    expect(bad({ stepover: 1 })).toEqual([]);
  });

  test("an unknown material is refused rather than defaulted", () => {
    expect(bad({ material: "titanium" as never })[0]!.message).toContain("titanium");
  });

  test("buildJob refuses rather than emitting a bad file", () => {
    const r = buildJob({ ...OK, width: 500 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusals[0]!.message).toContain("500mm");
  });

  test("all the size problems are reported at once, not one at a time", () => {
    const r = bad({ width: 300, height: 400, depth: 50 });
    expect(r.map((x) => x.field).sort()).toEqual(["depth", "height", "width"]);
  });
});
