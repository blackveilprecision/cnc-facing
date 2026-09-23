/**
 * Material x tool -> feeds, transcribed from TOOLING.md, which in turn
 * transcribes <https://wiki.makera.com/en/speeds-and-feeds> (re-read 2026-09-20,
 * and scraped in full 2026-09-21 -- the tables are in the served HTML, a plain
 * fetch renders only the title).
 *
 * Every row cites where it came from and says whether it is a VENDOR figure or a
 * DERIVED one. Makera's own preamble calls the published numbers ceilings, not
 * targets -- "start the test from the lower limit of the parameter" -- so treat
 * a change here as a machine decision, not a tweak. A derived row is a starting
 * point to test upward from, and the UI says so.
 *
 * TOOLS
 *
 * The 3.175x12mm single-flute Metal-series flat end is the default everywhere.
 * It is the bit surface_spoilboard.py declares and every faced board so far has
 * used. PLAN.md said metal facing had to drop to the 2x8mm bit because "the
 * 3.175mm flat end is a NON-METAL bit". The distinction is the SERIES, not the
 * diameter: the shelf has 3.175mm flat ends in both, all the same 3.175mm
 * cutting diameter. The 25mm and 42mm ones are the non-metal series, wood and
 * plastics only, with no aluminium or brass column at all. The 12mm one is the
 * Metal series and Makera does publish metal figures for it.
 *
 * A 6mm single flute was carried here briefly (2026-09-21) and then dropped:
 * one bit, one collet, one set of numbers is worth more than a marginal gain.
 * If it ever comes back, the facts were: Makera sell it with a DLC coating, and
 * publish a Tool Parameters table for it on the PRODUCT page rather than on the
 * wiki speeds-and-feeds page (whose tables contain no tool 4mm or wider). Those
 * figures are IDENTICAL to the 3.175 row material for material, so the only
 * gains were stepover and stiffness. `tools` stays an array so re-adding a bit
 * is a table entry rather than a refactor.
 */

export interface Tool {
  /** Makera's own naming, diameter*flutelength; goes verbatim into `;@MKR|TOOL|name=`. */
  readonly name: string;
  /** `;@MKR|TOOL|type=` -- one of Makera's tool-type words. */
  readonly type: string;
  readonly diameter: number;
  readonly handleDiameter: number;
  /** Hard ceiling on depth of cut: you cannot bury more bit than you have. */
  readonly fluteLength: number;
}

/** One material/tool pairing and the numbers that go with it. */
export interface ToolProfile {
  /** Short key used in the form and the filename. */
  readonly id: ToolId;
  readonly tool: Tool;
  readonly rpm: number;
  /** mm/min, lateral. Must stay under MAX_FEEDRATE. */
  readonly feed: number;
  /** mm/min, Z. */
  readonly plunge: number;
  readonly maxDepthPerPass: number;
  /** Default stepover as a fraction of tool diameter. See the note on each row. */
  readonly stepover: number;
  /**
   * Stepover fraction for the finishing pass in `finish` mode. Chosen, not
   * published: Makera gives feeds, not a finishing strategy. Every row lands at
   * roughly 0.7mm absolute, about half the roughing step.
   */
  readonly finishStepover: number;
  /** Where the numbers came from, printed in the UI. */
  readonly source: string;
  /** False = Makera publishes these. True = reasoned from chipload; start low. */
  readonly derived: boolean;
  readonly note: string;
}

export type ToolId = "3.175";
export type MaterialId = "mdf" | "aluminium" | "brass";

export interface Material {
  readonly id: MaterialId;
  readonly label: string;
  /** `;@MKR|MATERIAL|name2=` -- free text the controller shows. */
  readonly stockName: string;
  /** First entry is the default. */
  readonly tools: ToolProfile[];
  /**
   * How much depth `finish` mode leaves for the last pass, mm.
   *
   * Chosen, not published. A finishing pass wants a thin, even chip: too little
   * and the tool rubs and burnishes instead of cutting, which in aluminium is
   * how you get a smeared surface rather than a bright one. Must not exceed the
   * tool's depth per pass, which validate.ts checks.
   */
  readonly finishAllowance: number;
}

/** `;@MKR|MAXFEEDRATE|value=` -- declared in the header AND enforced in validate.ts. */
export const MAX_FEEDRATE = 1200;

/**
 * The 3.175x12mm single-flute Metal series. Two on the shelf.
 * Field values match what surface_spoilboard.py declares, so the controller sees
 * the same tool it has seen on every faced job so far.
 */
const FLAT_3175: Tool = {
  name: "3.175*12mm Flat End",
  type: "Flat End",
  diameter: 3.175,
  handleDiameter: 3.175,
  fluteLength: 12,
};


/**
 * 0.45 of tool diameter is surface_spoilboard.py's figure, picked conservatively
 * for MDF's ragged fibres, and it is what every faced board on this machine was
 * cut with.
 *
 * A wider bit would want a SMALLER fraction, not the same one. On a facing job
 * the finish is dominated by spindle tram, and the ridge left at each overlap
 * scales with the ABSOLUTE stepover, not the fraction -- so carrying 0.45 onto a
 * 6mm tool would step 2.7mm instead of 1.43mm and leave ridges nearly twice as
 * tall: a worse surface from a better tool. Noted for whoever adds the next bit.
 */
export const DEFAULT_STEPOVER = 0.45;

export const MATERIALS: Record<MaterialId, Material> = {
  mdf: {
    id: "mdf",
    label: "MDF",
    stockName: "MDF spoilboard",
    finishAllowance: 0.2,
    tools: [
      {
        id: "3.175",
        tool: FLAT_3175,
        rpm: 10000,
        feed: 1000,
        plunge: 300,
        // Hardwood, not softwood (2.0): MDF's binder is harder on an edge than
        // its density suggests, and this is what every faced board has used.
        maxDepthPerPass: 1.0,
        stepover: 0.45,
        finishStepover: 0.22,
        source: "TOOLING.md, Single Flute Metal, `3.175*12mm Flat End(Metal)`, Hardwood column",
        derived: false,
        note: "Makera publishes no MDF column for milling. Hardwood is the conservative read of the two wood columns (softwood allows 2.0mm/pass) and is what surface_spoilboard.py has always used.",
      },
    ],
  },

  aluminium: {
    id: "aluminium",
    label: "Aluminium",
    stockName: "Aluminium",
    finishAllowance: 0.05,
    tools: [
      {
        id: "3.175",
        tool: FLAT_3175,
        rpm: 12000,
        feed: 500,
        plunge: 200,
        maxDepthPerPass: 0.2,
        stepover: 0.45,
        finishStepover: 0.22,
        source: "TOOLING.md, Single Flute Metal, `3.175*12mm Flat End(Metal)`, Aluminum column",
        derived: false,
        note: "Vendor figures. Note the surface speed is only 120 m/min, which is low for carbide in aluminium and is where built-up edge comes from — so if a test coupon comes out cloudy grey rather than bright, suspect that before the feeds, and go shallower rather than faster.",
      },
    ],
  },

  brass: {
    id: "brass",
    label: "Brass",
    stockName: "Brass",
    finishAllowance: 0.05,
    tools: [
      {
        id: "3.175",
        tool: FLAT_3175,
        rpm: 12000,
        feed: 300,
        plunge: 100,
        maxDepthPerPass: 0.1,
        stepover: 0.45,
        finishStepover: 0.22,
        source: "TOOLING.md, Single Flute Metal, `3.175*12mm Flat End(Metal)`, Brass column",
        derived: false,
        note: "The slowest combination here: 0.1mm per pass at 300mm/min. Check the time estimate before committing the machine; a shallower total depth is usually the fix.",
      },
    ],
  },
};

export const MATERIAL_IDS = Object.keys(MATERIALS) as MaterialId[];

/**
 * A material and a chosen tool, flattened.
 *
 * Everything downstream (facing.ts, mkr.ts, summary.ts) works with one of these
 * rather than reaching through a material to a tool, so adding a tool never
 * changes the shape those modules see.
 */
export interface Recipe extends ToolProfile {
  readonly materialId: MaterialId;
  readonly label: string;
  readonly stockName: string;
  readonly finishAllowance: number;
}

/** Resolve a material id and optional tool id. Unknown tool -> the default. */
export function resolve(materialId: MaterialId, toolId?: string): Recipe | null {
  const m = MATERIALS[materialId];
  if (!m) return null;
  const profile = (toolId && m.tools.find((t) => t.id === toolId)) || m.tools[0]!;
  return {
    ...profile,
    materialId: m.id,
    label: m.label,
    stockName: m.stockName,
    finishAllowance: m.finishAllowance,
  };
}

export function isMaterialId(v: unknown): v is MaterialId {
  return typeof v === "string" && v in MATERIALS;
}

export function isToolId(v: unknown): v is ToolId {
  return v === "3.175";
}
