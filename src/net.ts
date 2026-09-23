/**
 * Which hosts may reach the app.
 *
 * Binding to 0.0.0.0 is what makes the app reachable from the workshop LAN, but
 * this machine is multi-homed -- 172.16.123.0/24, 172.30.150.0/24, two 10.100.x
 * nets, 10.11.12.0/24 and a Tailscale address -- so "listen on all interfaces"
 * means considerably more than "reachable from the workshop". The listener is
 * wide and the allowlist is narrow, which is the pair that actually expresses
 * the intent.
 *
 * This is not authentication. It is a blunt "do not answer strangers" filter for
 * a tool with no login that generates files a machine will run. Anything that
 * needs real access control needs a real reverse proxy in front.
 */

/** Default: the workshop subnet, plus loopback so the dev box can always reach it. */
export const DEFAULT_ALLOW = "127.0.0.0/8,::1/128,172.16.123.0/24";

export interface Cidr {
  readonly text: string;
  readonly v6: boolean;
  readonly bits: bigint;
  readonly prefix: number;
}

/** `::ffff:172.16.123.9` and `::ffff:ac10:7b09` both mean the IPv4 address. */
function unmap(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1]! : ip;
}

function v4ToBits(ip: string): bigint | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8n) | BigInt(v);
  }
  return n;
}

function v6ToBits(ip: string): bigint | null {
  const [head, tail] = ip.split("::") as [string, string | undefined];
  const lead = head ? head.split(":") : [];
  const trail = tail === undefined ? [] : tail ? tail.split(":") : [];
  if (tail === undefined && lead.length !== 8) return null;
  const fill = 8 - lead.length - trail.length;
  if (fill < 0) return null;
  const groups = [...lead, ...Array(fill).fill("0"), ...trail];
  let n = 0n;
  for (const gr of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(gr)) return null;
    n = (n << 16n) | BigInt(parseInt(gr, 16));
  }
  return n;
}

export function parseCidr(text: string): Cidr | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const slash = trimmed.lastIndexOf("/");
  const addr = unmap(slash === -1 ? trimmed : trimmed.slice(0, slash));
  const v6 = addr.includes(":");
  const width = v6 ? 128 : 32;
  const prefix = slash === -1 ? width : Number(trimmed.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > width) return null;
  const bits = v6 ? v6ToBits(addr) : v4ToBits(addr);
  if (bits === null) return null;
  // Mask the network address, so 172.16.123.15/24 behaves as 172.16.123.0/24
  // rather than silently matching nothing.
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(width - prefix);
  return { text: trimmed, v6, bits: bits & mask, prefix };
}

export function parseAllow(list: string): Cidr[] {
  const out: Cidr[] = [];
  for (const part of list.split(",")) {
    if (!part.trim()) continue;
    const c = parseCidr(part);
    if (!c) throw new Error(`Not a CIDR: "${part.trim()}"`);
    out.push(c);
  }
  return out;
}

export function matches(ip: string, cidrs: Cidr[]): boolean {
  const addr = unmap(ip.trim());
  const v6 = addr.includes(":");
  const width = v6 ? 128 : 32;
  const bits = v6 ? v6ToBits(addr) : v4ToBits(addr);
  if (bits === null) return false;
  return cidrs.some((c) => {
    if (c.v6 !== v6) return false;
    const mask = c.prefix === 0 ? 0n : ((1n << BigInt(c.prefix)) - 1n) << BigInt(width - c.prefix);
    return (bits & mask) === c.bits;
  });
}

/** Local addresses a client on one of `cidrs` could actually connect to. */
export function reachableOn(cidrs: Cidr[], interfaces: Record<string, { address: string; family: string | number }[] | undefined>): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" && a.family !== 4) continue;
      if (matches(a.address, cidrs)) out.push(a.address);
    }
  }
  return out;
}
