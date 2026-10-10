#!/usr/bin/env node
// SceneF — movie showtimes across California, Florida and Hawaii, as a LOCAL MCP
// server over stdio.
//
// This process IS the server: it implements the protocol itself and reads its
// data from SceneF's public, key-less REST contract (https://scenef.com/agents).
// It is not a bridge and does not proxy MCP traffic anywhere — the ten tools
// are registered, dispatched, and answered here.
//
// The hosted server at https://scenef.com/mcp speaks the same ten tools over
// streamable HTTP. Same names, same schemas, same words, same numbers; use
// whichever transport your client prefers.
//
// stdout belongs to the protocol. Anything this process wants to say goes to
// stderr, or it corrupts the stream.

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ACCURACY_CONTRACT, GO_ROW_FIELDS, TOOLS } from "./src/tools.js";

export const SERVER_NAME = "scenef";
export const SERVER_VERSION = "1.6.1";

/** What the server tells a client at initialize — the hosted server's words,
 *  verbatim (src/app/mcp/[transport]/route.ts). The hosted server
 *  interpolates four values from its region table — the board count
 *  (activeRegions().length), the states (siteWhere()), the default board
 *  and the number of time zones the lit boards keep; they are written down
 *  here as their live values (56; California, Florida and Hawaii; "sf" (San
 *  Francisco); 4). test/parity.js compares this string with the hosted one
 *  character for character, so the day a board lights it goes red. */
export const INSTRUCTIONS = [
  `Read-only movie showtimes across 56 regional boards in California, Florida and Hawaii — chains, independents, repertory and drive-ins. Each board-reading tool reads ONE board per call and takes a \`region\` board id; omitted means "sf" (San Francisco), and it is never inferred from where you are. For a city, ZIP or neighborhood call scenef_resolve_board first; when it answers outside_coverage, say SceneF has no board for that place and never present another board's listings as that place's (nearest_lit, when present, names published boards within 100 miles); when it answers unknown, the name is not in SceneF's place table, so ask the person for a nearby city, or call scenef_now with no region and use a board only if its place name plainly covers the place asked about. Call scenef_now with no region for the list of boards — each id comes with the place it names, so sgv reads as the San Gabriel Valley rather than a bare handle. TIMES ARE THE THEATER'S OWN WALL CLOCK, not one city's: the boards keep 4 time zones, and Hawaii keeps no daylight saving time, so it is two or three hours behind Pacific depending on the season. A board's timezone is reported with its data and is the only zone its times mean anything in. A screening belongs to the NIGHT it opens: a 12:15am Saturday show is Friday night. Use ticket and calendar URLs exactly as returned, preserving their region query parameters. SceneF does not sell, hold or book tickets. Ticket links use https://scenef.com/go/{screeningId}: a tool call records nothing; whoever follows one, a person or a client, is logged once anonymously (${GO_ROW_FIELDS}) and forwarded to the theater's own site or the ticket seller it uses. Film pages https://scenef.com/film/{slug}, or /film/{slug}/{regionSlug} for a specific board. Start with scenef_now to check freshness, scenef_plan_movie_night for recommendations.`,
  ACCURACY_CONTRACT,
  "Call scenef_accuracy for that record as numbers you can quote. Every returned showtime carries confidence, source_tier, sources, verified_at and freshness. Use freshness to distinguish retained or stale source evidence from a newly generated board; detailed responses include more rows, not stronger evidence. Many showtimes, including most chain theaters and some independents, come from a third-party showtimes data service rather than from the theater itself; they are labeled source_tier licensed-feed and carry the weakest claim on the site.",
].join(" ");

/** The JSON Schema dialect the hosted tools/list declares on every input and
 *  output schema (zod 4's toJSONSchema default). */
export const SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/**
 * THE TOOL OBJECTS, BYTE FOR BYTE — not just the words in them. Two things
 * SDK 1.32.1 adds on its own made every local tools/list entry differ from
 * the hosted one while every word matched:
 *
 *   execution   registerTool() hardcodes {taskSupport:"forbidden"} and the
 *               list handler emits it. The hosted tools carry no execution
 *               key. Absent means the same thing under the spec (no task
 *               support), and the call path reads tool.execution?.taskSupport,
 *               so the key is cleared after registration.
 *   $schema     the SDK converts with target draft-07 and labels the schema
 *               http://json-schema.org/draft-07/schema#; the hosted server
 *               labels the same bodies 2020-12. The bodies are identical
 *               under either target for every schema here (no tuple, no
 *               $defs), so only the label is rewritten, on the way out.
 *
 * And one thing it does to a call:
 *
 *   unknown tool   McpServer answers a tools/call for a name it does not
 *                  have with a TOOL RESULT — isError, the text "MCP error
 *                  -32602: Tool x not found". The hosted server answers it
 *                  as a JSON-RPC error, code -32602, message "Tool x not
 *                  found": the call was malformed, not a tool that ran and
 *                  failed. The call handler is wrapped so a name outside
 *                  TOOLS is refused that way before McpServer sees it.
 *
 * Both handlers are caught as McpServer installs them, through the public
 * setRequestHandler, and the instance override is removed once the tools are
 * registered. test/contract.js pins the list (no execution key; every schema
 * labelled 2020-12) and test/parity.js compares each whole tool object, and
 * the unknown-tool error, with the hosted server, so an SDK upgrade that
 * moves any of them goes red rather than drifting.
 */
export function createServer() {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  const proto = server.server;
  const names = new Set(TOOLS.map((t) => t.name));
  const wrap = (schema, handler) => {
    if (schema === ListToolsRequestSchema) {
      return async (request, extra) => {
        const result = await handler(request, extra);
        for (const tool of result?.tools ?? []) {
          for (const side of ["inputSchema", "outputSchema"]) {
            if (tool[side] && typeof tool[side] === "object" && "$schema" in tool[side]) tool[side].$schema = SCHEMA_DIALECT;
          }
        }
        return result;
      };
    }
    if (schema === CallToolRequestSchema) {
      return async (request, extra) => {
        const name = request?.params?.name;
        // A plain Error with a code: the protocol layer sends code and
        // message as they are, where McpError would prefix the message.
        if (!names.has(name)) throw Object.assign(new Error(`Tool ${name} not found`), { code: ErrorCode.InvalidParams });
        return handler(request, extra);
      };
    }
    return handler;
  };
  proto.setRequestHandler = (schema, handler) =>
    Object.getPrototypeOf(proto).setRequestHandler.call(proto, schema, wrap(schema, handler));
  try {
    for (const t of TOOLS) server.registerTool(t.name, t.config, t.handler).execution = undefined;
  } finally {
    delete proto.setRequestHandler;
  }
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
