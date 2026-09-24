/**
 * The `;@MKR|` block, in Makera Studio's field order. For seven machine trips
 * the order (TOOL before TIME) was believed to make the preview work; the
 * 2026-09-24 load tests showed it does not matter, and neither does the header
 * itself. The real cause was `M6 T<n>` (test/gcode.test.ts). Kept matching
 * Makera because it costs nothing; STOCK draws the box and TOOL names the bit.
 */

import { describe, expect, test } from "bun:test";
import { buildJob } from "../src/gcode.ts";
import { MKR_FIELD_ORDER, mkrTag } from "../src/mkr.ts";
import { MATERIAL_IDS } from "../src/materials.ts";

function build(over: Partial<Parameters<typeof buildJob>[0]> = {}) {
  const r = buildJob(
    { width: 80, height: 60, depth: 0.3, material: "mdf", stepover: 0.45, ...over },
    { thumbnail: false },
  );
  if (!r.ok) throw new Error(JSON.stringify(r.refusals));
  return r;
}

function headerTags(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const tag = mkrTag(l);
    if (!tag) continue;
    if (tag === "TOOLPATH_START") break; // body marker, not part of the block
    out.push(tag);
  }
  return out;
}

describe("the ;@MKR| header", () => {
  test("TOOL comes before TIME, as Makera Studio writes it", () => {
    const tags = headerTags(build().lines);
    expect(tags.indexOf("TOOL")).toBeGreaterThan(-1);
    expect(tags.indexOf("TIME")).toBeGreaterThan(tags.indexOf("TOOL"));
  });

  test("and TIME before the toolpath list", () => {
    const tags = headerTags(build().lines);
    expect(tags.indexOf("TOOLPATH")).toBeGreaterThan(tags.indexOf("TIME"));
  });

  test("the whole block is in the documented order", () => {
    expect(headerTags(build().lines)).toEqual([...MKR_FIELD_ORDER]);
  });

  test("it opens the file — nothing before BEGIN", () => {
    expect(build().lines[0]).toBe(";@MKR|BEGIN");
  });

  test("the body carries a TOOLPATH_START for its one toolpath", () => {
    const starts = build().lines.filter((l) => mkrTag(l) === "TOOLPATH_START");
    expect(starts).toEqual([";@MKR|TOOLPATH_START|toolpath_number=1"]);
  });

  test("STOCK is the faced area, so the job cannot fall outside its own preview", () => {
    const { lines, summary } = build({ width: 123.5, height: 40 });
    expect(lines).toContain(";@MKR|STOCK|id=cuboid|length=123.5|width=40|height=12|diameter=50");
    // fits_stock()'s check, applied to ourselves: swept X 0..L, Y -W..0.
    expect(summary.sweptArea.x).toEqual([0, 123.5]);
    expect(summary.sweptArea.y).toEqual([-40, 0]);
  });

  test("ORIGIN sits on the stock's BACK-left edge, because the job sweeps into -Y", () => {
    // y = +W/2, not -W/2. A front-left origin with a -Y job puts the preview
    // off the stock, the same failure a wrong stock box causes from the other side.
    expect(build().lines).toContain(
      ";@MKR|ORIGIN|id=0|type_name=topFrontLeft|x=-40|y=30|z=6",
    );
  });

  test("MAXFEEDRATE is declared, and every material stays under it", () => {
    expect(build().lines).toContain(";@MKR|MAXFEEDRATE|value=1200");
    for (const id of MATERIAL_IDS) {
      const s = build({ material: id, depth: 0.05 }).summary;
      expect(s.feed).toBeLessThanOrEqual(1200);
      expect(s.plunge).toBeLessThanOrEqual(1200);
    }
  });

  test("TIME is present and positive", () => {
    const time = build().lines.find((l) => mkrTag(l) === "TIME")!;
    expect(Number(time.split("=")[1])).toBeGreaterThan(0);
  });
});
