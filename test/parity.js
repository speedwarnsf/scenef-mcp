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
  // AN AMBIGUOUS FILM, ON TWO BOARDS. "the" matches dozens of titles, so the
  // answer is the candidate list — its members, their ORDER, and each one's
  // film page. The local matcher was exact → prefix → substring where the
  // hosted one is substring in board order, and it printed /film/{slug}
  // from every board where the hosted server prints /film/{slug}/la-central
  // off a non-default one. Both drifts are visible in this one sentence.
  ["scenef_search_showtimes", { film: "the" }],
  ["scenef_search_showtimes", { film: "the", region: "la-central" }],
  ["scenef_film_details", { film: "the", region: "la-central" }],
];

// THE NUMBERS AND THE NIGHTS. The prose of these tools is laid out
// differently on the two transports by design, so the text is not compared;
// the fields a caller branches on are. Each probe names the fields that must
// agree, read from structuredContent on both sides at (nearly) the same
// instant:
//   discounts       today is the board's CALENDAR date in its own zone, not
//                   the night the tonight slice rolled forward to — oahu is
//                   three hours behind and crosses midnight at a different
//                   instant, so the pair catches a "today" read off the
//                   wrong clock;
//   whats_playing   the window label says WHICH night "tonight" resolved to
//                   ("tonight" / "tomorrow (nothing tonight)" / "<night>
//                   (next lit night)"), and film_count is the number of rows
//                   RETURNED under max_results, not the number matched;
//   plan / now      the same label and night, where they are also used.
const same = (...keys) => (s) => Object.fromEntries(keys.map((k) => [k, s?.[k]]));
const FIELDS = [
  ["scenef_discounts", {}, same("today_dow", "today_name", "applies_today_count")],
  ["scenef_discounts", { region: "oahu" }, same("today_dow", "today_name", "applies_today_count")],
  ["scenef_whats_playing", { max_results: 3 }, (s) => ({ ...same("window", "nights", "film_count")(s), films_returned: s?.films?.length })],
  ["scenef_whats_playing", { max_results: 3, region: "la-central" }, (s) => ({ ...same("window", "nights", "film_count")(s), films_returned: s?.films?.length })],
  ["scenef_plan_movie_night", { region: "la-central" }, same("window", "nights")],
  ["scenef_now", { region: "la-central" }, same("night_of", "is_tonight")],
  ["scenef_coming_soon", { region: "la-central", horizon_days: 7 }, same("film_count")],
];

// FILM URLS OFF A NON-DEFAULT BOARD. The two transports may rank a list
// differently, so the urls are not compared row for row: the hosted answer's
// first film gives the SHAPE (/film/{slug}/la-central), and every local film
// on the same board must fit it. A bare /film/{slug} here sends a Los Angeles
// reader to San Francisco's showtimes for the film, or to a 404.
const URL_SHAPE = [
  ["scenef_whats_playing", { max_results: 3, region: "la-central" }, (s) => s?.films ?? []],
  ["scenef_coming_soon", { region: "la-central", horizon_days: 7 }, (s) => s?.films ?? []],
  ["scenef_now", { region: "la-central" }, (s) => (s?.next_curtains ?? []).map((c) => c.film).filter(Boolean)],
];

const keyOf = (name, args) => `${name} ${JSON.stringify(args)}`;
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
  for (const [name, args] of [...PROBES, ...FIELDS, ...URL_SHAPE]) {
    const key = keyOf(name, args);
    if (theirAnswers.has(key)) continue;
    const r = await hosted.callTool({ name, arguments: args });
    theirAnswers.set(key, { text: textOf(r), attribution: r.structuredContent?.attribution, data: r.structuredContent });
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

// One local call per distinct probe, whichever lists name it.
const mineAnswers = new Map();
async function callMine(name, args) {
  const key = keyOf(name, args);
  if (!mineAnswers.has(key)) mineAnswers.set(key, await local.callTool({ name, arguments: args }));
  return mineAnswers.get(key);
}

for (const [name, args] of PROBES) {
  const key = keyOf(name, args);
  const t = theirAnswers.get(key);
  if (!t) continue;
  const r = await callMine(name, args);
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

for (const [name, args, fields] of FIELDS) {
  const key = keyOf(name, args);
  const t = theirAnswers.get(key);
  if (!t) continue;
  const r = await callMine(name, args);
  const mine = fields(r.structuredContent);
  const their = fields(t.data);
  for (const k of Object.keys(their)) {
    const a = JSON.stringify(mine[k]);
    const b = JSON.stringify(their[k]);
    check(a === b, `${key} ${k} agrees with the hosted server`, `${a} vs ${b}`);
  }
}

for (const [name, args, films] of URL_SHAPE) {
  const key = keyOf(name, args);
  const t = theirAnswers.get(key);
  if (!t) continue;
  const r = await callMine(name, args);
  const theirFilms = films(t.data);
  const mineFilms = films(r.structuredContent);
  const first = theirFilms[0];
  if (!first?.url || !first?.slug) {
    console.log(`  skip  ${key} — the hosted answer carried no film to take the url shape from`);
    continue;
  }
  const shape = first.url.split(first.slug).join("{slug}");
  const wrong = mineFilms.filter((f) => f.url !== shape.split("{slug}").join(f.slug));
  check(
    mineFilms.length > 0 && !wrong.length,
    `${key} every film url fits the hosted shape ${shape}`,
    wrong.length ? wrong.slice(0, 3).map((f) => f.url).join(", ") : mineFilms.length ? "" : "no films returned locally",
  );
}

await local.close();
console.log(`\n${failures === 0 ? "PASS — the two transports publish the same contract" : `FAIL — ${failures} difference(s)`}`);
process.exit(failures === 0 ? 0 : 1);
