/**
 * Put the G word back on every motion line of a generated file.
 *
 * The app writes modal motion (see modalise in src/gcode.ts). The geometry
 * tests reason about moves line by line, and they read much more simply with
 * the motion mode spelled out, so they go through this. The file itself is
 * checked as written in golden, gcode and modal tests.
 */
export function explicit(lines: readonly string[]): string[] {
  let cur = "";
  return lines.map((l) => {
    const m = /^(G[0-3]) /.exec(l);
    if (m) { cur = m[1]!; return l; }
    return /^[XYZ]/.test(l) ? `${cur} ${l}` : l;
  });
}
