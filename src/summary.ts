/**
 * The derived numbers, and the warnings that do not refuse.
 *
 * Everything except size, depth and material is derived, and the whole value of
 * this app is encoding knowledge the user would otherwise re-derive -- so every
 * derived number is shown with the reason it has that value. A number the user
 * cannot check is a number they have to trust, and this project exists because
 * trusting a generated file cost seven trips to the machine.
 */

import type { FacingPath, Pattern } from "./facing.ts";
import type { StockDeclaration } from "./mkr.ts";

export interface Warning {
  readonly level: "note" | "warn";
  readonly text: string;
}

/** What the form and the summary call each pattern. */
export const PATTERN_LABELS: Record<Pattern, string> = {
  "serpentine-x": "Serpentine along X",
  "serpentine-y": "Serpentine along Y",
  "oneway-y": "One-way along Y, climb",
  spiral: "Spiral inward, climb",
};

/**
 * Which way the tool meets the material, per pattern -- the thing every "shiny
 * finish" guide leads with. Worth stating plainly because those guides are
 * almost always talking about WALLS, and this is a floor: it is cut by the end
 * face of the tool, not its periphery, so this governs the small ridge at each
 * stepover overlap rather than the surface itself.
 */
const DIRECTION_NOTES: Record<Pattern, string> = {
  "serpentine-x": "A serpentine alternates climb and conventional: the stepover runs into −Y, so the passes travelling +X are climb and the ones travelling −X are conventional.",
  "serpentine-y": "Cuts along Y, the stiffer axis on this gantry. Still a serpentine, so it alternates: the stepover runs into +X, so the passes travelling +Y (away from you) are climb and the ones travelling −Y are conventional.",
  "oneway-y": "Every pass is climb: front to back (+Y) with the uncut material on the right. Between passes the tool lifts 1mm, rapids back to the front edge and plunges, so each pass leaves a small dwell mark where it starts, on the front edge.",
  spiral: "Climb all the way: clockwise rings, inward, with the uncut material always on the right. Every ring cuts in all four directions, so the top and bottom triangles of the coupon are the X-cut surface and the left and right ones the Y-cut surface, from one tool, one stock and one run. The corners slow the machine down, and each ring closes before stepping in.",
};

export interface Summary {
  readonly mode: "general" | "finish";
  readonly pattern: Pattern;
  readonly patternLabel: string;
  /** "rings" for the spiral, "passes" for the rest. */
  readonly passUnit: string;
  /** Set in finish mode: what the last pass takes off, and how it runs. */
  readonly finish: {
    readonly allowance: number;
    readonly stepoverMm: number;
    readonly passes: number;
    readonly rotated: boolean;
  } | null;
  readonly tool: string;
  readonly toolId: string;
  /** True when the feeds are reasoned rather than published. The UI says so. */
  readonly derived: boolean;
  readonly rpm: number;
  readonly feed: number;
  readonly plunge: number;
  readonly source: string;
  readonly materialNote: string;
  readonly stepoverMm: number;
  readonly stepoverPct: number;
  readonly maxDepthPerPass: number;
  readonly levels: number;
  readonly passesPerLevel: number;
  readonly totalPasses: number;
  readonly passDepths: number[];
  readonly cutLengthMm: number;
  readonly minutes: number;
  readonly stock: StockDeclaration;
  readonly sweptArea: { x: [number, number]; y: [number, number] };
  readonly warnings: Warning[];
}

/** Above this, say how long it will take before the user finds out at the machine. */
const LONG_JOB_MINUTES = 30;
const VERY_LONG_JOB_MINUTES = 120;

export function summarise(path: FacingPath, stock: StockDeclaration): Summary {
  const { spec } = path;
  const m = spec.material;
  const minutes = path.seconds / 60;
  const warnings: Warning[] = [];

  // A derived row has no vendor figure behind it. Every row is currently
  // sourced, but the flag and this warning stay: the next third-party bit will
  // set it, and silently mixing reasoned numbers in with published ones is
  // exactly the drift this project is built to avoid.
  if (m.derived) {
    warnings.push({
      level: "warn",
      text: `These feeds are derived, not published. Take a shallow test cut and work up rather than trusting the first number.`,
    });
  }

  warnings.push({
    level: "note",
    text: `${DIRECTION_NOTES[path.pattern]} On a facing job that matters less than it does on a wall — the floor is cut by the end face of the tool — and spindle tram usually dominates how it looks.`,
  });

  if (path.mode === "finish") {
    // Makera publishes feeds, not strategies. The allowance and the finishing
    // stepover are this project's choices and should be read as such.
    warnings.push({
      level: "note",
      text: `The feeds are Makera's, but the finishing strategy is not: leaving ${m.finishAllowance}mm and stepping ${(m.tool.diameter * m.finishStepover).toFixed(2)}mm across it are choices made here. Makera publishes no finishing recipe.`,
    });
    warnings.push({
      level: "note",
      text: `The finishing pass runs at 90° to the roughing passes, so it cuts across their grooves instead of riding in them. It still serpentines — one-direction-only would roughly double the time and add a plunge mark per pass for no evidence of gain.`,
    });
  }

  if (minutes >= VERY_LONG_JOB_MINUTES) {
    warnings.push({
      level: "warn",
      text: `This is a ${formatDuration(minutes)} job. Reconsider the size or the depth before starting it — the machine is committed for the whole of it, and a single-flute 3.175mm bit is not the right tool for clearing this much material.`,
    });
  } else if (minutes >= LONG_JOB_MINUTES) {
    warnings.push({
      level: "warn",
      text: `Estimated ${formatDuration(minutes)}. Check you want the machine tied up that long.`,
    });
  }

  // A round cutter cannot reach into a square corner, so the preview draws the
  // fillets rather than promising a corner the machine cannot cut. In practice
  // it never bites: stock in the vice gets faced a few mm oversize, which puts
  // the fillets outside the part. Said once, briefly, for the case where the
  // faced area IS the part.
  warnings.push({
    level: "note",
    text: `Corners come out with a ${(m.tool.diameter / 2).toFixed(3)}mm radius; the edges are flush. Facing a few mm larger than the part puts them outside it.`,
  });

  if (m.materialId !== "mdf") {
    warnings.push({
      level: "note",
      text: `Facing metal with an end mill is slow by nature: ${m.maxDepthPerPass}mm per pass at ${m.feed}mm/min, and both are Makera's published figures. Go shallower rather than faster if it misbehaves — a 150W spindle bogging down is what makes chatter marks.`,
    });
  }

  // The reach check no generator can do. MILLING.md: the 160mm facing job needed
  // its origin near the back-left of travel, and found that out from a soft
  // endstop mid-trace.
  warnings.push({
    level: "note",
    text: `Needs +${spec.width}mm in X and −${spec.height}mm in Y from the origin, against 200 × 200 of travel. Jog to the far corner and confirm it is reachable before starting.`,
  });

  warnings.push({
    level: "note",
    text: "Run the controller's levelling probe (G32) before the job. It is controller-side, never in the file, and it persists across tool changes.",
  });

  const last = path.levels.at(-1);
  return {
    mode: path.mode,
    pattern: path.pattern,
    patternLabel: PATTERN_LABELS[path.pattern],
    passUnit: path.pattern === "spiral" ? "rings" : "passes",
    finish: last?.isFinish
      ? {
          allowance: m.finishAllowance,
          stepoverMm: m.tool.diameter * m.finishStepover,
          passes: last.passes,
          rotated: last.raster?.axis === "y",
        }
      : null,
    tool: m.tool.name,
    toolId: m.id,
    derived: m.derived,
    rpm: m.rpm,
    feed: m.feed,
    plunge: m.plunge,
    source: m.source,
    materialNote: m.note,
    stepoverMm: path.step,
    stepoverPct: spec.stepover * 100,
    maxDepthPerPass: m.maxDepthPerPass,
    levels: path.levels.length,
    passesPerLevel: path.passesPerLevel,
    totalPasses: path.totalPasses,
    passDepths: path.passDepths,
    cutLengthMm: path.cutLength,
    minutes,
    stock,
    sweptArea: { x: [0, spec.width], y: [-spec.height, 0] },
    warnings,
  };
}

export function formatDuration(minutes: number): string {
  if (minutes < 1) return `${Math.round(minutes * 60)}s`;
  if (minutes < 60) return `${minutes.toFixed(1)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes - h * 60);
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}
