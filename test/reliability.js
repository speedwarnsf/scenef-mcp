// Offline regressions for the September 18 agent journey. Exercise the real
// MCP protocol against fixture REST responses, not a separate serializer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";
import { MEMBER_PRICING, displayTime, freshnessAt, withheldDetail } from "../src/shape.js";

const day = "2099-10-02";
const verified = "2026-09-01T00:00:00Z";
const venues = [
  { id: "regal-dole-cannery", name: "Regal Dole Cannery", short: "Dole Cannery", neighborhood: "Iwilei", discounts: [] },
  { id: "consolidated-ward", name: "Consolidated Ward", short: "Ward", neighborhood: "Kakaako", discounts: [] },
];
const films = [{ key: "fixture-film", slug: "fixture-film", title: "Fixture Film", year: 2026, runtimeMin: 100, genres: ["Comedy"], directors: [] }];
const feed = {
  data_as_of: "2026-09-18T00:00:00Z", region: "oahu", region_name: "Oahu", timezone: "Pacific/Honolulu",
  accuracy: "https://scenef.com/api/accuracy", venues, films,
  screenings: [18, 20, 21].map((hour, i) => ({
    id: `fixture-${i}`, filmKey: films[0].key, venueId: venues[i % 2].id,
    startsAt: `${day}T${hour}:00:00-10:00`, nightOf: day, tags: [],
    ticketUrl: `https://scenef.com/go/fixture-${i}`, confidence: "single-source", source_tier: "licensed-feed",
    sources: ["fixture-source"], verified_at: verified, note: "Retained after source failure",
    freshness: { status: "stale", age_hours: 408, stale_after_hours: 24, retained: true, source_status: "held" },
  })),
};
const accuracy = {
  data_as_of: feed.data_as_of, attribution: "SceneF — https://scenef.com",
  site: { checks: 0, confirmed: 0, missing: 0, unreachable: 0, pass_rate: null, window_days: 30,
    pass_rate_basis: "confirmed divided by attempted checks", screenings: 3, confidence_mix: { "single-source": 3 } },
  venues: [], method: { rings: [], confidence_levels: {} }, docs: "https://scenef.com/methodology",
};
// A second board for the hosted 1b13eec/7188e71 rules: three films the
// general-audience guard must sort (an NC-17 certificate; a PG synopsis whose
// SECOND sentence carries a listed word; an R synopsis full of near-misses),
// one wide run past the 40-row concise cap, and a theater whose membership
// and discount card must not print their prices.
const tmdbPoster = "https://image.tmdb.org/t/p/w500/x.jpg";
const heldFilms = [
  { key: "rated", slug: "rated", title: "Rated", year: 1995, runtimeMin: 128, genres: ["Drama"], directors: ["A"], mpaa: "NC-17",
    overview: "A dancer arrives in a desert city.", posterUrl: tmdbPoster, backdropUrl: tmdbPoster, trailerYoutubeKey: "aaa", ratings: { tmdb: 5.1 } },
  { key: "worded", slug: "worded", title: "Worded", year: 1950, runtimeMin: 88, genres: ["Crime"], directors: ["B"], mpaa: "PG",
    overview: "A woodcutter tells a court what he found in the grove. Each witness describes the rape differently.", posterUrl: tmdbPoster, trailerYoutubeKey: "bbb" },
  { key: "plain", slug: "plain", title: "Plain", year: 2026, runtimeMin: 101, genres: ["Comedy"], directors: ["C"], mpaa: "R",
    overview: "A therapist inherits her uncle's vineyard. The grapes, the drapes and the debts come with it.", posterUrl: tmdbPoster, trailerYoutubeKey: "ccc", cast: ["1", "2", "3", "4", "5", "6", "7", "8"] },
  { key: "elsewhere", slug: "elsewhere", title: "Elsewhere", year: 2026, runtimeMin: 95, genres: ["Comedy"], directors: [], mpaa: "PG-13",
    overview: "A quiet film.", posterUrl: "https://m.media-amazon.com/images/x.jpg" },
];
const heldVenue = { id: "house", name: "The House", short: "House", neighborhood: "Center", platform: "veezi", discounts: [
  { kind: "membership", label: "Patron Plan", detail: "Fan $10 tickets · Patron $7" },
  { kind: "card", label: "Ten-pack", detail: "10 admissions for $90" },
  { kind: "weekly", label: "Tuesday discount", detail: "$8 all day", day: 2 },
] };
const heldFeed = {
  ...feed, region: "held", region_name: "Held", venues: [heldVenue], films: heldFilms,
  screenings: [
    // h-1 carries tags, sold-out among them: every prose line that names a
    // showtime must say so (hosted tagBadge()).
    ...heldFilms.map((f, i) => ({ ...feed.screenings[0], id: `h-${i}`, filmKey: f.key, venueId: heldVenue.id, startsAt: `${day}T1${i}:00:00-10:00`,
      ticketUrl: `https://scenef.com/go/h-${i}?region=held`, tags: i === 1 ? ["35mm", "sold-out"] : [] })),
    ...Array.from({ length: 45 }, (_, i) => ({ ...feed.screenings[0], id: `w-${i}`, filmKey: "plain", venueId: heldVenue.id,
      startsAt: `2099-10-${String(3 + Math.floor(i / 5)).padStart(2, "0")}T${String(14 + (i % 5) * 2).padStart(2, "0")}:00:00-10:00`,
      nightOf: `2099-10-${String(3 + Math.floor(i / 5)).padStart(2, "0")}` })),
  ],
};
// THE EDGE'S EXPIRED COPY (feed.js): "edge" is served STALE once and then
// refreshed, as Vercel's stale-while-revalidate does; "stuck" stays STALE,
// as it does when the origin cannot revalidate.
const edgeCalls = { edge: 0, stuck: 0 };
const OLD_AS_OF = "2026-09-17T18:00:00Z";
const staleHeaders = { "x-vercel-cache": "STALE", age: "300", "cache-control": "public, max-age=60" };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = new URL(input);
  const edgeBoard = url.pathname === "/api/listings" ? url.searchParams.get("region") : null;
  if (edgeBoard === "edge" || edgeBoard === "stuck") {
    edgeCalls[edgeBoard] += 1;
    const board = { ...feed, region: edgeBoard, region_name: edgeBoard };
    if (edgeBoard === "stuck" || edgeCalls.edge === 1) return Response.json({ ...board, data_as_of: OLD_AS_OF }, { headers: staleHeaders });
    return Response.json(board, { headers: { "x-vercel-cache": "HIT", age: "0" } });
  }
  if (url.searchParams.get("region") === "unknown") return Response.json({ error: "unusable_parameter" }, { status: 400 });
  if (url.pathname === "/api/listings" && url.searchParams.get("region") === "held") return Response.json(heldFeed);
  if (url.pathname === "/api/listings") return Response.json(feed);
  if (url.pathname === "/api/accuracy") return Response.json(accuracy);
  if (url.pathname === "/api/boards") return Response.json({ count: 1, boards: [{ region: "oahu", name: "Oahu", timezone: feed.timezone }],
    resolved: { ok: true, input: "Honolulu", matched: "city", region: "oahu", region_name: "Oahu" } });
  throw new Error(`Unexpected fixture request: ${url}`);
};

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createServer();
const client = new Client({ name: "reliability-test", version: "1" });
try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const served = (await client.listTools()).tools;
  const canonical = JSON.parse(readFileSync(new URL("./fixtures/hosted-tool-contract.json", import.meta.url), "utf8"));
  // Required fields are sets. Everything else — the $schema label included
  // (server.js relabels the SDK's draft-07 as the hosted 2020-12) — must
  // match as published.
  const normalize = (value, key) => {
    if (Array.isArray(value)) return key === "required" ? [...value].sort() : value.map((v) => normalize(v));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, k)]));
  };
  for (const expected of canonical) {
    const actual = served.find((tool) => tool.name === expected.name);
    assert.ok(actual, expected.name);
    for (const side of ["inputSchema", "outputSchema"]) assert.deepEqual(normalize(actual[side]), normalize(expected[side]), `${expected.name} ${side}`);
  }
  console.log("PASS all ten input/output schemas match the canonical hosted contract constraints");

  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: { region: "oahu", ...args } });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    return result;
  };
  for (const format of ["concise", "detailed"]) {
    const result = await call("scenef_whats_playing", { when: day, response_format: format });
    const row = result.structuredContent.films[0];
    assert.equal(row.showtime_count, 3);
    assert.equal(row.showtimes.length, format === "concise" ? 1 : 3);
    assert.equal(row.showtimes_complete, format === "detailed");
    assert.deepEqual(row.showtimes[0], row.next_showtime);
    assert.equal(row.next_showtime.verified_at, verified);
    assert.equal(row.next_showtime.freshness.source_status, "held");
    assert.equal((result.content[0].text.match(/Freshness:/g) ?? []).length, 1);
  }
  const planResult = await call("scenef_plan_movie_night", { when: day, preferences: { time_after: "19:00" } });
  const plan = planResult.structuredContent;
  assert.equal(plan.plans.length, 1);
  assert.equal(plan.plans[0].film.url, "https://scenef.com/film/fixture-film/oahu");
  const screening = plan.plans[0].showtime;
  assert.equal(screening.starts_at, `${day}T20:00:00-10:00`);
  for (const key of ["ticket_url", "calendar_url"]) assert.equal(new URL(screening[key]).searchParams.get("region"), "oahu");
  assert.ok(planResult.content[0].text.includes(screening.calendar_url));
  assert.equal(screening.calendar_feed, screening.calendar_url);
  assert.deepEqual(screening.sources, ["fixture-source"]);
  assert.equal(screening.confidence, "single-source");
  assert.equal(screening.source_tier, "licensed-feed");
  assert.equal(screening.verified_at, verified);
  assert.equal(screening.freshness.retained, true);
  console.log("PASS bounded legacy showtime array, retained provenance, and regional film/ticket/calendar links");

  for (const time of ["7pm", "24:00", "19:99", ""]) {
    const result = await call("scenef_search_showtimes", { film: films[0].title, date: day, time_after: time });
    assert.equal(result.structuredContent.matched, false);
    assert.equal(result.structuredContent.showtime_count, 0);
    assert.ok(result.structuredContent.warnings.length);
    assert.ok(result.content[0].text.startsWith("No search was run:"));
    const plan = (await call("scenef_plan_movie_night", { when: day, preferences: { time_after: time } })).structuredContent;
    assert.equal(plan.plan_count, 0);
    assert.ok(plan.warnings.length);
  }
  for (const date of ["2026-02-30", "2026-13-01", "not-a-date", ""]) {
    const refused = (await call("scenef_search_showtimes", { film: films[0].title, date })).structuredContent;
    assert.equal(refused.matched, false);
    assert.equal(refused.showtime_count, 0);
    assert.ok(refused.warnings.length);
    if (date) {
      const refusedPlan = (await call("scenef_plan_movie_night", { when: date })).structuredContent;
      assert.equal(refusedPlan.plan_count, 0);
      assert.ok(refusedPlan.warnings.length);
    }
  }
  assert.equal((await call("scenef_plan_movie_night", { when: day, preferences: { time_after: "22:00", time_before: "19:00" } })).structuredContent.plan_count, 0);
  assert.equal((await call("scenef_search_showtimes", { venues: [venues[0].id], date: day })).structuredContent.showtime_count, 2);
  for (const [name, args] of [
    ["scenef_theater_info", { theater: venues[0].id }], ["scenef_film_details", { film: films[0].title }],
    ["scenef_discounts", {}], ["scenef_coming_soon", {}], ["scenef_now", {}], ["scenef_accuracy", {}],
  ]) await call(name, args);
  const theater = (await call("scenef_theater_info", { theater: venues[0].id })).structuredContent.venue;
  assert.equal(theater.region, "oahu");
  assert.equal(theater.url, "https://scenef.com/theater/regal-dole-cannery");
  assert.equal(theater.calendar_feed, "https://scenef.com/feeds/theater/regal-dole-cannery.ics");
  console.log("PASS Oahu venue card uses the canonical theater-id route");
  const record = (await call("scenef_accuracy")).structuredContent;
  assert.equal(record.region, "oahu");
  assert.equal(record.timezone, feed.timezone);
  assert.equal(new URL(record.accuracy_url).searchParams.get("region"), "oahu");
  assert.notEqual((await client.callTool({ name: "scenef_resolve_board", arguments: { place: "Honolulu" } })).isError, true);
  assert.equal((await client.callTool({ name: "scenef_now", arguments: { region: "unknown" } })).isError, true);
  console.log("PASS actual MCP calls fail closed for hard filters and validate all ten tool outputs");

  // THE LISTING STAYS; THE SYNOPSIS AND THE ART STAND BACK — the hosted
  // scripts/test-general-audience.ts predicate table, verbatim.
  for (const mpaa of ["NC-17", "nc-17", "NC17", "X"]) assert.equal(withheldDetail({ mpaa }), true, mpaa);
  for (const overview of ["the rape of his wife", "she was raped", "incestuous", "barely-legal", "barely legal", "a sex worker",
    "sex workers", "pornographic", "eroticism", "a Japanese pink film", "the rapes"]) assert.equal(withheldDetail({ overview }), true, overview);
  for (const mpaa of ["R", "NR", "PG", undefined]) assert.equal(withheldDetail({ mpaa }), false, String(mpaa));
  for (const overview of ["grapes and drapes", "a therapist", "the trapeze", "rapeseed oil", "scrapes", ""]) assert.equal(withheldDetail({ overview }), false, overview);
  const held = (name, args) => client.callTool({ name, arguments: { region: "held", ...args } });
  for (const format of ["concise", "detailed"]) {
    for (const slug of ["rated", "worded"]) {
      const r = await held("scenef_film_details", { film: slug, response_format: format });
      for (const k of ["overview", "hook", "poster_url", "trailer_url", "backdrop_url", "ratings"]) assert.ok(!(k in r.structuredContent.film), `${slug} ${format} carries ${k}`);
      assert.equal(r.structuredContent.film.mpaa, slug === "rated" ? "NC-17" : "PG");
      const film = heldFilms.find((f) => f.slug === slug);
      assert.ok(!/Trailer: |Poster: /.test(r.content[0].text) && !r.content[0].text.includes(film.overview.slice(0, 30)), `${slug} ${format} prose`);
    }
    const plain = (await held("scenef_film_details", { film: "plain", response_format: format })).structuredContent;
    assert.equal(plain.film.poster_url, tmdbPoster);
    assert.equal(plain.film.trailer_url, "https://www.youtube.com/watch?v=ccc");
    assert.equal(plain.film.overview, heldFilms[2].overview);
    assert.equal(plain.film.cast.length, 6);
    assert.ok(!("backdrop_url" in plain.film) && "tmdb_rating" in plain.film);
    // ROW CAPS: the nearest 40 (concise) or up to 200 (detailed) of the total.
    assert.equal(plain.showtime_count, 46);
    assert.equal(plain.showtimes.length, format === "concise" ? 40 : 46);
    assert.equal(plain.showtimes_complete, format !== "concise");
    assert.equal(typeof plain.note, format === "concise" ? "string" : "object");
    const search = (await held("scenef_search_showtimes", { film: "plain", response_format: format })).structuredContent;
    assert.equal(search.showtime_count, 46);
    assert.equal(search.venues.reduce((n, v) => n + v.showtimes.length, 0), format === "concise" ? 40 : 46);
    assert.equal(search.showtimes_complete, format !== "concise");
    const playing = (await held("scenef_whats_playing", { when: day, response_format: format })).structuredContent.films;
    for (const f of playing) assert.equal("hook" in f, f.slug === "plain" || f.slug === "elsewhere", `${f.slug} hook key`);
  }
  assert.equal((await held("scenef_film_details", { film: "elsewhere" })).structuredContent.film.poster_url, null);
  const planText = (await held("scenef_plan_movie_night", { when: day })).content[0].text;
  for (const f of heldFilms.slice(0, 2)) assert.ok(!planText.includes(f.overview.slice(0, 30)), `${f.slug} synopsis in plan prose`);
  console.log("PASS held films keep their listing and lose synopsis, hook, poster and trailer; only TMDB posters; 40/200 row caps");

  // MEMBERSHIP PRICING IS THE THEATER'S TO STATE.
  const card = (await held("scenef_theater_info", { theater: "house" })).structuredContent.venue;
  const grid = (await held("scenef_discounts", {})).structuredContent.venues[0].discounts;
  for (const rows of [card.discounts, grid]) {
    assert.deepEqual(rows.slice(0, 2).map((d) => [d.label, d.detail]), [["Membership", MEMBER_PRICING], ["Discount card", MEMBER_PRICING]]);
    assert.deepEqual([rows[2].label, rows[2].detail, rows[2].day_name], ["Tuesday discount", "$8 all day", "Tuesday"]);
  }
  for (const name of ["scenef_theater_info", "scenef_discounts"]) {
    const t = (await held(name, name === "scenef_theater_info" ? { theater: "house" } : {})).content[0].text;
    assert.ok(!/\$10|\$7|\$90|Patron Plan|Ten-pack/.test(t), `${name} prose prints member pricing`);
  }
  assert.equal(card.platform, "veezi");
  console.log("PASS membership and discount-card pricing reads \"Member pricing; see the theater\"");

  // FRESHNESS IS AGED AT CALL TIME — the hosted createFreshnessReader().
  const nowMs = Date.parse("2026-10-10T12:00:00Z");
  const row = { status: "current", age_hours: 1.5, stale_after_hours: 24, retained: false, source_status: "ok" };
  assert.deepEqual(freshnessAt(row, "2026-10-10T10:00:00Z", nowMs), { ...row, status: "current", age_hours: 2 });
  assert.deepEqual(freshnessAt(row, "2026-10-09T11:59:00Z", nowMs), { ...row, status: "stale", age_hours: 24.02 });
  assert.deepEqual(freshnessAt(row, "2026-10-09T12:00:00Z", nowMs), { ...row, status: "current", age_hours: 24 });
  for (const v of ["2026-10-11T00:00:00Z", null, "not a time"]) {
    assert.deepEqual(freshnessAt(row, v, nowMs), { ...row, status: "unknown", age_hours: null }, String(v));
  }
  assert.deepEqual(freshnessAt({ ...row, stale_after_hours: null }, "2026-10-10T10:00:00Z", nowMs), { ...row, stale_after_hours: null });
  const aged = (await call("scenef_whats_playing", { when: day })).structuredContent.films[0].next_showtime.freshness;
  const expectHours = Math.round((Date.now() - Date.parse(verified)) / 36_000) / 100;
  assert.ok(Math.abs(aged.age_hours - expectHours) <= 0.02, `age_hours ${aged.age_hours} is aged from verified_at (${expectHours}), not copied (408)`);
  assert.deepEqual([aged.status, aged.stale_after_hours, aged.retained, aged.source_status], ["stale", 24, true, "held"]);
  console.log("PASS freshness age_hours and status are aged from verified_at at call time; allowance, retained and source_status kept");

  // THE FACTS THE HOSTED PROSE STATES, stated here too.
  const ratedText = (await held("scenef_film_details", { film: "rated" })).content[0].text;
  assert.ok(ratedText.includes("TMDB 5.1/10") && ratedText.includes("Film page: https://scenef.com/film/rated/held"), "film_details rating and film page");
  const searchText = (await call("scenef_search_showtimes", { film: films[0].title })).content[0].text;
  assert.ok(searchText.split("\n").includes("Showtimes for Fixture Film (2026) · https://scenef.com/film/fixture-film/oahu"), "search header carries the film page");
  const planDetailed = (await call("scenef_plan_movie_night", { when: day, response_format: "detailed" })).content[0].text;
  assert.ok(/ · screening fixture-\d · film: https:\/\/scenef\.com\/film\/fixture-film\/oahu/.test(planDetailed), "plan detailed names the screening and the film page");
  assert.ok(planDetailed.includes(`confidence single-source · source_tier licensed-feed (fixture-source) · verified_at ${verified} · note: Retained after source failure`), "plan detailed carries the hosted accuracy stamp");
  const houseText = (await held("scenef_theater_info", { theater: "house" })).content[0].text;
  assert.ok(!/Nonprofit:/.test(houseText), "theater_info prints no line the hosted card does not");
  console.log("PASS the prose states the hosted facts: TMDB rating, film pages, plan sources; no local-only nonprofit line");

  // THE HOSTED PROSE, LINE FOR LINE (src/lib/mcp/tools.ts renderers): the
  // tags on every showtime line — a sold-out show is never a bare ticket
  // link — each row's accuracy stamp in detailed mode, and the hosted
  // sentences where this server once had its own.
  const stamp = `confidence single-source · source_tier licensed-feed (fixture-source) · verified_at ${verified} · note: Retained after source failure`;
  const soldOut = "Worded (1950) [35mm, sold-out] · https://scenef.com/go/h-1?region=held";
  const houseDetailed = (await held("scenef_theater_info", { theater: "house", response_format: "detailed" })).content[0].text;
  assert.ok(houseDetailed.includes(`- Friday, October 2 · 11:00 AM — Worded [35mm, sold-out] · https://scenef.com/go/h-1?region=held\n  ${stamp}`), "theater_info row carries its tags and, in detailed, its stamp");
  assert.ok(houseDetailed.includes("\nvenue id: house · platform: veezi · lat/lng: undefined, undefined\n"), "theater_info detailed names the venue id, platform and position");
  assert.ok(houseDetailed.includes("- Tuesday discount (Tuesdays): $8 all day"), "theater_info discount line");
  const nowHeld = (await held("scenef_now", { response_format: "detailed" })).content[0].text;
  assert.ok(nowHeld.includes(`at House [35mm, sold-out] · https://scenef.com/go/h-1?region=held\n  ${stamp}`), "scenef_now row carries its tags and its stamp");
  const searchHeld = (await held("scenef_search_showtimes", { venues: ["house"], date: day, response_format: "detailed" })).content[0].text;
  assert.ok(searchHeld.includes(`- Friday, October 2 · 11:00 AM · ${soldOut}\n  screening h-1 · night ${day} · calendar: https://scenef.com/feeds/screening/h-1.ics?region=held\n  ${stamp}`), "search detailed rows: screening, night, calendar, stamp");
  const filmHeld = (await held("scenef_film_details", { film: "worded", response_format: "detailed" })).content[0].text;
  assert.ok(filmHeld.includes(`at House [35mm, sold-out] · https://scenef.com/go/h-1?region=held\n  screening h-1 · calendar: https://scenef.com/feeds/screening/h-1.ics?region=held · ${stamp}`), "film_details detailed row");
  const playingHeld = (await held("scenef_whats_playing", { when: day, response_format: "detailed" })).content[0].text;
  assert.ok(playingHeld.includes(`   - Friday, October 2 · 11:00 AM at House [35mm, sold-out] · https://scenef.com/go/h-1?region=held\n     ${stamp}`), "whats_playing detailed row");
  const gridText = (await held("scenef_discounts", { response_format: "detailed" })).content[0].text;
  assert.ok(/^Theater discounts on this board — today is \w+day:\n/.test(gridText), "discounts header names today");
  assert.ok(gridText.includes("- Tuesday discount (Tuesdays): $8 all day") && gridText.includes("  kind: weekly · venue: house"), "discount line and detailed kind/venue");
  assert.ok(/\n\d+ day-bound discounts? appl(?:y|ies) today; matinee, membership, and discount-card pricing runs on its own terms any day\.\n/.test(gridText), "discounts close with the any-day sentence");
  const soon = (await call("scenef_coming_soon", {})).content[0].text;
  assert.ok(soon.startsWith("Nothing new opening more than 48 hours out within 21 days.\n"), "coming_soon empty sentence is the hosted one");
  const rec = (await call("scenef_accuracy", {})).content[0].text;
  assert.ok(rec.includes("\nRecord opened not yet · last check none in window.\n") && rec.includes("\nPer venue (0 publishing showtimes):"), "accuracy prose is the hosted snapshot");
  console.log("PASS the hosted prose: tags on every showtime line, detailed stamps, hosted sentences");

  // ONE CLOCK FOR local_time AND THE TIME FILTER (hosted displayTime(iso,
  // tz)): the instant in the board's zone, never the literal HH:MM. On
  // fall-back day a single-pass noon-offset row reads 1:30 AM, as
  // eveningMinutes() does.
  assert.equal(displayTime("2026-11-01T00:30:00-08:00", "America/Los_Angeles"), "1:30 AM");
  assert.equal(displayTime("2099-10-02T20:00:00-10:00", "Pacific/Honolulu"), "8:00 PM");
  console.log("PASS local_time is the instant on the board's clock");

  // AN UNKNOWN TOOL IS A PROTOCOL ERROR, as on the hosted server — not a
  // tool result marked isError.
  await assert.rejects(client.callTool({ name: "scenef_nope", arguments: {} }), (err) => err.code === -32602 && /Tool scenef_nope not found$/.test(err.message));
  console.log("PASS an unknown tool name is refused with JSON-RPC -32602");

  // SOURCE HEALTH IS PER THEATER, from each row's source_status: both
  // fixture houses are "held", so both are unhealthy and named in the hosted
  // staleLine() words, aged from their newest verified row.
  const nowCall = await client.callTool({ name: "scenef_now", arguments: { region: "oahu" } });
  const src = nowCall.structuredContent.sources;
  assert.deepEqual([src.healthy, src.total], [0, 2]);
  assert.deepEqual(src.unhealthy.map((u) => u.venue_id), ["regal-dole-cannery", "consolidated-ward"]);
  assert.match(src.unhealthy[1].note, /^Consolidated Ward: listings may be out of date \(last updated \d+ days ago\)$/);
  const nowText = nowCall.content[0].text.split("\n");
  assert.ok(nowText.some((l) => /^Data: generated .* · 0\/2 sources healthy \(theaters with listings on this board\)\.$/.test(l)), "Data line counts theaters");
  assert.ok(nowText.includes(`- ${src.unhealthy[0].note}`) && nowText.includes(`- ${src.unhealthy[1].note}`), "each unhealthy theater is named in the prose");
  console.log("PASS scenef_now counts and names unhealthy theaters from each row's source_status");

  // A STALE EDGE COPY IS ASKED FOR AGAIN, and one that will not refresh is said.
  const fresh = await client.callTool({ name: "scenef_whats_playing", arguments: { region: "edge", when: day } });
  assert.equal(fresh.structuredContent.data_as_of, feed.data_as_of);
  assert.equal(edgeCalls.edge, 2);
  assert.ok(!/Local server note/.test(fresh.content[0].text));
  const started = Date.now();
  const stuck = await client.callTool({ name: "scenef_whats_playing", arguments: { region: "stuck", when: day } });
  assert.notEqual(stuck.isError, true);
  assert.equal(stuck.structuredContent.data_as_of, OLD_AS_OF);
  assert.equal(edgeCalls.stuck, 4);
  assert.ok(Date.now() - started >= 2_700, "three retries were waited for");
  assert.ok(/\nLocal server note: SceneF's edge cache answered with an expired copy \(cached 300s ago\) and was still serving it after 3 retries/.test(stuck.content[0].text));
  assert.ok(!("note" in stuck.structuredContent) || stuck.structuredContent.note === null, "the structured payload keeps the hosted key set");
  console.log("PASS a STALE edge copy is refetched; one the edge will not refresh is served once, briefly, and said");
} finally {
  await client.close();
  await server.close();
  globalThis.fetch = originalFetch;
}
