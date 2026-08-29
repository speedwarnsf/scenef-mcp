// The contract test: spawn the server exactly as a client would, over stdio,
// and call all nine tools against the live board.
//
// This is the test that matters. Declaring an outputSchema the payload fails
// is worse than declaring none — the tool breaks at call time, in the
// caller's client, with a validation error the server never saw. Every tool
// here is called for real, and the SDK validates each structuredContent
// against the schema the server advertises.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(here, "..", "server.js");

const EXPECTED = [
  "scenef_whats_playing",
  "scenef_search_showtimes",
  "scenef_theater_info",
  "scenef_film_details",
  "scenef_plan_movie_night",
  "scenef_discounts",
  "scenef_coming_soon",
  "scenef_now",
  "scenef_accuracy",
];

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const client = new Client({ name: "scenef-contract-test", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER] }));

console.log("handshake");
const info = client.getServerVersion();
check(info?.name === "scenef", "server name is scenef", info?.name);
check(info?.version === "1.0.0", "version is 1.0.0", info?.version);
check(
  (client.getInstructions() ?? "").includes("Accuracy is computed, not claimed"),
  "initialize carries the accuracy contract",
);

console.log("\ntools/list");
const { tools } = await client.listTools();
check(tools.length === 9, "nine tools", String(tools.length));
for (const name of EXPECTED) {
  const t = tools.find((x) => x.name === name);
  check(Boolean(t), `${name} present`);
  if (!t) continue;
  check(Boolean(t.description && t.description.length > 80), `${name} carries a real description`);
  check(t.annotations?.readOnlyHint === true, `${name} readOnlyHint`);
  check(t.annotations?.destructiveHint === false, `${name} destructiveHint`);
  check(t.annotations?.openWorldHint === false, `${name} openWorldHint`);
  check(Boolean(t.inputSchema), `${name} publishes an input schema`);
}

console.log("\ntools/call — every tool, against the live board");
const CALLS = [
  ["scenef_now", {}],
  ["scenef_whats_playing", { when: "tonight", max_results: 4 }],
  ["scenef_whats_playing", { when: "weekend", response_format: "detailed", max_results: 2 }],
  ["scenef_discounts", {}],
  ["scenef_coming_soon", { horizon_days: 30 }],
  ["scenef_accuracy", {}],
  ["scenef_plan_movie_night", { when: "tonight", party_size: 2, preferences: { likes: ["horror", "comedy"], window: "evening" } }],
];

for (const [name, args] of CALLS) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  check(!res.isError, `${name} ${JSON.stringify(args).slice(0, 46)}`, res.isError ? text.slice(0, 220) : "");
  check(text.length > 40, `${name} returns prose`, `${text.length} chars`);
  check(Boolean(res.structuredContent), `${name} returns structuredContent`);
}

// Film and theater lookups need a name that is actually on the board today.
const now = await client.callTool({ name: "scenef_now", arguments: {} });
const firstFilm = now.structuredContent?.next_curtains?.[0]?.film?.slug;
const firstVenue = now.structuredContent?.next_curtains?.[0]?.venue?.venue_id;
if (firstFilm) {
  const r = await client.callTool({ name: "scenef_film_details", arguments: { film: firstFilm } });
  check(!r.isError && r.structuredContent?.matched === true, `scenef_film_details matches ${firstFilm}`);
  const s = await client.callTool({ name: "scenef_search_showtimes", arguments: { film: firstFilm } });
  check(!s.isError && s.structuredContent?.matched === true, `scenef_search_showtimes finds ${firstFilm}`);
}
if (firstVenue) {
  const r = await client.callTool({ name: "scenef_theater_info", arguments: { theater: firstVenue } });
  check(!r.isError && r.structuredContent?.matched === true, `scenef_theater_info matches ${firstVenue}`);
  const s = await client.callTool({ name: "scenef_search_showtimes", arguments: { venues: [firstVenue] } });
  check(!s.isError && s.structuredContent?.filtered_by === "venue", "venue-scoped search reports filtered_by venue");
}

console.log("\nrefusals and misses are answers, not errors");
const bare = await client.callTool({ name: "scenef_search_showtimes", arguments: {} });
check(!bare.isError && typeof bare.structuredContent?.refusal === "string", "no film and no venue refuses in-band");
const miss = await client.callTool({ name: "scenef_film_details", arguments: { film: "purple monkey dishwasher" } });
check(!miss.isError && miss.structuredContent?.matched === false, "a film that is not on the board is a clean miss");
const badVenue = await client.callTool({ name: "scenef_search_showtimes", arguments: { film: "a", venues: ["nowhere cinema"] } });
check(!badVenue.isError && Array.isArray(badVenue.structuredContent?.unknown_venues), "an unknown theater is reported, not dropped");
const badWhen = await client.callTool({ name: "scenef_whats_playing", arguments: { when: "someday", max_results: 1 } });
check(typeof badWhen.structuredContent?.note === "string" && badWhen.structuredContent.note.includes("Unrecognized"), "an unusable when is reported, never silently swallowed");

await client.close();
console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check(s)`}`);
process.exit(failures === 0 ? 0 : 1);
