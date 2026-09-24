/**
 * The path. Findings #2 (no rapid while down), #3 (Y negative) and #11 (the
 * swept area equals the requested size) are asserted directly, because they are
 * the ones a plausible-looking refactor would break without failing anything else.
 */

import { describe, expect, test } from "bun:test";
import { gcodeBody, planFacing, splitDepth } from "../src/facing.ts";
import { MATERIALS, DEFAULT_STEPOVER, resolve, type MaterialId } from "../src/materials.ts";
import { buildJob } from "../src/gcode.ts";
import { explicit } from "./explicit.ts";

// Pinned to serpentine-x, the ported pattern these tests were written against.
// The default moved to serpentine-y in 0.9.0; patterns.test.ts checks the same
// properties for every pattern.
const plan = (w: number, h: number, d: number, m: MaterialId = "mdf", tool?: "3.175" | "6") =>
  planFacing({
    pattern: "serpentine-x",
    width: w, height: h, depth: d,
    material: resolve(m, tool)!,
    stepover: resolve(m, tool)!.stepover,
    mode: "general",
  });

function allLines(w: number, h: number, d: number, m: MaterialId = "mdf") {
  const r = buildJob({ width: w, height: h, depth: d, material: m, stepover: DEFAULT_STEPOVER, pattern: "serpentine-x" }, { thumbnail: false });
  if (!r.ok) throw new Error(JSON.stringify(r.refusals));
  return explicit(r.lines);
}

describe("the stepover is never a rapid", () => {
  test("no G0 appears between the plunge and the retract", () => {
    // Finding #2: an early version rapided sideways with the cutter buried and
    // left a groove 1.43mm wide that the neighbouring passes did not.
    for (const [w, h, d, m] of [[80, 60, 0.3, "mdf"], [40, 40, 2.5, "mdf"], [20, 20, 0.5, "aluminium"]] as const) {
      const body = gcodeBody(plan(w, h, d, m));
      const afterPlunge = body.slice(body.findIndex((l) => l.startsWith("G1 Z")));
      expect(afterPlunge.filter((l) => l.startsWith("G0"))).toEqual([]);
    }
  });

  test("the only G0 in the whole file is the approach and the two Z retracts", () => {
    const g0 = allLines(80, 60, 0.3).filter((l) => l.startsWith("G0"));
    // 1.5875 formats as 1.587, not 1.588 -- the golden fixture rounds the same way.
    expect(g0).toEqual(["G0 Z5", "G0 X1.587 Y-1.587", "G0 Z5"]);
  });

  test("every plunge is a G1 at the plunge feed, never a G0", () => {
    const body = gcodeBody(plan(40, 40, 2.5));
    const plunges = body.filter((l) => l.startsWith("G1 Z"));
    expect(plunges.length).toBe(3);
    for (const l of plunges) expect(l).toMatch(/^G1 Z-\d+\.\d{3} F300$/);
  });
});

describe("Y runs negative", () => {
  test("no positive Y coordinate is ever emitted", () => {
    // Finding #3: a +Y job asked for Y+158.412 and hit a soft endstop.
    for (const [w, h] of [[80, 60], [200, 200], [5, 5], [160, 160]] as const) {
      // Motion only. Comments carry the reach-check block, which quotes MDI
      // lines rather than emitting them, and a comment is not something the
      // controller moves on.
      for (const line of allLines(w, h, 0.5).filter((l) => !/^[;(]/.test(l))) {
        const m = /\bY(-?\d*\.?\d+)/.exec(line);
        if (m) expect(Number(m[1])).toBeLessThanOrEqual(0);
      }
    }
  });

  test("the sweep starts at the origin end and finishes at the far edge", () => {
    const p = plan(80, 60, 0.3);
    expect(p.levels[0]!.raster!.lines[0]).toBeCloseTo(-p.r, 9);
    expect(p.levels[0]!.raster!.lines.at(-1)).toBeCloseTo(-(60 - p.r), 9);
  });
});

describe("the swept area is exactly the requested size", () => {
  test("the tool centre runs r..W-r in both axes", () => {
    // Finding #11: this is what makes "face 80x60" mean what the user expects.
    const p = plan(80, 60, 0.3);
    const r = MATERIALS.mdf.tools[0]!.tool.diameter / 2;
    expect(p.xLo).toBeCloseTo(r, 9);
    expect(p.xHi).toBeCloseTo(80 - r, 9);
    expect(Math.min(...p.levels[0]!.raster!.lines)).toBeCloseTo(-(60 - r), 9);
    expect(Math.max(...p.levels[0]!.raster!.lines)).toBeCloseTo(-r, 9);
  });

  test("the last raster line is flush with the far edge, whatever the stepover leaves over", () => {
    for (const h of [60, 61.37, 20.001, 3.2]) {
      const p = plan(80, h, 0.3);
      expect(p.levels[0]!.raster!.lines.at(-1)).toBeCloseTo(-(h - p.r), 9);
    }
  });

  test("no gap between raster lines exceeds the stepover", () => {
    const p = plan(80, 61.37, 0.3);
    const ys = p.levels[0]!.raster!.lines;
    for (let i = 1; i < ys.length; i++) {
      expect(Math.abs(ys[i]! - ys[i - 1]!)).toBeLessThanOrEqual(p.step + 1e-9);
    }
  });

  test("a size equal to the tool diameter still gets one pass", () => {
    const p = plan(3.175, 3.175, 0.2);
    expect(p.passesPerLevel).toBe(1);
    expect(p.xLo).toBeCloseTo(p.xHi, 9);
  });
});

describe("depth stepping", () => {
  test("splits into equal passes, none deeper than the tool's DOC", () => {
    expect(splitDepth(0.3, 1.0)).toEqual([0.3]);
    expect(splitDepth(1.0, 1.0)).toEqual([1.0]);
    expect(splitDepth(2.5, 1.0)).toEqual([2.5 / 3, (2.5 / 3) * 2, 2.5]);
    for (const d of [0.05, 1, 2.5, 5.7, 11.9]) {
      const steps = splitDepth(d, 1.0);
      expect(steps.at(-1)).toBeCloseTo(d, 9);
      let prev = 0;
      for (const s of steps) {
        expect(s - prev).toBeLessThanOrEqual(1.0 + 1e-9);
        prev = s;
      }
    }
  });

  test("the depths are cumulative and end exactly at the requested depth", () => {
    const p = plan(50, 50, 5.7);
    expect(p.passDepths.length).toBe(6);
    expect(p.passDepths.at(-1)).toBeCloseTo(5.7, 9);
    expect(gcodeBody(p).filter((l) => l.startsWith("G1 Z")).length).toBe(6);
  });

  test("stepping down never needs a repositioning move: each level sweeps back", () => {
    const p = plan(50, 50, 2.5);
    const [a, b] = [p.levels[0]!, p.levels[1]!];
    expect(b.raster!.lines[0]).toBe(a.raster!.lines.at(-1)!);
    expect(b.raster!.lines).toEqual([...a.raster!.lines].reverse());
  });

  test("the aluminium 0.2mm DOC produces the pass count it should", () => {
    expect(plan(50, 50, 1.0, "aluminium").levels.length).toBe(5);
    expect(plan(50, 50, 1.0, "brass").levels.length).toBe(10);
  });
});

describe("estimates", () => {
  test("cut length is the raster length plus the stepovers", () => {
    const p = plan(80, 60, 0.3);
    const xTravel = (p.xHi - p.xLo) * p.passesPerLevel;
    const yTravel = 60 - 2 * p.r;
    expect(p.cutLength).toBeCloseTo(xTravel + yTravel, 6);
  });

  test("time scales with depth, and brass is the slow one", () => {
    expect(plan(80, 60, 1.0).seconds).toBeGreaterThan(plan(80, 60, 0.3).seconds);
    expect(plan(50, 50, 0.5, "brass").seconds).toBeGreaterThan(plan(50, 50, 0.5, "mdf").seconds);
  });
});
