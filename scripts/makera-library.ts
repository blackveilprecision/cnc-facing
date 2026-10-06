/**
 * Regenerates src/makera-bits.json from Makera's Fusion 360 tool library.
 *
 *   bun scripts/makera-library.ts [library dir]
 *
 * The directory defaults to where Fusion keeps a local "Makera" library on macOS.
 * Lasers and holders are skipped; every bit keeps the presets Makera ships.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = process.argv[2] ??
  join(homedir(), "Library/Application Support/Autodesk/CAM360/libraries/Local/Makera");
const OUT = join(import.meta.dir, "../src/makera-bits.json");

/** Fusion preset names to catalogue.ts's material columns. */
const COLUMNS: Record<string, string> = {
  Aluminum: "aluminum", Brass: "brass", "Carbon Fiber": "carbonFiber", Copper: "copper",
  Hardwood: "hardwood", PCB: "pcb", Plastic: "plastic", Softwood: "softwood",
};

interface FusionTool {
  type: string;
  description: string;
  "product-link"?: string;
  geometry: Record<string, number | boolean | undefined>;
  "start-values"?: { presets?: Record<string, unknown>[] };
}

function kind(t: FusionTool): string | null {
  switch (t.type) {
    case "flat end mill": return /corn/i.test(t.description) ? "corn" : "flat";
    case "ball end mill": return "ball";
    case "drill": return "drill";
    case "chamfer mill": return /chamfer/i.test(t.description) ? "chamfer" : "engraving";
    case "thread mill": return "thread";
    default: return null;
  }
}

const slug = (s: string) => s.toLowerCase().replace(/(^|\D)\.(\d)/g, "$10.$2").replace(/\*/g, "x")
  .replace(/[^a-z0-9.]+/g, "-").replace(/\.(?!\d)/g, "").replace(/^-|-$/g, "");
const num = (v: unknown, places = 3) => (typeof v === "number" ? Number(v.toFixed(places)) : undefined);

const bits = new Map<string, unknown>();
for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json")).sort()) {
  const tools = (JSON.parse(readFileSync(join(DIR, file), "utf8")).data ?? []) as FusionTool[];
  for (const t of tools) {
    const k = kind(t);
    if (!k) continue;
    const g = t.geometry;
    const vbit = k === "engraving" || k === "chamfer";
    const presets = Object.fromEntries((t["start-values"]?.presets ?? []).flatMap((p) => {
      const column = COLUMNS[p.name as string];
      if (!column) return [];
      return [[column, {
        rpm: Math.round(p.n as number),
        // Drills have no lateral feed or stepdown.
        feed: num(p.v_f, 0),
        plunge: num(p.v_f_plunge, 0),
        doc: num(p.stepdown),
      }]];
    }));
    const id = slug(t.description);
    // The library lists a few bits twice.
    if (bits.has(id)) continue;
    bits.set(id, {
      id,
      name: t.description.replace(/\s+/g, " ").trim(),
      kind: k,
      metal: ["flat", "ball", "engraving"].includes(k) ? /metal/i.test(t.description) : undefined,
      diameter: num(vbit ? g["tip-diameter"] : g.DC),
      shank: num(g.SFDM),
      flute: num(g.LCF),
      flutes: g.NOF,
      angle: vbit && typeof g.TA === "number" ? g.TA * 2 : undefined,
      url: t["product-link"] || undefined,
      presets,
    });
  }
}

writeFileSync(OUT, `[\n${[...bits.values()].map((b) => JSON.stringify(b)).join(",\n")}\n]\n`);
console.log(`${bits.size} bits -> ${OUT}`);
