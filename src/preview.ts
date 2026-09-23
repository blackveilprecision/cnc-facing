/**
 * The picture of the job, built once and rendered two ways.
 *
 * The browser gets it as SVG (crisp, and it is what you look at before you
 * commit the machine); the .nc file gets it as a base64 PNG so the controller's
 * job list shows something other than a blank tile. Both come from the same
 * Scene, so the thumbnail cannot drift from what the form showed you.
 *
 * What it draws, and why each part earns its place:
 *
 *   * the declared stock rectangle -- the box the controller draws its own
 *     preview inside, so seeing it here is seeing what `;@MKR|STOCK` says;
 *   * the SWEPT area, drawn by stroking the toolpath at the tool's real
 *     diameter rather than by filling the rectangle. If the swept bands do not
 *     exactly cover the stock rectangle, the r..W-r convention is broken and
 *     you can see it;
 *   * the toolpath centreline, which shows the pattern, with a dot where the
 *     tool first goes down so its direction can be read, and the lifted moves
 *     between strokes dashed;
 *   * a crosshair at the work origin. Origin orientation is the thing that has
 *     actually gone wrong on this machine -- a +Y job hit a soft endstop -- so
 *     the picture says out loud which corner is X0 Y0 and that Y runs down.
 */

import type { FacingPath, Pt } from "./facing.ts";
import type { MaterialId } from "./materials.ts";
import type { StockDeclaration } from "./mkr.ts";


export interface Palette {
  readonly ground: string;
  readonly stock: string;
  readonly cut: string;
  readonly path: string;
  readonly rule: string;
  readonly origin: string;
}

/** Material tints, so two jobs are told apart at a glance in the job list. */
const PALETTES: Record<MaterialId, Palette> = {
  mdf: { ground: "#ffffff", stock: "#c8a97e", cut: "#e6d3b3", path: "#6b4b22", rule: "#3a3a3a", origin: "#c0392b" },
  aluminium: { ground: "#ffffff", stock: "#9aa3ab", cut: "#d3d9de", path: "#3c4a57", rule: "#3a3a3a", origin: "#c0392b" },
  brass: { ground: "#ffffff", stock: "#b8922a", cut: "#e8cf74", path: "#5c4708", rule: "#3a3a3a", origin: "#c0392b" },
};

export interface Scene {
  readonly stock: StockDeclaration;
  /**
   * Tool centreline, work coordinates (Y negative), one depth level only. One
   * polyline per stroke: the tool is down along each and lifted between them.
   */
  readonly strokes: Pt[][];
  readonly toolDiameter: number;
  readonly palette: Palette;
}

export function buildScene(path: FacingPath, stock: StockDeclaration): Scene {
  // The LAST level, not the first: it is the one that leaves the surface you
  // actually get. In `general` mode it is the same footprint as every other
  // level; in `finish` mode it is the rotated finishing pass, and seeing that
  // rotation is most of the point of the preview. The strokes are the same
  // ones gcodeBody() prints, so the drawing follows the G-code rather than
  // re-deriving it.
  return {
    stock,
    strokes: path.levels.at(-1)!.strokes,
    toolDiameter: path.spec.material.tool.diameter,
    palette: PALETTES[path.spec.material.materialId],
  };
}

interface Layout {
  readonly scale: number;
  readonly ox: number;
  readonly oy: number;
}

/**
 * Work millimetres -> pixels, aspect preserved, centred, with room for the
 * origin crosshair and the tool's overhang at the edges of the stock.
 */
function layout(scene: Scene, w: number, h: number, margin: number): Layout {
  const scale = Math.min(
    (w - 2 * margin) / scene.stock.length,
    (h - 2 * margin) / scene.stock.width,
  );
  return {
    scale,
    ox: (w - scene.stock.length * scale) / 2,
    oy: (h - scene.stock.width * scale) / 2,
  };
}

/** Work point -> pixel. Y is negated: the job runs down the page, as it does on the machine. */
function project(p: Pt, l: Layout): Pt {
  return { x: l.ox + p.x * l.scale, y: l.oy + -p.y * l.scale };
}

export function sceneToSvg(scene: Scene, w = 640, h = 480): string {
  const margin = Math.max(16, Math.min(w, h) * 0.06);
  const l = layout(scene, w, h, margin);
  const { palette: c } = scene;
  const strokes = scene.strokes.map((st) => st.map((p) => project(p, l)));
  const n = (v: number) => v.toFixed(2);
  const polylines = strokes.map((xy) =>
    `<polyline points="${xy.map((q) => `${n(q.x)},${n(q.y)}`).join(" ")}" fill="none"` +
    ` stroke="${c.path}" stroke-width="1" opacity="0.65"/>`).join("");
  // One subpath PER SEGMENT, because stroke-linecap applies to the ends of a
  // subpath and not to the vertices inside one. A single polyline would leave
  // the outer half-tool-width of every row unpainted -- an uncovered strip down
  // both edges of the stock, which is not what the machine does and not what
  // the PNG thumbnail draws.
  const swept = strokes.flatMap((xy) => xy.slice(1).map((q, i) =>
    `M${n(xy[i]!.x)} ${n(xy[i]!.y)}L${n(q.x)} ${n(q.y)}`)).join("");
  // The lifted moves between strokes: dashed, and NOT swept, because the tool
  // is in the air for them.
  const rapids = strokes.slice(1).map((xy, i) => {
    const from = strokes[i]!.at(-1)!;
    return `M${n(from.x)} ${n(from.y)}L${n(xy[0]!.x)} ${n(xy[0]!.y)}`;
  }).join("");
  const start = strokes[0]![0]!;
  const sw = scene.toolDiameter * l.scale;
  const o = project({ x: 0, y: 0 }, l);
  const arm = Math.max(10, margin * 0.7);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" role="img"`,
    ` aria-label="Toolpath preview: ${scene.stock.length}×${scene.stock.width}mm faced from a top-left origin, sweeping toward the operator.">`,
    `<rect width="${w}" height="${h}" fill="${c.ground}"/>`,
    `<rect x="${l.ox.toFixed(2)}" y="${l.oy.toFixed(2)}"`,
    ` width="${(scene.stock.length * l.scale).toFixed(2)}" height="${(scene.stock.width * l.scale).toFixed(2)}"`,
    ` fill="${c.stock}" stroke="${c.rule}" stroke-width="1.5"/>`,
    // The swept area: each segment stroked at the tool's real width with round
    // caps, which is exactly the area a round cutter clears. The rounded corners
    // of the faced rectangle are real -- the tool cannot reach into a square
    // corner -- so they are drawn rather than painted over.
    `<path d="${swept}" fill="none" stroke="${c.cut}" stroke-width="${sw.toFixed(2)}"`,
    ` stroke-linecap="round"/>`,
    polylines,
    rapids ? `<path d="${rapids}" fill="none" stroke="${c.path}" stroke-width="1" stroke-dasharray="3 3" opacity="0.35"/>` : "",
    // Where the tool first goes down, so the direction of travel can be read.
    `<circle cx="${n(start.x)}" cy="${n(start.y)}" r="3.5" fill="${c.path}"/>`,
    // Origin crosshair, with the arrow showing which way Y runs.
    `<g stroke="${c.origin}" stroke-width="2" fill="none">`,
    `<path d="M${(o.x - arm).toFixed(1)} ${o.y.toFixed(1)}h${(arm * 2).toFixed(1)}"/>`,
    `<path d="M${o.x.toFixed(1)} ${(o.y - arm * 0.5).toFixed(1)}v${(arm * 1.5).toFixed(1)}"/>`,
    `<path d="M${(o.x - 5).toFixed(1)} ${(o.y + arm).toFixed(1)}l5 5 5 -5" stroke-linecap="round"/>`,
    `</g>`,
    `</svg>`,
  ].join("");
}

export { PALETTES, layout, project };
