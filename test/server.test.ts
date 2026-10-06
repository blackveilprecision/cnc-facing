/**
 * The server, run for real.
 *
 * The unit tests prove the CIDR maths; this proves the maths is actually wired
 * to every route. Bun matches `routes` before the `fetch` fallback, so the
 * allowlist cannot be middleware -- each route wraps itself in guard(), and a
 * new route that forgets to is exactly the mistake this catches.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";

const PATHS = ["/", "/api/materials", "/api/plan", "/api/download", "/api/check"];

const JOB = { width: 80, height: 60, depth: 0.3, material: "mdf", stepover: 0.45 };

async function start(env: Record<string, string>) {
  const proc = Bun.spawn(["bun", "run", "src/server.ts"], {
    env: { ...process.env, PORT: "0", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  // The startup line carries the port, which is how PORT=0 stays usable.
  const reader = proc.stdout.getReader();
  let buf = "";
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    const m = /listening on \S+?:(\d+)/.exec(buf);
    if (m) {
      reader.releaseLock();
      return { proc, port: Number(m[1]) };
    }
  }
  proc.kill();
  throw new Error(`server did not start: ${buf}`);
}

const hit = (port: number, path: string) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: path.startsWith("/api/") && path !== "/api/materials" ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: path.startsWith("/api/") && path !== "/api/materials" ? JSON.stringify(JOB) : undefined,
  });

const running: { proc: Bun.Subprocess }[] = [];
afterAll(() => { for (const r of running) r.proc.kill(); });

describe("with loopback allowed", () => {
  test("every route answers", async () => {
    const s = await start({ CNC_FACING_ALLOW: "127.0.0.0/8,::1/128" });
    running.push(s);
    for (const p of PATHS) expect((await hit(s.port, p)).status).toBe(200);
    s.proc.kill();
  }, 20_000);
});

describe("with loopback NOT allowed", () => {
  test("every route refuses with 403 — including the one that serves the form", async () => {
    const s = await start({ CNC_FACING_ALLOW: "192.0.2.0/24" });
    running.push(s);
    for (const p of PATHS) {
      const res = await hit(s.port, p);
      expect({ path: p, status: res.status }).toEqual({ path: p, status: 403 });
    }
    // An unmatched path goes through the fetch fallback, which is guarded too.
    expect((await fetch(`http://127.0.0.1:${s.port}/nope`)).status).toBe(403);
    s.proc.kill();
  }, 20_000);

  test("and the refusal leaks nothing about the job or the machine", async () => {
    const s = await start({ CNC_FACING_ALLOW: "192.0.2.0/24" });
    running.push(s);
    const body = await (await hit(s.port, "/api/materials")).text();
    expect(body).toBe("Not available from this network.\n");
    s.proc.kill();
  }, 20_000);
});

/** This host's own non-loopback IPv4 address; CI runners and the workshop box differ. */
const LAN_IP = Object.values(networkInterfaces())
  .flat()
  .find((a) => a?.family === "IPv4" && !a.internal)?.address;
const lanTest = LAN_IP ? test : test.skip;

describe("binding", () => {
  lanTest("listens on all interfaces by default, not just localhost", async () => {
    const s = await start({ CNC_FACING_ALLOW: "0.0.0.0/0,::/0" });
    running.push(s);
    // 127.0.0.1 would answer either way; the LAN address only answers if the
    // listener is not bound to loopback.
    const res = await fetch(`http://${LAN_IP}:${s.port}/api/materials`);
    expect(res.status).toBe(200);
    s.proc.kill();
  }, 20_000);

  lanTest("HOST pins it to one interface when that is what is wanted", async () => {
    const s = await start({ HOST: "127.0.0.1", CNC_FACING_ALLOW: "0.0.0.0/0,::/0" });
    running.push(s);
    expect((await fetch(`http://127.0.0.1:${s.port}/api/materials`)).status).toBe(200);
    await expect(fetch(`http://${LAN_IP}:${s.port}/api/materials`)).rejects.toThrow();
    s.proc.kill();
  }, 20_000);
});

describe("limits", () => {
  test("a chunked /api/check upload past the cap is refused, not read", async () => {
    const s = await start({ CNC_FACING_ALLOW: "127.0.0.0/8,::1/128" });
    running.push(s);
    const big = new ReadableStream({
      start(c) { for (let i = 0; i < 40; i++) c.enqueue(new Uint8Array(1024 * 1024).fill(71)); c.close(); },
    });
    const res = await fetch(`http://127.0.0.1:${s.port}/api/check`, {
      method: "POST", body: big, duplex: "half",
    } as RequestInit).catch(() => null);
    // Bun may refuse at the socket (connection error) or answer 413; never 200.
    expect(res === null || res.status === 413).toBe(true);
    s.proc.kill();
  }, 30_000);

  test("an oversized JSON body to /api/plan is a 413", async () => {
    const s = await start({ CNC_FACING_ALLOW: "127.0.0.0/8,::1/128" });
    running.push(s);
    const res = await fetch(`http://127.0.0.1:${s.port}/api/plan`, {
      method: "POST", body: JSON.stringify({ ...JOB, pad: "x".repeat(100_000) }),
    });
    expect(res.status).toBe(413);
    s.proc.kill();
  }, 20_000);

  test("/api/check answers 429 with Retry-After once the burst is spent", async () => {
    const s = await start({ CNC_FACING_ALLOW: "127.0.0.0/8,::1/128" });
    running.push(s);
    const statuses: number[] = [];
    let retry: string | null = null;
    for (let i = 0; i < 8; i++) {
      const res = await fetch(`http://127.0.0.1:${s.port}/api/check?name=a.nc`, { method: "POST", body: "G0 X1\n" });
      statuses.push(res.status);
      if (res.status === 429) retry = res.headers.get("retry-after");
    }
    expect(statuses.slice(0, 6).every((c) => c === 200)).toBe(true);
    expect(statuses).toContain(429);
    expect(Number(retry)).toBeGreaterThan(0);
    s.proc.kill();
  }, 30_000);

  test("X-Forwarded-For from a private peer separates clients", async () => {
    const s = await start({ CNC_FACING_ALLOW: "127.0.0.0/8,::1/128" });
    running.push(s);
    const hit = (ip: string) => fetch(`http://127.0.0.1:${s.port}/api/check?name=a.nc`, {
      method: "POST", body: "G0 X1\n", headers: { "x-forwarded-for": ip },
    }).then((r) => r.status);
    for (let i = 0; i < 6; i++) await hit("203.0.113.1");
    expect(await hit("203.0.113.1")).toBe(429);
    expect(await hit("203.0.113.2")).toBe(200);
    s.proc.kill();
  }, 30_000);
});
