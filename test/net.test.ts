/**
 * The allowlist. The listener is deliberately wide (0.0.0.0, so the workshop
 * laptop can reach it) and this is what keeps it narrow -- on a box that may
 * also be on a VPN or Tailscale.
 *
 * It is not authentication. It is "do not answer strangers" for a no-login tool
 * that emits files a machine will run.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_ALLOW, isPrivate, matches, parseAllow, parseCidr, reachableOn } from "../src/net.ts";

const allow = parseAllow(DEFAULT_ALLOW);

describe("the default allowlist", () => {
  test("lets the private LAN ranges in", () => {
    for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.1.20"]) {
      expect(matches(ip, allow)).toBe(true);
    }
  });

  test("lets loopback in, so the box itself always works", () => {
    expect(matches("127.0.0.1", allow)).toBe(true);
    expect(matches("::1", allow)).toBe(true);
  });

  test("keeps public, Tailscale and adjacent-to-private addresses out", () => {
    for (const ip of [
      "100.117.171.75",  // Tailscale (CGNAT range)
      "172.15.0.1", "172.32.0.1",  // just outside 172.16.0.0/12
      "192.169.0.1",
      "8.8.8.8",
    ]) {
      expect(matches(ip, allow)).toBe(false);
    }
  });

  test("an IPv4-mapped IPv6 peer is treated as its IPv4 address", () => {
    // Bun can report the peer this way on a dual-stack listener; without the
    // unmapping the allowlist would silently refuse the whole subnet.
    expect(matches("::ffff:192.168.1.20", allow)).toBe(true);
    expect(matches("::ffff:8.8.8.8", allow)).toBe(false);
  });
});

describe("parseCidr", () => {
  test("masks the host bits, so a host address written as a /24 still works", () => {
    // CNC_FACING_ALLOW=192.0.2.15/24 is the obvious typo; it should mean the
    // subnet, not match nothing at all.
    expect(matches("192.0.2.9", parseAllow("192.0.2.15/24"))).toBe(true);
  });

  test("a bare address is a single host", () => {
    const one = parseAllow("192.0.2.15");
    expect(matches("192.0.2.15", one)).toBe(true);
    expect(matches("192.0.2.16", one)).toBe(false);
  });

  test("/0 matches everything of its family, which is how the filter is turned off", () => {
    const off = parseAllow("0.0.0.0/0,::/0");
    for (const ip of ["8.8.8.8", "10.0.0.1", "::1", "2001:db8::1"]) {
      expect(matches(ip, off)).toBe(true);
    }
  });

  test("v4 and v6 never match across families", () => {
    expect(matches("::1", parseAllow("0.0.0.0/0"))).toBe(false);
    expect(matches("127.0.0.1", parseAllow("::/0"))).toBe(false);
  });

  test("rubbish is rejected loudly rather than silently allowing or denying", () => {
    for (const bad of ["192.0.2.0/33", "192.0.300.1/24", "nonsense", "192.0.2.0/-1", "1.2.3"]) {
      expect(() => parseAllow(bad)).toThrow();
    }
    expect(parseCidr("   ")).toBe(null);
  });

  test("whitespace and empty entries in the env var are tolerated", () => {
    const a = parseAllow(" 192.0.2.0/24 , ,127.0.0.1/8 ");
    expect(a.length).toBe(2);
    expect(matches("192.0.2.7", a)).toBe(true);
  });
});

describe("reachableOn", () => {
  test("reports only the local addresses a permitted client could connect to", () => {
    const ifaces = {
      lo: [{ address: "127.0.0.1", family: "IPv4" }],
      eno1: [
        { address: "192.168.1.20", family: "IPv4" },
        { address: "8.8.8.8", family: "IPv4" },
        { address: "fe80::1", family: "IPv6" },
      ],
      tailscale0: [{ address: "100.117.171.75", family: "IPv4" }],
    };
    expect(reachableOn(allow, ifaces)).toEqual(["127.0.0.1", "192.168.1.20"]);
  });

  test("says nothing rather than guessing when no interface qualifies", () => {
    expect(reachableOn(parseAllow("192.168.9.0/24"), { lo: [{ address: "127.0.0.1", family: "IPv4" }] }))
      .toEqual([]);
  });
});

describe("isPrivate", () => {
  test("is true for loopback and RFC 1918, false for public addresses", () => {
    for (const ip of ["127.0.0.1", "::1", "10.0.0.5", "172.18.0.2", "192.168.1.1"]) expect(isPrivate(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "100.64.0.1", "172.32.0.1"]) expect(isPrivate(ip)).toBe(false);
  });
});
