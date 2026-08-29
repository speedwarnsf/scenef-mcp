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

/** Provenance every structured payload carries. */
export function baseOf(feed) {
  return {
    data_as_of: feed.data_as_of ?? feed.generated,
    attribution: feed.attribution ?? "Showtimes via SceneF.com",
    accuracy_url: feed.accuracy ?? `${SITE}/api/accuracy`,
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

export function filmShape(f, { full = false } = {}) {
  if (!f) return null;
  const base = {
    key: f.key,
    slug: f.slug,
    title: f.title,
    year: f.year ?? null,
    runtime_min: f.runtimeMin ?? null,
    genres: f.genres ?? [],
    directors: f.directors ?? [],
    url: `${SITE}/film/${f.slug}`,
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

/** Text helpers — every tool renders the same answer twice, once for a
 *  reader and once for a parser, from ONE computation. */
export function both(text, data) {
  return { content: [{ type: "text", text }], structuredContent: data };
}

export const nn = (list) => list.filter(Boolean);
