/**
 * The stock simulation: does it measure the depth a move is really in, and
 * ignore the depth it only brushes?
 */

import { describe, expect, test } from "bun:test";
import { simulate, type Cutter, type Pt3, type Segment } from "../src/stock.ts";

const FLAT: Cutter = { kind: "flat", radius: 1 };
const tools = new Map([[1, FLAT]]);
const BOX = { x0: -5, x1: 25, y0: -10, y1: 10 };

const line = (...pts: [number, number, number][]): Segment =>
  ({ tool: 1, pts: pts.map(([x, y, z]): Pt3 => ({ x, y, z })) });

describe("depth per pass", () => {
  test("a slot reads its full depth", () => {
    const e = simulate([line([0, 0, -0.3], [20, 0, -0.3])], tools, BOX);
    expect(e.depth[0]).toBeCloseTo(0.3, 2);
  });

  test("a second pass over the same slot is in air", () => {
    const s = line([0, 0, -0.3], [20, 0, -0.3]);
    const e = simulate([s, s], tools, BOX);
    expect(e.depth[1]).toBe(0);
  });

  test("stepping down 0.2 at a time reads 0.2, not the total", () => {
    const e = simulate([line([0, 0, -0.2], [20, 0, -0.2]), line([0, 0, -0.4], [20, 0, -0.4])], tools, BOX);
    expect(e.depth[1]).toBeCloseTo(0.2, 2);
  });

  test("a 45% stepover pass beside the last one still reads full depth", () => {
    const e = simulate([line([0, 0, -0.3], [20, 0, -0.3]), line([0, -0.9, -0.3], [20, -0.9, -0.3])], tools, BOX);
    expect(e.depth[1]).toBeCloseTo(0.3, 2);
  });

  test("a helix reads its pitch, and the flat orbit at the bottom is not the whole hole", () => {
    const pts: [number, number, number][] = [];
    for (let i = 0; i <= 16 * 8; i++) {
      const a = (i / 16) * 2 * Math.PI;
      pts.push([10 + 0.5 * Math.cos(a), 0.5 * Math.sin(a), -Math.min(1.6, (i / 16) * 0.2)]);
    }
    const segs = pts.slice(1).map((p, i) => line(pts[i]!, p));
    const e = simulate(segs, tools, BOX);
    expect(Math.max(...e.depth.slice(16))).toBeLessThan(0.25);
    expect(Math.max(...e.depth.slice(-16))).toBeLessThan(0.25);
  });

  test("a wall-finishing pass with a 0.1mm radial leave is a sliver, not a 1.2mm pass", () => {
    // Rough a slot 1.2 deep, then run 0.1 further over at the same depth.
    const e = simulate([line([0, 0, -1.2], [20, 0, -1.2]), line([0, 0.1, -1.2], [20, 0.1, -1.2])], tools, BOX);
    expect(e.depth[1]).toBeLessThan(0.05);
    // ...but the deepest single cell it touched is still reported, for rapids.
    expect(e.any[1]).toBeGreaterThan(1);
  });

  test("a plunge reads its peck", () => {
    const e = simulate([line([5, 0, 0], [5, 0, -1]), line([5, 0, -1], [5, 0, -1.5])], tools, BOX);
    expect(e.depth[0]).toBeCloseTo(1, 2);
    expect(e.depth[1]).toBeCloseTo(0.5, 2);
  });

  test("a V-bit: the next isolation offset reads the full depth, the same pass again reads none", () => {
    // 0.3mm tip, 30 degrees, at -0.12: 0.364 wide. The offsets here overlap by
    // 20%, so the second pass is 0.29 over.
    const vbit = new Map([[1, { kind: "cone", radius: 1.5875, tipRadius: 0.15, halfAngle: 15 } as Cutter]]);
    const a = line([0, 0, -0.12], [20, 0, -0.12]);
    const e = simulate([a, line([0, 0.29, -0.12], [20, 0.29, -0.12]), a], vbit, BOX);
    expect(e.depth[0]).toBeCloseTo(0.12, 2);
    expect(e.depth[1]).toBeCloseTo(0.12, 2);
    expect(e.depth[2]).toBeLessThan(0.001);
  });
});
