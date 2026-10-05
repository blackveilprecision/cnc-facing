# cnc-facing

A facing-job generator for the **Makera Z1**. Pick X, Y, depth and material; get
a `.nc` the controller will preview, boundary-trace and run. Also checks any
`.nc` (Makera Studio, EasyTrace5000, FlatCAM, hand-edited) against what this
machine has taught.

Live at <https://facing.nottseter.no>.

```sh
bun install
bun run dev          # http://localhost:3117
bun test
bun run typecheck
```

## What it does

- **Facing jobs**: general mode (one pass per depth level) or fine finish
  (rough to an allowance, then a final pass at 90° with about half the
  stepover). Four patterns: serpentine X, serpentine Y (default), one-way Y,
  spiral.
- **Header and preview**: Makera's `;@MKR|` header, a toolpath thumbnail, and an
  MDI corner walk (the "reach" check) so the laser can be used to confirm the
  stock position before cutting.
- **Bits**: one bit, the 3.175 × 12mm single flute (Metal series), with
  Makera's published speeds and feeds. Chamfer and fly-cutter options exist;
  the checker also knows Makera's table for other bits.
- **Check a file** (`/#check`): reports Fail / Silent / Warning / Note findings
  for an uploaded `.nc` and draws its toolpath. Nothing is stored.

The machine knowledge lives in `src/facing.ts`, `src/mkr.ts`, `src/materials.ts`
and `src/check.ts`, with each rule commenting where it was learned. `PLAN.md`
has the original design.

## Configuration

| Variable | Default | |
|---|---|---|
| `PORT` | `3117` | |
| `HOST` | `0.0.0.0` | `127.0.0.1` for localhost only |
| `CNC_FACING_ALLOW` | `127.0.0.0/8,::1/128,172.16.123.0/24` | comma-separated CIDRs that may connect; `0.0.0.0/0,::/0` turns the filter off |

The allow-list is a blunt "do not answer strangers" filter, not authentication.
The Docker image turns it off, since behind the reverse proxy every request
comes from the proxy.

## Deployment

Pushes to `main` run `.github/workflows/build.yml` (typecheck, tests, then push
`ghcr.io/nilsan/cnc-facing`). The image runs as the `cnc-facing` stack in Komodo
on bf.nottseter.no, using `deploy/docker-compose.yml`, behind Caddy.

## License

[Mozilla Public License 2.0](LICENSE).
