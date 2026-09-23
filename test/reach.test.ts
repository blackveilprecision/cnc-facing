/**
 * The MDI reach check. It exists because jogging there is 10mm per press with a
 * wait between, and because the one time this was skipped the job found the soft
 * endstop after it had already started.
 */

import { describe, expect, test } from "bun:test";
import { buildJob } from "../src/gcode.ts";
import { reachCheck, reachCheckComment } from "../src/reach.ts";

const codes = (w: number, h: number) => reachCheck({ width: w, height: h }).map((s) => s.code);

describe("reachCheck", () => {
  test("sets absolute mm and lifts Z before it moves in XY", () => {
    const c = codes(80, 60);
    expect(c[0]).toBe("G90 G21");
    expect(c[1]).toBe("G0 Z5");
    expect(c.findIndex((l) => /X|Y/.test(l))).toBe(2);
  });

  test("walks the four STOCK corners, not the toolpath extents", () => {
    // The stock corners are the larger box and the one the laser boundary trace
    // follows, so clearing them clears the toolpath too.
    expect(codes(80, 60)).toEqual([
      "G90 G21", "G0 Z5", "G0 X0 Y0", "G0 X80 Y0", "G0 X80 Y-60", "G0 X0 Y-60", "G0 X0 Y0",
    ]);
  });

  test("the far corner is flagged, and it is the furthest in both axes", () => {
    const steps = reachCheck({ width: 150, height: 120 });
    const critical = steps.filter((s) => s.critical);
    expect(critical.length).toBe(1);
    expect(critical[0]!.code).toBe("G0 X150 Y-120");
  });

  test("it finishes back at the work origin", () => {
    expect(codes(80, 60).at(-1)).toBe("G0 X0 Y0");
  });

  test("every Y in it is negative or zero, like the job itself", () => {
    for (const [w, h] of [[80, 60], [200, 200], [12.5, 7.25]] as const) {
      for (const line of codes(w, h)) {
        const m = /\bY(-?\d*\.?\d+)/.exec(line);
        if (m) expect(Number(m[1])).toBeLessThanOrEqual(0);
      }
    }
  });

  test("each line is one bare command — no trailing comment to confuse MDI", () => {
    for (const s of reachCheck({ width: 80, height: 60 })) {
      expect(s.code).not.toContain(";");
      expect(s.code).not.toContain("(");
      expect(s.code.split("\n").length).toBe(1);
      expect(s.why.length).toBeGreaterThan(20);
    }
  });
});

describe("the block carried in the .nc", () => {
  const lines = reachCheckComment({ width: 80, height: 60 });

  test("is entirely comments — it must never execute", () => {
    // These lines sit in a file the controller runs. If one of them were not a
    // comment the machine would drive the perimeter at the start of every job.
    for (const l of lines) expect(l.startsWith(";")).toBe(true);
  });

  test("quotes every MDI step", () => {
    for (const s of reachCheck({ width: 80, height: 60 })) {
      expect(lines.some((l) => l.includes(s.code))).toBe(true);
    }
  });

  test("the relative-hop example avoids Y, the axis with no slack", () => {
    const hop = lines.slice(lines.findIndex((l) => l.includes("G91")));
    expect(hop.some((l) => /Y-?\d/.test(l))).toBe(false);
    expect(hop.some((l) => l.includes("G90"))).toBe(true);
  });

  test("it reaches the generated file, above the motion and below the header", () => {
    const r = buildJob(
      { width: 80, height: 60, depth: 0.3, material: "mdf", stepover: 0.45 },
      { thumbnail: false },
    );
    if (!r.ok) throw new Error("refused");
    const at = (s: string) => r.lines.findIndex((l) => l.includes(s));
    expect(at(";@MKR|END")).toBeLessThan(at("Reach check"));
    expect(at("Reach check")).toBeLessThan(r.lines.indexOf("G90 G21"));
    expect(r.reach.map((s) => s.code)).toEqual(codes(80, 60));
  });
});
