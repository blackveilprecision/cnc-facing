/**
 * The chamfer: T2, a lap round the block's top edge after the facing.
 *
 * Checked on the emitted file, as the other pattern tests are: the tool change
 * in the proven order, the header's second TOOL and TOOLPATH in the proven
 * order, the path on the block's outline and climb, and the depth that gives
 * the width asked for.
 */

import { describe, expect, test } from "bun:test";
import { buildJob } from "../src/gcode.ts";
import { MKR_FIELD_ORDER, mkrTag } from "../src/mkr.ts";
import { validate, type JobRequest } from "../src/validate.ts";

const BASE = {
  width: 45.26, height: 45, depth: 0.2, material: "aluminium", stepover: 0.45, overhang: true,
} as const;

function build(over: Partial<JobRequest> = {}) {
  const r = buildJob({ ...BASE, chamfer: 0.2, ...over } as JobRequest, { thumbnail: false, now: new Date(2026, 8, 24) });
  if (!r.ok) throw new Error(JSON.stringify(r.refusals));
  return r;
}

/** The lines after the tool change to T2. */
const t2 = (lines: string[]) => lines.slice(lines.indexOf("T2 M6"));

describe("the tool change", () => {
  const { lines } = build();

  test("lifts and stops the spindle before T2 M6, on one line, then spins up and dwells", () => {
    const i = lines.indexOf("T2 M6");
    expect(i).toBeGreaterThan(0);
    expect(lines.slice(i - 6, i).filter((l) => l)).toEqual([
      "G0 Z5", "M5", ";@MKR|TOOLPATH_START|toolpath_number=2", "; T2-3.175*0.1mm*90deg Chamfer - CHAMFER",
    ]);
    expect(lines.slice(i + 1, i + 4)).toEqual(["G0 Z5", "S12000 M3", "G4 P1"]);
  });

  test("comes after all the facing and before the trailer's park", () => {
    expect(lines.indexOf("T2 M6")).toBeGreaterThan(lines.lastIndexOf("G1 Z-0.200 F200"));
    expect(lines.indexOf("G28")).toBeGreaterThan(lines.indexOf("T2 M6"));
    expect(lines.filter((l) => / M6$/.test(l))).toEqual(["T1 M6", "T2 M6"]);
  });
});

describe("the header", () => {
  const { lines } = build();
  const mkr = lines.filter((l) => mkrTag(l) !== null && !l.includes("TOOLPATH_START"));

  test("two TOOL lines before TIME, two TOOLPATH lines after it", () => {
    const tags = mkr.map((l) => mkrTag(l)!);
    expect(tags.filter((t, i) => t !== tags[i - 1])).toEqual([...MKR_FIELD_ORDER]);
    expect(tags.filter((t) => t === "TOOL").length).toBe(2);
    expect(tags.filter((t) => t === "TOOLPATH").length).toBe(2);
  });

  test("T2 is declared as the V-bit form the PCB headers use", () => {
    expect(mkr).toContain(
      ";@MKR|TOOL|number=2|id=|name=3.175*0.1mm*90deg Chamfer - CHAMFER|type=Engraving|sticklength=0" +
      "|handlediameter=3.175|flutelength=1.5|diameter=3.175|tipdiameter=0.1|cornerradius=0|angle=0|halfAngle=45",
    );
    expect(mkr).toContain(";@MKR|TOOLPATH|number=2|tool_number=2|name=[T2]Chamfer 0.2mm");
  });

  test("TIME includes the chamfer", () => {
    const r = build();
    const time = Number(mkr.find((l) => l.startsWith(";@MKR|TIME"))!.split("=")[1]);
    expect(time).toBeCloseTo(r.path.seconds + r.chamfer!.seconds, 1);
  });
});

describe("the path", () => {
  test("the tip goes width minus the tip radius below the faced top", () => {
    // 0.2mm wide: the 0.05mm-radius tip at 0.15 below the 0.2mm faced top.
    expect(t2(build().lines)).toContain("G1 Z-0.350 F200");
  });

  test("laps no deeper than Makera's DOC for the chamfer bit", () => {
    // 0.6mm wide needs the tip 0.55 down: three laps at 0.2mm DOC in aluminium.
    const z = t2(build({ chamfer: 0.6 }).lines).filter((l) => l.startsWith("G1 Z"));
    expect(z.length).toBe(3);
    expect(z.at(-1)).toBe("G1 Z-0.750 F200");
  });

  test("runs the block's outline clockwise from X0 Y0, which is climb", () => {
    const moves = t2(build().lines).filter((l) => /^G[01] [XY]/.test(l));
    expect(moves).toEqual([
      "G0 X0.000 Y0.000",
      "G1 X45.260 F600",
      "G1 Y-45.000 F600",
      "G1 X0.000 F600",
      "G1 Y0.000 F600",
    ]);
  });

  test("uses the material's own chamfer feeds", () => {
    const brass = t2(build({ material: "brass", depth: 0.1 }).lines);
    expect(brass).toContain("G1 X45.260 F500");
    expect(brass.some((l) => l.startsWith("G1 Z-") && l.endsWith("F200"))).toBe(true);
  });
});

describe("naming and summary", () => {
  test("the filename and the comments say so", () => {
    const r = build();
    expect(r.filename).toBe("facing-aluminium-45.26x45-0.2mm-overhang-chamfer0.2-serpentine-y-20260924.nc");
    expect(r.lines).toContain("(Then T2: 0.2 mm chamfer round the top edge, 90deg chamfer bit)");
    expect(r.summary.chamfer).toMatchObject({ width: 0.2, laps: 1, feed: 600 });
  });

  test("no chamfer means no T2 at all", () => {
    const r = build({ chamfer: undefined });
    expect(r.lines).not.toContain("T2 M6");
    expect(r.lines.some((l) => l.includes("number=2"))).toBe(false);
    expect(r.summary.chamfer).toBe(null);
  });
});

describe("validation", () => {
  const fields = (over: Partial<JobRequest>) => validate({ ...BASE, ...over } as JobRequest).map((r) => r.field);

  test("needs the overhang", () => {
    expect(fields({ chamfer: 0.2, overhang: false })).toEqual(["chamfer"]);
  });

  test("0.1 to 1mm", () => {
    expect(fields({ chamfer: 0.1 })).toEqual([]);
    expect(fields({ chamfer: 1 })).toEqual([]);
    expect(fields({ chamfer: 0.05 })).toEqual(["chamfer"]);
    expect(fields({ chamfer: 1.5 })).toEqual(["chamfer"]);
    expect(fields({ chamfer: Number.NaN })).toEqual(["chamfer"]);
  });
});
