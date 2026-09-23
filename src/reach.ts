/**
 * The reach check, as MDI lines you can paste one at a time.
 *
 * Every job this app produces carries the warning that its origin has to sit far
 * enough back in the travel -- MILLING.md's facing job found that out from a
 * soft endstop mid-trace, after the file had already started. The check is to
 * drive the head to each corner first and watch it get there.
 *
 * Doing that by jogging is the annoying part: the jog control moves at most 10mm
 * per press and wants ~2s between presses, so walking a 150mm job's perimeter is
 * sixty-odd presses and a minute of waiting. One MDI line per corner does the
 * same thing in four moves.
 *
 * The corners traced are the STOCK corners (0..W, -H..0), not the toolpath
 * extents (r..W-r). Two reasons: they are the larger of the two, so a pass here
 * clears the toolpath as well; and they are what the controller's own laser
 * boundary trace walks, so this is a dry run of that.
 */

import type { JobRequest } from "./validate.ts";
import { g } from "./mkr.ts";
import { SAFE_Z } from "./facing.ts";

export interface ReachStep {
  /** The MDI line, bare -- no trailing comment, in case the parser dislikes one. */
  readonly code: string;
  readonly why: string;
  /** The corner that fails first on a job that is too far forward. */
  readonly critical?: boolean;
}

export function reachCheck(req: Pick<JobRequest, "width" | "height">): ReachStep[] {
  const x = g(req.width);
  const y = g(-req.height);
  return [
    {
      code: "G90 G21",
      why: "Absolute, mm. Jogging can leave the controller in G91, and a relative move here would go somewhere you did not ask for.",
    },
    {
      code: `G0 Z${g(SAFE_Z)}`,
      why: `Lift to safe Z before any XY move. Assumes Z0 is already set on the stock top — do this after zeroing, not before.`,
    },
    { code: "G0 X0 Y0", why: "Back to the work origin, so the walk starts from a known corner." },
    { code: `G0 X${x} Y0`, why: "Along the back edge, to the far end in X." },
    {
      code: `G0 X${x} Y${y}`,
      why: "The far corner — furthest in X and furthest toward you in Y. This is the one that hits the soft endstop, and if it is reachable the rest is.",
      critical: true,
    },
    { code: `G0 X0 Y${y}`, why: "Along the front edge, back to X0." },
    { code: "G0 X0 Y0", why: "Home to the work origin, ready to start the job." },
  ];
}

/**
 * The same walk for a file this app did not write: round any box, from either
 * origin corner. `yNear` is the Y edge on the origin's side and `yFar` the other,
 * so a +Y job from a front-left origin walks away from you instead of toward you.
 * The critical corner is the one furthest from X0 Y0, which is the one that
 * finds a soft endstop first whichever way the job runs.
 */
export function reachWalk(box: { x0: number; x1: number; y0: number; y1: number }): ReachStep[] {
  const positive = box.y0 + box.y1 > 0;
  const yNear = positive ? box.y0 : box.y1;
  const yFar = positive ? box.y1 : box.y0;
  const corner = (x: number, y: number) => `G0 X${g(round(x))} Y${g(round(y))}`;
  return [
    {
      code: "G90 G21",
      why: "Absolute, mm. Jogging can leave the controller in G91, and a relative move here would go somewhere you did not ask for.",
    },
    {
      code: `G0 Z${g(SAFE_Z)}`,
      why: "Lift before any XY move. Assumes Z0 is already set on the stock top, so do this after zeroing, not before.",
    },
    { code: corner(box.x0, yNear), why: "The near corner on the origin's side." },
    { code: corner(box.x1, yNear), why: "Along the near edge, to the far end in X." },
    {
      code: corner(box.x1, yFar),
      why: `The far corner, furthest from the origin (${positive ? "away from you in Y" : "toward you in Y"}). This is the one that hits the soft endstop, and if it is reachable the rest is.`,
      critical: true,
    },
    { code: corner(box.x0, yFar), why: "Along the far edge, back in X." },
    { code: "G0 X0 Y0", why: "Home to the work origin, ready to start the job." },
  ];
}

const round = (v: number) => Number(v.toFixed(2));

/**
 * The same thing as a comment block for the top of the .nc, so the file carries
 * its own instructions for checking it. Comments cost nothing at the controller
 * and the file is often read on the laptop before it is ever loaded.
 */
export function reachCheckComment(req: Pick<JobRequest, "width" | "height">): string[] {
  const steps = reachCheck(req);
  const width = Math.max(...steps.map((s) => s.code.length));
  // ASCII only, and no trailing whitespace. The controller skips comments, but
  // it is a byte parser on an embedded board and there is nothing to gain from
  // feeding it multi-byte punctuation in a file it has to read off a USB stick.
  return [
    "; Reach check - paste these into MDI before running, and watch the head get",
    "; to each one. Jogging there takes 10mm per press with a wait between; these",
    "; are one move each.",
    ...steps.map((s) =>
      (`;   ${s.code.padEnd(width)}` + (s.critical ? "   <-- the far corner, the one that fails first" : "")).trimEnd()),
    "; A relative hop, if you just want the head out of the way, is:",
    ";   G91",
    ";   G0 Z10",
    ";   G0 X-25",
    ";   G90",
    "; Z and X only, deliberately. Y is the axis with no slack on this machine:",
    "; a job already runs the gantry most of the way toward you, so a relative Y",
    "; move in either direction is the one that finds an endstop.",
    "; G91 is modal and stays set until G90 puts it back. Leaving it set is how a",
    "; later absolute move ends up 80mm from where it should be.",
  ];
}
