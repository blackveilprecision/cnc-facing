/**
 * The server, run for real.
 *
 * The unit tests prove the CIDR maths; this proves the maths is actually wired
 * to every route. Bun matches `routes` before the `fetch` fallback, so the
 * allowlist cannot be middleware -- each route wraps itself in guard(), and a
 * new route that forgets to is exactly the mistake this catches.
 */

import { afterAll, describe, expect, test } from "bun:test";

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
    const s = await start({ CNC_FACING_ALLOW: "172.16.123.0/24" });
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
    const s = await start({ CNC_FACING_ALLOW: "172.16.123.0/24" });
    running.push(s);
    const body = await (await hit(s.port, "/api/materials")).text();
    expect(body).toBe("Not available from this network.\n");
    s.proc.kill();
  }, 20_000);
});

describe("binding", () => {
  test("listens on all interfaces by default, not just localhost", async () => {
    const s = await start({ CNC_FACING_ALLOW: "0.0.0.0/0,::/0" });
    running.push(s);
    // 127.0.0.1 would answer either way; the LAN address only answers if the
    // listener is not bound to loopback.
    const res = await fetch(`http://172.16.123.15:${s.port}/api/materials`);
    expect(res.status).toBe(200);
    s.proc.kill();
  }, 20_000);

  test("HOST pins it to one interface when that is what is wanted", async () => {
    const s = await start({ HOST: "127.0.0.1", CNC_FACING_ALLOW: "0.0.0.0/0,::/0" });
    running.push(s);
    expect((await fetch(`http://127.0.0.1:${s.port}/api/materials`)).status).toBe(200);
    await expect(fetch(`http://172.16.123.15:${s.port}/api/materials`)).rejects.toThrow();
    s.proc.kill();
  }, 20_000);
});
