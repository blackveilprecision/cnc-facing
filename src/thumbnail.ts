/**
 * Makera's three-line base64 PNG trailer -- the job-list preview.
 *
 * Only the picture: the tile in the job list and in Windows Explorer (for .nc;
 * Explorer shows none for .cnc). The toolpath preview and the laser trace do not
 * depend on it or on the `;@MKR|` block (load tests 19 and 23, 2026-09-24).
 *
 * Format (EASYTRACE-Z1.md): `;(thumbnail_image_begin)`, one `;`-prefixed base64
 * line, `;(thumbnail_image_end)`. Makera's own thumbnails are 800x600 PNGs,
 * matched here.
 */

import { Canvas } from "./png.ts";
import { layout, project, type Scene } from "./preview.ts";

export const THUMB_W = 800;
export const THUMB_H = 600;

/**
 * Lay the tool's swept area down a segment: the rectangle the body of the cutter
 * covers, plus a disc at each end.
 *
 * The discs are not decoration. A round cutter sweeping a segment covers the
 * segment's Minkowski sum with a disc of radius r, and drawing it that way is
 * what makes the four corners of a faced rectangle come out with the r radius
 * they actually have. A square-capped band would paint those corners in and
 * quietly promise a sharp corner the machine cannot cut.
 */
function sweep(c: Canvas, x0: number, y0: number, x1: number, y1: number, w: number, hex: string): void {
  const half = w / 2;
  if (Math.abs(y1 - y0) < 0.5) {
    c.fillRect(Math.min(x0, x1), y0 - half, Math.abs(x1 - x0), w, hex);
  } else if (Math.abs(x1 - x0) < 0.5) {
    c.fillRect(x0 - half, Math.min(y0, y1), w, Math.abs(y1 - y0), hex);
  } else {
    c.line(x0, y0, x1, y1, hex, Math.max(1, Math.round(w)));
  }
  c.fillCircle(x0, y0, half, hex);
  c.fillCircle(x1, y1, half, hex);
}

export function sceneToPng(scene: Scene, w = THUMB_W, h = THUMB_H): Uint8Array {
  const c = new Canvas(w, h, scene.palette.ground);
  const margin = Math.min(w, h) * 0.08;
  const l = layout(scene, w, h, margin);
  const p = scene.palette;

  const sx = l.ox;
  const sy = l.oy;
  const sw = scene.stock.length * l.scale;
  const sh = scene.stock.width * l.scale;
  // The stock is painted first in its own colour and then completely overdrawn
  // by the swept bands -- which is the point. Because the tool centre runs
  // r..W-r, full coverage is exact, so any stock tint still showing through is a
  // gap in the toolpath you can see. The test asserts zero such pixels, with a
  // negative control so "never painted" cannot pass for "fully covered".
  c.fillRect(sx, sy, sw, sh, p.stock);

  const band = Math.max(1, scene.toolDiameter * l.scale);
  const strokes = scene.strokes.map((st) => st.map((q) => project(q, l)));
  for (const pts of strokes) {
    for (let i = 1; i < pts.length; i++) {
      sweep(c, pts[i - 1]!.x, pts[i - 1]!.y, pts[i]!.x, pts[i]!.y, band, p.cut);
    }
  }
  for (const pts of strokes) {
    for (let i = 1; i < pts.length; i++) {
      c.line(pts[i - 1]!.x, pts[i - 1]!.y, pts[i]!.x, pts[i]!.y, p.path, 1);
    }
  }

  // Stock outline last, so the tool's overhang at the edges does not eat it.
  c.strokeRect(sx, sy, sw, sh, p.rule, 2);

  // Origin crosshair at X0 Y0, with a stub running the way Y travels.
  const o = project({ x: 0, y: 0 }, l);
  const arm = Math.round(margin * 0.8);
  c.fillRect(o.x - arm, o.y - 1.5, arm * 2, 3, p.origin);
  c.fillRect(o.x - 1.5, o.y - arm * 0.5, 3, arm * 1.5, p.origin);

  return c.encode();
}

/** The three trailer lines, ready to append to the G-code. */
export function thumbnailLines(png: Uint8Array): string[] {
  return [
    ";(thumbnail_image_begin)",
    ";" + Buffer.from(png).toString("base64"),
    ";(thumbnail_image_end)",
  ];
}
