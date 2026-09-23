/**
 * The `;@MKR|` metadata header. FIELD ORDER IS PART OF THE CONTRACT.
 *
 * This is the single most important thing in the project and it took seven
 * machine trips to pin down (EASYTRACE-Z1.md, "The `;@MKR|` header is required,
 * and its field order matters"). The controller reads this block to render the
 * toolpath preview AND to compute the laser boundary trace. Without it -- or
 * with one whose fields are in the wrong order -- both silently do nothing: the
 * file loads, the thumbnail renders, the machine cuts the job perfectly, and the
 * preview pane stays blank while the trace walks a zero-size box at X0 Y0.
 *
 * The order, which MKR_FIELD_ORDER below encodes and the tests assert:
 *
 *   BEGIN SCHEMA MACHINE MATERIAL STOCK ORIGIN CAM UNIT MAXFEEDRATE
 *   TOOL...        <- tools BEFORE time
 *   TIME           <- then time
 *   TOOLPATH...    <- then the toolpath list
 *   END
 *
 * TOOL-before-TIME is the specific one that failed: our files had TIME first,
 * which is what an order-sensitive parser would reject outright.
 */

import type { FacingPath } from "./facing.ts";
import { MAX_FEEDRATE } from "./materials.ts";

/** Asserted by the tests. Changing this is changing what the machine accepts. */
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
    `;@MKR|TIME|seconds=${path.seconds.toFixed(2)}`,
    `;@MKR|TOOLPATH|number=1|tool_number=1|name=[T1]${opts.toolpathName}`,
    ";@MKR|END",
    "",
  ];
}

/** The tag of a `;@MKR|X|...` line, or null if the line is not one. */
export function mkrTag(line: string): string | null {
  if (!line.startsWith(";@MKR|")) return null;
  return line.slice(6).split("|")[0] ?? null;
}
