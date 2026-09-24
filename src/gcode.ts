/**
 * Assembles the file: `;@MKR|` header, comments, preamble, body, trailer,
 * thumbnail. CRLF throughout.
 *
 * The preamble and trailer are a straight port of `surface_spoilboard.py`, which
 * is the file this machine has actually run. Every line in them is load-bearing:
 *
 *   M331 BEFORE the tool change   the proven order, used by every file the
 *                                 machine has run. A job that looked like "no
 *                                 vacuum" turned out to be the AIR ASSIST hose
 *                                 having fallen out with suction running the
 *                                 whole time; the G-code was never at fault and
 *                                 a reordering tried as a guess was reverted.
 *   T1 M6 on ONE line             split across two lines the controller aborts
 *                                 mid-job and loses its levelling heightmap.
 *                                 M6 is not something to avoid: it parks the
 *                                 head, shows the bit number on the LED strip
 *                                 and re-probes Z, so no manual re-zero.
 *   G4 P1                         dwell for the spindle to reach speed before
 *                                 the first cut.
 *   G28 then M02                  park, then end. M30 is inert on this
 *                                 controller; Makera Studio ends with M02.
 *   no G32                        levelling is controller-side and persists
 *                                 across tool changes and files. Never embed it.
 *   no G2/G3                      facing is all G1. The Z1 handles arcs, but
 *                                 Makera Studio emits none and there is no
 *                                 reason to be the first to try here.
 */

import pkg from "../package.json" with { type: "json" };
import { chamferBody, planChamfer, type ChamferPlan } from "./chamfer.ts";
import { DEFAULT_PATTERN, gcodeBody, planFacing, SAFE_Z, type FacingPath } from "./facing.ts";
import { MATERIALS, resolve } from "./materials.ts";
import { g, mkrHeader, type StockDeclaration } from "./mkr.ts";
import { buildScene, sceneToSvg, type Scene } from "./preview.ts";
import { reachCheck, reachCheckComment, type ReachStep } from "./reach.ts";
import { PATTERN_LABELS, summarise, type Summary } from "./summary.ts";
import { sceneToPng, thumbnailLines } from "./thumbnail.ts";
import { validate, type JobRequest, type Refusal } from "./validate.ts";

export const VERSION: string = pkg.version;

/**
 * The thickness `;@MKR|STOCK` declares, mm. Fixed, not asked for.
 *
 * It only sets how tall the controller draws its preview box (and so the
 * ORIGIN z, which is half of it); nothing about the cut depends on it. 12 is
 * what surface_spoilboard.py declares in the file this machine has run, so
 * the header stays the proven one. The depth that could matter -- more than
 * the bit can reach -- is capped by the 12mm flute length in validate.ts.
 */
export const STOCK_HEIGHT = 12;

export interface BuildOptions {
  /** Injected in tests so the date stamp is deterministic. */
  readonly now?: Date;
  /** Off in most tests: a 30KB base64 line makes a diff unreadable. */
  readonly thumbnail?: boolean;
}

export interface BuildOk {
  readonly ok: true;
  readonly filename: string;
  readonly gcode: string;
  readonly lines: string[];
  readonly path: FacingPath;
  /** The T2 chamfer pass, or null. */
  readonly chamfer: ChamferPlan | null;
  readonly scene: Scene;
  readonly svg: string;
  readonly summary: Summary;
  /** MDI lines for walking the job's corners before committing the machine. */
  readonly reach: ReachStep[];
}

export interface BuildFailed {
  readonly ok: false;
  readonly refusals: Refusal[];
}

export type BuildResult = BuildOk | BuildFailed;

/** Makera Studio writes CRLF and so do we -- see writeGcode's note below. */
export const EOL = "\r\n";

export function buildJob(req: JobRequest, opts: BuildOptions = {}): BuildResult {
  const refusals = validate(req);
  if (refusals.length) return { ok: false, refusals };

  const material = resolve(req.material, req.tool)!;
  const path = planFacing({
    width: req.width,
    height: req.height,
    depth: req.depth,
    material,
    stepover: req.stepover,
    mode: req.mode ?? "general",
    pattern: req.pattern,
    // A tool radius when on: the tool centre then runs the block's outline.
    overhang: req.overhang ? material.tool.diameter / 2 : 0,
  });

  // The declared stock is the block. With no overhang it is also exactly the
  // swept area, because the tool centre runs r..W-r. With one, the swept area
  // is the block plus the overhang on each side, and the preview shows the
  // cutter going past the block's edges, which is what the machine will do.
  // Declaring the swept area instead would make the preview box bigger than
  // the block on the table and lie about what is being faced.
  const stock: StockDeclaration = {
    length: req.width,
    width: req.height,
    height: STOCK_HEIGHT,
  };

  const chamfer = req.chamfer
    ? planChamfer({ profile: material.chamfer, width: req.chamfer, w: req.width, h: req.height, faceDepth: req.depth })
    : null;

  const now = opts.now ?? new Date();
  const scene = buildScene(path, stock);
  const tool = material.tool;

  const lines = [
    ...mkrHeader({
      path,
      stock,
      camVersion: VERSION,
      toolpathName: `Face ${g(req.width)}x${g(req.height)}`,
      chamfer,
    }),
    `(Facing ${g(req.width)} x ${g(req.height)} mm, ${g(req.depth)} mm deep, ${material.label}` +
      `${path.overhang > 0 ? `, overhang ${path.overhang.toFixed(2)} mm` : ""})`,
    `(${PATTERN_LABELS[path.pattern]}${path.mode === "finish" ? ", then a finishing pass along Y" : ""})`,
    `(${path.levels.length} pass${path.levels.length === 1 ? "" : "es"} at ${g(round(path.step, 3))} mm stepover, ~${(path.seconds / 60).toFixed(1)} min)`,
    ...(chamfer ? [`(Then T2: ${g(chamfer.width)} mm chamfer round the top edge, 90deg chamfer bit)`] : []),
    `(Generated ${stamp(now)} by cnc-facing ${VERSION})`,
    "",
    ...reachCheckComment(req),
    "",
    "G90 G21",
    ";@MKR|TOOLPATH_START|toolpath_number=1",
    "",
    `; T1-${tool.name} - FACING`,
    "",
    "M331",
    "T1 M6",
    `G0 Z${g(SAFE_Z)}`,
    `S${material.rpm} M3`,
    "G4 P1",
    ...gcodeBody(path),
    ...(chamfer ? chamferBody(chamfer) : []),
    `G0 Z${g(SAFE_Z)}`,
    "M5",
    "M332",
    "G28",
    "M02",
  ];

  if (opts.thumbnail !== false) lines.push(...thumbnailLines(sceneToPng(scene)));

  return {
    ok: true,
    filename: filenameFor(req, now),
    gcode: writeGcode(lines),
    lines,
    path,
    chamfer,
    scene,
    svg: sceneToSvg(scene),
    summary: summarise(path, stock, chamfer),
    reach: reachCheck(req),
  };
}

/**
 * CRLF, explicitly, not the platform's newline.
 *
 * Both Makera sample files are CRLF throughout, and so is every file that has
 * previewed on this machine, so this matches them. It is NOT the fix for the
 * blank preview, though it was once believed to be (a \r\n splitter would read
 * an LF file as one line): EASYTRACE-Z1.md records LF vs CRLF as one of the six
 * hypotheses tested on the machine that all failed. The cause was the ;@MKR|
 * header's field order. Kept because matching the known-good file costs
 * nothing; the checker (check.ts) reports LF as a note, not a failure.
 */
export function writeGcode(lines: string[]): string {
  return lines.join(EOL) + EOL;
}

/**
 * `facing-<material>-<X>x<Y>-<depth>mm-<YYYYMMDD>.nc`, the garasje naming habit.
 *
 * Anything that changes the cut but not those fields gets named too, because two
 * jobs sharing a filename is how the wrong one ends up on the machine:
 *
 *   a non-default bit   `facing-aluminium-6mm-90x70-0.4mm-...`
 *   finish mode         `facing-brass-40x30-0.1mm-finish-...`
 *   a non-default pattern `facing-aluminium-40x30-0.2mm-spiral-...`
 *   overhang on         `facing-aluminium-45.2x45.2-0.2mm-overhang-...`
 *   a chamfer           `facing-aluminium-45.2x45.2-0.2mm-overhang-chamfer0.2-...`
 *
 * Finish mode and the pattern matter here more than they look: a set of
 * 40x30x0.2 coupons differs only by those, so without them in the name the
 * second download silently replaces the first and the comparison you cut them
 * for is gone.
 *
 * The plain name means serpentine-x, the pattern every job before 0.9.0 was
 * cut with, so files already on disk keep meaning what they did. The default
 * since then, serpentine-y, is named like any other pattern.
 */
export function filenameFor(req: JobRequest, now = new Date()): string {
  const d = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const recipe = resolve(req.material, req.tool);
  const isDefaultBit = !recipe || MATERIALS[req.material]?.tools[0]?.id === recipe.id;
  const bit = isDefaultBit ? "" : `-${recipe.tool.diameter}mm`;
  const mode = req.mode === "finish" ? "-finish" : "";
  const effective = req.mode === "finish" ? "serpentine-x" : req.pattern ?? DEFAULT_PATTERN;
  const pattern = effective !== "serpentine-x" ? `-${effective}` : "";
  const overhang = (req.overhang ? "-overhang" : "") + (req.chamfer ? `-chamfer${g(req.chamfer)}` : "");
  return `facing-${req.material}${bit}-${g(req.width)}x${g(req.height)}-${g(req.depth)}mm${overhang}${pattern}${mode}-${d}.nc`;
}

const pad = (n: number) => n.toString().padStart(2, "0");
const round = (v: number, d: number) => Number(v.toFixed(d));

function stamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
