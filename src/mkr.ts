/**
 * The `;@MKR|` metadata header, in Makera Studio's field order.
 *
 * For seven machine trips this block, and TOOL-before-TIME in particular, was
 * believed to be what makes the controller's toolpath preview and laser
 * boundary trace work. The 2026-09-24 load tests (EASYTRACE-Z1.md) disproved
 * that: a file with no header at all previews and traces normally, and so does
 * one with TIME before TOOL. The real cause of every blank preview was the tool
 * change written `M6 T<n>` instead of `T<n> M6`, which --makera-style happened
 * to fix at the same time.
 *
 * What the header visibly does:
 *
 *   STOCK   draws the stock box in the Machining Wizard, always at Anchor1
 *           (the machine's bottom-left L-bracket), never at the work origin.
 *           Kept because users of Makera's tools expect a box.
 *   TOOL    each tool's name, shown by Makera Studio at the tool change next
 *           to the LED count. The most useful thing in here.
 *
 * Nothing else has a visible effect: MATERIAL, CAM, MAXFEEDRATE, TIME, the
 * TOOLPATH list and ORIGIN were each left out without any change. Makera
 * Studio's order is kept because matching the known-good file costs nothing:
 *
 *   BEGIN SCHEMA MACHINE MATERIAL STOCK ORIGIN CAM UNIT MAXFEEDRATE
 *   TOOL...        <- tools BEFORE time
 *   TIME           <- then time
 *   TOOLPATH...    <- then the toolpath list
 *   END
 *
 * (TIME before TOOL, once blamed, previews fine: load test 21.)
 */

import type { ChamferPlan } from "./chamfer.ts";
import type { FacingPath } from "./facing.ts";
import { MAX_FEEDRATE } from "./materials.ts";

/** Makera Studio's order, asserted by the tests so the header keeps matching it. */
export const MKR_FIELD_ORDER = [
  "BEGIN",
  "SCHEMA",
  "MACHINE",
  "MATERIAL",
  "STOCK",
  "ORIGIN",
  "CAM",
  "UNIT",
  "MAXFEEDRATE",
  "TOOL",
  "TIME",
  "TOOLPATH",
  "END",
] as const;

export interface StockDeclaration {
  /** X extent of the material clamped down, mm. */
  readonly length: number;
  /** Y extent, mm. */
  readonly width: number;
  /** Thickness, mm. The preview box is drawn this tall. */
  readonly height: number;
}

/** Python `%g`: 6 significant digits, trailing zeros stripped. */
export function g(v: number): string {
  return Number(v.toPrecision(6)).toString();
}

/**
 * `stock` is the material you clamped, not the cut envelope.
 *
 * The controller draws the preview INSIDE this box, so a stock smaller than the
 * job puts the toolpath outside it and the preview goes wrong -- the same
 * visible failure as a wrong origin, from the opposite direction. For a facing
 * job the swept area is exactly the declared length x width by construction
 * (the tool centre runs r..W-r), so it fits provided the caller declares the
 * faced size, which gcode.ts does.
 */
export function mkrHeader(opts: {
  path: FacingPath;
  stock: StockDeclaration;
  camVersion: string;
  toolpathName: string;
  /**
   * The chamfer as T2, when there is one. Two TOOL lines, then TIME, then two
   * TOOLPATH lines: the order the multi-tool PCB headers here have run with.
   */
  chamfer?: ChamferPlan | null;
}): string[] {
  const { path, stock } = opts;
  const { material } = path.spec;
  const tool = material.tool;
  const { length: L, width: W, height: H } = stock;

  return [
    ";@MKR|BEGIN",
    ";@MKR|SCHEMA|v=1.0.0",
    ";@MKR|MACHINE|id=Z1|name=Makera Z1",
    `;@MKR|MATERIAL|id=|name3=other|name1=Other|name2=${material.stockName}`,
    `;@MKR|STOCK|id=cuboid|length=${g(L)}|width=${g(W)}|height=${g(H)}|diameter=50`,
    // The work origin sits on the stock's BACK-left edge (y=+W/2), expressed
    // from the stock's centre, because the job sweeps into -Y. `topFrontLeft` is
    // the only type_name the parser is known to accept, so the corner is moved
    // by the numbers rather than by the name -- the same thing fix_gcode.py does
    // for a top-left-origin board.
    `;@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=${g(-L / 2)}|y=${g(W / 2)}|z=${g(H / 2)}`,
    `;@MKR|CAM|id=cnc-facing|name=cnc-facing|v=${opts.camVersion}`,
    ";@MKR|UNIT|value=mm",
    `;@MKR|MAXFEEDRATE|value=${MAX_FEEDRATE}`,
    `;@MKR|TOOL|number=1|id=|name=${tool.name} - FACING|type=${tool.type}` +
      `|sticklength=0|handlediameter=${g(tool.handleDiameter)}` +
      `|flutelength=${g(tool.fluteLength)}|diameter=${g(tool.diameter)}` +
      `|tipdiameter=${g(tool.diameter)}|cornerradius=0|angle=0|halfAngle=0`,
    ...(opts.chamfer ? [chamferToolLine(opts.chamfer)] : []),
    `;@MKR|TIME|seconds=${(path.seconds + (opts.chamfer?.seconds ?? 0)).toFixed(2)}`,
    `;@MKR|TOOLPATH|number=1|tool_number=1|name=[T1]${opts.toolpathName}`,
    ...(opts.chamfer ? [`;@MKR|TOOLPATH|number=2|tool_number=2|name=[T2]Chamfer ${g(opts.chamfer.width)}mm`] : []),
    ";@MKR|END",
    "",
  ];
}

/** T2's line, in the V-bit form the PCB headers use: tip, and the half angle. */
function chamferToolLine(c: ChamferPlan): string {
  const t = c.profile.tool;
  return `;@MKR|TOOL|number=2|id=|name=${t.name} - CHAMFER|type=${t.type}` +
    `|sticklength=0|handlediameter=${g(t.handleDiameter)}` +
    `|flutelength=${g(t.fluteLength)}|diameter=${g(t.diameter)}` +
    `|tipdiameter=${g(t.tipDiameter)}|cornerradius=0|angle=0|halfAngle=${g(t.halfAngle)}`;
}

/** The tag of a `;@MKR|X|...` line, or null if the line is not one. */
export function mkrTag(line: string): string | null {
  if (!line.startsWith(";@MKR|")) return null;
  return line.slice(6).split("|")[0] ?? null;
}
