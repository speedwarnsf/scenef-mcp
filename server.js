#!/usr/bin/env node
// SceneF — San Francisco movie showtimes, as a LOCAL MCP server over stdio.
//
// This process IS the server: it implements the protocol itself and reads its
// data from SceneF's public, key-less REST contract (https://scenef.com/agents).
// It is not a bridge and does not proxy MCP traffic anywhere — the nine tools
// are registered, dispatched, and answered here.
//
// The hosted server at https://scenef.com/mcp speaks the same nine tools over
// streamable HTTP. Same names, same schemas, same words, same numbers; use
// whichever transport your client prefers.
//
// stdout belongs to the protocol. Anything this process wants to say goes to
// stderr, or it corrupts the stream.

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ACCURACY_CONTRACT, TOOLS } from "./src/tools.js";

export const SERVER_NAME = "scenef";
export const SERVER_VERSION = "1.0.0";

/** What the server tells a client at initialize — the hosted server's words. */
export const INSTRUCTIONS = [
  "Read-only San Francisco movie showtimes. Ticket links are always https://scenef.com/go/{screeningId}; film pages https://scenef.com/film/{slug}. Times are SF wall-clock. Start with scenef_now to check freshness, scenef_plan_movie_night for recommendations.",
  ACCURACY_CONTRACT,
  'Call scenef_accuracy for that record as numbers you can quote, or pass response_format: "detailed" to any showtime tool to get the confidence level and verified_at on each showtime. Chain showtimes (AMC, Regal, Apple Cinemas), when present, are licensed from an aggregator rather than read from the theater — they are labeled source_tier licensed-feed and carry the weakest claim on the site.',
].join(" ");

export function createServer() {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  for (const t of TOOLS) server.registerTool(t.name, t.config, t.handler);
  return server;
}

async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write(`scenef-mcp ${SERVER_VERSION} ready on stdio — ${TOOLS.length} tools, reading ${process.env.SCENEF_BASE_URL ?? "https://scenef.com"}\n`);
}

// Run when executed, stay quiet when imported.
//
// THIS GUARD MUST FOLLOW THE SYMLINK. Comparing import.meta.url against a
// bare `file://${process.argv[1]}` looked right and was wrong the moment
// anyone installed this the documented way: npm and npx put the bin in
// node_modules/.bin as a SYMLINK, so argv[1] is the link and import.meta.url
// is the real file. They never matched, main() never ran, and the process
// exited 0 having said nothing at all — which a stdio client reports as a
// server that closed the connection, with no error to explain it. realpath
// resolves the link; pathToFileURL survives spaces in the path.
const invokedAs = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : null;
if (invokedAs === import.meta.url) {
  main().catch((err) => {
    process.stderr.write(`scenef-mcp failed to start: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
