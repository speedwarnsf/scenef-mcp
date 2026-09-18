// Offline regressions for the September 18 agent journey. Exercise the real
// MCP protocol against fixture REST responses, not a separate serializer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";

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
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = new URL(input);
  if (url.searchParams.get("region") === "unknown") return Response.json({ error: "unusable_parameter" }, { status: 400 });
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
  // SDK versions label the same supported keywords as draft-07 vs 2020-12.
  // Required fields are sets. Preserve every actual schema constraint.
  const normalize = (value, key) => {
    if (Array.isArray(value)) return key === "required" ? [...value].sort() : value.map((v) => normalize(v));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "$schema").map(([k, v]) => [k, normalize(v, k)]));
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
} finally {
  await client.close();
  await server.close();
  globalThis.fetch = originalFetch;
}
