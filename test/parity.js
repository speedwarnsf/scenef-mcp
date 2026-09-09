// ONE CONTRACT, TWO TRANSPORTS — proven, not asserted.
//
// This server and the hosted one at https://scenef.com/mcp publish the same
// ten tools. If the names, descriptions, or input schemas drift apart, an
// agent that learned the contract from one is quietly mis-informed about the
// other, and the difference will surface as a wrong answer rather than an
// error. So the two are diffed against each other, live.
//
// This test needs the network and the hosted endpoint. When the endpoint
// cannot be reached it says so and exits 0 — a local build must not fail
// because scenef.com is having a bad minute — but any REAL difference it can
// see is a failure.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HOSTED = process.env.SCENEF_MCP_URL ?? "https://scenef.com/mcp";
const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "server.js");

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `\n        ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const local = new Client({ name: "scenef-parity", version: "1.0.0" });
await local.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER] }));
const mine = (await local.listTools()).tools;

// THE WORDS A MISS IS ANSWERED WITH. A tool's description can match to the
// letter while the sentence it answers a miss with does not — that is the
// drift the 2026-09-08 review found (three different sentences for "not on
// the board"). These calls are made on both transports and the text compared
// whole, with only the data_as_of timestamp masked: the two read the same
// board, so everything else — the board's name, the id list and how it is
// joined, the footer — has to agree.
const PROBES = [
  ["scenef_film_details", { film: "purple monkey dishwasher" }],
  ["scenef_search_showtimes", { film: "purple monkey dishwasher" }],
  ["scenef_theater_info", { theater: "nowhere cinema" }],
  ["scenef_search_showtimes", {}],
];
const maskTime = (t) => t.replace(/data as of \S+/g, "data as of <data_as_of>");
const textOf = (r) => r.content?.find((c) => c.type === "text")?.text ?? "";

let theirs;
let theirInstructions = "";
const theirAnswers = new Map();
try {
  const hosted = new Client({ name: "scenef-parity", version: "1.0.0" });
  await hosted.connect(new StreamableHTTPClientTransport(new URL(HOSTED)));
  theirs = (await hosted.listTools()).tools;
  theirInstructions = hosted.getInstructions() ?? "";
  for (const [name, args] of PROBES) {
    const r = await hosted.callTool({ name, arguments: args });
    theirAnswers.set(`${name} ${JSON.stringify(args)}`, { text: textOf(r), attribution: r.structuredContent?.attribution });
  }
  await hosted.close();
} catch (err) {
  console.log(`  skip  ${HOSTED} unreachable (${err?.message ?? err}) — parity not checked this run.`);
  await local.close();
  process.exit(0);
}

console.log(`local: ${mine.length} tools · hosted: ${theirs.length} tools`);
check(mine.length === theirs.length, "same number of tools", `${mine.length} vs ${theirs.length}`);

const names = (xs) => xs.map((t) => t.name).sort().join(", ");
check(names(mine) === names(theirs), "same tool names", `${names(mine)}\n        ${names(theirs)}`);

for (const t of theirs) {
  const m = mine.find((x) => x.name === t.name);
  if (!m) {
    check(false, `${t.name} exists locally`);
    continue;
  }
  check(m.description === t.description, `${t.name} description matches verbatim`,
    m.description === t.description ? "" : `local : ${JSON.stringify(m.description).slice(0, 150)}\n        hosted: ${JSON.stringify(t.description).slice(0, 150)}`);
  check(m.title === t.title, `${t.name} title matches`, m.title === t.title ? "" : `${m.title} vs ${t.title}`);

  // Input schemas: the property set and every property's description.
  const mp = m.inputSchema?.properties ?? {};
  const tp = t.inputSchema?.properties ?? {};
  const keys = (o) => Object.keys(o).sort().join(", ");
  check(keys(mp) === keys(tp), `${t.name} same input properties`, keys(mp) === keys(tp) ? "" : `${keys(mp)} vs ${keys(tp)}`);
  for (const k of Object.keys(tp)) {
    if (!(k in mp)) continue;
    check(
      (mp[k].description ?? null) === (tp[k].description ?? null),
      `${t.name}.${k} description matches verbatim`,
      (mp[k].description ?? null) === (tp[k].description ?? null)
        ? ""
        : `local : ${JSON.stringify(mp[k].description).slice(0, 130)}\n        hosted: ${JSON.stringify(tp[k].description).slice(0, 130)}`,
    );
    check((mp[k].type ?? null) === (tp[k].type ?? null), `${t.name}.${k} same type`, `${mp[k].type} vs ${tp[k].type}`);
  }
  const req = (s) => (s?.required ?? []).slice().sort().join(", ");
  check(req(m.inputSchema) === req(t.inputSchema), `${t.name} same required fields`, `${req(m.inputSchema)} vs ${req(t.inputSchema)}`);

  for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"]) {
    check(m.annotations?.[hint] === t.annotations?.[hint], `${t.name} ${hint} matches`, `${m.annotations?.[hint]} vs ${t.annotations?.[hint]}`);
  }
}

/** The first place two strings part ways, with a window of both around it —
 *  a failure has to say WHERE, or the fix is a hunt through 1,400 chars. */
function whereTheyDiffer(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  const from = Math.max(0, i - 60);
  const win = (s) => JSON.stringify(s.slice(from, i + 90));
  return `differ at char ${i} (local ${a.length} chars, hosted ${b.length} chars)\n        local : ${win(a)}\n        hosted: ${win(b)}`;
}

// THE INSTRUCTIONS, VERBATIM. The hosted server interpolates its board count
// live (`activeRegions().length`), so the day a region flips, this line goes
// red and the desk re-syncs INSTRUCTIONS in server.js. It used to check only
// that the local string was longer than 400 chars, which a stale count passes.
const mineInstructions = local.getInstructions() ?? "";
check(
  mineInstructions === theirInstructions,
  "initialize instructions match the hosted server verbatim",
  mineInstructions === theirInstructions ? "" : whereTheyDiffer(mineInstructions, theirInstructions),
);

for (const [name, args] of PROBES) {
  const key = `${name} ${JSON.stringify(args)}`;
  const t = theirAnswers.get(key);
  if (!t) continue;
  const r = await local.callTool({ name, arguments: args });
  const mineText = maskTime(textOf(r));
  const theirText = maskTime(t.text);
  check(
    mineText === theirText,
    `${key} answers with the hosted words, footer included`,
    mineText === theirText ? "" : whereTheyDiffer(mineText, theirText),
  );
  check(
    r.structuredContent?.attribution === t.attribution,
    `${key} structuredContent.attribution matches`,
    `${JSON.stringify(r.structuredContent?.attribution)} vs ${JSON.stringify(t.attribution)}`,
  );
}

await local.close();
console.log(`\n${failures === 0 ? "PASS — the two transports publish the same contract" : `FAIL — ${failures} difference(s)`}`);
process.exit(failures === 0 ? 0 : 1);
