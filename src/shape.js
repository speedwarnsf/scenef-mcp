// Feed records in, published shapes and readable prose out.
//
// The feed speaks camelCase because it is the site's own machine feed; the
// MCP contract speaks snake_case because that is what the hosted server
// published first. This module is the one place the two meet, so a field
// renamed upstream breaks in exactly one file.

import { SITE, edgeStaleness, safeZone } from "./feed.js";

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

/** "8:00 PM" — the hosted displayTime(iso, tz) (src/lib/time.ts): the
 *  INSTANT converted into the board's zone with Intl, not the literal HH:MM
 *  read off the string. The two agree whenever a row's written offset is the
 *  zone's real offset at that instant; they part on fall-back day for a lane
 *  that mints a single-pass noon offset ("2026-11-01T00:30:00-08:00" is
 *  1:30 AM Pacific). eveningMinutes() — the time_after/time_before filter —
 *  converts the instant too (minutesOf), and the hosted rule is that the
 *  filter and the local_time printed beside it read ONE clock. This read the
 *  string, so the filter could drop a show printed as inside the window.
 *  Some ICU builds put a narrow no-break space before AM/PM; the hosted
 *  answers carry a plain space, so that is what is printed. */
export function displayTime(startsAt, tz) {
  const at = new Date(startsAt);
  if (!Number.isFinite(at.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: safeZone(tz),
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(at)
    .replace(/\u202f/g, " ");
}

/** " [35mm, sold-out]" after a showtime, or nothing — the hosted tagBadge().
 *  Every prose line that names a showtime carries it, so a sold-out show is
 *  never handed over as a plain ticket link. */
export function tagBadge(s) {
  const tags = s?.tags ?? [];
  return tags.length ? ` [${tags.join(", ")}]` : "";
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

/** Bases built from a feed the edge served stale and would not refresh
 *  (feed.js edgeStaleness). finish() reads it; pass it the base itself. */
const staleBases = new WeakMap();

/** Provenance every structured payload carries. */
export function baseOf(feed) {
  const region = feed.region ?? "sf";
  const accuracy = new URL(feed.accuracy ?? `${SITE}/api/accuracy`);
  if (region !== "sf") accuracy.searchParams.set("region", region);
  const base = {
    data_as_of: feed.data_as_of ?? feed.generated,
    attribution: ATTRIBUTION,
    accuracy_url: accuracy.toString(),
    // Board identity, from the feed (2026-09-08): the answer names which
    // board it read, in the reader's own words. region_name ships with
    // region or not at all — there is no handle without its label.
    region,
    region_name: feed.region_name ?? feed.region ?? "sf",
    timezone: feed.timezone ?? "America/Los_Angeles",
  };
  const stale = edgeStaleness(feed);
  if (stale) staleBases.set(base, stale);
  return base;
}

/** THE ONE LINE THIS TRANSPORT ADDS, and only when it must. The hosted
 *  server reads the current dataset; this one reads it through the edge
 *  cache, and when the edge keeps serving an expired copy after retries
 *  (feed.js) the answer is built on an older board than the hosted one.
 *  That is a gap of this transport, so it is said, never served silently. */
export function edgeStaleNote(stale) {
  if (!stale) return null;
  const age = Number.isFinite(stale.age_s) ? ` (cached ${stale.age_s}s ago)` : "";
  return `Local server note: SceneF's edge cache answered with an expired copy${age} and was still serving it after ${stale.tries} retr${stale.tries === 1 ? "y" : "ies"}, so this answer may trail the hosted server at https://scenef.com/mcp; data_as_of is that copy's.`;
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

/** The hosted DAY_NAMES, Sunday = 0 — a discount's `day` read as a word. */
export const DAY_NAMES = DAYS;

/** A caller's words, echoed back in a refusal or a miss — the hosted
 *  echoInput() (src/lib/mcp/tools.ts). Clipped, because the echo is for
 *  recognition, and trimmed. Only sentences go through it; the structured
 *  `query`, `input` and `unknown_venues` keep the raw value, as there. */
export function echoInput(s, max = 80) {
  const t = String(s ?? "").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * MEMBERSHIP PRICING IS THE THEATER'S TO STATE — the hosted shownDiscount().
 * A membership or a discount card is named as one and priced as "see the
 * theater": subscription plans and their prices are not repeated, and the
 * plan's own name goes too. Every other kind passes through.
 */
export const MEMBER_PRICING = "Member pricing; see the theater";
export function shownDiscount(d) {
  if (d.kind === "membership") return { label: "Membership", detail: MEMBER_PRICING };
  if (d.kind === "card") return { label: "Discount card", detail: MEMBER_PRICING };
  return { label: d.label, detail: d.detail ?? "" };
}

/** The full theater card — the hosted theaterInfoData venue, key for key and
 *  in its order, then three keys this package has always carried and keeps
 *  for its own callers: each discount's `kind`, `nonprofit`, and the
 *  theater page `url`. Discounts go through shownDiscount, as there. */
export function venueCard(v, { region } = {}) {
  return {
    ...venueShape(v),
    address: v.address ?? null,
    region: v.region ?? region,
    website: v.website ?? null,
    lat: v.lat ?? null,
    lng: v.lng ?? null,
    platform: v.platform ?? null,
    ticketing_note: v.ticketingNote ?? null,
    amenities: v.amenities ?? [],
    preshow_min: v.preshowMin ?? null,
    discounts: (v.discounts ?? []).map((d) => ({
      ...shownDiscount(d),
      kind: d.kind ?? "other",
      day: d.day ?? null,
      day_name: d.day !== undefined && d.day !== null ? DAY_NAMES[d.day] : null,
    })),
    calendar_feed: `${SITE}/feeds/theater/${v.id}.ics`,
    nonprofit: v.nonprofit ?? null,
    url: `${SITE}/theater/${v.id}`,
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

/**
 * THE ART WE MAY HAND ON — the hosted tmdbPosterUrl(). Posters reach the
 * board from TMDB, from OMDb (IMDb's Amazon-hosted art) and from a theater's
 * own thumbnail; only TMDB's leaves through a tool. Anything else is null.
 */
export function tmdbPosterUrl(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname === "image.tmdb.org" ? url : null;
  } catch {
    return null;
  }
}

/**
 * THE LISTING STAYS; THE SYNOPSIS AND THE ART STAND BACK — the hosted
 * withheldDetail() and filmExtras(), as written. A film rated NC-17 or X, or
 * whose synopsis carries one of these words, keeps its listing — title,
 * year, runtime, rating, genres, showtimes, ticket links — and loses the
 * synopsis, its first line, the poster and the trailer. Nothing stands in
 * their place. The predicate reads only `mpaa` and `overview`, which the
 * non-compact /api/listings carries under those names; a compact feed
 * strips both and must never reach it.
 *
 * filmExtras() is the ONLY code here that reads overview, posterUrl or
 * trailerYoutubeKey. It returns null for a held film — the keys are then
 * omitted — and an object (nulls included) for any other.
 */
const ADULT_CERTIFICATE = /^(?:NC-?17|X)$/i;
const ADULT_WORDS = /\b(?:rap(?:e|ed|es|ing)|incest\w*|barely[- ]legal|sex workers?|porn\w*|erotic\w*|pink film)\b/i;

export function withheldDetail(f) {
  return ADULT_CERTIFICATE.test(f?.mpaa?.trim() ?? "") || ADULT_WORDS.test(f?.overview ?? "");
}

/** First sentence of a synopsis — the one-line hook, the hosted
 *  firstSentence(). Reached only through filmExtras(). */
function firstSentence(overview) {
  const o = typeof overview === "string" ? overview.trim() : "";
  if (!o) return undefined;
  const m = o.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : o).trim();
}

export function filmExtras(f) {
  if (!f || withheldDetail(f)) return null;
  return {
    overview: f.overview ?? null,
    hook: firstSentence(f.overview) ?? null,
    poster_url: tmdbPosterUrl(f.posterUrl),
    trailer_url: f.trailerYoutubeKey ? `https://www.youtube.com/watch?v=${f.trailerYoutubeKey}` : null,
  };
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
  // The hosted filmDetailsData card, key for key: a held film's card omits
  // overview, poster_url and trailer_url; mpaa stays. No backdrop art and no
  // ratings object — the hosted card carries tmdb_rating and nothing else.
  const x = filmExtras(f);
  return {
    ...base,
    mpaa: f.mpaa ?? null,
    cast: (f.cast ?? []).slice(0, 6),
    ...(x ? { overview: x.overview } : {}),
    tmdb_rating: f.ratings?.tmdb ?? null,
    ...(x ? { poster_url: x.poster_url, trailer_url: x.trailer_url } : {}),
  };
}

/**
 * FRESHNESS IS AGED AT CALL TIME — the hosted createFreshnessReader()
 * (src/lib/freshness.ts), over the feed's row. The hosted server stamps
 * age_hours and status from Date.now() on every call; the REST row carries
 * them as of the moment the feed was rendered, and the edge and this
 * process cache that render, so a copied age ran behind the hosted one by
 * the age of the cache (0.1–0.4 h measured 2026-10-10) and a row crossing
 * its allowance stayed "current" here after it went "stale" there. The
 * allowance (stale_after_hours, from the board's cadence and heat),
 * retained and source_status need venue ingest data and are kept from the
 * feed; age and status are recomputed exactly as there: a missing or
 * future verified_at is unknown with no age, past the allowance is stale,
 * otherwise current. A row without a freshness object, or one whose
 * allowance is not a number, is passed through as served.
 */
export function freshnessAt(f, verifiedAt, nowMs = Date.now()) {
  if (!f || typeof f !== "object") return f;
  const allowance = Number(f.stale_after_hours);
  if (f.stale_after_hours === null || f.stale_after_hours === undefined || !Number.isFinite(allowance)) return f;
  const verified = Date.parse(verifiedAt ?? "");
  const ageMs = Number.isFinite(verified) && verified <= nowMs ? nowMs - verified : null;
  return {
    ...f,
    status: ageMs === null ? "unknown" : ageMs > allowance * 3_600_000 ? "stale" : "current",
    age_hours: ageMs === null ? null : Math.round(ageMs / 36_000) / 100,
  };
}

/** The hosted provDetail() — one showtime's accuracy stamp, as the detailed
 *  prose prints it — over a screeningShape() row. */
export function provDetail(row) {
  return `confidence ${row.confidence ?? "unstamped"} · source_tier ${row.source_tier} (${(row.sources ?? []).join(", ")}) · verified_at ${row.verified_at}${row.note ? ` · note: ${row.note}` : ""}`;
}

/** Evidence accompanies every emitted screening, in both response modes.
 * Freshness comes from the canonical feed's cadence calculation, aged at
 * call time (freshnessAt above); never infer it from the dataset
 * publication timestamp. */
export function screeningShape(s, venues, { region, tz, detailed = false } = {}) {
  const v = venues.get(s.venueId);
  const hint = region && region !== "sf" ? `?region=${encodeURIComponent(region)}` : "";
  const ticket = new URL(s.ticketUrl ?? `${SITE}/go/${s.id}${hint}`);
  if (hint && !ticket.searchParams.has("region")) ticket.searchParams.set("region", region);
  const out = {
    screening_id: s.id,
    venue: venueShape(v) ?? { venue_id: s.venueId, name: s.venueId, short: s.venueId, neighborhood: null },
    starts_at: s.startsAt,
    night_of: s.nightOf,
    local_time: displayTime(s.startsAt, tz),
    tags: s.tags ?? [],
    ticket_url: ticket.toString(),
    calendar_url: s.calendar_url ?? `${SITE}/feeds/screening/${s.id}.ics${hint}`,
    confidence: s.confidence ?? s.provenance?.confidence ?? null,
    source_tier: s.source_tier ?? s.provenance?.sourceTier ?? "unknown",
    sources: s.sources ?? s.provenance?.sources ?? [s.provenance?.source].filter(Boolean),
    verified_at: s.verified_at ?? s.provenance?.lastVerifiedAt ?? null,
  };
  if (s.freshness) out.freshness = freshnessAt(s.freshness, out.verified_at);
  // Keep the local server's former detailed key as a compatibility alias.
  if (detailed) out.calendar_feed = out.calendar_url;
  if (s.note) out.note = s.note;
  return out;
}

export const venueIndex = (feed) => new Map(feed.venues.map((v) => [v.id, v]));
export const filmIndex = (feed) => new Map(feed.films.map((f) => [f.key, f]));

/** The hosted normText(): lowercase, decomposed, diacritics dropped, every
 *  run of anything but a-z0-9 collapsed to ONE SPACE, trimmed. The space is
 *  load-bearing — word boundaries survive, so the substring test below runs
 *  over words rather than over the letters run together. A collapse-to-
 *  nothing normaliser is a different relation and produced a different
 *  candidate set for the same query. */
export const normText = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Fuzzy film match — the hosted matchFilm() (src/lib/mcp/tools.ts), stage
 * for stage, so the candidate list an ambiguous query gets is the same list
 * in the same order on both transports:
 *
 *   1. the slug, verbatim (trimmed, lowercased)
 *   2. "title year" normalised — one hit is a hit
 *   3. the title normalised — one hit is a hit, several are ALL candidates
 *   4. namesOverlap on the normalised title (below) — one hit is a hit,
 *      several are the first eight in board order
 *
 * No prefix stage: the hosted matcher has none, and a prefix preference here
 * ranked "The Hole" above "Ghost in the Shell" for film:"the" where the
 * hosted answer lists them in board order. One survivor is a hit; several
 * are candidates the caller picks from; none is an honest miss. A miss is
 * an ANSWER — it is never dressed up as the whole board.
 */
export function matchFilm(feed, query) {
  const raw = String(query ?? "").trim().toLowerCase();
  const bySlug = feed.films.find((f) => f.slug === raw);
  if (bySlug) return { film: bySlug, candidates: [] };
  const nq = normText(query);
  if (!nq) return { film: null, candidates: [] };
  const withYear = feed.films.filter((f) => normText(`${f.title} ${f.year ?? ""}`) === nq);
  if (withYear.length === 1) return { film: withYear[0], candidates: [] };
  const exact = feed.films.filter((f) => normText(f.title) === nq);
  if (exact.length === 1) return { film: exact[0], candidates: [] };
  if (exact.length > 1) return { film: null, candidates: exact };
  const fuzzy = feed.films.filter((f) => namesOverlap(normText(f.title), nq));
  if (fuzzy.length === 1) return { film: fuzzy[0], candidates: [] };
  return { film: null, candidates: fuzzy.slice(0, 8) };
}

/**
 * A SHORT NAME MATCHES ONLY AS A WHOLE WORD — the hosted holds() and
 * namesOverlap(), as written. Containment either way stays ("Balboa" finds
 * "Balboa Theater", "Roxie Theater San Francisco" finds the Roxie), but only
 * for a needle of four characters or more; a shorter one has to be a whole
 * word of the other name. Without it Miami's O Cinema, id "o", answered for
 * "Tower Theater", and a film titled "It" claimed "Verity". Both arguments
 * already through normText.
 */
function holds(hay, needle) {
  if (!needle) return false;
  return needle.length >= 4 ? hay.includes(needle) : ` ${hay} `.includes(` ${needle} `);
}
export function namesOverlap(a, b) {
  if (!a || !b) return false;
  return a === b || holds(a, b) || holds(b, a);
}

/** The hosted venueNamed(), shared by matchVenue and the search venue
 *  filter: namesOverlap between the normalised query and the venue's id,
 *  name, or short name. Empty strings are skipped, as namesOverlap's `!a`
 *  skips them there. */
export function venueHit(v, nq) {
  return [v.id, v.name, v.short]
    .filter((x) => typeof x === "string" && x)
    .some((x) => namesOverlap(normText(x), nq));
}

/**
 * Theater match — the hosted matchVenue() (src/lib/mcp/tools.ts), as
 * written: the id verbatim (trimmed, lowercased), then venueHit over every
 * venue on the board. One hit is a hit; several are the first eight in
 * board order; none is a miss. There is no exact-name stage and no
 * one-way test: this server had both, and answered a query the hosted
 * server resolves with a "No theater on this board" sentence.
 */
export function matchVenue(feed, query) {
  const raw = String(query ?? "").trim().toLowerCase();
  const byId = feed.venues.find((v) => v.id === raw);
  if (byId) return { venue: byId, candidates: [] };
  const nq = normText(query);
  if (!nq) return { venue: null, candidates: [] };
  const hits = feed.venues.filter((v) => venueHit(v, nq));
  if (hits.length === 1) return { venue: hits[0], candidates: [] };
  return { venue: null, candidates: hits.slice(0, 8) };
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
  const stale = edgeStaleNote(staleBases.get(base));
  return [...body, "", footer(base), ...(stale ? [stale] : [])].join("\n");
}

/** Hosted `filmCandidatesText()`: one function renders the film miss for
 *  BOTH scenef_search_showtimes and scenef_film_details — a miss, or an
 *  ambiguity with the candidates and their film pages. The board is named
 *  by its region_name, from the feed, and each candidate's page is that
 *  board's page for it (filmUrl above). */
export function filmCandidatesText(base, query, candidates) {
  if (!candidates.length) {
    return [
      `No film matching "${echoInput(query)}" in the current ${base.region_name} listings.`,
      `Try scenef_whats_playing to browse what's on.`,
    ];
  }
  return [
    `"${echoInput(query)}" is ambiguous — did you mean:`,
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
      `No theater on this board matching "${echoInput(query)}".`,
      `Known: ${venues.map((v) => v.id).join(", ")}.`,
    ];
  }
  return [
    `"${echoInput(query)}" is ambiguous — did you mean:`,
    ...candidates.map((v) => `- ${v.name} (${v.id})`),
    `Call again with the id.`,
  ];
}

/** Text helpers — every tool renders the same answer twice, once for a
 *  reader and once for a parser, from ONE computation. */
export function both(text, data) {
  const stale = new Set();
  const visit = (row) => {
    if (!row || typeof row !== "object") return;
    if (row.screening_id && row.freshness?.status === "stale") stale.add(row.screening_id);
    for (const child of Object.values(row)) visit(child);
  };
  visit(data);
  const note = stale.size
    ? `\n\nFreshness: ${stale.size} listed screenings have stale source verification. Confirm those times with the box office; structured rows carry the source status and age.`
    : "";
  return { content: [{ type: "text", text: text + note }], structuredContent: data };
}

export const nn = (list) => list.filter(Boolean);
