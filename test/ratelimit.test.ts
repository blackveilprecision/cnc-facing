import { describe, expect, test } from "bun:test";
import { LIMITS, RateLimiter } from "../src/ratelimit.ts";

describe("RateLimiter", () => {
  test("allows a burst up to capacity, then says how long to wait", () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    for (let i = 0; i < LIMITS.check.capacity; i++) expect(rl.take("a", "check")).toBe(0);
    expect(rl.take("a", "check")).toBeGreaterThan(0);
  });

  test("refills over time", () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    for (let i = 0; i < LIMITS.check.capacity; i++) rl.take("a", "check");
    expect(rl.take("a", "check")).toBeGreaterThan(0);
    t += 6000; // 0.2/s -> at least one token
    expect(rl.take("a", "check")).toBe(0);
  });

  test("clients and classes do not share a bucket", () => {
    const rl = new RateLimiter(() => 0);
    for (let i = 0; i < LIMITS.check.capacity; i++) rl.take("a", "check");
    expect(rl.take("a", "check")).toBeGreaterThan(0);
    expect(rl.take("b", "check")).toBe(0);
    expect(rl.take("a", "form")).toBe(0);
  });

  test("typing into the form never trips the form bucket", () => {
    let t = 0;
    const rl = new RateLimiter(() => t);
    for (let i = 0; i < 300; i++) { t += 100; expect(rl.take("a", "form")).toBe(0); } // 10 keystrokes/s for 30 s
  });
});
