/**
 * The checker, against three kinds of input:
 *
 *   1. every job the generator here can produce -- which must pass, or the two
 *      halves of the app disagree about what the machine wants;
 *   2. real files: the golden fixture, and EasyTrace's raw export of a coupon
 *      next to the post-processed file that actually ran;
 *   3. a known-good file with ONE thing broken, per rule, so each rule is shown
 *      to fire on exactly the change it is about.
 */

import { describe, expect, test } from "bun:test";
import { checkGcode, parseLine, type CheckReport, type Level } from "../src/check.ts";
import { reportToSvg } from "../src/checksvg.ts";
import { buildJob, writeGcode } from "../src/gcode.ts";
import { explicit } from "./explicit.ts";
import { PATTERNS } from "../src/facing.ts";
import { MATERIAL_IDS } from "../src/materials.ts";
import { reachCheck, reachWalk } from "../src/reach.ts";

const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();

const codes = (r: CheckReport, level?: Level) =>
  r.findings.filter((f) => !level || f.level === level).map((f) => f.code);

/** Anything above a note: what would make the verdict anything but ok. */
const serious = (r: CheckReport) => r.findings.filter((f) => f.level !== "note").map((f) => `${f.level}:${f.code} ${f.title}`);

function generated(over: object = {}): string[] {
  const b = buildJob({ width: 80, height: 60, depth: 0.3, material: "mdf", stepover: 0.45, ...over });
  if (!b.ok) throw new Error(JSON.stringify(b.refusals));
  // Explicit, so each mutation below can find its line by G word. The modal
  // file as written is checked in modal.test.ts.
  return explicit(b.lines);
}

/** A known-good file with one edit, re-serialised the way the generator does. */
const mutate = (edit: (lines: string[]) => string[], name = "job.nc") =>
  checkGcode(writeGcode(edit(generated())), name);

const replace = (from: string | RegExp, to: string) => (ls: string[]) =>
  ls.flatMap((l) => (typeof from === "string" ? l === from : from.test(l)) ? to.split("\n") : [l]);

describe("this app's own output", () => {
  test("every material, pattern and mode passes with nothing above a note", () => {
    for (const material of MATERIAL_IDS) {
      for (const pattern of PATTERNS) {
        const depth = material === "mdf" ? 1.5 : 0.3;
        const r = checkGcode(writeGcode(generated({ material, pattern, depth })), "job.nc");
        expect({ material, pattern, serious: serious(r) }).toEqual({ material, pattern, serious: [] });
      }
      const f = checkGcode(writeGcode(generated({ material, mode: "finish", depth: 0.3 })), "job.nc");
      expect({ material, finish: serious(f) }).toEqual({ material, finish: [] });
    }
  });

  test("it reads the job back: extents, depth, tool, thumbnail", () => {
    const r = checkGcode(writeGcode(generated()), "job.nc");
    expect(r.verdict).toBe("ok");
    // Swept area is exactly 0..W, 0..-H: the tool centre runs r..W-r and the
    // checker grows it by the declared radius.
    const c = r.stats.cutExtents!;
    // `+ 0` folds -0 into 0: x0 is r - r computed in floating point.
    expect([c.x0, c.x1, c.y0, c.y1].map((v) => Number(v.toFixed(2)) + 0)).toEqual([0, 80, -60, 0]);
    expect(r.stats.zMin).toBe(-0.3);
    expect(r.stats.toolChanges).toEqual([1]);
    expect(r.stats.thumbnail).toEqual({ present: true, width: 800, height: 600 });
    expect(r.stats.yDirection).toBe("negative");
  });

  test("its time estimate agrees with the header's", () => {
    const r = checkGcode(writeGcode(generated({ pattern: "spiral" })), "job.nc");
    expect(Math.abs(r.stats.seconds - r.stats.header.time!) / r.stats.header.time!).toBeLessThan(0.05);
  });
});

describe("real files", () => {
  test("the golden fixture (surface_spoilboard.py, run on the machine) is ok", async () => {
    const r = checkGcode(await fixture("surface_spoilboard-80x60x0.3.nc"), "surface_spoilboard-80x60x0.3.nc");
    expect(serious(r)).toEqual([]);
  });

  test("the post-processed EasyTrace coupon that ran is ok", async () => {
    const r = checkGcode(await fixture("easytrace-B-back-FIXED.nc"), "easytrace-B-back-FIXED.nc");
    expect(serious(r)).toEqual([]);
    expect(r.stats.toolChanges).toEqual([1, 2]);
  });

  test("its raw export shows every fault fix_gcode.py exists to fix", async () => {
    const r = checkGcode(await fixture("easytrace-B-back-RAW.cnc"), "easytrace-B-back-RAW.cnc");
    expect(r.verdict).toBe("silent");
    expect(codes(r)).toEqual(expect.arrayContaining([
      "m6-word-order", "mkr-missing", "m30", "extension", "modal-motion", "missing-tool-change",
    ]));
    // M6 T1 is the one that blanks the preview (load tests 05/31, 2026-09-24).
    expect(codes(r, "silent")).toContain("m6-word-order");
    // 475 bare lines, the number the examples README gives for this file.
    expect(r.findings.find((f) => f.code === "modal-motion")!.count).toBe(475);
  });
});

describe("the CRLF and modal-motion stories are not asserted as failures", () => {
  // Both were blamed for the blank preview, and both are among the six
  // hypotheses EASYTRACE-Z1.md records as tested on the machine and FAILED --
  // the cause was the tool change written M6 T<n> (load tests, 2026-09-24).
  // Both were then tested on their own and are fine. A checker that calls
  // either a failure is repeating a disproved story.
  test("LF line endings alone are a note, and leave the verdict ok", () => {
    const r = checkGcode(generated().join("\n") + "\n", "job.nc");
    expect(r.stats.lineEndings).toBe("lf");
    expect(r.findings.find((f) => f.code === "line-endings")!.level).toBe("note");
    expect(r.verdict).toBe("ok");
  });

  test("bare coordinate lines are a note (settled on the machine 2026-09-24)", () => {
    const r = mutate((ls) => ls.map((l) => l.replace(/^G1 (X)/, "$1")));
    expect(r.findings.find((f) => f.code === "modal-motion")!.level).toBe("note");
    expect(r.verdict).toBe("ok");
  });
});

describe("one thing broken", () => {
  test("T and M6 on separate lines fails", () => {
    const r = mutate(replace("T1 M6", "T1\nM6"));
    expect(r.verdict).toBe("fail");
    expect(r.findings.find((f) => f.code === "m6-split")!.count).toBe(2);
  });

  test("M6 T1 is silent: it cuts, but the preview is blank and the trace goes only to the origin", () => {
    // Load tests 05 and 31 (2026-09-24). The firmware runs either order.
    const r = mutate(replace("T1 M6", "M6 T1"));
    expect(r.verdict).toBe("silent");
    expect(codes(r, "silent")).toEqual(["m6-word-order"]);
    expect(codes(r)).not.toContain("layout");
  });

  test("M3 S12000 word order is only a layout note (load test 32)", () => {
    const r = mutate((ls) => ls.map((l) => l.replace(/^S(\d+) M3$/, "M3 S$1")));
    expect(serious(r)).toEqual([]);
    expect(codes(r)).toContain("layout");
  });

  test("TIME before TOOL is only a note: it previews fine (load test 21), though it was blamed for seven trips", () => {
    const r = mutate((ls) => {
      const t = ls.findIndex((l) => l.startsWith(";@MKR|TIME"));
      const time = ls[t]!;
      const out = ls.filter((_, i) => i !== t);
      out.splice(out.findIndex((l) => l.startsWith(";@MKR|TOOL|")), 0, time);
      return out;
    });
    expect(codes(r, "note")).toContain("mkr-time-before-tool");
    expect(serious(r)).toEqual([]);
  });

  test("no header at all warns, not silent: preview and trace work without one (load tests 18, 23)", () => {
    const r = mutate((ls) => ls.filter((l) => !l.startsWith(";@MKR|")));
    expect(codes(r, "warn")).toContain("mkr-missing");
    expect(codes(r, "silent")).toEqual([]);
  });

  test("a feed over MAXFEEDRATE fails", () => {
    const r = mutate((ls) => ls.map((l) => l.replace("F1000", "F1500")));
    expect(codes(r, "fail")).toContain("feed-high");
  });

  test("deeper than the bit's flutes warns -- the header may just name the wrong bit", () => {
    // flip-gauge A (v2) declared T3 as the 2mm corn bit (8mm flutes), cut to
    // -9.7, and was really cut with a 3.175x12mm bit. So a warning, not a fail.
    const r = mutate((ls) => ls.map((l) => l.replace("Z-0.3", "Z-12.5")));
    expect(codes(r, "warn")).toContain("deeper-than-flutes");
  });

  test("cutting with the spindle off fails", () => {
    const r = mutate((ls) => ls.filter((l) => !/^S\d+ M3$/.test(l)));
    expect(codes(r, "fail")).toContain("cut-spindle-off");
  });

  test("more than 200mm of travel fails", () => {
    const r = mutate((ls) => ls.map((l) => l.replace(/^G1 X78\.412/, "G1 X210")));
    expect(codes(r, "fail")).toContain("envelope");
  });

  test("M30 instead of M02 is a warning: loads and previews, runtime end untested", () => {
    const r = mutate(replace("M02", "M30"));
    expect(codes(r, "warn")).toContain("m30");
  });

  test("M7/M9 in place of M331/M332 is silent: accepted, and nothing happens", () => {
    const r = mutate((ls) => ls.map((l) => (l === "M331" ? "M7" : l === "M332" ? "M9" : l)));
    expect(codes(r, "silent")).toContain("no-vacuum");
  });

  test("an S1200 typo is caught", () => {
    const r = mutate((ls) => ls.map((l) => l.replace("S10000 M3", "S1200 M3")));
    expect(codes(r, "warn")).toContain("rpm-low");
  });

  test("a new spindle speed with no tool change between is the EasyTrace combined-export shape", () => {
    const r = mutate((ls) => {
      const end = ls.indexOf("M5");
      return [...ls.slice(0, end), "M5", "G0 Z5", "S12000 M3", "G1 X10 Y-10 Z-0.1 F300", ...ls.slice(end)];
    });
    expect(codes(r, "warn")).toContain("missing-tool-change");
  });

  test("a front-left ORIGIN on a -Y job is only a note: both conventions are valid", () => {
    // The garage opener predates the back-left convention and cut fine.
    const r = mutate((ls) => ls.map((l) => l.replace(/\|y=30\|/, "|y=-30|")));
    expect(r.findings.find((f) => f.code === "origin-mismatch")!.level).toBe("note");
    expect(serious(r)).toEqual([]);
  });

  test("a cut one tool radius past the stock is an overhang: a note, not a warning", () => {
    // Our own Overhang job: the 3.175 bit's centre on the block's outline.
    const built = buildJob(
      { width: 45, height: 45, depth: 0.2, material: "aluminium", stepover: 0.45, overhang: true, chamfer: 0.2, mode: "finish" },
      { thumbnail: false },
    );
    if (!built.ok) throw new Error("build failed");
    const r = checkGcode(built.gcode, "job.nc");
    expect(r.findings.find((f) => f.code === "outside-stock")!.level).toBe("note");
    expect(r.verdict).toBe("ok");
  });

  test("a cut outside the declared stock warns", () => {
    const r = mutate((ls) => ls.map((l) => l.replace("|length=80|", "|length=60|").replace("|x=-40|", "|x=-30|")));
    expect(codes(r, "warn")).toContain("outside-stock");
  });

  test("a .cnc extension is only a note: it loads and previews (load test 20)", () => {
    expect(codes(mutate((ls) => ls, "job.cnc"), "note")).toContain("extension");
  });

  test("an embedded G32 warns, it is not refused: what it does is unknown", () => {
    const r = mutate(replace("G90 G21", "G90 G21\nG32 R1"));
    expect(r.findings.find((f) => f.code === "g32")!.level).toBe("warn");
  });

  test("a rapid through uncut stock warns", () => {
    // The first pass as a G0: it rapids along the row at -0.3 before anything
    // there has been cut.
    let first = true;
    const r = mutate((ls) => ls.map((l) => (first && l === "G1 X78.412 F1000" ? (first = false, "G0 X78.412") : l)));
    expect(codes(r, "warn")).toContain("rapid-in-material");
  });

  test("a rapid below Z0 through air already cleared is not reported", () => {
    // Makera Studio does this 25,053 times in its own sample, inside pockets.
    const r = mutate((ls) => {
      const end = ls.indexOf("G0 Z5", ls.indexOf("G4 P1") + 2);
      return [...ls.slice(0, end), "G0 X10 Y-1.587", "G0 X70 Y-1.587", ...ls.slice(end)];
    });
    expect(codes(r)).not.toContain("rapid-in-material");
  });
});

describe("the parser", () => {
  test("strips both comment styles and allows spaces inside words", () => {
    const p = parseLine("G1 X 1.5 (a comment; with a semicolon) Y-2 ; the rest");
    expect(p.words.map((w) => w.text)).toEqual(["G1", "X1.5", "Y-2"]);
    expect(p.junk).toBeNull();
  });

  test("inches and relative moves are tracked, not assumed away", () => {
    const text = [
      ";@MKR|BEGIN", "G90 G20", "T1 M6", "S12000 M3", "M331",
      "G0 X0 Y0 Z0.2", "G91", "G1 Z-0.21 F10", "G1 X1 Y-1", "G90", "G0 Z0.2", "M5", "M332", "G28", "M2",
    ].join("\r\n");
    const r = checkGcode(text, "inch.nc");
    expect(r.stats.extents).toEqual({ x0: 0, x1: 25.4, y0: -25.4, y1: 0 });
    expect(Number(r.stats.zMin!.toFixed(3))).toBe(-0.254);
    expect(codes(r)).toEqual(expect.arrayContaining(["inch", "relative"]));
  });

  test("a full circle is a full circle, not a zero-length arc", () => {
    const text = ["G90 G21", "T1 M6", "S12000 M3", "G0 X10 Y-10 Z1", "G1 Z-0.1 F100", "G2 X10 Y-10 I5 J0 F300", "G0 Z5", "M5", "M2"].join("\r\n");
    const e = checkGcode(text, "circle.nc").stats.extents!;
    // Chords are kept within 0.01mm of the arc, so the extremes land that close.
    [10, 20, -15, -5].forEach((want, i) => expect(Math.abs([e.x0, e.x1, e.y0, e.y1][i]! - want)).toBeLessThanOrEqual(0.011));
  });
});

describe("the reach walk for an uploaded file", () => {
  test("for a -Y stock box it is exactly the generator's walk", () => {
    expect(reachWalk({ x0: 0, x1: 80, y0: -60, y1: 0 }).map((s) => s.code))
      .toEqual(reachCheck({ width: 80, height: 60 }).map((s) => s.code));
  });

  test("for a +Y job the critical corner is the back-right one", () => {
    const crit = reachWalk({ x0: 0, x1: 86, y0: 0, y1: 56 }).find((s) => s.critical)!;
    expect(crit.code).toBe("G0 X86 Y56");
  });
});

describe("the preview", () => {
  test("a 100,000-point file is thinned to a sensible SVG", () => {
    const lines = ["G90 G21", "T1 M6", "S12000 M3", "G0 X0 Y0 Z1", "G1 Z-0.1 F300"];
    for (let i = 0; i < 100_000; i++) lines.push(`G1 X${(i % 1000) * 0.08} Y${-Math.floor(i / 1000) * 0.5}`);
    lines.push("G0 Z5", "M5", "M2");
    const svg = reportToSvg(checkGcode(lines.join("\r\n"), "big.nc"));
    expect(svg.length).toBeLessThan(600_000);
    expect(svg.startsWith("<svg")).toBe(true);
  });
});

describe("the bits, against Makera's table", () => {
  const bit = (r: CheckReport, n = 1) => r.bits.find((b) => b.tool === n)!;

  test("this app's jobs sit exactly on Makera's figures", () => {
    for (const material of MATERIAL_IDS) {
      const r = checkGcode(writeGcode(generated({ material, depth: material === "brass" ? 0.1 : 0.2 })), "job.nc");
      const b = bit(r);
      expect(b.bit).toBe("3.175*12mm Flat End(Metal)");
      expect(b.over).toEqual({});
      expect(b.used.feed).toBe(b.published!.feed);
    }
  });

  test("the material comes from the header, and can be overridden", () => {
    expect(checkGcode(writeGcode(generated()), "job.nc").material).toMatchObject({ id: "hardwood", from: "header" });
    // The MDF job's F1000 and 0.3mm checked as aluminium: both over.
    const r = checkGcode(writeGcode(generated()), "job.nc", { material: "aluminum" });
    expect(r.material).toMatchObject({ id: "aluminum", from: "chosen" });
    expect(codes(r, "warn")).toEqual(expect.arrayContaining(["feed-over-table", "doc-over-table"]));
  });

  test("a feed over Makera's figure warns, well before MAXFEEDRATE", () => {
    const r = checkGcode(writeGcode(generated({ material: "aluminium", depth: 0.2 }).map((l) => l.replace("F500", "F700"))), "job.nc");
    expect(codes(r, "warn")).toContain("feed-over-table");
    expect(codes(r)).not.toContain("feed-high");
  });

  test("a slower spindle at the same feed is a heavier chip, and warns", () => {
    const r = mutate((ls) => ls.map((l) => l.replace("S10000 M3", "S6000 M3")));
    expect(codes(r, "warn")).toContain("chipload-over-table");
  });

  test("a faster spindle at the same feed is a lighter chip, but still a warning: always Makera's figures", () => {
    const r = mutate((ls) => ls.map((l) => l.replace("S10000 M3", "S12000 M3")));
    expect(r.findings.find((f) => f.code === "rpm-differs")!.level).toBe("warn");
    expect(codes(r)).not.toContain("chipload-over-table");
  });

  test("a feed under Makera's figure is a warning too", () => {
    const r = mutate((ls) => ls.map((l) => l.replace(/F(\d+)$/, (_, f) => `F${Math.round(Number(f) * 0.6)}`)));
    expect(codes(r, "warn")).toContain("feed-under-table");
  });

  test("a non-metal bit in aluminium fails", () => {
    const r = checkGcode(writeGcode(generated({ material: "aluminium", depth: 0.2 })
      .map((l) => l.replace("name=3.175*12mm Flat End - FACING", "name=3.175*25mm Flat End").replace("flutelength=12", "flutelength=25"))), "job.nc");
    expect(codes(r, "fail")).toContain("bit-wrong-material");
  });

  test("a bit that is not one of Makera's is reported, not guessed at", () => {
    const r = mutate((ls) => ls.map((l) => l.replace("name=3.175*12mm Flat End - FACING", "name=Mystery cutter")));
    expect(codes(r, "warn")).toContain("bit-unknown");
  });

  describe("PCB isolation with the 0.3mm V-bit", () => {
    const pcb = (depth: number) => [
      ";@MKR|BEGIN", ";@MKR|MATERIAL|id=|name3=other|name1=Other|name2=FR4 copper-clad",
      ";@MKR|TOOL|number=1|id=|name=3.175*0.3mm*30deg Engraving - ISOLATION|type=Engraving|handlediameter=3.175|flutelength=5|diameter=3.175|tipdiameter=0.3|halfAngle=15",
      ";@MKR|END", "G90 G21", "M331", "T1 M6", "S12000 M3", "G0 X0 Y-5 Z1",
      `G1 Z-${depth} F200`, `G1 X20 Y-5 F500`, "G0 Z5", "M5", "M332", "G28", "M02",
    ].join("\r\n");

    test("at 0.1 it is on Makera's figure", () => {
      expect(bit(checkGcode(pcb(0.1), "pcb.nc")).over).toEqual({});
    });

    test("at 0.12 it is over, by the choice TOOLING.md records: a note", () => {
      const r = checkGcode(pcb(0.12), "pcb.nc");
      expect(bit(r).over.doc).toBe("deviation");
      expect(r.findings.find((f) => f.code === "doc-deviation")!.level).toBe("note");
    });

    test("at 0.15 it is over both: a warning (car-remote was cut like this)", () => {
      const r = checkGcode(pcb(0.15), "pcb.nc");
      expect(bit(r).over.doc).toBe("over");
      expect(codes(r, "warn")).toContain("doc-over-table");
    });
  });
});
