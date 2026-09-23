/**
 * The picture of an uploaded file: what it cuts, where, against the stock it
 * declares. Drawn in the same terms as preview.ts -- stock box, work origin
 * crosshair, Y running down the page as it does on the machine -- so a checked
 * file and a generated one read the same way.
 *
 * Makera Studio's sample is 160,000 points, so strokes are thinned in PIXEL
 * space: a point closer than a pixel to the last one kept is dropped. That
 * loses nothing visible and takes that file's SVG from over 1MB to about
 * 750KB -- most of what is left is its 25,000 rapids inside cleared pockets.
 */

import type { Box, CheckReport } from "./check.ts";

const C = {
  ground: "#ffffff",
  stock: "#e9e4da",
  rule: "#3a3a3a",
  cut: "#3c4a57",
  air: "#9aa3ab",
  envelope: "#c0392b",
  origin: "#c0392b",
};

/** Pixels. Points closer than this to the last kept one are dropped. */
const THIN = 1;

export function reportToSvg(r: CheckReport, w = 640, h = 480): string {
  const stock = r.stats.header.stock;
  const stockBox: Box | null = stock
    ? (r.stats.yDirection === "positive"
      ? { x0: 0, x1: stock.length, y0: 0, y1: stock.width }
      : { x0: 0, x1: stock.length, y0: -stock.width, y1: 0 })
    : null;
  // Fit everything worth seeing: the stock, the motion and the origin itself.
  const boxes = [stockBox, r.stats.extents, r.stats.cutExtents, { x0: 0, x1: 0, y0: 0, y1: 0 }]
    .filter((b): b is Box => b !== null);
  const all = boxes.reduce((a, b) => ({
    x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1),
  }));
  const margin = Math.max(16, Math.min(w, h) * 0.06);
  const spanX = Math.max(all.x1 - all.x0, 1);
  const spanY = Math.max(all.y1 - all.y0, 1);
  const scale = Math.min((w - 2 * margin) / spanX, (h - 2 * margin) / spanY);
  const ox = (w - spanX * scale) / 2 - all.x0 * scale;
  // Y is negated: the top of the page is the largest Y.
  const oy = (h - spanY * scale) / 2 + all.y1 * scale;
  const px = (x: number) => ox + x * scale;
  const py = (y: number) => oy - y * scale;
  const n = (v: number) => v.toFixed(1);

  const paths = { cut: [] as string[], air: [] as string[] };
  for (const s of r.strokes) {
    let d = "";
    let lx = Number.NaN;
    let ly = Number.NaN;
    s.points.forEach((p, i) => {
      const x = px(p.x);
      const y = py(p.y);
      const last = i === s.points.length - 1;
      if (i > 0 && !last && Math.hypot(x - lx, y - ly) < THIN) return;
      d += `${i === 0 ? "M" : "L"}${n(x)} ${n(y)}`;
      lx = x;
      ly = y;
    });
    (s.cut ? paths.cut : paths.air).push(d);
  }

  const rect = (b: Box, attrs: string) =>
    `<rect x="${n(px(b.x0))}" y="${n(py(b.y1))}" width="${n((b.x1 - b.x0) * scale)}" height="${n((b.y1 - b.y0) * scale)}" ${attrs}/>`;
  const o = { x: px(0), y: py(0) };
  const arm = Math.max(10, margin * 0.7);
  const down = r.stats.yDirection === "positive" ? -1 : 1;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" role="img"`,
    ` aria-label="Toolpath of the uploaded file, seen from above, with the declared stock and the work origin.">`,
    `<rect width="${w}" height="${h}" fill="${C.ground}"/>`,
    stockBox ? rect(stockBox, `fill="${C.stock}" stroke="${C.rule}" stroke-width="1.5"`) : "",
    paths.air.length
      ? `<path d="${paths.air.join("")}" fill="none" stroke="${C.air}" stroke-width="0.8" stroke-dasharray="3 3" opacity="0.6"/>`
      : "",
    paths.cut.length
      ? `<path d="${paths.cut.join("")}" fill="none" stroke="${C.cut}" stroke-width="1" stroke-linejoin="round"/>`
      : "",
    // Material removed, tool radius included: what the stock has to contain.
    r.stats.cutExtents
      ? rect(r.stats.cutExtents, `fill="none" stroke="${C.envelope}" stroke-width="1" stroke-dasharray="6 3"`)
      : "",
    `<g stroke="${C.origin}" stroke-width="2" fill="none">`,
    `<path d="M${n(o.x - arm)} ${n(o.y)}h${n(arm * 2)}"/>`,
    `<path d="M${n(o.x)} ${n(o.y - down * arm * 0.5)}v${n(down * arm * 1.5)}"/>`,
    `<path d="M${n(o.x - 5)} ${n(o.y + down * arm)}l5 ${5 * down} 5 ${-5 * down}" stroke-linecap="round"/>`,
    `</g>`,
    `</svg>`,
  ].join("");
}
