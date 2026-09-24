/**
 * Bun.serve. The form, a plan endpoint the form calls on every keystroke, the
 * download, and the checker for files this app did not write.
 *
 * Plan and download run the SAME buildJob(), so what the preview shows and what
 * the file contains cannot disagree -- the whole point of drawing a picture
 * before committing the machine is that it is a picture of the actual job.
 */

import { networkInterfaces } from "node:os";
import { buildJob, VERSION } from "./gcode.ts";
import { DEFAULT_PATTERN, PATTERNS } from "./facing.ts";
import { PATTERN_LABELS } from "./summary.ts";
import { DEFAULT_ALLOW, matches, parseAllow, reachableOn } from "./net.ts";
import { MATERIALS, MATERIAL_IDS, DEFAULT_STEPOVER, isMaterialId, isToolId, resolve } from "./materials.ts";
import { ENVELOPE_X, ENVELOPE_Y, type JobRequest } from "./validate.ts";
import { checkGcode } from "./check.ts";
import { CAT_MATERIALS, CAT_MATERIAL_LABELS, isCatMaterial } from "./catalogue.ts";
import { reportToSvg } from "./checksvg.ts";
import { reachWalk } from "./reach.ts";

/**
 * Largest file /api/check reads. Makera Studio's 161,000-line sample is 3.2MB;
 * this leaves room for ten of those and stops short of reading anything absurd.
 */
const CHECK_MAX_BYTES = 32 * 1024 * 1024;

const PORT = Number(process.env.PORT ?? 3117);

/**
 * Listen on every interface by default, so the workshop LAN can reach it -- the
 * point of the app is that it runs on this box and is used from the laptop next
 * to the machine.
 */
const HOST = process.env.HOST ?? "0.0.0.0";

/**
 * ...but answer only the workshop subnet. This box is multi-homed (several
 * 10.x nets, a second 172.x, and Tailscale), so a wide listener without a
 * narrow allowlist would put a no-login G-code generator on all of them.
 * CNC_FACING_ALLOW=0.0.0.0/0,::/0 turns the filter off.
 */
const ALLOW = parseAllow(process.env.CNC_FACING_ALLOW ?? DEFAULT_ALLOW);

/**
 * Where the .nc is headed after the browser saves it. The Z1 is fed by scp from
 * a Windows laptop, and the habit is a `latest-facing.nc` pointing at the newest
 * file, so set CNC_FACING_SCP_TARGET and the summary prints the two commands.
 */
const SCP_TARGET = process.env.CNC_FACING_SCP_TARGET ?? "";

/**
 * A checkbox: FormData sends "on" when ticked and nothing when not. JSON
 * callers may send a boolean. Anything else is passed on for validate() to
 * refuse.
 */
function checkbox(v: unknown): boolean | undefined {
  if (v === undefined || v === false || v === "") return undefined;
  return v === true || v === "on" || v === "true" ? true : (v as never);
}

function parseRequest(body: unknown): JobRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (v === "" || v === null || v === undefined ? Number.NaN : Number(v));
  const material = isMaterialId(b.material) ? b.material : ("" as JobRequest["material"]);
  const tool = isToolId(b.tool) ? b.tool : undefined;
  // An omitted stepover means "whatever this bit wants", not a global constant.
  // With one bit those coincide; with two they would not, since a wider tool
  // needs a smaller FRACTION to keep the absolute step -- and so the ridge left
  // by any spindle tram -- where it is.
  const fallback = resolve(material, tool)?.stepover ?? DEFAULT_STEPOVER;
  return {
    width: num(b.width),
    height: num(b.height),
    overhang: checkbox(b.overhang),
    // Sent only when the chamfer box is ticked; blank means none.
    chamfer: b.chamfer === undefined || b.chamfer === "" ? undefined : num(b.chamfer),
    depth: num(b.depth),
    material,
    tool,
    // Anything that is not the finish strategy is the general one. An unknown
    // value must not quietly become "finish" and add a pass nobody asked for.
    mode: b.mode === "finish" ? "finish" : "general",
    // Passed through as given: an unknown pattern is refused by validate(),
    // not coerced into the default and cut as a test it was not.
    pattern: b.pattern === undefined || b.pattern === "" ? undefined : (String(b.pattern) as JobRequest["pattern"]),
    stepover: b.stepover === undefined || b.stepover === "" ? fallback : num(b.stepover),
  };
}

function scpHint(filename: string): string[] {
  if (!SCP_TARGET) return [];
  return [
    `ln -sf ${filename} latest-facing.nc`,
    `scp latest-facing.nc ${SCP_TARGET}`,
  ];
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/**
 * Wraps a handler in the allowlist check.
 *
 * Bun matches `routes` BEFORE the `fetch` fallback, so `fetch` cannot act as
 * middleware in front of them -- every route has to be wrapped, and the wrapper
 * is applied at the one place each route is defined so a new route cannot
 * quietly skip it. The test asserts that every route is wrapped.
 *
 * The peer address from `requestIP` is the only thing worth trusting here: there
 * is no proxy in front, so an X-Forwarded-For header would be whatever the
 * caller felt like sending.
 */
function guard(handler: (req: Request, srv: Bun.Server<undefined>) => Response | Promise<Response>) {
  return async (req: Request, srv: Bun.Server<undefined>): Promise<Response> => {
    const ip = srv.requestIP(req)?.address;
    if (!ip || !matches(ip, ALLOW)) {
      console.warn(`refused ${ip ?? "unknown"} ${new URL(req.url).pathname}`);
      return new Response("Not available from this network.\n", { status: 403 });
    }
    return handler(req, srv);
  };
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,

  routes: {
    "/": guard(() =>
      new Response(Bun.file(new URL("./index.html", import.meta.url)), {
        headers: { "content-type": "text/html; charset=utf-8" },
      })),

    /** Everything the form needs to know about a job, minus the G-code itself. */
    "/api/plan": {
      POST: guard(async (req) => {
        const built = buildJob(parseRequest(await req.json()), { thumbnail: false });
        if (!built.ok) return json({ ok: false, refusals: built.refusals }, 422);
        return json({
          ok: true,
          filename: built.filename,
          svg: built.svg,
          summary: built.summary,
          reach: built.reach,
          scp: scpHint(built.filename),
          lineCount: built.lines.length,
        });
      }),
    },

    /** The real thing, thumbnail and all. */
    "/api/download": {
      POST: guard(async (req) => {
        const built = buildJob(parseRequest(await req.json()));
        if (!built.ok) return json({ ok: false, refusals: built.refusals }, 422);
        return new Response(built.gcode, {
          headers: {
            // text/plain, not a made-up type: the Windows laptop this lands on
            // should open it in an editor without argument.
            "content-type": "text/plain; charset=utf-8",
            "content-disposition": `attachment; filename="${built.filename}"`,
          },
        });
      }),
    },

    /**
     * Check an uploaded file. The body is the file itself, as text; the name
     * comes in the query because the extension is one of the things checked.
     * Nothing is written to disk: the file is read, reported on and dropped.
     */
    "/api/check": {
      POST: guard(async (req) => {
        const size = Number(req.headers.get("content-length") ?? 0);
        if (size > CHECK_MAX_BYTES) {
          return json({ ok: false, error: `The file is ${(size / 1048576).toFixed(1)} MB; the checker reads up to ${CHECK_MAX_BYTES / 1048576} MB.` }, 413);
        }
        const text = await req.text();
        const q = new URL(req.url).searchParams;
        const name = q.get("name") || "upload.nc";
        // The material column to check the bits against; omitted, the header's.
        const material = q.get("material");
        const report = checkGcode(text, name, isCatMaterial(material) ? { material } : {});
        const { strokes: _strokes, ...rest } = report;
        return json({
          ok: true,
          ...rest,
          svg: reportToSvg(report),
          reach: report.reachBox ? reachWalk(report.reachBox) : [],
          materials: CAT_MATERIALS.map((id) => ({ id, label: CAT_MATERIAL_LABELS[id] })),
        });
      }),
    },

    /** The materials table, so the form does not restate what materials.ts knows. */
    "/api/materials": guard(() => json({
      version: VERSION,
      defaultStepover: DEFAULT_STEPOVER,
      envelope: { x: ENVELOPE_X, y: ENVELOPE_Y },
      defaultPattern: DEFAULT_PATTERN,
      patterns: PATTERNS.map((id) => ({ id, label: PATTERN_LABELS[id] })),
      materials: MATERIAL_IDS.map((id) => ({
        id,
        label: MATERIALS[id].label,
        finishAllowance: MATERIALS[id].finishAllowance,
        defaultDepth: MATERIALS[id].defaultDepth,
        tools: MATERIALS[id].tools.map((t) => ({
          id: t.id,
          // "3.175mm" -- what the form shows, and what goes in the collet.
          label: `${t.tool.diameter}mm`,
          tool: t.tool.name,
          rpm: t.rpm,
          feed: t.feed,
          plunge: t.plunge,
          maxDepthPerPass: t.maxDepthPerPass,
          fluteLength: t.tool.fluteLength,
          diameter: t.tool.diameter,
          stepover: t.stepover,
          finishStepover: t.finishStepover,
          derived: t.derived,
          source: t.source,
          note: t.note,
        })),
      })),
    })),
  },

  fetch: guard(() => new Response("Not found", { status: 404 })),
});

const urls = reachableOn(ALLOW, networkInterfaces()).map((a) => `http://${a}:${server.port}`);
console.log(`cnc-facing ${VERSION} listening on ${HOST}:${server.port}`);
console.log(`  reachable from: ${ALLOW.map((c) => c.text).join(", ")}`);
for (const u of urls) console.log(`  ${u}`);
if (!urls.length) {
  console.log("  (no local IPv4 address is inside the allowlist — check CNC_FACING_ALLOW)");
}
if (!SCP_TARGET) {
  console.log("Set CNC_FACING_SCP_TARGET=user@laptop:path to print the scp/symlink hint.");
}
