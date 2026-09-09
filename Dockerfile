# SceneF MCP — a LOCAL server, built and run in this image.
#
# It implements the Model Context Protocol itself over stdio and reads its
# data from SceneF's public, key-less REST API. Nothing here proxies MCP
# traffic to another endpoint: the ten tools are registered, dispatched, and
# answered by the process this image starts.
#
# The hosted server at https://scenef.com/mcp speaks the same ten tools over
# streamable HTTP, for clients that prefer a URL to a subprocess.

FROM node:22-alpine

LABEL org.opencontainers.image.title="scenef-mcp"
LABEL org.opencontainers.image.description="Movie showtimes across California and Hawaii over MCP — 33 regional boards, chains, indies, and repertory houses, verified against each theater's own calendar. Local stdio server, read-only, no API key."
LABEL org.opencontainers.image.source="https://github.com/speedwarnsf/scenef-mcp"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Manifests first: a source edit must not reinstall the dependency tree.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js ./
COPY src ./src
COPY glama.json README.md LICENSE ./

ENV NODE_ENV=production

# Read-only, no key, no network privileges beyond outbound https to the
# public feed. Run as the image's own unprivileged user.
USER node

# stdio transport: stdout belongs to the protocol, diagnostics go to stderr.
CMD ["node", "server.js"]
