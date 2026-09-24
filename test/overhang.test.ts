/**
 * The overhang, and the laser box it moves.
 *
 * The laser boundary trace follows the tool centre, so with no overhang it sits
 * a tool radius inside the block. On 2026-09-23 that was read as the job being
 * too small, and a 45.2mm block got a 49mm job. The fix is an overhang: a
 * checkbox that runs the cutter a tool radius past every edge of the measured
 * block, so the tool centre runs the outline and never goes behind or left of
 * X0 Y0, which is where the 3D probe puts the origin.
 *
 * As in patterns.test.ts, the geometry is checked on the emitted G-code, not
 * on the planner's idea of it.
 */

import { describe, expect, test } from "bun:test";
import { buildJob } from "../src/gcode.ts";
import { PATTERNS } from "../src/facing.ts";
import { resolve } from "../src/materials.ts";
import { validate, type JobRequest } from "../src/validate.ts";

const BASE = {
  width: 45.2, height: 45.2, depth: 0.2, material: "aluminium", stepover: 0.45,
} as const;
const R = resolve("aluminium")!.tool.diameter / 2;

function build(over: Partial<JobRequest> = {}) {
  const r = buildJob({ ...BASE, ...over } as JobRequest, { thumbnail: false, now: new Date(2026, 8, 24) });
  if (!r.ok) throw new Error(JSON.stringify(r.refusals));
  return r;
}

/** Every XY the tool centre visits while below Z0, read back from the lines. */
function centres(lines: string[]) {
  let x = 0, y = 0, z = 5;
  const out: { x: number; y: number }[] = [];
  for (const line of lines) {
    const m = /^G[01] (.*)$/.exec(line);
    if (!m) continue;
    const w = Object.fromEntries([...m[1]!.matchAll(/([XYZ])(-?\d*\.?\d+)/g)].map((v) => [v[1]!, Number(v[2])]));
    x = w.X ?? x; y = w.Y ?? y; z = w.Z ?? z;
    if (z < 0) out.push({ x, y });
  }
  return {
    x0: Math.min(...out.map((p) => p.x)), x1: Math.max(...out.map((p) => p.x)),
    y0: Math.min(...out.map((p) => p.y)), y1: Math.max(...out.map((p) => p.y)),
  };
}

const motion = (over: Partial<JobRequest> = {}) =>
  build(over).lines.filter((l) => /^G[01] /.test(l));

describe("no overhang is the old behaviour", () => {
  test("overhang off emits the same motion as no overhang field at all", () => {
    expect(motion({ overhang: false })).toEqual(motion({}));
  });

  test("the tool centre runs a radius inside the block, which is where the laser sits", () => {
    const b = centres(build().lines);
    expect(b.x0).toBeCloseTo(R, 3);
    expect(b.x1).toBeCloseTo(45.2 - R, 3);
    expect(b.y1).toBeCloseTo(-R, 3);
    expect(b.y0).toBeCloseTo(-(45.2 - R), 3);
  });
});

describe.each([...PATTERNS])("overhang, %s", (pattern) => {
  test("the tool centre runs the block's outline, not shifted, and never behind or left of X0 Y0", () => {
    const b = centres(build({ pattern, overhang: true }).lines);
    expect(b.x0).toBeCloseTo(0, 3);
    expect(b.y1).toBeCloseTo(0, 3);
    expect(b.x1).toBeCloseTo(45.2, 3);
    expect(b.y0).toBeCloseTo(-45.2, 3);
    expect(b.x0).toBeGreaterThanOrEqual(0);
    expect(b.y1).toBeLessThanOrEqual(0);
  });
});

describe("overhang in finish mode", () => {
  test("applies to the rotated finishing pass as well as the roughing", () => {
    const r = build({ mode: "finish", overhang: true });
    for (const level of r.path.levels) {
      const pts = level.strokes.flat();
      expect(Math.min(...pts.map((p) => p.x))).toBeCloseTo(0, 9);
      expect(Math.max(...pts.map((p) => p.y))).toBeCloseTo(0, 9);
    }
  });
});

describe("the file", () => {
  test("STOCK stays the block, not the swept area", () => {
    const r = build({ overhang: true });
    expect(r.lines).toContain(";@MKR|STOCK|id=cuboid|length=45.2|width=45.2|height=12|diameter=50");
    expect(r.summary.sweptArea.x[0]).toBeCloseTo(-R, 9);
    expect(r.summary.sweptArea.x[1]).toBeCloseTo(45.2 + R, 9);
    expect(r.summary.sweptArea.y[0]).toBeCloseTo(-(45.2 + R), 9);
    expect(r.summary.sweptArea.y[1]).toBeCloseTo(R, 9);
  });

  test("the comment line and the filename name the overhang, so jobs differing only by it do not collide", () => {
    const r = build({ overhang: true });
    expect(r.lines).toContain("(Facing 45.2 x 45.2 mm, 0.2 mm deep, Aluminium, overhang 1.59 mm)");
    expect(r.filename).toBe("facing-aluminium-45.2x45.2-0.2mm-overhang-serpentine-y-20260924.nc");
    expect(build({ overhang: false }).filename).toBe("facing-aluminium-45.2x45.2-0.2mm-serpentine-y-20260924.nc");
  });
});

describe("the summary says where the laser will be", () => {
  const laser = (over: Partial<JobRequest>) =>
    build(over).summary.warnings.find((w) => w.text.startsWith("Laser"))!.text;

  test("a radius inside with no overhang, and that this is correct", () => {
    expect(build().summary.laserInset).toBeCloseTo(R, 9);
    expect(laser({})).toContain(`${R.toFixed(2)}mm inside the block`);
    expect(laser({})).toContain("That is correct");
  });

  test("on the outline with overhang on", () => {
    expect(build({ overhang: true }).summary.laserInset).toBeCloseTo(0, 9);
    expect(laser({ overhang: true })).toContain("block's outline");
  });
});

describe("validation", () => {
  test("on and off are fine; anything else is refused, not coerced", () => {
    expect(validate({ ...BASE, overhang: true })).toEqual([]);
    expect(validate({ ...BASE, overhang: false })).toEqual([]);
    expect(validate({ ...BASE, overhang: 1.5 as never }).map((r) => r.field)).toEqual(["overhang"]);
  });
});

describe("finish mode explains itself", () => {
  const note = () => build({ mode: "finish" }).summary.warnings
    .find((w) => w.text.includes("total depth"))!.text;

  test("the depth entered is the total, and what each pass takes of it", () => {
    expect(note()).toBe("0.2mm is the total depth. Roughing along X to 0.15mm, then finishing along Y takes the last 0.05mm at 0.70mm step.");
  });

  test("and it is not shown in general mode", () => {
    expect(build().summary.warnings.some((w) => w.text.includes("total depth"))).toBe(false);
  });
});
