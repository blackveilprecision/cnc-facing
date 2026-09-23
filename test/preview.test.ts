/**
 * The two pictures. The thumbnail is checked by decoding it back rather than by
 * trusting that it encoded -- a PNG the controller cannot read would look
 * exactly like a working one from here, and that is precisely the class of
 * silent failure this project exists to avoid.
 */

import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { buildJob } from "../src/gcode.ts";
import { THUMB_H, THUMB_W, sceneToPng, thumbnailLines } from "../src/thumbnail.ts";
import { layout, project } from "../src/preview.ts";
import { Canvas } from "../src/png.ts";

function build(over: object = {}, thumbnail = false) {
  const r = buildJob(
    { width: 80, height: 60, depth: 0.3, material: "mdf", stepover: 0.45, ...over },
    { thumbnail },
  );
  if (!r.ok) throw new Error(JSON.stringify(r.refusals));
  return r;
}

/** Minimal PNG reader: enough to prove the encoder wrote a real one. */
function decode(png: Uint8Array) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  expect([...png.subarray(0, 8)]).toEqual(sig);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: Record<string, Uint8Array> = {};
  const order: string[] = [];
  let at = 8;
  while (at < png.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + len);
    // CRC covers the type and the data, and a wrong one is how a decoder bails.
    const crcAt = at + 8 + len;
    expect(crc32(png.subarray(at + 4, crcAt))).toBe(view.getUint32(crcAt));
    chunks[type] = data;
    order.push(type);
    at = crcAt + 4;
  }
  const ih = new DataView(chunks.IHDR!.buffer, chunks.IHDR!.byteOffset);
  const width = ih.getUint32(0);
  const height = ih.getUint32(4);
  const raw = new Uint8Array(inflateSync(chunks.IDAT!));
  expect(raw.length).toBe((width + 1) * height);

  // Undo the Up filter to get the index plane back.
  const px = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const o = y * (width + 1);
    expect(raw[o]).toBe(2);
    for (let x = 0; x < width; x++) {
      const up = y === 0 ? 0 : px[(y - 1) * width + x]!;
      px[y * width + x] = (raw[o + 1 + x]! + up) & 0xff;
    }
  }
  const palette = chunks.PLTE!;
  const rgb = (i: number) =>
    "#" + [0, 1, 2].map((k) => palette[i * 3 + k]!.toString(16).padStart(2, "0")).join("");
  return { width, height, order, px, rgb, at: (x: number, y: number) => rgb(px[y * width + x]!) };
}

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

describe("the PNG encoder", () => {
  test("writes a decodable 800x600 palette PNG with the chunks in order", () => {
    const img = decode(sceneToPng(build().scene));
    expect([img.width, img.height]).toEqual([THUMB_W, THUMB_H]);
    expect(img.order).toEqual(["IHDR", "PLTE", "IDAT", "IEND"]);
  });

  test("draws what it was asked to", () => {
    const c = new Canvas(10, 10, "#ffffff");
    c.fillRect(2, 2, 3, 3, "#ff0000");
    c.line(0, 9, 9, 9, "#0000ff", 1);
    const img = decode(c.encode());
    expect(img.at(0, 0)).toBe("#ffffff");
    expect(img.at(3, 3)).toBe("#ff0000");
    expect(img.at(5, 3)).toBe("#ffffff"); // fillRect is half-open, as it should be
    expect(img.at(4, 9)).toBe("#0000ff");
  });
});

describe("the thumbnail", () => {
  test("shows the swept area, the outline and the origin", () => {
    const img = decode(sceneToPng(build().scene));
    const seen = new Set(Array.from(img.px, (i) => img.rgb(i)));
    for (const c of ["#ffffff", "#e6d3b3", "#6b4b22", "#3a3a3a", "#c0392b"]) {
      expect(seen).toContain(c);
    }
  });

  test("the swept area covers the stock everywhere except the corners the tool cannot reach", () => {
    // The strongest check in here, and the reason the stock is painted first in
    // its own colour: every pixel of it that gets overdrawn IS the r..W-r
    // convention holding. If the bands stop short of an edge, or the stepover
    // leaves a ridge, the stock colour reappears somewhere in the middle.
    //
    // The four corners are the exception, and a real one: a round cutter whose
    // centre stops at (r, r) cannot reach the corner at (0, 0), so a faced
    // rectangle has corner fillets of radius r. Those are drawn rather than
    // painted over, so the tolerance here is "within a tool radius of a corner"
    // and nothing else.
    for (const over of [
      {}, { height: 61.37 }, { width: 3.175, height: 3.175 }, { material: "brass", depth: 0.1 },
      { pattern: "serpentine-y" }, { pattern: "oneway-y" }, { pattern: "spiral" },
      { pattern: "spiral", width: 37.3, height: 12.9 },
    ]) {
      const { scene } = build(over);
      const img = decode(sceneToPng(scene));
      const l = layout(scene, THUMB_W, THUMB_H, Math.min(THUMB_W, THUMB_H) * 0.08);
      const r = (scene.toolDiameter / 2) * l.scale + 1.5;
      const corners = [
        { x: 0, y: 0 },
        { x: scene.stock.length, y: 0 },
        { x: 0, y: -scene.stock.width },
        { x: scene.stock.length, y: -scene.stock.width },
      ].map((c) => project(c, l));

      let stray = 0;
      for (let i = 0; i < img.px.length; i++) {
        if (img.rgb(img.px[i]!) !== scene.palette.stock) continue;
        const x = i % img.width;
        const y = Math.floor(i / img.width);
        if (!corners.some((c) => Math.hypot(x - c.x, y - c.y) <= r)) stray++;
      }
      expect(stray).toBe(0);
    }
  });

  test("and those corner fillets are actually drawn, not an artefact", () => {
    // If the renderer went back to square caps this would silently become 0 and
    // the preview would promise a sharp corner the machine cannot cut.
    const { scene } = build();
    const img = decode(sceneToPng(scene));
    const showing = Array.from(img.px).filter((i) => img.rgb(i) === scene.palette.stock).length;
    expect(showing).toBeGreaterThan(8);
    expect(showing).toBeLessThan(200);
  });

  test("and the stock colour DOES show when the job does not cover it", () => {
    // The negative control: without it, the check above would also pass if the
    // stock were simply never painted.
    const { scene } = build();
    const short = { ...scene, stock: { ...scene.stock, length: scene.stock.length * 2 } };
    const img = decode(sceneToPng(short));
    expect(Array.from(img.px).filter((i) => img.rgb(i) === scene.palette.stock).length)
      .toBeGreaterThan(1000);
  });

  test("a 3-line trailer: begin marker, one base64 line, end marker", () => {
    const lines = thumbnailLines(sceneToPng(build().scene));
    expect(lines.length).toBe(3);
    expect(lines[0]).toBe(";(thumbnail_image_begin)");
    expect(lines[2]).toBe(";(thumbnail_image_end)");
    expect(lines[1]!.startsWith(";")).toBe(true);
    expect(lines[1]!.slice(1)).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  test("the trailer round-trips back to the same PNG", () => {
    const png = sceneToPng(build().scene);
    const b64 = thumbnailLines(png)[1]!.slice(1);
    expect(Array.from(Buffer.from(b64, "base64"))).toEqual(Array.from(png));
  });

  test("it is appended to the file, after M02", () => {
    const lines = build({}, true).lines;
    expect(lines.indexOf(";(thumbnail_image_begin)")).toBeGreaterThan(lines.indexOf("M02"));
    expect(lines.at(-1)).toBe(";(thumbnail_image_end)");
  });

  test("and stays a sensible size for a file that goes on a USB stick", () => {
    for (const over of [{}, { width: 200, height: 200, depth: 1 }]) {
      expect(sceneToPng(build(over).scene).length).toBeLessThan(120_000);
    }
  });

  test("each material gets its own tint, so the job list tells them apart", () => {
    const tints = (["mdf", "aluminium", "brass"] as const).map((material) => {
      const img = decode(sceneToPng(build({ material, depth: 0.1 }).scene));
      return img.at(THUMB_W / 2, THUMB_H / 2);
    });
    expect(new Set(tints).size).toBe(3);
  });
});

describe("the browser preview", () => {
  test("is an SVG covering the same geometry as the thumbnail", () => {
    const { svg, scene } = build();
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    const lines = [...svg.matchAll(/<polyline points="([^"]+)"/g)].map((m) => m[1]!.trim().split(" "));
    expect(lines.map((pts) => pts.length)).toEqual(scene.strokes.map((s) => s.length));
  });

  test("draws the lifted moves dashed, and only when there are some", () => {
    expect(build({ pattern: "oneway-y" }).svg).toContain("stroke-dasharray");
    expect(build({ pattern: "spiral" }).svg).not.toContain("stroke-dasharray");
    expect(build().svg).not.toContain("stroke-dasharray");
  });

  test("no coordinate escapes the canvas", () => {
    const { svg } = build({ width: 200, height: 20 });
    for (const [, x, y] of svg.matchAll(/(\d+\.\d\d),(\d+\.\d\d)/g)) {
      expect(Number(x)).toBeGreaterThanOrEqual(0);
      expect(Number(x)).toBeLessThanOrEqual(640);
      expect(Number(y)).toBeGreaterThanOrEqual(0);
      expect(Number(y)).toBeLessThanOrEqual(480);
    }
  });

  test("it carries a text description, since it is the only picture on the page", () => {
    expect(build().svg).toContain('aria-label="Toolpath preview: 80×60mm');
  });
});
