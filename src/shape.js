// Feed records in, published shapes and readable prose out.
//
// The feed speaks camelCase because it is the site's own machine feed; the
// MCP contract speaks snake_case because that is what the hosted server
// published first. This module is the one place the two meet, so a field
// renamed upstream breaks in exactly one file.

import { SITE, shiftDate } from "./feed.js";

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

/** The wall clock as the theater posts it. Read straight off the ISO string:
 *  the offset is already the venue's, so converting through a timezone would
 *  be a chance to be wrong about a time we were handed correctly. */
export function displayTime(startsAt) {
  const m = /T(\d{2}):(\d{2})/.exec(startsAt);
  if (!m) return "";
  const h = Number(m[1]);
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${suffix}`;
}

/** Day-of-week for a YYYY-MM-DD night, Sunday = 0, without timezone drift. */
export function dowOf(night) {
  const [y, m, d] = night.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function dayName(night) {
  return DAYS[dowOf(night)];
}

/** "Friday, August 29" — the night, spelled out. */
export function nightLabel(night) {
  const [y, m, d] = night.split("-").map(Number);
  void y;
  return `${dayName(night)}, ${MONTHS[m - 1]} ${d}`;
}

/** The hosted server's structuredBase attribution, hardcoded there and so
 *  hardcoded here. The feed's own `attribution` field says "Showtimes via
 *  SceneF.com" — that is the TEXT footer's phrase (see footer below), and
 *  passing it through put a different string in the JSON than the hosted
 *  server puts in the same field. */
export const ATTRIBUTION = "SceneF — https://scenef.com";

/** Provenance every structured payload carries. */
export function baseOf(feed) {
  return {
    data_as_of: feed.data_as_of ?? feed.generated,
    attribution: ATTRIBUTION,
    accuracy_url: feed.accuracy ?? `${SITE}/api/accuracy`,
    // Board identity, from the feed (2026-09-08): the answer names which
    // board it read, in the reader's own words. region_name ships with
    // region or not at all — there is no handle without its label.
    region: feed.region ?? "sf",
    region_name: feed.region_name ?? feed.region ?? "sf",
    timezone: feed.timezone ?? "America/Los_Angeles",
  };
}

export function venueShape(v) {
  if (!v) return null;
  return {
    venue_id: v.id,
    name: v.name,
    short: v.short ?? v.name,
    neighborhood: v.neighborhood ?? null,
  };
}

/** The full theater card — everything the venue record carries that a
 *  moviegoer would act on, plus the two public urls for it. */
export function venueCard(v) {
  return {
    ...venueShape(v),
    address: v.address ?? null,
    website: v.website ?? null,
    lat: v.lat ?? null,
    lng: v.lng ?? null,
    amenities: v.amenities ?? [],
    discounts: (v.discounts ?? []).map((d) => ({
      label: d.label,
      kind: d.kind ?? "other",
      day: d.day ?? null,
      detail: d.detail ?? "",
    })),
    ticketing_note: v.ticketingNote ?? null,
    preshow_min: v.preshowMin ?? null,
    nonprofit: v.nonprofit ?? null,
    calendar_feed: `${SITE}/feeds/theater/${v.id}.ics`,
    url: `${SITE}/theaters`,
  };
}

/**
 * A FILM PAGE IS REGION-SCOPED — the hosted filmUrl(slug, regionSlug) over
 * regionHref() (src/lib/region-path.ts). The bare path serves the default
 * board, so a film url handed to a caller reading Central Los Angeles must
 * hang the board off the film: /film/{slug}/la-central. This server printed
 * the bare path from every board and sent a Maui reader to San Francisco's
 * showtimes, or to a 404 when the film does not play there.
 *
 * `region` is the feed's own region id. The hosted server maps the id
 * through its region table to a slug; in that table (src/config/regions.ts)
 * every board's slug equals its id, and /api/boards publishes no slug column
 * to read one from, so the id IS the slug here. The default board stays
 * bare by the same literal the hosted regionHref uses: "sf".
 */
export function filmUrl(slug, region) {
  const path = `/film/${slug}`;
  if (!region || region === "sf") return `${SITE}${path}`;
  return `${SITE}${path}/${region}`;
}

export function filmShape(f, { full = false, region } = {}) {
  if (!f) return null;
  const base = {
    key: f.key,
    slug: f.slug,
    title: f.title,
    year: f.year ?? null,
    runtime_min: f.runtimeMin ?? null,
    genres: f.genres ?? [],
    directors: f.directors ?? [],
    url: filmUrl(f.slug, region),
  };
  if (!full) return base;
  return {
    ...base,
    mpaa: f.mpaa ?? null,
    overview: f.overview ?? null,
    cast: f.cast ?? [],
    ratings: f.ratings ?? null,
    poster_url: f.posterUrl ?? null,
    backdrop_url: f.backdropUrl ?? null,
    trailer_url: f.trailerYoutubeKey ? `https://www.youtube.com/watch?v=${f.trailerYoutubeKey}` : null,
  };
}

/** One showtime. `detailed` adds the accuracy fields the description
 *  promises: confidence level, source tier, reporting sources, verified_at. */
export function screeningShape(s, venues, { detailed = false } = {}) {
  const v = venues.get(s.venueId);
  const out = {
    screening_id: s.id,
    venue: venueShape(v) ?? { venue_id: s.venueId, name: s.venueId, short: s.venueId, neighborhood: null },
    starts_at: s.startsAt,
    night_of: s.nightOf,
    local_time: displayTime(s.startsAt),
    tags: s.tags ?? [],
    ticket_url: s.ticketUrl ?? `${SITE}/go/${s.id}`,
  };
  if (s.note) out.note = s.note;
  if (!detailed) return out;
  return {
    ...out,
    confidence: s.confidence ?? s.provenance?.confidence ?? null,
    source_tier: s.source_tier ?? s.provenance?.sourceTier ?? null,
    sources: s.sources ?? s.provenance?.sources ?? [],
    verified_at: s.verified_at ?? s.provenance?.lastVerifiedAt ?? null,
    calendar_feed: `${SITE}/feeds/screening/${s.id}.ics`,
  };
}

export const venueIndex = (feed) => new Map(feed.venues.map((v) => [v.id, v]));
export const filmIndex = (feed) => new Map(feed.films.map((f) => [f.key, f]));

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Fuzzy film match. Exact slug and exact title first, then prefix, then
 * substring. One survivor is a hit; several are candidates the caller picks
 * from; none is an honest miss. A miss is an ANSWER — it is never dressed up
 * as the whole board.
 */
export function matchFilm(feed, query) {
  const q = norm(query);
  if (!q) return { film: null, candidates: [] };
  const slug = feed.films.find((f) => f.slug === String(query).trim().toLowerCase());
  if (slug) return { film: slug, candidates: [] };
  const exact = feed.films.filter((f) => norm(f.title) === q);
  if (exact.length === 1) return { film: exact[0], candidates: [] };
  if (exact.length > 1) return { film: null, candidates: exact };
  const prefix = feed.films.filter((f) => norm(f.title).startsWith(q));
  if (prefix.length === 1) return { film: prefix[0], candidates: [] };
  const partial = prefix.length ? prefix : feed.films.filter((f) => norm(f.title).includes(q) || q.includes(norm(f.title)));
  if (partial.length === 1) return { film: partial[0], candidates: [] };
  return { film: null, candidates: partial.slice(0, 8) };
}

/** The same idea for theaters, which callers name by id, short name, or the
 *  name on the marquee. */
export function matchVenue(feed, query) {
  const q = norm(query);
  if (!q) return { venue: null, candidates: [] };
  const byId = feed.venues.find((v) => v.id === String(query).trim().toLowerCase());
  if (byId) return { venue: byId, candidates: [] };
  const exact = feed.venues.filter((v) => norm(v.name) === q || norm(v.short) === q);
  if (exact.length === 1) return { venue: exact[0], candidates: [] };
  const partial = feed.venues.filter((v) => norm(v.name).includes(q) || norm(v.short).includes(q));
  if (partial.length === 1) return { venue: partial[0], candidates: [] };
  return { venue: null, candidates: partial.slice(0, 8) };
}

/** Fri/Sat/Sun of the week the given night sits in. */
export function weekendNights(night) {
  const dow = dowOf(night);
  // Friday is 5. From Sunday (0) the weekend just past is the one you mean.
  const toFriday = dow === 0 ? -2 : 5 - dow;
  const friday = shiftDate(night, toFriday);
  return [friday, shiftDate(friday, 1), shiftDate(friday, 2)];
}

// ————————————————————————————————————————————— the hosted server's prose
//
// These are the words the hosted server answers with, copied so a caller
// reading a miss from either transport reads the same sentence. Each one
// names its source in the hosted tree (src/lib/mcp/tools.ts).

/** The provenance footer every hosted answer ends with — `footer()` there,
 *  appended by `finish()` after one blank line. Two tools are the exceptions
 *  and are mirrored per tool: scenef_resolve_board carries no footer (it
 *  reads no board), and scenef_accuracy ends with its own two-line tail.
 *  The freshness is the feed's data_as_of, which is the hosted dataset's
 *  generatedAt; the record url is the feed's own. */
export function footer(base) {
  return `— Showtimes via SceneF.com, data as of ${base.data_as_of} · accuracy record: ${base.accuracy_url}`;
}

/** Hosted `finish()`: the lines, a blank, the footer. Trailing blanks are
 *  dropped first so the tail is always exactly "\n\n— Showtimes via …" —
 *  the hosted renderers pop them before finishing where they can occur. */
export function finish(base, lines) {
  const body = [...lines];
  while (body.length && body[body.length - 1] === "") body.pop();
  return [...body, "", footer(base)].join("\n");
}

/** Hosted `filmCandidatesText()`: one function renders the film miss for
 *  BOTH scenef_search_showtimes and scenef_film_details — a miss, or an
 *  ambiguity with the candidates and their film pages. The board is named
 *  by its region_name, from the feed, and each candidate's page is that
 *  board's page for it (filmUrl above). */
export function filmCandidatesText(base, query, candidates) {
  if (!candidates.length) {
    return [
      `No film matching "${query}" in the current ${base.region_name} listings.`,
      `Try scenef_whats_playing to browse what's on.`,
    ];
  }
  return [
    `"${query}" is ambiguous — did you mean:`,
    ...candidates.map((f) => `- ${f.title}${f.year ? ` (${f.year})` : ""} — ${f.slug} · ${filmUrl(f.slug, base.region)}`),
    `Call again with the exact slug.`,
  ];
}

/** Hosted `theaterInfo()` miss: no theater, and every id on the board —
 *  the whole list, joined with ", ", never truncated. An ambiguous name
 *  lists the candidates by name and id. */
export function theaterCandidatesText(query, candidates, venues) {
  if (!candidates.length) {
    return [
      `No theater on this board matching "${query}".`,
      `Known: ${venues.map((v) => v.id).join(", ")}.`,
    ];
  }
  return [
    `"${query}" is ambiguous — did you mean:`,
    ...candidates.map((v) => `- ${v.name} (${v.id})`),
    `Call again with the id.`,
  ];
}

/** Text helpers — every tool renders the same answer twice, once for a
 *  reader and once for a parser, from ONE computation. */
export function both(text, data) {
  return { content: [{ type: "text", text }], structuredContent: data };
}

export const nn = (list) => list.filter(Boolean);
