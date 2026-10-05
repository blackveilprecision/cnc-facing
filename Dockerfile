FROM oven/bun:1-alpine

LABEL org.opencontainers.image.source="https://github.com/nilsan/cnc-facing" \
      org.opencontainers.image.licenses="MPL-2.0"

WORKDIR /app

# Dependencies first (layer cache). Runtime has none, so this is cheap.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src/ ./src/

# Behind a reverse proxy the peer address is the proxy's, so the built-in
# subnet allow-list is meaningless here; access control is the proxy's job.
ENV HOST=0.0.0.0 \
    PORT=3117 \
    CNC_FACING_ALLOW=0.0.0.0/0,::/0

USER bun
EXPOSE 3117

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD bun -e "const r = await fetch('http://127.0.0.1:3117/'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "run", "src/server.ts"]
