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
//
// SAME SECOND, ON PURPOSE. Every probe below is asked of the hosted server
// and then of this one back to back, before the next probe is asked of
// either, because most of what is compared is decided by the clock: which
// night is tonight, which curtains have gone up, how many shows are still
// ahead. Collecting every hosted answer first and every local answer after
// put a minute between the two reads of the same question, and a curtain
// inside that minute is a false failure.

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

let hosted;
let theirs;
try {
  hosted = new Client({ name: "scenef-parity", version: "1.0.0" });
  await hosted.connect(new StreamableHTTPClientTransport(new URL(HOSTED)));
  theirs = (await hosted.listTools()).tools;
} catch (err) {
  console.log(`  skip  ${HOSTED} unreachable (${err?.message ?? err}) — parity not checked this run.`);
  await local.close();
  process.exit(0);
}

const keyOf = (name, args) => `${name} ${JSON.stringify(args)}`;
const maskTime = (t) => t.replace(/data as of \S+/g, "data as of <data_as_of>");
const textOf = (r) => r.content?.find((c) => c.type === "text")?.text ?? "";

/** One probe, both transports, back to back — memoised so a probe named by
 *  several lists is asked once of each. */
const pairs = new Map();
async function pair(name, args) {
  const key = keyOf(name, args);
  if (!pairs.has(key)) {
    const their = await hosted.callTool({ name, arguments: args });
    const mine = await local.callTool({ name, arguments: args });
    pairs.set(key, { their, mine });
  }
  return pairs.get(key);
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

/** Tomorrow's calendar date on the la-central board's clock — a lit night
 *  for the search-with-date probe, computed the way the board computes it. */
function tomorrowIn(tz) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  const d = new Date(`${get("year")}-${get("month")}-${get("day")}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const TOMORROW = tomorrowIn("America/Los_Angeles");

// ————————————————————————————————————————————— the contract as published

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

// THE INSTRUCTIONS, VERBATIM. The hosted server interpolates its board count
// live (`activeRegions().length`), so the day a region flips, this line goes
// red and the desk re-syncs INSTRUCTIONS in server.js. It used to check only
// that the local string was longer than 400 chars, which a stale count passes.
const mineInstructions = local.getInstructions() ?? "";
const theirInstructions = hosted.getInstructions() ?? "";
check(
  mineInstructions === theirInstructions,
  "initialize instructions match the hosted server verbatim",
  mineInstructions === theirInstructions ? "" : whereTheyDiffer(mineInstructions, theirInstructions),
);

// ————————————————————————————————————————————————— the words of a miss
//
// A tool's description can match to the letter while the sentence it answers
// a miss with does not — that is the drift the 2026-09-08 review found (three
// different sentences for "not on the board"). These calls are made on both
// transports and the text compared whole, with only the data_as_of timestamp
// masked: the two read the same board, so everything else — the board's
// name, the id list and how it is joined, the footer — has to agree.
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
  // THE WHEN GRAMMAR REFUSES "today" — the hosted resolveWhen() accepts
  // tonight, tomorrow, weekend and a date, and answers anything else with
  // one sentence and no window. This server read "today" as tonight.
  ["scenef_whats_playing", { when: "today", max_results: 3 }],
  ["scenef_plan_movie_night", { when: "today" }],
  // SEARCH MATCHES OVER THE WHOLE BOARD, then filters to the night. With a
  // date, this server fetched the night slice and matched against only that
  // night's films, so the candidate list for an ambiguous title depended on
  // the date beside it. The hosted list is the board's.
  ["scenef_search_showtimes", { film: "the", region: "la-central", date: TOMORROW }],
  // AN AMBIGUOUS THEATER: the hosted matchVenue() is an either-way substring
  // over id, name and short, capped at eight, in board order.
  ["scenef_theater_info", { theater: "amc", region: "la-central" }],
];

for (const [name, args] of PROBES) {
  const key = keyOf(name, args);
  const { their, mine: r } = await pair(name, args);
  const mineText = maskTime(textOf(r));
  const theirText = maskTime(textOf(their));
  check(
    mineText === theirText,
    `${key} answers with the hosted words, footer included`,
    mineText === theirText ? "" : whereTheyDiffer(mineText, theirText),
  );
  check(
    r.structuredContent?.attribution === their.structuredContent?.attribution,
    `${key} structuredContent.attribution matches`,
    `${JSON.stringify(r.structuredContent?.attribution)} vs ${JSON.stringify(their.structuredContent?.attribution)}`,
  );
}

// ————————————————————————————————————————————— the numbers and the nights
//
// The prose of these tools is laid out differently on the two transports by
// design, so the text is not compared; the fields a caller branches on are,
// read from structuredContent on both sides in the same second. Each probe
// names the fields that must agree:
//   discounts       today is the board's CALENDAR date in its own zone, not
//                   the night the tonight slice rolled forward to — oahu is
//                   three hours behind and crosses midnight at a different
//                   instant, so the pair catches a "today" read off the
//                   wrong clock;
//   now             the LIVE night, decided at call time from Date.now() and
//                   the board's timezone — not the feed's cached tonight_is
//                   label, which after midnight still names the night the
//                   edge computed before it. screenings_tonight is the
//                   catchable set, still_to_come the not-started set;
//   whats_playing   the window label says WHICH night "tonight" resolved to
//                   ("tonight" / "tomorrow (nothing tonight)" / "<night>
//                   (next lit night)"); the weekend has its own label and
//                   nights rule; "today" is refused with window "", nights []
//                   and the refusal as the note; film_count is the number of
//                   rows RETURNED under max_results; and the ROWS — slug,
//                   venue_count, showtime_count — are the hosted selection:
//                   started shows dropped, ranked by venues, then shows,
//                   then rating;
//   search          started shows are dropped, the date grammar accepts
//                   "tonight", a theater name reaches every venue it names;
//   plan            exactly three plans plus a wildcard, each plan's
//                   screening, score and why[] lines, and the plan film url
//                   BARE as the hosted server prints it;
//   coming_soon     the first row is the film with the earliest first
//                   curtain, its opening venues by short name, and the
//                   horizon runs to a night, not to a millisecond;
//   theater_info    a query that CONTAINS a venue's name resolves (either-way
//                   substring), and upcoming_count is everything ahead, not
//                   the five rows shown.
const same = (...keys) => (s) => Object.fromEntries(keys.map((k) => [k, s?.[k]]));
const filmRows = (s) => (s?.films ?? []).map((f) => [f.slug, f.venue_count, f.showtime_count]);
const planRows = (s) => (s?.plans ?? []).map((p) => [p.showtime?.screening_id, p.score, p.why, p.film?.url]);
const wildcardRow = (s) => (s?.wildcard ? [s.wildcard.showtime?.screening_id, s.wildcard.score, s.wildcard.why, s.wildcard.film?.url] : null);
const venueCounts = (s) => (s?.venues ?? []).map((v) => [v.venue_id, v.showtimes?.length]);
const FIELDS = [
  ["scenef_discounts", {}, same("today_dow", "today_name", "applies_today_count")],
  ["scenef_discounts", { region: "oahu" }, same("today_dow", "today_name", "applies_today_count")],
  ["scenef_now", {}, same("night_of", "is_tonight", "screenings_tonight", "still_to_come")],
  ["scenef_now", { region: "la-central" }, same("night_of", "is_tonight", "screenings_tonight", "still_to_come")],
  ["scenef_now", { region: "oahu" }, same("night_of", "is_tonight", "screenings_tonight", "still_to_come")],
  ["scenef_whats_playing", { max_results: 3 }, (s) => ({ ...same("window", "nights", "film_count")(s), films_returned: s?.films?.length, rows: filmRows(s) })],
  ["scenef_whats_playing", { max_results: 3, region: "la-central" }, (s) => ({ ...same("window", "nights", "film_count")(s), films_returned: s?.films?.length, rows: filmRows(s) })],
  ["scenef_whats_playing", { when: "tomorrow", max_results: 3, region: "la-central" }, (s) => ({ ...same("window", "nights", "film_count")(s), rows: filmRows(s) })],
  ["scenef_whats_playing", { when: "weekend", max_results: 3, region: "la-central" }, (s) => ({ ...same("window", "nights", "film_count")(s), rows: filmRows(s) })],
  ["scenef_whats_playing", { when: "today", max_results: 3 }, same("window", "nights", "film_count", "note")],
  ["scenef_search_showtimes", { venues: ["amc"], region: "la-central", date: "tonight" }, (s) => ({ ...same("matched", "filtered_by", "showtime_count", "unknown_venues", "coverage_note")(s), by_venue: venueCounts(s) })],
  ["scenef_plan_movie_night", { region: "la-central" }, (s) => ({ ...same("window", "nights", "note", "discounts_relaxed", "plan_count")(s), plans: planRows(s), wildcard: wildcardRow(s) })],
  ["scenef_plan_movie_night", { region: "la-central", preferences: { likes: ["horror"] } }, (s) => ({ ...same("window", "nights", "plan_count")(s), plans: planRows(s), wildcard: wildcardRow(s) })],
  ["scenef_plan_movie_night", { when: "today" }, same("window", "nights", "note", "plan_count", "plans", "wildcard")],
  ["scenef_coming_soon", { region: "la-central", horizon_days: 7 }, (s) => ({ ...same("film_count")(s), first_row: s?.films?.[0] ? [s.films[0].slug, s.films[0].first_night, s.films[0].opening_venues] : null })],
  ["scenef_theater_info", { theater: "Roxie Theater San Francisco" }, (s) => ({ ...same("matched", "upcoming_count")(s), venue_id: s?.venue?.venue_id })],
];

for (const [name, args, fields] of FIELDS) {
  const key = keyOf(name, args);
  const { their, mine: r } = await pair(name, args);
  const mineF = fields(r.structuredContent);
  const theirF = fields(their.structuredContent);
  for (const k of Object.keys(theirF)) {
    const a = JSON.stringify(mineF[k]);
    const b = JSON.stringify(theirF[k]);
    check(a === b, `${key} ${k} agrees with the hosted server`, a === b ? "" : `${a} vs ${b}`);
  }
}

// A FILM SCOPED SEARCH, on a film the board is actually playing: the first
// curtain the hosted server names is on its board, so its slug is a safe
// query. Every count here is the not-started set — this server counted the
// whole run (54 for Akira on la-central where the hosted server counted the
// 30 still ahead).
{
  const { their: nowLA } = await pair("scenef_now", { region: "la-central" });
  const slug = nowLA.structuredContent?.next_curtains?.[0]?.film?.slug;
  if (!slug) {
    console.log("  skip  scenef_search_showtimes by film — the hosted la-central board named no next curtain to search for");
  } else {
    const args = { film: slug, region: "la-central" };
    const key = keyOf("scenef_search_showtimes", args);
    const { their, mine: r } = await pair("scenef_search_showtimes", args);
    const pick = (s) => ({ ...same("matched", "showtime_count")(s), film_url: s?.film?.url, by_venue: venueCounts(s) });
    const mineF = pick(r.structuredContent);
    const theirF = pick(their.structuredContent);
    for (const k of Object.keys(theirF)) {
      const a = JSON.stringify(mineF[k]);
      const b = JSON.stringify(theirF[k]);
      check(a === b, `${key} ${k} agrees with the hosted server`, a === b ? "" : `${a} vs ${b}`);
    }
  }
}

// ———————————————————————————————————————————————— the header line
//
// The one line of whats_playing prose that is mirrored verbatim: the label
// already carries the night for tomorrow and date windows, and this server
// appended it again ("tomorrow, Thursday, September 10, Thursday,
// September 10"). Read as the first line of the answer — the notable lead
// never rides a window that is not tonight.
for (const args of [
  { when: "tomorrow", max_results: 3, region: "la-central" },
  { when: "weekend", max_results: 3, region: "la-central" },
]) {
  const key = keyOf("scenef_whats_playing", args);
  const { their, mine: r } = await pair("scenef_whats_playing", args);
  const a = textOf(r).split("\n")[0];
  const b = textOf(their).split("\n")[0];
  check(a === b, `${key} header line matches the hosted server`, a === b ? "" : `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

// —————————————————————————————————————————————— the last-night flag
//
// is_last_night compares the film's final night to the LIVE night (the 4am
// rule on Date.now() in the board's zone), never to the night the tonight
// slice rolled forward to. After midnight, with the evening spent, this
// server flagged a film whose run ends TOMORROW as ending tonight. The film
// is found on the hosted board: the first film in tonight's window whose
// hosted answer carries the flag, if one exists; otherwise the fields are
// checked to agree on every film tried, and the run says no such film was
// found tonight.
{
  const { their: playing } = await pair("scenef_whats_playing", { max_results: 25 });
  const slugs = (playing.structuredContent?.films ?? []).map((f) => f.slug).slice(0, 8);
  let found = null;
  for (const slug of slugs) {
    const args = { film: slug };
    const key = keyOf("scenef_film_details", args);
    const { their, mine: r } = await pair("scenef_film_details", args);
    const pick = same("matched", "final_night", "is_last_night", "showtime_count");
    const mineF = pick(r.structuredContent);
    const theirF = pick(their.structuredContent);
    for (const k of Object.keys(theirF)) {
      const a = JSON.stringify(mineF[k]);
      const b = JSON.stringify(theirF[k]);
      check(a === b, `${key} ${k} agrees with the hosted server`, a === b ? "" : `${a} vs ${b}`);
    }
    if (their.structuredContent?.is_last_night === true) {
      found = slug;
      break;
    }
  }
  if (found) console.log(`        (${found} is on its last night on the hosted board — the flag agreed)`);
  else if (slugs.length) console.log(`        (no film among the first ${slugs.length} tonight is on its last night on the hosted board — the flag agreed as false on each)`);
  else console.log("  skip  scenef_film_details is_last_night — the hosted board returned no films for tonight");
}

// ————————————————————————————————————— film urls off a non-default board
//
// The two transports may rank a list differently, so the urls are not
// compared row for row: the hosted answer's first film gives the SHAPE
// (/film/{slug}/la-central), and every local film on the same board must fit
// it. A bare /film/{slug} here sends a Los Angeles reader to San Francisco's
// showtimes for the film, or to a 404.
const URL_SHAPE = [
  ["scenef_whats_playing", { max_results: 3, region: "la-central" }, (s) => s?.films ?? []],
  ["scenef_coming_soon", { region: "la-central", horizon_days: 7 }, (s) => s?.films ?? []],
  ["scenef_now", { region: "la-central" }, (s) => (s?.next_curtains ?? []).map((c) => c.film).filter(Boolean)],
];

for (const [name, args, films] of URL_SHAPE) {
  const key = keyOf(name, args);
  const { their, mine: r } = await pair(name, args);
  const theirFilms = films(their.structuredContent);
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

await hosted.close();
await local.close();
console.log(`\n${failures === 0 ? "PASS — the two transports publish the same contract" : `FAIL — ${failures} difference(s)`}`);
process.exit(failures === 0 ? 0 : 1);
