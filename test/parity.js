// ONE CONTRACT, TWO TRANSPORTS — proven, not asserted.
//
// This server and the hosted one at https://scenef.com/mcp publish the same
// nine tools. If the names, descriptions, or input schemas drift apart, an
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

let theirs;
try {
  const hosted = new Client({ name: "scenef-parity", version: "1.0.0" });
  await hosted.connect(new StreamableHTTPClientTransport(new URL(HOSTED)));
  theirs = (await hosted.listTools()).tools;
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

check(
  (local.getInstructions() ?? "").length > 400,
  "local initialize carries the server instructions",
);

await local.close();
console.log(`\n${failures === 0 ? "PASS — the two transports publish the same contract" : `FAIL — ${failures} difference(s)`}`);
process.exit(failures === 0 ? 0 : 1);
