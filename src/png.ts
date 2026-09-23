/**
 * A minimal indexed-colour PNG encoder, and the tiny raster canvas that feeds it.
 *
 * Why hand-rolled: `fix_gcode.py`'s `thumbnail()` shells out to ImageMagick, and
 * an absent `magick` binary there is a hard failure. This app has to produce a
 * thumbnail on every request, in a browser-facing server, so the encoder is
 * inline and has no dependencies beyond node:zlib. It only has to draw what a
 * facing preview contains: filled rectangles and straight lines.
 *
 * Palette PNG (colour type 3) rather than truecolour, for the same reason
 * fix_gcode.py passes `PNG8:` and `-colors 32`: these previews are line art on a
 * flat ground, so a truecolour encode costs roughly 15x the bytes for no visible
 * gain -- and those bytes go into the .nc file as base64, on a machine that
 * reads it off a USB stick.
 */

import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** An 8-bit indexed image. Colours are added on demand, up to 256. */
export class Canvas {
  readonly pixels: Uint8Array;
  private readonly palette: number[] = [];
  private readonly index = new Map<number, number>();

  constructor(
    readonly width: number,
    readonly height: number,
    background: string,
  ) {
    this.pixels = new Uint8Array(width * height);
    this.pixels.fill(this.color(background));
  }

  /** `#rrggbb` -> palette index, allocating on first use. */
  color(hex: string): number {
    const rgb = parseInt(hex.slice(1), 16);
    let i = this.index.get(rgb);
    if (i === undefined) {
      if (this.palette.length >= 256) throw new Error("palette full");
      i = this.palette.length;
      this.palette.push(rgb);
      this.index.set(rgb, i);
    }
    return i;
  }

  set(x: number, y: number, ci: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.pixels[y * this.width + x] = ci;
  }

  fillRect(x: number, y: number, w: number, h: number, hex: string): void {
    const ci = this.color(hex);
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) this.pixels.fill(ci, yy * this.width + x0, yy * this.width + x1);
  }

  /** Filled disc. The tool is round, so this is what one point of the path sweeps. */
  fillCircle(cx: number, cy: number, r: number, hex: string): void {
    const ci = this.color(hex);
    const r2 = r * r;
    const y0 = Math.max(0, Math.ceil(cy - r));
    const y1 = Math.min(this.height - 1, Math.floor(cy + r));
    for (let y = y0; y <= y1; y++) {
      const dx = Math.sqrt(Math.max(0, r2 - (y - cy) ** 2));
      const x0 = Math.max(0, Math.round(cx - dx));
      const x1 = Math.min(this.width, Math.round(cx + dx));
      if (x1 > x0) this.pixels.fill(ci, y * this.width + x0, y * this.width + x1);
    }
  }

  strokeRect(x: number, y: number, w: number, h: number, hex: string, t = 1): void {
    this.fillRect(x, y, w, t, hex);
    this.fillRect(x, y + h - t, w, t, hex);
    this.fillRect(x, y, t, h, hex);
    this.fillRect(x + w - t, y, t, h, hex);
  }

  /**
   * Bresenham with a square brush. Every segment a facing toolpath contains is
   * axis-aligned, but the general case costs a dozen lines and means a future
   * ramp or lead-in move still draws.
   */
  line(x0: number, y0: number, x1: number, y1: number, hex: string, t = 1): void {
    const ci = this.color(hex);
    let x = Math.round(x0);
    let y = Math.round(y0);
    const xe = Math.round(x1);
    const ye = Math.round(y1);
    const dx = Math.abs(xe - x);
    const dy = -Math.abs(ye - y);
    const sx = x < xe ? 1 : -1;
    const sy = y < ye ? 1 : -1;
    let err = dx + dy;
    const off = Math.floor((t - 1) / 2);
    for (;;) {
      for (let by = 0; by < t; by++) {
        for (let bx = 0; bx < t; bx++) this.set(x - off + bx, y - off + by, ci);
      }
      if (x === xe && y === ye) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  }

  encode(): Uint8Array {
    const ihdr = new Uint8Array(13);
    const v = new DataView(ihdr.buffer);
    v.setUint32(0, this.width);
    v.setUint32(4, this.height);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 3;   // colour type: indexed
    ihdr[10] = 0;  // compression: deflate
    ihdr[11] = 0;  // filter method: adaptive
    ihdr[12] = 0;  // interlace: none

    const plte = new Uint8Array(this.palette.length * 3);
    this.palette.forEach((rgb, i) => {
      plte[i * 3] = (rgb >> 16) & 0xff;
      plte[i * 3 + 1] = (rgb >> 8) & 0xff;
      plte[i * 3 + 2] = rgb & 0xff;
    });

    // Filter type 2 (Up) on every row. For a drawing that is mostly flat bands
    // this turns whole scanlines into runs of zeros; on row 0 the absent prior
    // row counts as zeros, which makes Up identical to None there.
    const stride = this.width;
    const raw = new Uint8Array((stride + 1) * this.height);
    for (let y = 0; y < this.height; y++) {
      const o = y * (stride + 1);
      raw[o] = 2;
      for (let x = 0; x < stride; x++) {
        const cur = this.pixels[y * stride + x]!;
        const up = y === 0 ? 0 : this.pixels[(y - 1) * stride + x]!;
        raw[o + 1 + x] = (cur - up) & 0xff;
      }
    }

    const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const parts = [
      sig,
      chunk("IHDR", ihdr),
      chunk("PLTE", plte),
      chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
      chunk("IEND", new Uint8Array(0)),
    ];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }
}
