# The hosted server lives at https://scenef.com/mcp (streamable HTTP).
# This image is a thin stdio bridge to it via mcp-remote — the standard
# pattern for stdio-only clients and registry health checks. It starts,
# answers introspection, and proxies every tool call to the live board.
FROM node:22-alpine
RUN npm install -g mcp-remote
ENTRYPOINT ["mcp-remote", "https://scenef.com/mcp"]
