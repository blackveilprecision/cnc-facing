/**
 * The allowlist. The listener is deliberately wide (0.0.0.0, so the workshop
 * laptop can reach it) and this is what keeps it narrow -- on a box that is also
 * on 172.30.150.0/24, two 10.100.x nets, 10.11.12.0/24 and Tailscale.
 *
 * It is not authentication. It is "do not answer strangers" for a no-login tool
 * that emits files a machine will run.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_ALLOW, matches, parseAllow, parseCidr, reachableOn } from "../src/net.ts";

const allow = parseAllow(DEFAULT_ALLOW);

describe("the default allowlist", () => {
  test("lets the workshop subnet in", () => {
    for (const ip of ["172.16.123.1", "172.16.123.15", "172.16.123.254", "172.16.123.0"]) {
      expect(matches(ip, allow)).toBe(true);
    }
  });

  test("lets loopback in, so the box itself always works", () => {
    expect(matches("127.0.0.1", allow)).toBe(true);
    expect(matches("::1", allow)).toBe(true);
  });

  test("keeps this machine's OTHER networks out — the whole reason it exists", () => {
    for (const ip of [
      "172.30.150.222",  // second 172.x on the same NIC
      "10.100.0.2", "10.100.1.2", "10.11.12.2",
      "100.117.171.75",  // Tailscale
      "172.16.124.1",    // the adjacent /24
      "172.16.122.255",
      "8.8.8.8",
    ]) {
      expect(matches(ip, allow)).toBe(false);
    }
  });

  test("an IPv4-mapped IPv6 peer is treated as its IPv4 address", () => {
    // Bun can report the peer this way on a dual-stack listener; without the
    // unmapping the allowlist would silently refuse the whole subnet.
    expect(matches("::ffff:172.16.123.15", allow)).toBe(true);
    expect(matches("::ffff:10.100.0.2", allow)).toBe(false);
  });
});

describe("parseCidr", () => {
  test("masks the host bits, so a host address written as a /24 still works", () => {
    // CNC_FACING_ALLOW=172.16.123.15/24 is the obvious typo; it should mean the
    // subnet, not match nothing at all.
    expect(matches("172.16.123.9", parseAllow("172.16.123.15/24"))).toBe(true);
  });

  test("a bare address is a single host", () => {
    const one = parseAllow("172.16.123.15");
    expect(matches("172.16.123.15", one)).toBe(true);
    expect(matches("172.16.123.16", one)).toBe(false);
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
    for (const bad of ["172.16.123.0/33", "172.16.300.1/24", "nonsense", "172.16.123.0/-1", "1.2.3"]) {
      expect(() => parseAllow(bad)).toThrow();
    }
    expect(parseCidr("   ")).toBe(null);
  });

  test("whitespace and empty entries in the env var are tolerated", () => {
    const a = parseAllow(" 172.16.123.0/24 , ,127.0.0.1/8 ");
    expect(a.length).toBe(2);
    expect(matches("172.16.123.7", a)).toBe(true);
  });
});

describe("reachableOn", () => {
  test("reports only the local addresses a permitted client could connect to", () => {
    const ifaces = {
      lo: [{ address: "127.0.0.1", family: "IPv4" }],
      eno1: [
        { address: "172.16.123.15", family: "IPv4" },
        { address: "172.30.150.222", family: "IPv4" },
        { address: "10.100.0.2", family: "IPv4" },
        { address: "fe80::1", family: "IPv6" },
      ],
      tailscale0: [{ address: "100.117.171.75", family: "IPv4" }],
    };
    expect(reachableOn(allow, ifaces)).toEqual(["127.0.0.1", "172.16.123.15"]);
  });

  test("says nothing rather than guessing when no interface qualifies", () => {
    expect(reachableOn(parseAllow("192.168.9.0/24"), { lo: [{ address: "127.0.0.1", family: "IPv4" }] }))
      .toEqual([]);
  });
});
