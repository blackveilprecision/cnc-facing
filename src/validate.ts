/**
 * The gate. Refuse with the offending value named; never emit a file that will
 * fail at the machine.
 *
 * This mirrors `fix_gcode.py --stock`, which exists because a header that does
 * not match its own job is a silent failure: the file runs, and the preview or
 * the boundary trace is wrong. Everything here is a refusal, not a warning.
 * Warnings (the metal-facing time, mostly) live in summary.ts and do not block.
 */

import { isPattern, type Mode, type Pattern } from "./facing.ts";
import { MAX_FEEDRATE, resolve, type MaterialId, type ToolId } from "./materials.ts";

/**
 * The Z1's XY travel, mm.
 *
 * MILLING.md records it twice: "the machine's 200 x 200 envelope" (the facing
 * job needing +118.4 X / -158.4 Y "leaving only ~40mm of slack in Y"), and "A
 * 150 x 200 sheet is the machine's entire work area (200 x 200)".
 *
 * Confirmed against Makera's published figure 2026-09-21: the Z1's work volume
 * is 200 x 200 x 100 mm. Two independent sources agreeing is the most this can
 * be checked without a tape measure.
 *
 * A job of exactly 200 x 200 only fits if its origin is on the exact corner of
 * travel, which nothing guarantees -- the facing job above already had to be
 * jogged to the back-left before it would reach. So this is a hard ceiling, not
 * a promise: the UI says to jog to the far corner and confirm reach before
 * starting, which is the check no generator can do for you.
 *
 * Z travel is 100mm by the same published figure. It is not checked, because it
 * cannot bind: facing depth is capped by the tool's 12mm flutes long before it
 * runs out of Z. Recorded here so the next person
 * does not have to go looking, which PLAN.md had to.
 */
export const ENVELOPE_X = 200;
export const ENVELOPE_Y = 200;

export interface JobRequest {
  width: number;
  height: number;
  depth: number;
  material: MaterialId;
  /** Which bit. Omitted means the material's default. */
  tool?: ToolId;
  /** `general` (the default) or `finish`. */
  mode?: Mode;
  /** General mode only. Omitted means serpentine-x. */
  pattern?: Pattern;
  stepover: number;
}

export interface Refusal {
  /** Which input to point at in the form. */
  readonly field: keyof JobRequest;
  readonly message: string;
}

function positive(v: number, field: keyof JobRequest, label: string): Refusal | null {
  if (!Number.isFinite(v)) return { field, message: `${label} is not a number.` };
  if (v <= 0) return { field, message: `${label} must be greater than zero (got ${v}).` };
  return null;
}

export function validate(req: JobRequest): Refusal[] {
  const out: Refusal[] = [];
  const push = (r: Refusal | null) => { if (r) out.push(r); };

  push(positive(req.width, "width", "Size X"));
  push(positive(req.height, "height", "Size Y"));
  push(positive(req.depth, "depth", "Depth"));
  push(positive(req.stepover, "stepover", "Stepover"));
  if (out.length) return out;

  const material = resolve(req.material, req.tool);
  if (!material) {
    return [{ field: "material", message: `Unknown material "${req.material}".` }];
  }
  if (req.tool !== undefined && material.id !== req.tool) {
    // Silently falling back to the default bit would run a job at the wrong
    // feeds for the bit actually in the collet.
    return [{ field: "tool", message: `No ${req.tool}mm profile for ${material.label}.` }];
  }
  const tool = material.tool;

  if (req.stepover > 1) {
    out.push({
      field: "stepover",
      message: `Stepover is a fraction of tool diameter; ${req.stepover} would step further than the tool is wide and leave uncut ridges.`,
    });
  }

  if (req.width < tool.diameter) {
    out.push({
      field: "width",
      message: `Size X ${req.width}mm is narrower than the ${tool.diameter}mm tool — there is no room for even one pass.`,
    });
  }
  if (req.height < tool.diameter) {
    out.push({
      field: "height",
      message: `Size Y ${req.height}mm is narrower than the ${tool.diameter}mm tool — there is no room for even one pass.`,
    });
  }

  if (req.width > ENVELOPE_X) {
    out.push({
      field: "width",
      message: `Size X ${req.width}mm is beyond the Z1's ${ENVELOPE_X}mm X travel.`,
    });
  }
  if (req.height > ENVELOPE_Y) {
    out.push({
      field: "height",
      message: `Size Y ${req.height}mm is beyond the Z1's ${ENVELOPE_Y}mm Y travel.`,
    });
  }

  if (req.depth > tool.fluteLength) {
    out.push({
      field: "depth",
      message: `Depth ${req.depth}mm is deeper than the ${tool.name}'s ${tool.fluteLength}mm flutes — the shank would rub before the cut finished.`,
    });
  }

  if (req.mode !== undefined && req.mode !== "general" && req.mode !== "finish") {
    out.push({ field: "mode", message: `Unknown mode "${req.mode}".` });
  }

  if (req.pattern !== undefined && !isPattern(req.pattern)) {
    out.push({ field: "pattern", message: `Unknown pattern "${req.pattern}".` });
  } else if (req.mode === "finish" && req.pattern !== undefined && req.pattern !== "serpentine-x") {
    // Finish mode's roughing and its rotated finishing pass are a fixed
    // strategy. Quietly dropping the pattern would hand back a file that is
    // not the test the user asked for.
    out.push({
      field: "pattern",
      message: `Fine finish always roughs along X and finishes along Y; the ${req.pattern} pattern is general mode only.`,
    });
  }

  if (req.mode === "finish") {
    // The finishing pass takes the whole allowance in one go, so it has to fit
    // inside what the tool is allowed to cut per pass.
    if (material.finishAllowance > material.maxDepthPerPass) {
      out.push({
        field: "mode",
        message: `The ${material.label} finishing allowance of ${material.finishAllowance}mm is deeper than the ${material.tool.name}'s ${material.maxDepthPerPass}mm per pass.`,
      });
    }
    if (req.depth < material.finishAllowance) {
      out.push({
        field: "depth",
        message: `Finish mode leaves ${material.finishAllowance}mm for the last pass, so it needs at least that much depth (got ${req.depth}mm). Use general mode for a skim this light.`,
      });
    }
  }

  // Belt and braces: the table is checked at the machine's own limit, not just
  // trusted. A feed above MAXFEEDRATE is the one refusal the controller would
  // also catch, but it would catch it after the tool change.
  for (const [label, v] of [["Feed", material.feed], ["Plunge", material.plunge]] as const) {
    if (v > MAX_FEEDRATE) {
      out.push({
        field: "material",
        message: `${label} ${v} mm/min for ${material.label} exceeds the declared MAXFEEDRATE of ${MAX_FEEDRATE}.`,
      });
    }
  }

  return out;
}
