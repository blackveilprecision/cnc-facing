/**
 * The materials table and the bit it names.
 *
 * A 6mm single flute lived here briefly and was dropped in favour of one bit,
 * one collet, one set of numbers. `tools` is still an array, so the shape these
 * tests pin is the one a second bit would slot into.
 */

import { describe, expect, test } from "bun:test";
import { MATERIALS, MATERIAL_IDS, MAX_FEEDRATE, resolve } from "../src/materials.ts";
import { buildJob, filenameFor } from "../src/gcode.ts";
import { validate, type JobRequest } from "../src/validate.ts";

const REQ = { width: 80, height: 60, depth: 0.3, material: "mdf", stepover: 0.45 } as const;
const AT = new Date(2026, 8, 21, 14, 5);

function build(over: Partial<JobRequest> = {}) {
  const r = buildJob({ ...REQ, ...over } as JobRequest, { now: AT, thumbnail: false });
  if (!r.ok) throw new Error(JSON.stringify(r.refusals));
  return r;
}

describe("the table itself", () => {
  test("one bit, the 3.175x12mm Metal-series flat end, for every material", () => {
    for (const id of MATERIAL_IDS) {
      expect(MATERIALS[id].tools.map((t) => t.id)).toEqual(["3.175"]);
      const r = resolve(id)!;
      expect(r.tool.diameter).toBe(3.175);
      expect(r.tool.fluteLength).toBe(12);
    }
  });

  test("every row stays under the declared MAXFEEDRATE", () => {
    for (const id of MATERIAL_IDS) {
      for (const t of MATERIALS[id].tools) {
        expect(t.feed).toBeLessThanOrEqual(MAX_FEEDRATE);
        expect(t.plunge).toBeLessThanOrEqual(MAX_FEEDRATE);
      }
    }
  });

  test("every row is vendor-sourced and says where from", () => {
    // Nothing here is reasoned. If a row ever is, it sets derived and the UI
    // shouts about it — silently mixing reasoned numbers in with published ones
    // is the drift this project exists to avoid.
    for (const id of MATERIAL_IDS) {
      for (const t of MATERIALS[id].tools) {
        expect(t.derived).toBe(false);
        expect(t.source).toContain("speeds and feeds");
      }
    }
  });

  test("the published metal figures are what Makera lists", () => {
    // Transcription errors here are silent and expensive, so the two metal rows
    // are spelled out rather than trusted.
    const al = resolve("aluminium")!;
    expect([al.rpm, al.feed, al.plunge, al.maxDepthPerPass]).toEqual([12000, 500, 200, 0.2]);
    const br = resolve("brass")!;
    expect([br.rpm, br.feed, br.plunge, br.maxDepthPerPass]).toEqual([12000, 300, 100, 0.1]);
    const mdf = resolve("mdf")!;
    expect([mdf.rpm, mdf.feed, mdf.plunge, mdf.maxDepthPerPass]).toEqual([10000, 1000, 300, 1.0]);
  });

  test("the finishing stepover is finer than the roughing one everywhere", () => {
    for (const id of MATERIAL_IDS) {
      const t = resolve(id)!;
      expect(t.finishStepover).toBeLessThan(t.stepover);
    }
  });

  test("the finishing allowance fits inside one pass of the tool", () => {
    // Otherwise finish mode would ask for a cut deeper than the bit is rated
    // for, which validate.ts refuses but should never have to.
    for (const id of MATERIAL_IDS) {
      const t = resolve(id)!;
      expect(t.finishAllowance).toBeLessThanOrEqual(t.maxDepthPerPass);
    }
  });
});

describe("choosing a bit", () => {
  test("an unknown tool is refused rather than silently defaulted", () => {
    // Falling back would run the job at the wrong feeds for whatever is in the
    // collet, and nothing downstream could notice.
    const r = validate({ ...REQ, tool: "6" as never });
    expect(r[0]!.field).toBe("tool");
    expect(r[0]!.message).toContain("6mm");
  });

  test("omitting the tool gives the material's only profile", () => {
    expect(build().summary.toolId).toBe("3.175");
    expect(build({ tool: "3.175" }).summary.toolId).toBe("3.175");
  });

  test("the bit reaches the header, so M6 names the right one", () => {
    expect(build().lines.some((l) =>
      l.startsWith(";@MKR|TOOL|") && l.includes("name=3.175*12mm Flat End - FACING") &&
      l.includes("diameter=3.175") && l.includes("flutelength=12"))).toBe(true);
  });

  test("and the spindle speed follows the material", () => {
    expect(build({ material: "aluminium", depth: 0.1 }).lines).toContain("S12000 M3");
    expect(build({ material: "mdf" }).lines).toContain("S10000 M3");
  });
});

describe("the filename", () => {
  test("keeps the one-bit pattern, with one bit in play", () => {
    // The plain name is serpentine-x, as it was for every job before 0.9.0;
    // the default since then is named like any other pattern.
    const x = { ...REQ, pattern: "serpentine-x" } as const;
    expect(filenameFor(x, AT)).toBe("facing-mdf-80x60-0.3mm-20260921.nc");
    expect(filenameFor({ ...x, material: "brass", depth: 0.1 }, AT))
      .toBe("facing-brass-80x60-0.1mm-20260921.nc");
    expect(filenameFor({ ...x, mode: "general" }, AT)).toBe("facing-mdf-80x60-0.3mm-20260921.nc");
    expect(filenameFor(REQ, AT)).toBe("facing-mdf-80x60-0.3mm-serpentine-y-20260921.nc");
  });

  test("names finish mode, so the two coupons of a comparison cannot collide", () => {
    // A 40x30x0.1 brass coupon in each mode differs ONLY by the mode. Without
    // this the second download replaces the first and the comparison is gone.
    const coupon = { ...REQ, material: "brass", width: 40, height: 30, depth: 0.1 } as const;
    const a = filenameFor({ ...coupon, mode: "general" }, AT);
    const b = filenameFor({ ...coupon, mode: "finish" }, AT);
    expect(a).toBe("facing-brass-40x30-0.1mm-serpentine-y-20260921.nc");
    expect(b).toBe("facing-brass-40x30-0.1mm-finish-20260921.nc");
    expect(a).not.toBe(b);
  });
});

describe("nothing is derived", () => {
  test("so no row warns about it", () => {
    expect(build().summary.derived).toBe(false);
    expect(build().summary.warnings.some((x) => x.text.includes("derived, not published")))
      .toBe(false);
  });
});
