/**
 * Modal motion: a G word only where the motion mode changes. Previewed and
 * boundary-traced normally on the Z1, 2026-09-24, and written for every file
 * since 0.10.0.
 */

import { describe, expect, test } from "bun:test";
import { buildJob, modalise } from "../src/gcode.ts";
import { explicit } from "./explicit.ts";
import { checkGcode } from "../src/check.ts";

const REQ = { width: 45, height: 45, depth: 0.2, material: "aluminium", stepover: 0.45 } as const;
const AT = new Date(2026, 8, 24, 10, 0);

function build(over: object = {}) {
  const r = buildJob({ ...REQ, ...over }, { now: AT, thumbnail: false });
  if (!r.ok) throw new Error(JSON.stringify(r.refusals));
  return r;
}

describe("modalise", () => {
  test("drops a G word only when it repeats the previous motion line's", () => {
    expect(modalise(["G0 X1 Y2", "G0 Z5", "G1 Z-0.1 F300", "G1 X5 F800", "G1 Y-3 F800", "G0 Z5"]))
      .toEqual(["G0 X1 Y2", "Z5", "G1 Z-0.1 F300", "X5 F800", "Y-3 F800", "G0 Z5"]);
  });

  test("comments and blank lines keep the mode", () => {
    expect(modalise(["G1 X1 F800", "", "; note", "(note)", "G1 X2 F800"]))
      .toEqual(["G1 X1 F800", "", "; note", "(note)", "X2 F800"]);
  });

  test("any other code forgets it, so the first move after a tool change is explicit", () => {
    // M6's macro runs its own G53 G0 and G38.6 probes.
    expect(modalise(["G0 Z5", "T2 M6", "G0 Z5", "M3 S10000", "G0 X0 Y0", "G4 P1", "G0 X1"]))
      .toEqual(["G0 Z5", "T2 M6", "G0 Z5", "M3 S10000", "G0 X0 Y0", "G4 P1", "G0 X1"]);
  });

  test("leaves lines that are not a bare G0-G3 plus coordinates alone", () => {
    expect(modalise(["G90 G21", "G28", "G28", "G4 P1", "G4 P1"]))
      .toEqual(["G90 G21", "G28", "G28", "G4 P1", "G4 P1"]);
  });
});

describe("every generated file", () => {
  const job = build({ overhang: true, chamfer: 0.2 });

  test("is modal: no motion line repeats the previous one's G word", () => {
    let cur = "";
    for (const l of job.lines) {
      const m = /^(G[0-3]) [XYZ]/.exec(l);
      if (m) { expect(m[1]).not.toBe(cur); cur = m[1]!; }
      else if (l && !l.startsWith(";") && !l.startsWith("(") && !/^[XYZ]/.test(l)) cur = "";
    }
    expect(job.lines.filter((l) => /^[XYZ]/.test(l)).length).toBeGreaterThan(20);
  });

  test("keeps F on every feed move", () => {
    const feeds = explicit(job.lines).filter((l) => /^G1 /.test(l));
    expect(feeds.every((l) => /F\d+$/.test(l))).toBe(true);
  });

  test("the first move after each tool change is explicit", () => {
    for (const tc of ["T1 M6", "T2 M6"]) {
      const i = job.lines.indexOf(tc);
      const next = job.lines.slice(i + 1).find((l) => /^(G[0-3] )?[XYZ]/.test(l))!;
      expect(next).toMatch(/^G[0-3] /);
    }
  });

  test("the checker reads it as a note only, and the verdict is ok", () => {
    const r = checkGcode(job.gcode, job.filename);
    expect(r.findings.find((f) => f.code === "modal-motion")!.level).toBe("note");
    expect(r.findings.filter((f) => f.level !== "note")).toEqual([]);
  });
});
