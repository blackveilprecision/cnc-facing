/**
 * The four patterns, checked against the G-code they emit rather than against
 * the planner's idea of them.
 *
 * `simulate()` below reads the motion lines back the way the controller would --
 * modal position, Z tracked, G0 versus G1 -- and every geometric claim is made
 * about what it recovers. That is the difference between "the plan is right"
 * and "the file is right", and only the second one reaches the machine.
 */

import { describe, expect, test } from "bun:test";
import { buildJob } from "../src/gcode.ts";
import { CLEAR_Z, PATTERNS, SAFE_Z, type Pattern } from "../src/facing.ts";
import { validate, type JobRequest } from "../src/validate.ts";

const BASE = {
  width: 40, height: 30, depth: 0.2, material: "aluminium", stepover: 0.45,
} as const;

function build(over: Partial<JobRequest> = {}) {
  const r = buildJob({ ...BASE, ...over } as JobRequest, { thumbnail: false, now: new Date(2026, 8, 22) });
  if (!r.ok) throw new Error(JSON.stringify(r.refusals));
  return r;
}

interface P { x: number; y: number }
interface Seg { a: P; b: P; z: number }

/** Replays the motion lines. Returns the cutting segments and any rule breaks. */
function simulate(lines: string[]) {
  let x = 0, y = 0, z = SAFE_Z;
  const cuts: Seg[] = [];
  const plunges: Seg[] = [];
  const broken: string[] = [];
  const lifts: number[] = [];
  for (const line of lines) {
    const m = /^G([01]) (.*)$/.exec(line);
    if (!m) continue;
    const words = Object.fromEntries(
      [...m[2]!.matchAll(/([XYZF])(-?\d*\.?\d+)/g)].map((w) => [w[1]!, Number(w[2])]),
    );
    const nx = words.X ?? x, ny = words.Y ?? y, nz = words.Z ?? z;
    const lateral = nx !== x || ny !== y;
    if (m[1] === "0" && lateral && z < 0) broken.push(`rapid while down: ${line}`);
    if (m[1] === "0" && words.Z !== undefined && nz > z) lifts.push(nz);
    if (m[1] === "1" && lateral && z < 0) cuts.push({ a: { x, y }, b: { x: nx, y: ny }, z });
    if (m[1] === "1" && lateral && z >= 0) broken.push(`feed move in the air: ${line}`);
    // A plunge cuts a disc, which is all a job exactly one tool wide gets.
    if (m[1] === "1" && !lateral && nz < 0 && nz < z) plunges.push({ a: { x, y }, b: { x, y }, z: nz });
    x = nx; y = ny; z = nz;
  }
  // The last lift is gcode.ts's retract before M5, not part of the pattern.
  lifts.pop();
  return { cuts, plunges, broken, lifts };
}

function distToSeg(p: P, s: Seg): number {
  const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (s.a.x + t * dx), p.y - (s.a.y + t * dy));
}

const R = 3.175 / 2;
const SIZES = [[40, 30], [37.3, 12.9], [10, 60], [25, 25], [3.175, 3.175], [3.2, 20]] as const;

describe.each(PATTERNS.map((p) => [p]))("%s", (pattern: Pattern) => {
  test("never rapids with the tool down, and never feeds sideways in the air", () => {
    for (const depth of [0.2, 0.6]) {
      expect(simulate(build({ pattern, depth }).lines).broken).toEqual([]);
    }
  });

  test("every Y is negative and every X positive — rule 2 holds on every pattern", () => {
    for (const [width, height] of SIZES) {
      for (const line of build({ pattern, width, height }).lines.filter((l) => /^G[01] /.test(l))) {
        const ys = /\bY(-?\d*\.?\d+)/.exec(line);
        const xs = /\bX(-?\d*\.?\d+)/.exec(line);
        if (ys) expect(Number(ys[1])).toBeLessThanOrEqual(0);
        if (xs) expect(Number(xs[1])).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("the tool centre stays inside r..W-r, so nothing outside the rectangle is cut", () => {
    for (const [width, height] of SIZES) {
      for (const s of simulate(build({ pattern, width, height }).lines).cuts) {
        for (const p of [s.a, s.b]) {
          expect(p.x).toBeGreaterThanOrEqual(R - 1e-3);
          expect(p.x).toBeLessThanOrEqual(width - R + 1e-3);
          expect(p.y).toBeLessThanOrEqual(-R + 1e-3);
          expect(p.y).toBeGreaterThanOrEqual(-(height - R) - 1e-3);
        }
      }
    }
  });

  test("and the whole rectangle IS cut, apart from the corner fillets and edge scallops", () => {
    // Every point of the faced area must lie within a tool radius of some
    // cutting move at the final depth. Two real exceptions:
    //
    //  * the corners: a round tool whose centre stops at (r, r) cannot reach
    //    (0, 0);
    //  * where raster lines END at an edge, between the ends of two passes the
    //    edge is a row of tool-radius arcs, not a straight line. The sliver
    //    left is r - sqrt(r^2 - (step/2)^2) deep, 0.17mm at the default step --
    //    true of the original serpentine-x on its left and right edges too, and
    //    the reason stock gets faced a few mm oversize. The spiral has none,
    //    because its rings run along every edge.
    //
    // Everything further in than the scallop has to be covered exactly.
    const step = 3.175 * 0.45;
    const scallop = R - Math.sqrt(R * R - (step / 2) ** 2) + 1e-3;
    for (const [width, height] of SIZES) {
      const { cuts, plunges } = simulate(build({ pattern, width, height, depth: 0.4 }).lines);
      const all = [...cuts, ...plunges];
      const deepest = Math.min(...all.map((c) => c.z));
      const floor = all.filter((c) => c.z === deepest);
      const missed: P[] = [];
      for (let x = 0; x <= width + 1e-9; x += 0.25) {
        for (let y = 0; y <= height + 1e-9; y += 0.25) {
          const p = { x, y: -y };
          const nearCorner = [[0, 0], [width, 0], [0, -height], [width, -height]]
            .some(([cx, cy]) => Math.hypot(p.x - cx!, p.y - cy!) < R + 0.01);
          const onEdge = Math.min(x, width - x, y, height - y) < scallop;
          if (nearCorner || onEdge) continue;
          if (!floor.some((s) => distToSeg(p, s) <= R + 1e-3)) missed.push(p);
        }
      }
      expect({ size: [width, height], missed: missed.slice(0, 3) }).toEqual({ size: [width, height], missed: [] });
    }
  });

  test("goes all the way to the requested depth, in steps no deeper than the DOC", () => {
    const { cuts } = simulate(build({ pattern, depth: 0.6 }).lines);
    const zs = [...new Set(cuts.map((c) => c.z))].sort((a, b) => b - a);
    expect(zs.map((z) => Number(z.toFixed(3)))).toEqual([-0.2, -0.4, -0.6]);
  });

  test("puts the pattern in the filename unless it is the original serpentine-x", () => {
    const name = build({ pattern }).filename;
    if (pattern === "serpentine-x") expect(name).toBe("facing-aluminium-40x30-0.2mm-20260922.nc");
    else expect(name).toBe(`facing-aluminium-40x30-0.2mm-${pattern}-20260922.nc`);
  });

  test("the time estimate is at least the cutting time", () => {
    const r = build({ pattern });
    expect(r.path.seconds).toBeGreaterThan((r.path.cutLength / 500) * 60);
  });
});

describe("serpentine-y", () => {
  test("cuts along Y and steps along X", () => {
    const { cuts } = simulate(build({ pattern: "serpentine-y" }).lines);
    const along = cuts.filter((c) => Math.abs(c.b.y - c.a.y) > 5);
    const steps = cuts.filter((c) => Math.abs(c.b.y - c.a.y) < 1e-9);
    expect(along.every((c) => c.a.x === c.b.x)).toBe(true);
    expect(steps.every((c) => c.b.x > c.a.x)).toBe(true);
    expect(along.length).toBe(build({ pattern: "serpentine-y" }).path.passesPerLevel);
  });

  test("steps down in place between levels, like the X serpentine", () => {
    expect(simulate(build({ pattern: "serpentine-y", depth: 0.6 }).lines).lifts).toEqual([]);
  });
});

describe("oneway-y is climb on every pass", () => {
  const r = build({ pattern: "oneway-y" });
  const { cuts, lifts } = simulate(r.lines);

  test("every cut travels +Y, front to back, and there are no cutting stepovers", () => {
    expect(cuts.length).toBe(r.path.passesPerLevel);
    for (const c of cuts) {
      expect(c.a.x).toBe(c.b.x);
      expect(c.b.y).toBeGreaterThan(c.a.y);
    }
  });

  test("with the uncut material on the right: the passes advance into +X", () => {
    // Travelling +Y, the right-hand side is +X. Each pass has to be to the
    // right of the one before, or it is conventional after all.
    const xs = cuts.map((c) => c.a.x);
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
  });

  test("lifts to CLEAR_Z between passes, and to SAFE_Z between levels", () => {
    expect(lifts).toEqual(Array(cuts.length - 1).fill(CLEAR_Z));
    const deep = simulate(build({ pattern: "oneway-y", depth: 0.4 }).lines).lifts;
    expect(deep.filter((z) => z === SAFE_Z).length).toBe(1);
  });

  test("the return is a rapid, and the stepover is taken in the air", () => {
    const i = r.lines.indexOf(`G0 Z${CLEAR_Z}`);
    expect(r.lines.slice(i, i + 3)).toEqual([
      "G0 Z1",
      "G0 X3.016 Y-28.413",
      "G1 Z-0.200 F200",
    ]);
  });

  test("costs more time than the Y serpentine it is compared against", () => {
    expect(r.path.seconds).toBeGreaterThan(build({ pattern: "serpentine-y" }).path.seconds);
  });
});

describe("spiral", () => {
  test("is climb throughout: the centre of the work is always on the right", () => {
    // Clockwise and inward, the remaining island is on the right of travel.
    // Axis-aligned moves only: the diagonal ring-to-ring steps are stepovers.
    for (const [width, height] of SIZES) {
      const c = { x: width / 2, y: -height / 2 };
      for (const s of simulate(build({ pattern: "spiral", width, height }).lines).cuts) {
        const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
        if (dx && dy) continue;
        // Right-hand normal of (dx, dy) is (dy, -dx).
        const side = (c.x - s.a.x) * dy + (c.y - s.a.y) * -dx;
        expect(side).toBeGreaterThanOrEqual(-1e-6);
      }
    }
  });

  test("is one stroke per level: no lifts within a level", () => {
    expect(simulate(build({ pattern: "spiral" }).lines).lifts).toEqual([]);
  });

  test("goes back to the corner at SAFE_Z for each new level", () => {
    const { lifts } = simulate(build({ pattern: "spiral", depth: 0.6 }).lines);
    expect(lifts).toEqual([SAFE_Z, SAFE_Z]);
  });

  test("the only two-axis moves are the ring-to-ring stepovers, and they are short", () => {
    const r = build({ pattern: "spiral" });
    const diag = simulate(r.lines).cuts.filter((c) => c.a.x !== c.b.x && c.a.y !== c.b.y);
    expect(diag.length).toBe(r.path.passesPerLevel - 1);
    // 1e-3 of slack for the three-decimal rounding of both ends.
    for (const d of diag) expect(Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y)).toBeLessThanOrEqual(r.path.step * Math.SQRT2 + 1e-3);
  });

  test("counts rings, and says so", () => {
    const s = build({ pattern: "spiral" }).summary;
    expect(s.passUnit).toBe("rings");
    // 30mm short side: rings at r, r+step, ... up to 15mm.
    expect(s.passesPerLevel).toBe(Math.ceil((15 - R) / (3.175 * 0.45) - 1e-9) + 1);
  });
});

describe("what the summary says about direction", () => {
  test("each pattern gets its own climb/conventional note", () => {
    const note = (pattern: Pattern) =>
      build({ pattern }).summary.warnings.find((w) => /climb/i.test(w.text))!.text;
    expect(note("serpentine-x")).toContain("Alternates: +X passes climb");
    expect(note("serpentine-y")).toContain("Alternates: +Y passes climb");
    expect(note("oneway-y")).toContain("Every pass climb");
    expect(note("spiral")).toContain("Climb throughout");
  });
});

describe("refusals", () => {
  test("an unknown pattern is refused, not quietly cut as the default", () => {
    const r = validate({ ...BASE, pattern: "zigzag" as never });
    expect(r.map((x) => x.field)).toEqual(["pattern"]);
  });

  test("fine finish takes no pattern but its own", () => {
    expect(validate({ ...BASE, depth: 0.2, mode: "finish", pattern: "spiral" })[0]!.field).toBe("pattern");
    expect(validate({ ...BASE, depth: 0.2, mode: "finish", pattern: "serpentine-x" })).toEqual([]);
    expect(validate({ ...BASE, depth: 0.2, mode: "finish" })).toEqual([]);
  });
});
