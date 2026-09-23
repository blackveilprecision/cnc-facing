/**
 * Finish mode: rough to an allowance, then one rotated finishing pass.
 *
 * The rotation is the risky part. It moves the raster onto the other axis,
 * which is exactly where a "Y must be negative" or "the swept area is the
 * requested rectangle" invariant would quietly stop holding, so both are
 * re-asserted here against the rotated pass specifically.
 */

import { describe, expect, test } from "bun:test";
import { buildJob } from "../src/gcode.ts";
import { MATERIALS, resolve } from "../src/materials.ts";
import { validate, type JobRequest } from "../src/validate.ts";

const BASE = {
  width: 90, height: 70, depth: 0.4, material: "aluminium", stepover: 0.45,
} as const;

function build(over: Partial<JobRequest> = {}) {
  const r = buildJob({ ...BASE, ...over } as JobRequest, { thumbnail: false });
  if (!r.ok) throw new Error(JSON.stringify(r.refusals));
  return r;
}

const motion = (over: Partial<JobRequest> = {}) =>
  build(over).lines.filter((l) => /^G[01] /.test(l));

describe("general mode is untouched", () => {
  test("no finishing level, and the same output as before the mode existed", () => {
    expect(build({ mode: "general" }).summary.finish).toBe(null);
    expect(motion({ mode: "general" })).toEqual(motion({}));
  });
});

describe("the finishing pass", () => {
  const r = build({ mode: "finish" });
  const levels = r.path.levels;
  const last = levels.at(-1)!;

  test("is one extra level, taking exactly the allowance", () => {
    const allowance = MATERIALS.aluminium.finishAllowance;
    expect(last.isFinish).toBe(true);
    expect(levels.filter((l) => l.isFinish).length).toBe(1);
    expect(last.z).toBeCloseTo(0.4, 9);
    expect(last.z - levels.at(-2)!.z).toBeCloseTo(allowance, 9);
  });

  test("roughing stops short by the allowance, and never exceeds the DOC", () => {
    const rough = levels.filter((l) => !l.isFinish);
    expect(rough.at(-1)!.z).toBeCloseTo(0.4 - MATERIALS.aluminium.finishAllowance, 9);
    let prev = 0;
    for (const l of rough) {
      expect(l.z - prev).toBeLessThanOrEqual(resolve("aluminium")!.maxDepthPerPass + 1e-9);
      prev = l.z;
    }
  });

  test("runs at 90° to the roughing passes", () => {
    expect(levels.filter((l) => !l.isFinish).every((l) => l.raster!.axis === "x")).toBe(true);
    expect(last.raster!.axis).toBe("y");
  });

  test("steps about half as far as roughing", () => {
    const m = resolve("aluminium")!;
    expect(m.finishStepover).toBeLessThan(m.stepover);
    const abs = m.tool.diameter * m.finishStepover;
    expect(abs).toBeGreaterThan(0.3);
    expect(abs).toBeLessThan(m.tool.diameter * m.stepover);
  });
});

describe("the rotation does not break the invariants", () => {
  test("every Y is still negative — on the rotated pass too", () => {
    // The rotated pass is the one that CUTS along Y, so if the sign convention
    // were going to break anywhere it would break here.
    for (const [w, h] of [[90, 70], [200, 200], [10, 10], [30, 180]] as const) {
      for (const line of motion({ mode: "finish", width: w, height: h })) {
        const m = /\bY(-?\d*\.?\d+)/.exec(line);
        if (m) expect(Number(m[1])).toBeLessThanOrEqual(0);
      }
    }
  });

  test("every X is still positive", () => {
    for (const line of motion({ mode: "finish" })) {
      const m = /\bX(-?\d*\.?\d+)/.exec(line);
      if (m) expect(Number(m[1])).toBeGreaterThanOrEqual(0);
    }
  });

  test("the finishing pass sweeps the requested rectangle, not the rotated one", () => {
    const r = build({ mode: "finish", width: 90, height: 70 });
    const last = r.path.levels.at(-1)!;
    const tool = resolve("aluminium")!.tool.diameter;
    // Raster lines run r..W-r in X; the cut sweeps -r..-(H-r) in Y.
    expect(last.raster!.lines[0]).toBeCloseTo(tool / 2, 9);
    expect(last.raster!.lines.at(-1)).toBeCloseTo(90 - tool / 2, 9);
    expect(last.raster!.from).toBeCloseTo(-tool / 2, 9);
    expect(last.raster!.to).toBeCloseTo(-(70 - tool / 2), 9);
    expect(r.summary.sweptArea).toEqual({ x: [0, 90], y: [-70, 0] });
  });

  test("no gap between finishing lines exceeds the tool", () => {
    const last = build({ mode: "finish" }).path.levels.at(-1)!;
    for (let i = 1; i < last.raster!.lines.length; i++) {
      expect(Math.abs(last.raster!.lines[i]! - last.raster!.lines[i - 1]!))
        .toBeLessThanOrEqual(resolve("aluminium")!.tool.diameter);
    }
  });
});

describe("repositioning for the rotated pass", () => {
  test("lifts to safe Z BEFORE traversing, when a traverse is needed", () => {
    // A rapid across the work at cutting depth is the groove-cutting mistake
    // this whole project exists to avoid — and here it would be dragged across
    // the surface the finishing pass is meant to leave clean.
    //
    // depth 0.25 leaves one roughing level, which ends at the far Y edge while
    // the rotated pass starts at the near one, so the hop is real.
    const lines = build({ mode: "finish", depth: 0.25 }).lines;
    const i = lines.indexOf("G1 Z-0.250 F200");
    expect(lines.slice(i - 2, i)).toEqual(["G0 Z5", "G0 X1.587 Y-1.587"]);
  });

  test("and does not traverse at all when the roughing already ended there", () => {
    // depth 0.4 leaves two roughing levels, and the second sweeps back to the
    // origin corner — which is exactly where the rotated pass begins. Emitting
    // a retract and a rapid to the spot the tool is already on would be four
    // seconds of nothing, per job.
    const lines = build({ mode: "finish", depth: 0.4 }).lines;
    const i = lines.indexOf("G1 Z-0.400 F200");
    expect(lines[i - 1]).toBe("G1 X1.587 F500");
  });

  test("still no G0 anywhere between a plunge and the next retract", () => {
    const lines = [
      ...build({ mode: "finish", depth: 0.25 }).lines,
      ...build({ mode: "finish", depth: 0.4 }).lines,
      ...build({ mode: "finish", depth: 0.55 }).lines,
    ];
    let down = false;
    for (const l of lines) {
      if (/^G1 Z-/.test(l)) down = true;
      else if (/^G0 Z/.test(l)) down = false;
      else if (down) expect(l.startsWith("G0")).toBe(false);
    }
  });
});

describe("refusals specific to finish mode", () => {
  test("a skim shallower than the allowance is refused, not silently rounded", () => {
    const r = validate({ ...BASE, mode: "finish", depth: 0.02 });
    expect(r[0]!.field).toBe("depth");
    expect(r[0]!.message).toContain("0.05mm for the last pass");
  });

  test("depth exactly equal to the allowance is one finishing pass, no roughing", () => {
    const p = build({ mode: "finish", depth: 0.05 }).path;
    expect(p.levels.length).toBe(1);
    expect(p.levels[0]!.isFinish).toBe(true);
  });

  test("an unknown mode is refused", () => {
    expect(validate({ ...BASE, mode: "polish" as never })[0]!.field).toBe("mode");
  });
});

describe("what the summary says", () => {
  test("it splits roughing from finishing rather than giving one number", () => {
    const s = build({ mode: "finish" }).summary;
    expect(s.mode).toBe("finish");
    expect(s.finish).toMatchObject({ allowance: 0.05, rotated: true });
    expect(s.finish!.passes).toBeGreaterThan(0);
    expect(s.totalPasses).toBe(
      build({ mode: "finish" }).path.levels.reduce((n, l) => n + l.raster!.lines.length, 0),
    );
  });

  test("it admits the strategy is ours even though the feeds are Makera's", () => {
    const w = build({ mode: "finish" }).summary.warnings.map((x) => x.text).join(" ");
    expect(w).toContain("finishing strategy is not");
    expect(w).toContain("90°");
  });

  test("finish mode costs time — that is the trade", () => {
    expect(build({ mode: "finish" }).summary.minutes)
      .toBeGreaterThan(build({ mode: "general" }).summary.minutes);
  });
});
