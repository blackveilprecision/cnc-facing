/**
 * The checker. An arbitrary .nc in, a report on whether the Z1 will run it as
 * intended out. Pure: text in, findings and geometry out.
 *
 * Everything the generator side of this app gets right by construction, a file
 * from somewhere else (Makera Studio, EasyTrace5000, FlatCAM, a hand edit) can
 * get wrong -- and most of the ways it can go wrong on this machine are silent.
 * So every rule here is one that cost a machine trip, cited to where it was
 * learned, and the report keeps four levels apart rather than blurring them:
 *
 *   fail     the controller aborts, or the machine damages the bit or the work,
 *            or it breaks a limit this project enforces on its own files.
 *   silent   it runs, but something quietly does not happen: no preview, a
 *            boundary trace that only goes to the work origin, no extraction.
 *   warn     differs from what is known to work, or looks like a known mistake.
 *   note     worth knowing; includes the things that are genuinely UNKNOWN.
 *
 * What is NOT asserted matters as much. MILLING.md and EASYTRACE-Z1.md are
 * explicit about what was tested and turned out harmless (CRLF, the header's
 * field order, most of the header itself: the 2026-09-24 load tests), and what
 * was never tested at all (literal canned cycles, embedded G32). Those come out
 * as warn or note, never fail, because refusing a file on a guess is how a
 * checker stops being believed.
 *
 * Coordinates are tool CENTRES in work coordinates, Z0 on the stock top, which
 * is how every file this machine has run is written.
 */

import {
  CAT_MATERIAL_LABELS, DEVIATIONS, detectMaterial, isMetal, matchBit,
  type CatMaterial, type Row,
} from "./catalogue.ts";
import { MAX_FEEDRATE } from "./materials.ts";
import { simulate, type Cutter, type Segment } from "./stock.ts";
import { MKR_FIELD_ORDER } from "./mkr.ts";
import { ENVELOPE_X, ENVELOPE_Y } from "./validate.ts";

export type Level = "fail" | "silent" | "warn" | "note";

export const LEVELS: readonly Level[] = ["fail", "silent", "warn", "note"];

export interface Finding {
  readonly level: Level;
  /** Stable id, one per rule; the tests key off it. */
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  /** Where it was learned. Shown so a finding can be checked, not just trusted. */
  readonly source?: string;
  /** 1-based line numbers of the first few occurrences. */
  readonly lines: number[];
  /** How many times it occurred in all. */
  readonly count: number;
  /** The first offending line, as written. */
  readonly sample?: string;
}

export interface Pt3 { readonly x: number; readonly y: number; readonly z: number }

export interface Box { x0: number; x1: number; y0: number; y1: number }

export interface ToolDecl {
  readonly number: number;
  readonly name: string;
  readonly diameter?: number;
  readonly tipDiameter?: number;
  readonly fluteLength?: number;
}

export interface Stats {
  readonly lines: number;
  readonly bytes: number;
  readonly motionLines: number;
  readonly lineEndings: "crlf" | "lf" | "mixed" | "none";
  /** Tool numbers in the order the file changes to them. */
  readonly toolChanges: number[];
  readonly rpms: number[];
  readonly maxFeed: number | null;
  /** Tool centres, every move. */
  readonly extents: Box | null;
  /** Material actually removed: cutting moves grown by the tool radius. */
  readonly cutExtents: Box | null;
  readonly zMin: number | null;
  readonly zMax: number | null;
  readonly seconds: number;
  readonly header: {
    readonly present: boolean;
    readonly stock?: { length: number; width: number; height: number };
    readonly origin?: { typeName: string; x: number; y: number; z: number };
    readonly cam?: string;
    readonly tools: ToolDecl[];
    readonly toolpaths: number;
    readonly time?: number;
  };
  readonly thumbnail: { readonly present: boolean; readonly width?: number; readonly height?: number };
  /** Which way the job runs in Y, read from the coordinates. */
  readonly yDirection: "negative" | "positive" | "none";
}

/** One continuous run of XY motion, split wherever the tool goes up or down. */
export interface Stroke {
  readonly cut: boolean;
  readonly points: { x: number; y: number }[];
}

/** One tool as the file uses it, set against Makera's row for it. */
export interface BitUsage {
  readonly tool: number;
  /** As the header names it. */
  readonly name: string;
  /** The official bit it was identified as, by Makera's name. */
  readonly bit?: string;
  /** Why it was not identified. */
  readonly unmatched?: string;
  readonly used: {
    readonly rpm: number[];
    /** Fastest lateral cutting feed, mm/min. */
    readonly feed: number | null;
    /** Fastest plunge into the stock, mm/min. */
    readonly plunge: number | null;
    /** Largest step between successive cutting depths, mm. An estimate. */
    readonly doc: number | null;
    readonly zMin: number | null;
  };
  /** Makera's row for this bit and material; null if Makera publishes none. */
  readonly published?: Row | null;
  /** Per field: over Makera's figure, or over it by a recorded choice. */
  readonly over: Partial<Record<keyof Row, "over" | "deviation">>;
}

export interface CheckOptions {
  /** Which material column to check against. Omitted: read from the header. */
  readonly material?: CatMaterial;
}

export interface CheckReport {
  readonly filename: string;
  /** The material column the bits were checked against, and where it came from. */
  readonly material: { readonly id: CatMaterial | null; readonly from: "chosen" | "header" | null; readonly label?: string };
  readonly bits: BitUsage[];
  readonly verdict: Level | "ok";
  readonly findings: Finding[];
  readonly stats: Stats;
  readonly strokes: Stroke[];
  /** The box the reach walk should trace: declared stock if any, else what is cut. */
  readonly reachBox: Box | null;
}

/** Rapids charged at this in the time estimate, as facing.ts and fix_gcode.py do. */
const RAPID_FEED = 1000;

/**
 * The Z1's spindle, per Makera's published figures: 0-13,000 rpm (README, "Fly
 * cutters"). What the controller does with an S above it is not recorded.
 */
const SPINDLE_MAX = 13000;

/**
 * Below this an S word is more likely a dropped zero than a choice. S1200 for
 * 12000 turned up four times in EasyTrace forms (MILLING.md); at 1200 rpm and
 * F500 the 2mm corn bit snaps. The lowest speed used on purpose here is 6000.
 */
const RPM_TYPO_BELOW = 5000;

/** Z travel, Makera's published 200 x 200 x 100 (validate.ts has the XY half). */
const ENVELOPE_Z = 100;

/** Occurrences kept per finding; the count carries the rest. */
const KEEP_LINES = 5;

/** mm. Below this two floats are the same coordinate. */
const EPS = 1e-6;

/** mm. How far a cut may overhang the declared stock before it is reported. */
const STOCK_SLACK = 0.05;

interface Word { readonly letter: string; readonly value: number; readonly text: string }

interface Parsed {
  /** The code with comments removed, trimmed. */
  readonly code: string;
  readonly words: Word[];
  /** A word that did not parse, e.g. `X1.2.3` or a stray letter. */
  readonly junk: string | null;
}

/**
 * Strip `;` (rest of line) and `( ... )` comments, then split into words.
 * Letters are case-folded; spaces between a letter and its number are allowed,
 * because the controller's parser (Smoothieware) allows them.
 */
export function parseLine(raw: string): Parsed {
  let code = "";
  let depth = 0;
  for (const ch of raw) {
    if (depth === 0 && ch === ";") break;
    if (ch === "(") { depth++; continue; }
    if (ch === ")" && depth > 0) { depth--; continue; }
    if (depth === 0) code += ch;
  }
  code = code.trim();
  const words: Word[] = [];
  let junk: string | null = null;
  const re = /([A-Za-z])\s*([+-]?(?:\d+\.?\d*|\.\d+))|(\S)/g;
  for (const m of code.matchAll(re)) {
    if (m[3] !== undefined) {
      if (m[3] !== "%") junk ??= m[3];
      continue;
    }
    words.push({ letter: m[1]!.toUpperCase(), value: Number(m[2]), text: `${m[1]!.toUpperCase()}${m[2]}` });
  }
  return { code, words, junk };
}

/** The `;@MKR|TAG|k=v|...` lines, parsed. */
interface MkrLine { readonly line: number; readonly tag: string; readonly fields: Record<string, string> }

function parseMkr(raw: string, line: number): MkrLine | null {
  if (!raw.startsWith(";@MKR|")) return null;
  const [tag = "", ...rest] = raw.slice(6).split("|");
  const fields: Record<string, string> = {};
  for (const kv of rest) {
    const i = kv.indexOf("=");
    if (i > 0) fields[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return { line, tag, fields };
}

/** Collects findings, one per code, keeping the first few line numbers. */
class Findings {
  private readonly byCode = new Map<string, { f: Omit<Finding, "lines" | "count" | "sample">; lines: number[]; count: number; sample?: string }>();

  add(f: Omit<Finding, "lines" | "count" | "sample">, line?: number, sample?: string): void {
    let e = this.byCode.get(f.code);
    if (!e) {
      e = { f, lines: [], count: 0, sample };
      this.byCode.set(f.code, e);
    }
    e.count++;
    if (line !== undefined && e.lines.length < KEEP_LINES) e.lines.push(line);
  }

  has(code: string): boolean { return this.byCode.has(code); }

  list(): Finding[] {
    const rank = (l: Level) => LEVELS.indexOf(l);
    return [...this.byCode.values()]
      .map((e) => ({ ...e.f, lines: e.lines, count: e.count, sample: e.sample }))
      .sort((a, b) => rank(a.level) - rank(b.level));
  }
}

const grow = (b: Box | null, x: number, y: number, r = 0): Box =>
  b
    ? { x0: Math.min(b.x0, x - r), x1: Math.max(b.x1, x + r), y0: Math.min(b.y0, y - r), y1: Math.max(b.y1, y + r) }
    : { x0: x - r, x1: x + r, y0: y - r, y1: y + r };

const fmt = (v: number) => Number(v.toFixed(3)).toString();

/**
 * Points along an arc, for extents and the preview. Chord error is kept under
 * about 0.01mm, which is well below a pixel at any size this is drawn.
 */
function arcPoints(from: Pt3, to: Pt3, i: number, j: number, cw: boolean): Pt3[] {
  const cx = from.x + i;
  const cy = from.y + j;
  const r = Math.hypot(i, j);
  const a0 = Math.atan2(from.y - cy, from.x - cx);
  const a1 = Math.atan2(to.y - cy, to.x - cx);
  let sweep = cw ? a0 - a1 : a1 - a0;
  // A full circle -- end equal to start -- is one the Z1 is known to handle
  // (MILLING.md, verified on copper 2026-09-21), so it is a full turn, not zero.
  if (sweep <= EPS) sweep += 2 * Math.PI;
  const step = r > 0.01 ? 2 * Math.acos(Math.max(-1, 1 - 0.01 / r)) : Math.PI / 4;
  const n = Math.max(2, Math.min(720, Math.ceil(sweep / step)));
  const out: Pt3[] = [];
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const a = a0 + (cw ? -1 : 1) * sweep * t;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), z: from.z + (to.z - from.z) * t });
  }
  out[out.length - 1] = to;
  return out;
}

/** The M codes this controller is known to accept, with what they do here. */
const KNOWN_M = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 30, 331, 332, 370, 801, 802, 811, 812, 821, 822, 851, 852]);

/** G codes whose handling on this machine is recorded (MILLING.md, supported-codes). */
const KNOWN_G = new Set([0, 1, 2, 3, 4, 17, 21, 28, 90, 94]);

export function checkGcode(text: string, filename = "upload.nc", opts: CheckOptions = {}): CheckReport {
  const out = new Findings();

  // ---------------------------------------------------------------- the bytes
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  const lineEndings: Stats["lineEndings"] = lf === 0 ? "none" : crlf === lf ? "crlf" : crlf === 0 ? "lf" : "mixed";
  const rawLines = text.split(/\r?\n/);
  if (rawLines.at(-1) === "") rawLines.pop();

  if (!/\.nc$/i.test(filename)) {
    out.add({
      level: "note", code: "extension",
      title: `The file is called .${filename.split(".").pop() ?? ""}, not .nc`,
      detail: "A .cnc file loads, previews and traces like a .nc one (load test 20, 2026-09-24), but Windows Explorer shows no thumbnail for it. EasyTrace5000 writes .cnc. Other extensions have not been tried.",
      source: "EASYTRACE-Z1.md",
    });
  }
  if (lineEndings === "lf" || lineEndings === "mixed") {
    // A NOTE, deliberately. CRLF was long blamed for the blank preview, but an
    // LF file previews and traces normally (load test 08, 2026-09-24). The cause
    // was the tool change written M6 T<n>. Makera writes CRLF and matching it
    // costs nothing; that is all.
    out.add({
      level: "note", code: "line-endings",
      title: lineEndings === "lf" ? "LF line endings, not CRLF" : "Mixed CRLF and LF line endings",
      detail: "Makera Studio writes CRLF, and this app's own files match it. An LF file previews and traces normally (load test 08), so this is only a difference from Makera's output.",
      source: "EASYTRACE-Z1.md, load tests 2026-09-24",
    });
  }
  // The thumbnail is base64, so this is about comments and typing, not bulk.
  const nonAscii = rawLines.findIndex((l) => /[^\x00-\x7f]/.test(l));
  if (nonAscii >= 0) {
    out.add({
      level: "warn", code: "non-ascii",
      title: "Non-ASCII characters",
      detail: "The controller is a byte parser reading off a USB stick. Nothing has failed from this yet, but there is nothing to gain from it: an em-dash typed into a comment is the usual culprit.",
      source: "PLAN.md, 'Found while building'",
    }, nonAscii + 1, rawLines[nonAscii]!.slice(0, 120));
  }

  // --------------------------------------------------------------- the header
  const mkr: MkrLine[] = [];
  let toolpathStarts = 0;
  let thumbBegin = -1;
  let thumbEnd = -1;
  rawLines.forEach((l, i) => {
    const m = parseMkr(l, i + 1);
    if (m) {
      if (m.tag === "TOOLPATH_START") toolpathStarts++;
      else mkr.push(m);
    }
    if (l.trim() === ";(thumbnail_image_begin)") thumbBegin = i;
    if (l.trim() === ";(thumbnail_image_end)") thumbEnd = i;
  });

  const tag = (t: string) => mkr.find((m) => m.tag === t);
  const num = (v: string | undefined) => (v === undefined || v === "" ? Number.NaN : Number(v));
  const tools: ToolDecl[] = mkr.filter((m) => m.tag === "TOOL").map((m) => ({
    number: num(m.fields.number),
    name: m.fields.name ?? "",
    diameter: Number.isFinite(num(m.fields.diameter)) ? num(m.fields.diameter) : undefined,
    tipDiameter: Number.isFinite(num(m.fields.tipdiameter)) ? num(m.fields.tipdiameter) : undefined,
    fluteLength: Number.isFinite(num(m.fields.flutelength)) ? num(m.fields.flutelength) : undefined,
  }));
  const stockTag = tag("STOCK");
  const stock = stockTag && ["length", "width", "height"].every((k) => Number.isFinite(num(stockTag.fields[k])))
    ? { length: num(stockTag.fields.length), width: num(stockTag.fields.width), height: num(stockTag.fields.height) }
    : undefined;
  const originTag = tag("ORIGIN");
  const origin = originTag
    ? { typeName: originTag.fields.type_name ?? "", x: num(originTag.fields.x), y: num(originTag.fields.y), z: num(originTag.fields.z) }
    : undefined;
  const maxFeedTag = tag("MAXFEEDRATE");
  const feedCeiling = maxFeedTag && Number.isFinite(num(maxFeedTag.fields.value)) ? num(maxFeedTag.fields.value) : MAX_FEEDRATE;

  if (!mkr.length) {
    out.add({
      level: "warn", code: "mkr-missing",
      title: "No ;@MKR| header",
      detail: "The preview and the laser boundary trace work without one (load tests 18 and 23, 2026-09-24). What is lost: no stock box in the Machining Wizard, and no tool names. Makera Studio shows each tool's name at the tool change, next to the LED count, and that text comes from the header's TOOL lines.",
      source: "EASYTRACE-Z1.md, load tests 2026-09-24; src/mkr.ts",
    });
  } else {
    // Makera Studio's field order, reported as a NOTE. TIME before TOOL was
    // believed for seven machine trips to blank the preview, but a header in
    // exactly that order previews and traces normally (load test 21,
    // 2026-09-24). The real cause was the tool change written M6 T<n>.
    const order = MKR_FIELD_ORDER as readonly string[];
    let highest = -1;
    let highestTag = "";
    for (const m of mkr) {
      const at = order.indexOf(m.tag);
      if (at < 0) {
        out.add({
          level: "note", code: "mkr-unknown-tag",
          title: `Unfamiliar ;@MKR| field ${m.tag}`,
          detail: "Not one Makera Studio writes in any file seen here. Probably harmless; the controller's parser is not published.",
        }, m.line, rawLines[m.line - 1]);
        continue;
      }
      if (at < highest) {
        const timeFirst = m.tag === "TOOL" && highestTag === "TIME";
        out.add({
          level: "note", code: timeFirst ? "mkr-time-before-tool" : "mkr-order",
          title: timeFirst ? "TIME comes before TOOL in the header" : `;@MKR|${m.tag} is out of order (after ${highestTag})`,
          detail: timeFirst
            ? "Long blamed for the blank preview, but a header in exactly this order previews and traces normally (load test 21). Only a difference from Makera Studio's order."
            : `Makera Studio writes ${order.join(" ")}. The order has not been seen to matter (load test 21), so this is only a difference.`,
          source: "EASYTRACE-Z1.md, load tests 2026-09-24; src/mkr.ts",
        }, m.line, rawLines[m.line - 1]);
      }
      if (at > highest) { highest = at; highestTag = m.tag; }
    }
    if (mkr[0]!.line !== 1 || mkr[0]!.tag !== "BEGIN") {
      out.add({
        level: "note", code: "mkr-not-first",
        title: "The header does not start the file with ;@MKR|BEGIN",
        detail: "Every Makera Studio file opens with ;@MKR|BEGIN on line 1. Where the header sits has not been seen to matter; a file with no header at all previews (load test 18).",
        source: "EASYTRACE-Z1.md",
      }, mkr[0]!.line, rawLines[mkr[0]!.line - 1]);
    }
    // Tested one at a time on 2026-09-24 (load tests 09-15, 17): leaving any of
    // these out changes nothing but the stock box, which only STOCK draws.
    const MISSING: Record<string, string> = {
      STOCK: "No stock box in the Machining Wizard; the preview and the laser trace are unaffected (load test 14). The box is always drawn at Anchor1, the bottom-left L-bracket, not at the work origin.",
      ORIGIN: "No visible effect (load test 15): the toolpath is drawn at the probed work origin, and the stock box at Anchor1, whatever ORIGIN says.",
      TIME: "No visible effect on the preview or the trace (load test 12).",
    };
    for (const t of ["BEGIN", "SCHEMA", "MACHINE", "STOCK", "ORIGIN", "UNIT", "TIME", "END"]) {
      if (!tag(t)) {
        out.add({
          level: "note", code: `mkr-no-${t.toLowerCase()}`,
          title: `The header has no ${t} line`,
          detail: MISSING[t] ?? `Makera Studio always writes ;@MKR|${t}. A minimal header without MATERIAL, CAM, MAXFEEDRATE, TIME or the TOOLPATH list previews and traces normally (load test 17); ${t} itself has not been left out on its own.`,
          source: "EASYTRACE-Z1.md, load tests 2026-09-24",
        });
      }
    }
    const machine = tag("MACHINE");
    if (machine && machine.fields.id !== "Z1") {
      out.add({
        level: "warn", code: "mkr-machine",
        title: `Header says MACHINE id=${machine.fields.id ?? ""}, not Z1`,
        detail: "This file was set up for a different machine. The Carvera and the Z1 differ in travel and accessories.",
      }, machine.line, rawLines[machine.line - 1]);
    }
    const unit = tag("UNIT");
    if (unit && unit.fields.value !== "mm") {
      out.add({
        level: "warn", code: "mkr-unit",
        title: `Header declares UNIT ${unit.fields.value ?? ""}`,
        detail: "Every file run here is in mm. Inch files have never been tried on this machine.",
      }, unit.line, rawLines[unit.line - 1]);
    }
    if (origin && origin.typeName !== "topFrontLeft") {
      out.add({
        level: "note", code: "origin-type",
        title: `ORIGIN type_name=${origin.typeName}`,
        detail: "topFrontLeft is the only type_name ever seen. ORIGIN has no visible effect on the preview or the trace (load tests 15 and 16), so another value is very likely harmless; it has not been tried.",
        source: "MILLING.md; src/mkr.ts",
      }, originTag!.line, rawLines[originTag!.line - 1]);
    }
    if (tools.length === 0) {
      out.add({
        level: "warn", code: "mkr-no-tools",
        title: "The header declares no tools",
        detail: "Makera Studio shows each tool's name at the tool change, next to the LED count, and the name comes from these TOOL lines. Without them the operator gets only the number, and this checker cannot check depth against flute length.",
      });
    }
    const toolpathsDeclared = mkr.filter((m) => m.tag === "TOOLPATH").length;
    if (toolpathStarts === 0) {
      out.add({
        level: "note", code: "no-toolpath-start",
        title: "No ;@MKR|TOOLPATH_START markers in the body",
        detail: "Makera Studio puts one before each operation, pairing with the header's TOOLPATH list. A file without them previews and traces normally (load test 07), and Makera Studio shows no job list, so this is only a difference.",
        source: "EASYTRACE-Z1.md, load tests 2026-09-24",
      });
    } else if (toolpathsDeclared !== toolpathStarts) {
      out.add({
        level: "note", code: "toolpath-count",
        title: `Header lists ${toolpathsDeclared} toolpaths, body starts ${toolpathStarts}`,
        detail: "In a Makera Studio file these always match one for one. Neither has a visible effect on the Z1 (load tests 07 and 13).",
      });
    }
  }

  // ------------------------------------------------------------- the thumbnail
  let thumbnail: Stats["thumbnail"] = { present: false };
  if (thumbBegin < 0 || thumbEnd < 0) {
    out.add({
      level: "note", code: "no-thumbnail",
      title: "No thumbnail",
      detail: "Cosmetic: the job list shows a blank tile beside the filename. The preview and the laser trace do not depend on it (load tests 19 and 23).",
      source: "README.md, 'Preview and thumbnail'",
    });
  } else if (thumbEnd !== thumbBegin + 2 || !rawLines[thumbBegin + 1]?.startsWith(";")) {
    out.add({
      level: "warn", code: "thumbnail-shape",
      title: "The thumbnail is not one base64 line between its markers",
      detail: "Makera's trailer is exactly three lines: begin marker, ';' plus one line of base64 PNG, end marker.",
      source: "src/thumbnail.ts",
    }, thumbBegin + 1);
  } else {
    const b64 = rawLines[thumbBegin + 1]!.slice(1).trim();
    const png = Buffer.from(b64, "base64");
    const sig = png.subarray(0, 8).toString("hex");
    if (sig !== "89504e470d0a1a0a" || png.length < 24) {
      out.add({
        level: "warn", code: "thumbnail-not-png",
        title: "The thumbnail does not decode to a PNG",
        detail: "fix_gcode.py once came close to base64'ing raw SVG markup into this line: a tile the controller cannot decode, with no error to say so.",
        source: "kicad/fix_gcode.py, thumbnail()",
      }, thumbBegin + 2);
    } else {
      thumbnail = { present: true, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
    }
  }

  // --------------------------------------------------------------- the motion
  const declared = new Map(tools.map((t) => [t.number, t]));
  let absolute = true;
  let mm = true;
  let sawG90 = false;
  let sawG21 = false;
  let motion: number | null = null;
  let pos: { x?: number; y?: number; z?: number } = {};
  let feed: number | null = null;
  let spindle = false;
  let rpm: number | null = null;
  let tool: number | null = null;
  let changedSinceSpindle = true;
  let lastStartRpm: number | null = null;
  let firstMotion = -1;
  let motionLines = 0;
  let seconds = 0;
  let extents: Box | null = null;
  let cutExtents: Box | null = null;
  let zMin: number | null = null;
  let zMax: number | null = null;
  let maxFeed: number | null = null;
  const toolChanges: number[] = [];
  const rpms: number[] = [];
  const moves: (Segment & { line: number; rapid: boolean; lateral: boolean; feed: number | null; down: boolean })[] = [];
  const strokes: Stroke[] = [];
  let stroke: Stroke | null = null;
  let endCode: { code: "M2" | "M30"; line: number } | null = null;
  let vacuum: "auto" | "direct" | null = null;
  let airOnly = false;
  const styleDiffs = new Set<string>();

  // The CUTTING radius. A V-bit is declared with its 3.175 shank as `diameter`
  // and its 0.3mm point as `tipdiameter`; at PCB depths the point is what cuts.
  /** Per tool number (0 = no tool change seen), what the file makes it do. */
  interface Use {
    rpm: Set<number>;
    feed: number | null; feedLine?: number;
    plunge: number | null; plungeLine?: number;
    /** Deepest material removed by a lateral move, and by a plunge. */
    doc: number | null; docLine?: number;
    peck: number | null; peckLine?: number;
    zMin: number | null; zMinLine?: number;
    cuts: boolean;
  }
  const uses = new Map<number, Use>();
  // A file with no M6 but one declared tool is plainly using that tool.
  const current = () => tool ?? (tools.length === 1 ? tools[0]!.number : 0);
  const use = () => {
    const k = current();
    let u = uses.get(k);
    if (!u) {
      u = { rpm: new Set(), feed: null, plunge: null, doc: null, peck: null, zMin: null, cuts: false };
      uses.set(k, u);
    }
    return u;
  };

  const radius = () => {
    const d = tool !== null ? declared.get(tool) : undefined;
    return (d?.tipDiameter ?? d?.diameter ?? 0) / 2;
  };

  for (let idx = 0; idx < rawLines.length; idx++) {
    const raw = rawLines[idx]!;
    const n = idx + 1;
    if (raw.startsWith(";")) continue;
    const p = parseLine(raw);
    if (!p.code) continue;
    const sample = raw.trim().slice(0, 120);
    if (p.junk) {
      out.add({
        level: "warn", code: "unparsed",
        title: "Characters that are not G-code words",
        detail: `This checker could not read '${p.junk}'. The controller may not either.`,
      }, n, sample);
    }

    const ws = p.words;
    const gs = ws.filter((w) => w.letter === "G").map((w) => w.value);
    const ms = ws.filter((w) => w.letter === "M").map((w) => w.value);
    const t = ws.find((w) => w.letter === "T");
    const s = ws.find((w) => w.letter === "S");
    const f = ws.find((w) => w.letter === "F");

    // A line that opens with a coordinate inherits the last G0-G3. Legal G-code,
    // and it cuts correctly. A NOTE: bare lines were blamed for the blank
    // preview, but the files it was observed on also wrote their tool changes
    // M6 T<n>, which was the real cause. Settled 2026-09-24: a modal file
    // previewed and boundary-traced normally on the Z1.
    if (/^[XYZIJ]/i.test(p.code)) {
      out.add({
        level: "note", code: "modal-motion",
        title: "Motion lines without a G word",
        detail: "Bare coordinate lines inherit the last G0/G1/G2/G3. Fine on the Z1: a modal file previewed and boundary-traced like an explicit one (2026-09-24). They were once blamed for the blank preview, but those files also wrote M6 T<n>, which was the real cause. Makera Studio writes a G word on every line; nothing requires it.",
        source: "EASYTRACE-Z1.md, 'Modal motion is fine'; cnc-facing README, 'Modal motion'",
      }, n, sample);
    }

    // ---- units and distance mode, before any motion on the same line
    for (const g of gs) {
      if (g === 90) { absolute = true; sawG90 = true; }
      else if (g === 91) {
        absolute = false;
        out.add({
          level: "warn", code: "relative",
          title: "Relative distance mode (G91)",
          detail: "Allowed, and tracked here, but no file run on this machine uses it. G91 is modal: a later move meant as absolute goes somewhere else unless G90 comes back first.",
          source: "src/reach.ts",
        }, n, sample);
      } else if (g === 21) { mm = true; sawG21 = true; }
      else if (g === 20) {
        mm = false;
        out.add({
          level: "warn", code: "inch",
          title: "Inch units (G20)",
          detail: "Every file this machine has run is in mm. Inches are converted here for the checks; on the machine they are untried.",
        }, n, sample);
      } else if (g === 17 || g === 94) {
        styleDiffs.add("G17/G94 in the preamble (Makera Studio omits them)");
      } else if (g === 32) {
        out.add({
          level: "warn", code: "g32",
          title: "Levelling probe (G32) in the file",
          detail: "Levelling is done from the controller before the job and persists across files and tool changes. Makera Studio never embeds it. What happens when a file probes mid-program is not known; it would at least re-level over whatever is on the bed.",
          source: "PLAN.md non-negotiable 12; MILLING.md",
        }, n, sample);
      } else if (g >= 80 && g <= 89) {
        out.add({
          level: "warn", code: "canned-cycle",
          title: `Canned cycle G${g}`,
          detail: g === 80
            ? "G80 cancels a canned cycle. Harmless on its own, but it suggests the CAM expected to use one."
            : "Nobody here has run a literal canned cycle on the Z1. EasyTrace's 'G83 - Peck' setting expands to plain G1/G0 moves, which is what has actually run. Whether the controller accepts this word is not known.",
          source: "MILLING.md",
        }, n, sample);
      } else if (g >= 53 && g <= 59.3) {
        out.add({
          level: "note", code: "wcs",
          title: `Work coordinate system G${g}`,
          detail: "No file run here selects one; they all use whatever the controller is zeroed to. G53 in particular moves in machine coordinates, which this checker cannot place.",
        }, n, sample);
      } else if (g >= 40 && g <= 49) {
        out.add({
          level: "warn", code: "compensation",
          title: `Cutter or length compensation (G${g})`,
          detail: "Never used in a file run here. The Makera Studio sample emits none; compensation is baked into its toolpaths.",
        }, n, sample);
      } else if (!KNOWN_G.has(g) && !(g >= 0 && g <= 3) && g !== 90 && g !== 91 && g !== 20) {
        out.add({
          level: "note", code: `g-${g}`,
          title: `G${g} has not been used on this machine`,
          detail: "Not in any file run here. It may be perfectly fine; it is flagged so you know it is untested.",
        }, n, sample);
      }
    }

    // ---- tool changes. T and M6 on ONE line, T first.
    const m6 = ms.includes(6);
    if (m6 && !t) {
      out.add({
        level: "fail", code: "m6-split",
        title: "M6 without a T word on the same line",
        detail: "Split across two lines (FlatCAM does this), the controller aborts mid-job and drops its levelling heightmap. Write T1 M6 on one line (T first: M6 T1 blanks the preview).",
        source: "PLAN.md non-negotiable 4; MILLING.md",
      }, n, sample);
    } else if (t && !m6) {
      out.add({
        level: "fail", code: "m6-split",
        title: "T word without M6 on the same line",
        detail: "Split across two lines (FlatCAM does this), the controller aborts mid-job and drops its levelling heightmap. Write T1 M6 on one line (T first: M6 T1 blanks the preview).",
        source: "PLAN.md non-negotiable 4; MILLING.md",
      }, n, sample);
    }
    if (m6 && t) {
      tool = t.value;
      toolChanges.push(t.value);
      changedSinceSpindle = true;
      // The one thing that blanks the preview and the laser trace. Load tests
      // 05 and 31 (2026-09-24): the control file with only T1 M6 -> M6 T1
      // changed loses its preview, and the trace only goes to the work origin.
      // T1 M6 is fine, and the spindle's M3 S / S M3 order does not matter
      // (32). The firmware runs either order, so nothing else says so.
      if (ws.indexOf(ws.find((w) => w.letter === "M" && w.value === 6)!) < ws.indexOf(t)) {
        out.add({
          level: "silent", code: "m6-word-order",
          title: `Tool change written M6 T${t.value}`,
          detail: `The file cuts, but the controller shows no toolpath preview and the laser boundary trace only goes to the work origin, so the check that would show a clamp in the path does nothing. Write T${t.value} M6. EasyTrace5000 writes M6 T<n>; this is why its files never previewed.`,
          source: "EASYTRACE-Z1.md, load tests 05 and 31 (2026-09-24)",
        }, n, sample);
      }
      if (spindle) {
        out.add({
          level: "warn", code: "m6-spindle-on",
          title: "Tool change with the spindle still running",
          detail: "Every file run here stops the spindle (M5) and lifts before M6. The controller may do it for you; nothing here has tested it.",
          source: "kicad/fix_gcode.py, insert_tool_changes()",
        }, n, sample);
      }
      if (tools.length && !declared.has(t.value)) {
        out.add({
          level: "warn", code: "tool-undeclared",
          title: `T${t.value} is not in the header's tool list`,
          detail: "The header's TOOL entries are how the controller knows each bit's geometry. A tool change to an undeclared number also means this checker cannot check its depth.",
        }, n, sample);
      }
    }

    // ---- M codes
    for (const m of ms) {
      if (m === 3 || m === 4) {
        if (!s && rpm === null) {
          out.add({
            level: "warn", code: "spindle-no-speed",
            title: "Spindle started with no speed",
            detail: "M3 with no S word and no earlier one. The spindle would run at whatever it was last set to.",
          }, n, sample);
        }
        if (m === 4) {
          out.add({
            level: "warn", code: "m4",
            title: "Spindle counter-clockwise (M4)",
            detail: "Every bit on the shelf is right-hand cutting and every file here uses M3. Backwards, a bit rubs rather than cuts.",
          }, n, sample);
        }
        const speed = s?.value ?? rpm;
        if (speed !== null && ms.indexOf(m) < ws.indexOf(s ?? ws[0]!) && s) styleDiffs.add("M3 S<rpm> word order (Makera Studio writes S<rpm> M3)");
        // A spindle start at a new speed with no tool change since the last one
        // is how EasyTrace's combined exports looked: one M6 at the top, then
        // bare M3s, so every operation ran with the first bit.
        if (!changedSinceSpindle && lastStartRpm !== null && speed !== null && speed !== lastStartRpm) {
          out.add({
            level: "warn", code: "missing-tool-change",
            title: "New spindle speed with no tool change since the last start",
            detail: "This is the shape of EasyTrace's combined exports: one M6 at the top, then bare spindle starts, so every operation runs with the first bit. One of them drove a V-bit to -1.7mm forty-three times. If the bit really is the same, ignore this.",
            source: "EASYTRACE-Z1.md; kicad/fix_gcode.py, insert_tool_changes()",
          }, n, sample);
        }
        if (speed !== null) use().rpm.add(speed);
        spindle = true;
        changedSinceSpindle = false;
        lastStartRpm = speed;
      } else if (m === 5) spindle = false;
      else if (m === 2) endCode = { code: "M2", line: n };
      else if (m === 30) endCode ??= { code: "M30", line: n };
      else if (m === 331) vacuum = "auto";
      else if (m === 801) vacuum ??= "direct";
      else if (m === 7 || m === 9) airOnly = true;
      else if (m === 8) {
        out.add({
          level: "warn", code: "m8",
          title: "Coolant (M8)",
          detail: "There is no coolant on this machine. At best it is ignored; it has not been tried.",
          source: "MILLING.md",
        }, n, sample);
      } else if (m === 0 || m === 1) {
        out.add({
          level: "note", code: "pause",
          title: `Program pause (M${m})`,
          detail: "Not used in any file run here, so how the controller presents the pause is not recorded.",
        }, n, sample);
      } else if (!KNOWN_M.has(m)) {
        out.add({
          level: "warn", code: `m-${m}`,
          title: `M${m} is not a code this machine is known to accept`,
          detail: "Not in the codes tested here or in Makera's list as recorded. Some controllers abort a job on an unknown M code; on the Z1 that is untested.",
          source: "MILLING.md",
        }, n, sample);
      }
    }

    if (s) {
      rpm = s.value;
      if (!rpms.includes(s.value)) rpms.push(s.value);
      if (s.value > 0 && s.value < RPM_TYPO_BELOW) {
        out.add({
          level: "warn", code: "rpm-low",
          title: `Spindle speed S${s.value}`,
          detail: `Below ${RPM_TYPO_BELOW} rpm. S1200 for S12000 has turned up four times in EasyTrace's forms, and at 1200 rpm and F500 a 2mm bit snaps. The lowest speed used on purpose here is 6000.`,
          source: "MILLING.md; EASYTRACE-Z1.md",
        }, n, sample);
      } else if (s.value > SPINDLE_MAX) {
        out.add({
          level: "warn", code: "rpm-high",
          title: `Spindle speed S${s.value}`,
          detail: `Above the Z1's published ${SPINDLE_MAX} rpm. What the controller does with it is not recorded; most likely it clamps.`,
          source: "README.md, 'Fly cutters'",
        }, n, sample);
      }
    }

    if (f) {
      feed = mm ? f.value : f.value * 25.4;
      maxFeed = Math.max(maxFeed ?? 0, feed);
      if (feed > feedCeiling) {
        out.add({
          level: "fail", code: "feed-high",
          title: `Feed F${fmt(feed)} is above ${feedCeiling} mm/min`,
          detail: `${maxFeedTag ? "The header declares" : "Makera's header declares"} MAXFEEDRATE ${feedCeiling}, and this project refuses its own files above it. What the controller does above it is not recorded; no Makera sample goes past it.`,
          source: "PLAN.md non-negotiable 9",
        }, n, sample);
      }
    }

    // ---- motion
    const mg = gs.filter((g) => g >= 0 && g <= 3 && Number.isInteger(g));
    if (mg.length) motion = mg.at(-1)!;
    const ax = (l: string) => ws.find((w) => w.letter === l)?.value;
    const X = ax("X"), Y = ax("Y"), Z = ax("Z");
    if (X === undefined && Y === undefined && Z === undefined) continue;
    if (gs.includes(28) || gs.includes(53)) continue; // park / machine coords: not work-space motion
    if (motion === null) {
      out.add({
        level: "warn", code: "no-motion-mode",
        title: "Coordinates before any G0/G1",
        detail: "A move with no motion mode set. The controller's default is not recorded here.",
      }, n, sample);
      continue;
    }
    if (firstMotion < 0) firstMotion = n;
    motionLines++;
    const k = mm ? 1 : 25.4;
    const next = (v: number | undefined, cur: number | undefined) =>
      v === undefined ? cur : absolute ? v * k : (cur ?? 0) + v * k;
    const to = { x: next(X, pos.x), y: next(Y, pos.y), z: next(Z, pos.z) };
    const from = pos;
    pos = to;
    if (to.z !== undefined) {
      zMin = Math.min(zMin ?? to.z, to.z);
      zMax = Math.max(zMax ?? to.z, to.z);
    }
    if (to.x === undefined || to.y === undefined) continue;
    extents = grow(extents, to.x, to.y);

    const z0 = from.z;
    const z1 = to.z;
    const movesXY = from.x !== undefined && from.y !== undefined && (Math.abs(to.x - from.x) > EPS || Math.abs(to.y - from.y) > EPS);
    const buried = (z0 !== undefined && z0 < -EPS) || (z1 !== undefined && z1 < -EPS);

    // Cutting (feeding into or below the stock) with the spindle stopped.
    if (motion !== 0 && buried && !spindle) {
      out.add({
        level: "fail", code: "cut-spindle-off",
        title: "Feeding below Z0 with the spindle off",
        detail: "The tool is driven into the stock without an M3 in effect. That breaks bits.",
      }, n, sample);
    }
    if (motion !== 0 && buried && feed === null) {
      out.add({
        level: "warn", code: "no-feed",
        title: "Cutting move with no feed rate set",
        detail: "No F word has appeared yet, so the move runs at whatever the controller last had.",
      }, n, sample);
    }
    if (motion !== 0 && buried && z1 !== undefined) {
      const u = use();
      u.cuts = true;
      if (u.zMin === null || z1 < u.zMin) { u.zMin = z1; u.zMinLine = n; }
    }

    // Geometry for the preview, the extents and the time estimate.
    const f0 = { x: from.x ?? to.x, y: from.y ?? to.y, z: from.z ?? to.z ?? 0 };
    const t3 = { x: to.x, y: to.y, z: to.z ?? f0.z };
    const I = ax("I"), J = ax("J");
    const pts = (motion === 2 || motion === 3) && (I !== undefined || J !== undefined)
      ? arcPoints(f0, t3, (I ?? 0) * k, (J ?? 0) * k, motion === 2)
      : [t3];
    let len = 0;
    let prev = f0;
    for (const q of pts) { len += Math.hypot(q.x - prev.x, q.y - prev.y, q.z - prev.z); prev = q; }
    seconds += (len / (motion === 0 ? RAPID_FEED : Math.max(feed ?? RAPID_FEED, 1))) * 60;

    // Anything below Z0 can be in material, rapids included; the simulation
    // (stock.ts) decides whether it was.
    if (buried) {
      moves.push({ tool: current(), pts: [f0, ...pts], line: n, rapid: motion === 0, lateral: movesXY || pts.length > 1, feed, down: t3.z < f0.z - EPS });
    }

    const cut = motion !== 0 && buried;
    if (cut) {
      const r = radius();
      for (const q of pts) cutExtents = grow(cutExtents, q.x, q.y, r);
      cutExtents = grow(cutExtents, f0.x, f0.y, r);
    }
    for (const q of pts) extents = grow(extents, q.x, q.y);
    if (!movesXY && pts.length === 1) continue;
    if (!stroke || stroke.cut !== cut) {
      stroke = { cut, points: [{ x: f0.x, y: f0.y }] };
      strokes.push(stroke);
    }
    for (const q of pts) stroke.points.push({ x: q.x, y: q.y });
  }

  // ------------------------------------------------------------ the whole file
  if (firstMotion < 0) {
    out.add({
      level: "fail", code: "no-motion",
      title: "No motion in the file",
      detail: "Nothing here moves the machine. Either this is not G-code, or every line is a comment.",
    });
  }
  if (!sawG90 || !sawG21) {
    out.add({
      level: "warn", code: "no-g90-g21",
      title: `No ${[!sawG90 && "G90", !sawG21 && "G21"].filter(Boolean).join(" or ")} in the file`,
      detail: "Every file run here sets absolute mm explicitly before moving. Jogging can leave the controller in G91, and the file would then run relative to wherever the head happens to be.",
      source: "src/reach.ts",
    });
  }
  if (!endCode) {
    out.add({
      level: "warn", code: "no-end",
      title: "No program end (M2)",
      detail: "Makera Studio ends with G28 then M02.",
      source: "PLAN.md non-negotiable 8",
    });
  } else if (endCode.code === "M30") {
    out.add({
      level: "warn", code: "m30",
      title: "Ends with M30, not M2",
      detail: "Makera's code list: M30 is 'End of the program, no action on the Carvera'. It loads, previews and traces normally (load tests 02 and 30, 2026-09-24); whether it ends a running program cleanly has not been tested. Makera Studio ends with M02; fix_gcode.py rewrites it.",
      source: "MILLING.md; kicad/fix_gcode.py",
    }, endCode.line, rawLines[endCode.line - 1]);
  }
  if (spindle) {
    out.add({
      level: "warn", code: "spindle-left-on",
      title: "The spindle is still on at the end of the file",
      detail: "No M5 after the last spindle start.",
    });
  }
  if (firstMotion >= 0 && !vacuum) {
    out.add({
      level: airOnly ? "silent" : "warn", code: "no-vacuum",
      title: airOnly ? "M7/M9 only: the vacuum will not run from the file" : "Nothing turns the vacuum on",
      detail: airOnly
        ? "M7 and M9 are accepted and do nothing on this machine: there is no separate air port, and the air hose follows the vacuum. Both Makera Studio samples use only M7/M9. Put M331 before the tool change, M332 after M5, or switch the vacuum on from the controller."
        : "No M331 (auto vacuum, follows the spindle) or M801. Fine if you run extraction from the controller; otherwise the chips stay where they are cut.",
      source: "MILLING.md; PLAN.md non-negotiable 6",
    });
  }
  if (firstMotion >= 0 && toolChanges.length === 0) {
    out.add({
      level: "warn", code: "no-m6",
      title: "No tool change (M6) in the file",
      detail: "M6 is how this machine runs a bit change: it parks, lights the tool number on the LED strip and re-probes Z. Without one the file trusts that the right bit is in and Z was zeroed on it by hand.",
      source: "MILLING.md; kicad/fix_gcode.py",
    });
  }
  if (styleDiffs.size) {
    out.add({
      level: "note", code: "layout",
      title: "Layout differs from Makera Studio's",
      detail: `${[...styleDiffs].join("; ")}. Both spellings run, and none of these affects the preview or the laser trace (load tests 02, 28 and 32, 2026-09-24). Only a difference from Makera Studio's layout.`,
      source: "EASYTRACE-Z1.md, load tests 2026-09-24",
    });
  }

  // ---- envelope
  if (extents) {
    const w = extents.x1 - extents.x0;
    const h = extents.y1 - extents.y0;
    if (w > ENVELOPE_X + EPS || h > ENVELOPE_Y + EPS) {
      out.add({
        level: "fail", code: "envelope",
        title: `The job spans ${fmt(w)} x ${fmt(h)} mm`,
        detail: `Beyond the Z1's ${ENVELOPE_X} x ${ENVELOPE_Y} mm travel from any origin. The controller stops with 'Soft Endstop ... was exceeded', possibly during the boundary trace, possibly mid-job.`,
        source: "MILLING.md; src/validate.ts",
      });
    }
  }
  if (zMin !== null && zMax !== null && zMax - zMin > ENVELOPE_Z) {
    out.add({
      level: "fail", code: "envelope-z",
      title: `Z spans ${fmt(zMax - zMin)} mm`,
      detail: `More than the Z1's ${ENVELOPE_Z} mm of Z travel.`,
      source: "README.md, 'Fly cutters'",
    });
  }

  // ---- which way the job runs, and does the header agree
  const yDirection: Stats["yDirection"] = !extents ? "none" : extents.y0 + extents.y1 > 0 ? "positive" : "negative";
  if (extents && yDirection === "positive") {
    out.add({
      level: "note", code: "y-positive",
      title: "The job runs into +Y (front-left origin)",
      detail: "Fine, and it is how Makera Studio lays jobs out. But the facing and PCB jobs here all run into -Y from a back-left origin, so zero this one on the stock's FRONT-left corner, not where you zero the others. A +Y job from a back-left origin is the one that hit 'Soft Endstop Y was exceeded'.",
      source: "MILLING.md; PLAN.md non-negotiable 3",
    });
  }
  if (stock && origin && extents) {
    const L = stock.length, W = stock.width, H = stock.height;
    const backLeft = Math.abs(origin.y - W / 2) < 0.01;
    const frontLeft = Math.abs(origin.y + W / 2) < 0.01;
    // A NOTE: both origin conventions are valid and both have run here. And
    // ORIGIN has no visible effect at all (load test 16, 2026-09-24): the stock
    // box is drawn at Anchor1 and the toolpath at the probed work origin.
    if ((backLeft && yDirection === "positive") || (frontLeft && yDirection === "negative")) {
      out.add({
        level: "note", code: "origin-mismatch",
        title: `ORIGIN is declared ${backLeft ? "back" : "front"}-left, but the job runs into ${yDirection === "positive" ? "+" : "-"}Y`,
        detail: `Both origin conventions are valid. This header uses the ${backLeft ? "back" : "front"}-left form while the coordinates run the other way, as files from before the back-left convention do. The cut does not depend on it, and neither does the preview (load test 16). Zero where the coordinates say: the ${yDirection === "positive" ? "front" : "back"}-left corner.`,
        source: "MILLING.md; kicad/fix_gcode.py, mkr_header()",
      }, originTag!.line, rawLines[originTag!.line - 1]);
    } else if (!backLeft && !frontLeft) {
      out.add({
        level: "note", code: "origin-y",
        title: `ORIGIN y=${fmt(origin.y)} is neither edge of the ${fmt(W)}mm stock`,
        detail: `Known-good headers put the origin on a stock edge: y=${fmt(-W / 2)} (front-left, +Y jobs) or y=${fmt(W / 2)} (back-left, -Y jobs). ORIGIN has no visible effect on the Z1 (load tests 15 and 16), so this is only a difference.`,
      }, originTag!.line, rawLines[originTag!.line - 1]);
    }
    if (Math.abs(origin.x + L / 2) > 0.01) {
      out.add({
        level: "note", code: "origin-x",
        title: `ORIGIN x=${fmt(origin.x)}, expected ${fmt(-L / 2)}`,
        detail: "Every known-good header puts the origin on the stock's left edge, x = -length/2 from its centre. ORIGIN has no visible effect on the Z1 (load tests 15 and 16), so this is only a difference.",
      }, originTag!.line, rawLines[originTag!.line - 1]);
    }
    if (Number.isFinite(origin.z) && Math.abs(origin.z - H / 2) > 0.01) {
      out.add({
        level: "note", code: "origin-z",
        title: `ORIGIN z=${fmt(origin.z)}, expected ${fmt(H / 2)}`,
        detail: "Known-good headers put Z0 on the stock top, z = height/2 from its centre.",
      }, originTag!.line, rawLines[originTag!.line - 1]);
    }
    // Does what is cut lie inside the stock the preview is drawn in?
    if (cutExtents) {
      const ylo = yDirection === "positive" ? 0 : -W;
      const yhi = yDirection === "positive" ? W : 0;
      const over = [
        cutExtents.x0 < -STOCK_SLACK && `X ${fmt(cutExtents.x0)} is left of the stock`,
        cutExtents.x1 > L + STOCK_SLACK && `X ${fmt(cutExtents.x1)} is past its ${fmt(L)}mm length`,
        cutExtents.y0 < ylo - STOCK_SLACK && `Y ${fmt(cutExtents.y0)} is past its edge at ${fmt(ylo)}`,
        cutExtents.y1 > yhi + STOCK_SLACK && `Y ${fmt(cutExtents.y1)} is past its edge at ${fmt(yhi)}`,
      ].filter(Boolean);
      if (over.length) {
        // No further past the stock than the radius of a bit the file uses is
        // an overhang: a facing job run past every edge on purpose (cnc-facing's
        // Overhang box, run on this machine 2026-09-24), or a profile cutout
        // that runs a tool radius past the part. Further than that is the case
        // worth a warning: a cut into the vice or the bed.
        const worst = Math.max(
          -cutExtents.x0, cutExtents.x1 - L, ylo - cutExtents.y0, cutExtents.y1 - yhi,
        );
        const radius = Math.max(0, ...tools.map((t) => (t.tipDiameter ?? t.diameter ?? 0) / 2));
        const overhang = worst <= radius + STOCK_SLACK;
        out.add(overhang
          ? {
              level: "note", code: "outside-stock",
              title: `Cuts up to ${fmt(worst)}mm past the declared stock: an overhang`,
              detail: `${over.join("; ")} (tool radius included). That is within one ${fmt(2 * radius)}mm bit's radius, as a facing job run past every edge or a profile cutout does. Make sure nothing but air is there.`,
              source: "kicad/fix_gcode.py, fits_stock()",
            }
          : {
              level: "warn", code: "outside-stock",
              title: "The cut reaches outside the declared stock",
              detail: `${over.join("; ")} (tool radius included), further than a bit's radius. The controller draws the preview inside the STOCK box, so a job outside it renders wrong, and a cut outside the stock you actually clamped is a cut into the vice or the bed.`,
              source: "kicad/fix_gcode.py, fits_stock()",
            }, stockTag!.line, rawLines[stockTag!.line - 1]);
      }
    }
    if (zMin !== null && -zMin > H + 0.5) {
      out.add({
        level: "warn", code: "below-stock",
        title: `Cuts to Z${fmt(zMin)}, ${fmt(-zMin - H)}mm below the ${fmt(H)}mm stock`,
        detail: "Through-cuts go a little below the stock on purpose (0.2mm on FR4). This is more than that: make sure the backing under it is thick enough, or the bit goes into the spoilboard, the vice or the bed.",
        source: "MILLING.md, dowel holes and backing",
      });
    }
  }

  // ------------------------------------------ the bits, against Makera's table
  const mat = opts.material
    ? { id: opts.material, from: "chosen" as const }
    : (() => {
      const m = tag("MATERIAL");
      // "Other" is Makera's placeholder category, not a material.
      const id = m ? detectMaterial(m.fields.name1 === "Other" ? undefined : m.fields.name1, m.fields.name2) : null;
      return { id, from: id ? ("header" as const) : null };
    })();
  const bits: BitUsage[] = [];

  // Identify every declared bit once: its shape drives the stock simulation,
  // its catalogue row the checks below.
  const matched = new Map(tools.map((t) => [t.number, matchBit(t)] as const));
  const cutters = new Map<number, Cutter>();
  for (const t of tools) {
    const m = matched.get(t.number)!;
    const shank = (t.diameter ?? 3.175) / 2;
    if (m.ok) {
      const b = m.bit;
      cutters.set(t.number, b.kind === "engraving" || b.kind === "chamfer"
        ? { kind: "cone", radius: shank, tipRadius: b.diameter / 2, halfAngle: (b.angle ?? 30) / 2 }
        : { kind: b.kind === "ball" ? "ball" : "flat", radius: b.diameter / 2 });
    } else if (t.tipDiameter !== undefined && t.diameter !== undefined && t.tipDiameter < t.diameter - EPS) {
      const half = Number(rawLines.find((l) => l.startsWith(`;@MKR|TOOL|number=${t.number}|`))?.match(/halfAngle=([\d.]+)/)?.[1] ?? 15);
      cutters.set(t.number, { kind: "cone", radius: shank, tipRadius: t.tipDiameter / 2, halfAngle: half || 15 });
    } else {
      cutters.set(t.number, { kind: "flat", radius: (t.diameter ?? 1) / 2 });
    }
  }
  const engaged = simulate(moves, cutters, cutExtents ?? extents ?? { x0: 0, x1: 1, y0: 0, y1: 1 });
  // A few hundredths is the map's own resolution, not material.
  const IN_MATERIAL = 0.02;
  // A rapid is reported from a tenth of a millimetre in: finer than that is the
  // map's own edges, not a rapid through the work.
  const RAPID_CONTACT = 0.1;
  moves.forEach((mv, i) => {
    const e = engaged.depth[i]!;
    if (e < (mv.rapid ? RAPID_CONTACT : IN_MATERIAL)) return;
    if (mv.rapid) {
      // A rapid through uncut stock. The facing generator's first version did
      // this between passes: a groove the neighbouring passes did not have.
      out.add({
        level: "warn", code: "rapid-in-material",
        title: "Rapid moves through uncut material",
        detail: `G0 through stock the file has not cleared, up to ${fmt(e)}mm deep. At rapid speed that is a groove in the work at best and a broken bit at worst; an early facing job left exactly that groove. (Rapids below Z0 inside pockets already cleared are fine, and are not reported: Makera Studio does it thousands of times.)`,
        source: "PLAN.md non-negotiable 2; src/stock.ts",
      }, mv.line, rawLines[mv.line - 1]?.trim());
      return;
    }
    const u = uses.get(mv.tool);
    if (!u) return;
    if (mv.lateral) {
      if (mv.feed !== null && (u.feed === null || mv.feed > u.feed)) { u.feed = mv.feed; u.feedLine = mv.line; }
      if (u.doc === null || e > u.doc) { u.doc = e; u.docLine = mv.line; }
    } else if (mv.down) {
      if (mv.feed !== null && (u.plunge === null || mv.feed > u.plunge)) { u.plunge = mv.feed; u.plungeLine = mv.line; }
      if (u.peck === null || e > u.peck) { u.peck = e; u.peckLine = mv.line; }
    }
  });

  const cutting = [...uses.entries()].filter(([, u]) => u.cuts);
  if (cutting.length && tools.length && !mat.id) {
    out.add({
      level: "note", code: "no-material",
      title: "Material not known, so feeds are not checked against Makera's table",
      detail: "The header's MATERIAL line does not name one this checker recognises. Pick the material to check each bit's speed, feed, plunge and depth per pass against Makera's published figures.",
    });
  }
  for (const [num, u] of cutting) {
    const decl = declared.get(num);
    if (!decl) {
      if (tools.length) {
        out.add({
          level: "warn", code: "bit-undeclared",
          title: num ? `T${num} cuts, but the header does not say what bit it is` : "The file cuts before any tool change, and the header names more than one bit",
          detail: "Without a declared bit there is nothing to check its feeds or depth against.",
        });
      }
      continue;
    }
    const m = matched.get(num)!;
    const isDrill = m.ok && m.bit.kind === "drill";
    // A drill's depth of cut IS its peck; everything else cuts sideways.
    const depth = isDrill ? u.peck : u.doc;
    const used = {
      rpm: [...u.rpm], feed: isDrill ? null : u.feed, plunge: u.plunge,
      doc: depth === null ? null : Number(depth.toFixed(2)), zMin: u.zMin,
    };
    if (!m.ok) {
      out.add({
        level: "warn", code: "bit-unknown",
        title: `T${num} "${decl.name}" is not one of Makera's bits`,
        detail: `Not identified as an official bit: ${m.reason}${m.candidates.length ? ` (${m.candidates.map((b) => b.name).join(", ")})` : ""}. Every bit used here is an official one, so this usually means the header names the bit loosely or wrongly. Its feeds cannot be checked against Makera's table.`,
        source: "TOOLING.md",
      });
      bits.push({ tool: num, name: decl.name, unmatched: m.reason, used, over: {} });
      continue;
    }
    const bit = m.bit;
    const over: BitUsage["over"] = {};
    // Depth against the flutes: Makera's figure when its name gives one, else
    // the header's. A WARN, because the header can simply be wrong about the
    // bit -- flip-gauge A (v2) declared T3 as the 2mm corn bit and was cut with
    // a 3.175x12mm one. Either the header names the wrong bit, which puts the
    // wrong name in front of the controller, or the shank rubs.
    const flutes = bit.flute ?? decl.fluteLength;
    if (flutes !== undefined && u.zMin !== null && -u.zMin > flutes + EPS) {
      out.add({
        level: "warn", code: "deeper-than-flutes",
        title: `T${num} cuts to Z${fmt(u.zMin)}, deeper than the ${bit.name}'s ${flutes}mm flutes`,
        detail: "Either the header names the wrong bit for T" + num + " (then the controller's tool list, and this check, describe a bit that is not the one in the collet), or the shank rubs before the cut finishes. Check which bit this operation is really cut with.",
        source: "src/validate.ts; TOOLING.md",
      }, u.zMinLine, rawLines[(u.zMinLine ?? 1) - 1]?.trim());
    }
    if (!mat.id) {
      bits.push({ tool: num, name: decl.name, bit: bit.name, used, over });
      continue;
    }
    const row = bit.rows[mat.id];
    const label = CAT_MATERIAL_LABELS[mat.id];
    if (!row) {
      const metalInWood = isMetal(mat.id) && bit.metal !== true;
      out.add({
        level: metalInWood ? "fail" : "warn", code: "bit-wrong-material",
        title: `Makera publishes no ${label} figures for the ${bit.name}`,
        detail: metalInWood
          ? `T${num} is not a metal-cutting bit: Makera gives it no ${label} figures at all.` +
            (bit.kind === "flat" && bit.metal === false
              ? " The long flat ends are the non-metal series, for wood, plastics and composites only. Do not reach for one because it is the longest thing in the box."
              : bit.kind === "corn" ? " Corn bits are published for PCB and carbon fibre only." : "")
          : `T${num} has no ${label} row in Makera's table, which usually means the bit is not meant for it.`,
        source: "TOOLING.md",
      });
      bits.push({ tool: num, name: decl.name, bit: bit.name, used, published: null, over });
      continue;
    }
    const deviation = (field: keyof Row, v: number) =>
      DEVIATIONS.find((d) => d.bit === bit.id && d.material === mat.id && d.field === field && v <= d.value + EPS);
    const ceiling = (field: "feed" | "plunge" | "doc", v: number | null, line?: number) => {
      // Depths from the simulation are exact in Z, so only rounding is allowed.
      if (v === null || v <= row[field] + (field === "doc" ? 0.005 : EPS)) return;
      const dev = deviation(field, v);
      over[field] = dev ? "deviation" : "over";
      const what = { feed: "feed", plunge: "plunge", doc: bit.kind === "drill" ? "peck" : "depth per pass" }[field];
      const unit = field === "doc" ? "mm" : " mm/min";
      out.add(dev
        ? {
          level: "note", code: `${field}-deviation`,
          title: `T${num} ${what} ${fmt(v)}${unit}, over Makera's ${row[field]}${unit}, by a recorded choice`,
          detail: dev.why,
          source: "TOOLING.md",
        }
        : {
          level: "warn", code: `${field}-over-table`,
          title: `T${num} ${what} ${fmt(v)}${unit} is over Makera's ${row[field]}${unit}`,
          detail: `Makera's figure for the ${bit.name} in ${label} is ${row.rpm} rpm / F${row.feed} / plunge ${row.plunge} / ${row.doc}mm per pass, and it is a ceiling: "start the test from the lower limit of the parameter".` +
            (field === "doc" ? " Depth is measured on a simulated stock: how deep a band of new material at least a fifth of the bit wide goes. A helix counts its pitch, moves through cleared air count nothing, and a finishing pass skimming a thin wall is not a deep pass." : ""),
          source: "TOOLING.md, from wiki.makera.com/en/speeds-and-feeds",
        }, line, line ? rawLines[line - 1]?.trim() : undefined);
    };
    if (!isDrill) ceiling("feed", u.feed, u.feedLine);
    ceiling("plunge", u.plunge, u.plungeLine);
    ceiling("doc", used.doc, isDrill ? u.peckLine : u.docLine);
    // Speed: what matters is the chip. A lower rpm at the same feed takes a
    // bigger bite per revolution, which is how S1200-for-12000 snaps a bit.
    for (const s of u.rpm) {
      if (s === row.rpm || s <= 0) continue;
      const load = (u.feed ?? row.feed) / s;
      const pub = row.feed / row.rpm;
      if (load > pub * 1.1) {
        over.rpm = "over";
        out.add({
          level: "warn", code: "chipload-over-table",
          title: `T${num} at S${s}: ${(load / pub).toFixed(1)}× Makera's chip load`,
          detail: `Makera runs the ${bit.name} in ${label} at ${row.rpm} rpm and F${row.feed}, ${(pub * 1000).toFixed(1)} µm per revolution. This file's F${fmt(u.feed ?? row.feed)} at ${s} rpm is ${(load * 1000).toFixed(1)} µm, a heavier bite than the table allows.`,
          source: "TOOLING.md",
        });
      } else {
        out.add({
          level: "note", code: "rpm-differs",
          title: `T${num} at S${s}, where Makera gives ${row.rpm}`,
          detail: `The chip load stays within Makera's (F${fmt(u.feed ?? 0)} at ${s} rpm), so this is a lighter cut, not a riskier one.`,
          source: "TOOLING.md",
        });
      }
    }
    bits.push({ tool: num, name: decl.name, bit: bit.name, used, published: row, over });
  }

  const findings = out.list();
  const verdict = findings.find((f) => f.level !== "note")?.level ?? (findings.length ? "ok" : "ok");

  const reachBox = stock && extents
    ? (yDirection === "positive"
      ? { x0: 0, x1: stock.length, y0: 0, y1: stock.width }
      : { x0: 0, x1: stock.length, y0: -stock.width, y1: 0 })
    : cutExtents ?? extents;

  return {
    filename,
    material: { ...mat, label: mat.id ? CAT_MATERIAL_LABELS[mat.id] : undefined },
    bits,
    verdict,
    findings,
    strokes,
    reachBox,
    stats: {
      lines: rawLines.length,
      bytes: text.length,
      motionLines,
      lineEndings,
      toolChanges,
      rpms,
      maxFeed,
      extents,
      cutExtents,
      zMin,
      zMax,
      seconds,
      header: {
        present: mkr.length > 0,
        stock,
        origin,
        cam: tag("CAM")?.fields.name,
        tools,
        toolpaths: mkr.filter((m) => m.tag === "TOOLPATH").length,
        time: tag("TIME") ? num(tag("TIME")!.fields.seconds) : undefined,
      },
      thumbnail,
      yDirection,
    },
  };
}
