// The ten tools — the SAME ten the hosted server at https://scenef.com/mcp
// registers, with the same names, the same input schemas, and the same
// descriptions word for word.
//
// ONE CONTRACT, TWO TRANSPORTS. An agent that learned these tools from the
// hosted endpoint must be able to speak to this one without a second code
// path, and vice versa. That is why the descriptions here are copied rather
// than paraphrased: a caller who reads "response_format: detailed adds the
// confidence level" from one server and gets something else from the other
// has been told a small lie by whichever of us drifted.
//
// What differs is only where the data comes from. The hosted server reads the
// dataset in process; this one reads the same board over the public REST
// contract at https://scenef.com/agents. Both answer from the same numbers.

import { z } from "zod";
import { SITE, accuracyRecord, boardsList, listings, resolvePlace, shiftDate, tonightNight } from "./feed.js";
import {
  baseOf,
  both,
  displayTime,
  filmCandidatesText,
  filmShape,
  finish,
  matchFilm,
  matchVenue,
  nightLabel,
  screeningShape,
  theaterCandidatesText,
  venueCard,
  venueIndex,
  venueShape,
  weekendNights,
} from "./shape.js";
import {
  accuracyOutput,
  comingOut,
  discountsOut,
  filmDetailsOut,
  nowOut,
  placeOut,
  planOut,
  searchOut,
  theaterOut,
  whatsPlayingOut,
} from "./schemas.js";

const responseFormat = z
  .enum(["concise", "detailed"])
  .optional()
  .describe(
    'Output size. "concise" (default) is tight text plus a structured summary — on list-shaped tools each film carries showtime_count and next_showtime, but NOT the full showtimes array. "detailed" adds the per-showtime rows with ids, ticket urls, and accuracy metadata. Concise measures ~10KB where detailed measures ~69KB, so ask for detailed when you need the rows and scenef_search_showtimes when you need them for one film or theatre.',
  );

const whenParam = z
  .string()
  .optional()
  .describe(
    'When to look: "tonight" (default), "tomorrow", "weekend" (Fri/Sat/Sun of the current week), or a YYYY-MM-DD date.',
  );

// The hosted server's words, verbatim — every tool takes it (ONE CONTRACT,
// TWO TRANSPORTS, above). The feed refuses an unknown region with a 400
// naming the valid list, and getJson passes that correction through, so the
// "error, not a fallback" promise below is the API's own behavior.
const regionParam = z
  .string()
  .optional()
  .describe(
    'Which regional board to read, e.g. "sf", "oahu", "sacramento". Omitted means the default board — it is never inferred from where you are. Call scenef_now for the full list; an unknown region is an error, not a fallback.',
  );

/**
 * ALL THREE HINTS, EXPLICITLY, ON EVERY TOOL.
 *
 * The values are facts about these ten tools, not paperwork:
 *   readOnlyHint    true  — every tool reads the board; there is no write
 *                           path anywhere in this server, and the REST client
 *                           issues nothing but GET.
 *   destructiveHint false — nothing is deleted or modified, so there is
 *                           nothing to destroy.
 *   openWorldHint   false — the tools read SceneF's own published feed. They
 *                           do not browse, search the web, or call an
 *                           endpoint whose contents we do not control.
 *
 * Anything that ever is NOT read-only must declare its own annotations rather
 * than reuse this constant.
 */
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

/** One sentence every tool description can hand to a caller verbatim. */
export const ACCURACY_CONTRACT =
  "Accuracy is computed, not claimed: every showtime carries a confidence level, a source tier, and a last-verified time, and the running record of our own verification checks — failures included — is public at https://scenef.com/api/accuracy.";

const DETAILED_CARRIES_ACCURACY =
  '"detailed" adds the full showtimes array, each row carrying its confidence level, source tier, reporting sources and verified_at timestamp; "concise" gives showtime_count and next_showtime instead.';

const isDetailed = (args) => args?.response_format === "detailed";

// ————————————————————————————————————————————————————————— the window
//
// "tonight" is a question for the board, not for this process. The night rolls
// at 4am — a 12:40am show belongs to the evening you are standing in — so we
// ask the feed which night it is currently calling tonight and slice from
// there. Only an empty board falls back to computing it locally.

async function windowFor(when, extra = {}) {
  const raw = String(when ?? "tonight").trim().toLowerCase();
  const t = await tonightNight(extra.region);

  if (raw === "" || raw === "tonight" || raw === "today") {
    const feed = await listings({ when: "tonight", ...extra });
    return { label: "tonight", nights: [t], feed, screenings: feed.screenings, warning: null };
  }
  if (raw === "tomorrow") {
    const n = shiftDate(t, 1);
    const feed = await listings({ night: n, ...extra });
    return { label: `tomorrow, ${nightLabel(n)}`, nights: [n], feed, screenings: feed.screenings, warning: null };
  }
  if (raw === "weekend") {
    const nights = weekendNights(t);
    let feed = await listings({ when: "week", ...extra });
    let screenings = feed.screenings.filter((s) => nights.includes(s.nightOf));
    if (!screenings.length) {
      // The weekend can sit outside the week slice. Fall back to the whole
      // board rather than reporting an empty weekend that isn't empty.
      feed = await listings({ ...extra });
      screenings = feed.screenings.filter((s) => nights.includes(s.nightOf));
    }
    return { label: "the weekend", nights, feed, screenings, warning: null };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const feed = await listings({ night: raw, ...extra });
    return { label: nightLabel(raw), nights: [raw], feed, screenings: feed.screenings, warning: null };
  }

  // A parameter we cannot honor is reported, never ignored. Silently answering
  // for tonight without saying so is the worst failure this product has.
  const feed = await listings({ when: "tonight", ...extra });
  return {
    label: "tonight",
    nights: [t],
    feed,
    screenings: feed.screenings,
    warning: `Unrecognized when="${when}". Use tonight, tomorrow, weekend, or YYYY-MM-DD. Answered for tonight instead.`,
  };
}

/** The notable lead is strictly about tonight, so it only ships on answers
 *  whose window actually covers tonight. */
function notableFor(w, tonight) {
  if (!w.nights.includes(tonight)) return [];
  return (w.feed.notable?.items ?? []).map((n) => ({
    title: n.title,
    venue: n.venue,
    local_time: n.time ?? displayTime(n.startsAt),
    film_slug: n.filmSlug ?? null,
    screening_id: n.screeningId ?? null,
    ticket_url: n.ticketUrl ?? null,
    reasons: (n.reasons ?? []).map((r) => r.evidence ?? r.why),
  }));
}

/** First sentence of the overview, as the one-line hook. */
function hook(film) {
  const o = String(film?.overview ?? "").trim();
  if (!o) return null;
  const first = o.split(/(?<=[.!?])\s+/)[0] ?? o;
  return first.length > 160 ? `${first.slice(0, 157).trimEnd()}…` : first;
}

const hhmm = (t) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Minutes past midnight of a screening's own wall clock. */
const minutesOf = (s) => {
  const m = /T(\d{2}):(\d{2})/.exec(s.startsAt);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
};

const lower = (xs) => (xs ?? []).map((x) => String(x).toLowerCase());

function timeFiltered(screenings, after, before) {
  const a = hhmm(after);
  const b = hhmm(before);
  return screenings.filter((s) => {
    const mins = minutesOf(s);
    if (a !== null && mins < a) return false;
    if (b !== null && mins > b) return false;
    return true;
  });
}

// ——————————————————————————————————————————————————————————— the tools

export const TOOLS = [];
const tool = (name, config, handler) => TOOLS.push({ name, config, handler });

tool(
  "scenef_whats_playing",
  {
    title: "What's playing in California and Hawaii",
    description:
      `Ranked list of films playing California and Hawaii theaters in a given window (tonight, tomorrow, the weekend, or a date), with optional genre and format filters. When the window covers tonight, opens with Notable tonight — scarcity facts with evidence (measured seat counts, final nights, lone prints, posted discounts, live elements); lead with those when asked what to see. Each entry carries year, runtime, genres, a one-line hook, venue count, showtime_count, the next showtime, and the film's SceneF url. The full per-showtime rows are in "detailed", or from scenef_search_showtimes scoped to one film or theatre. ${DETAILED_CARRIES_ACCURACY}`,
    inputSchema: {
      when: whenParam,
      genres: z.array(z.string()).optional().describe('Genre filters, e.g. ["horror", "comedy"].'),
      formats: z
        .array(z.string())
        .optional()
        .describe('Format/tag filters, e.g. ["35mm", "70mm", "qa", "live-score"].'),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(25)
        .optional()
        .describe("Max films to return (default 12, cap 25)."),
      response_format: responseFormat,
      region: regionParam,
    },
    outputSchema: whatsPlayingOut.shape,
    annotations: READ_ONLY,
  },
  async (args) => {
    const detailed = isDetailed(args);
    const tonight = await tonightNight(args.region);
    const w = await windowFor(args.when, args.region ? { region: args.region } : {});
    const venues = venueIndex(w.feed);
    const films = new Map(w.feed.films.map((f) => [f.key, f]));

    const wantGenres = lower(args.genres);
    const wantFormats = lower(args.formats);

    let screenings = w.screenings;
    if (wantFormats.length) {
      screenings = screenings.filter((s) => lower(s.tags).some((t) => wantFormats.includes(t)));
    }

    const byFilm = new Map();
    for (const s of screenings) {
      const f = films.get(s.filmKey);
      if (!f) continue;
      if (wantGenres.length && !lower(f.genres).some((g) => wantGenres.includes(g))) continue;
      if (!byFilm.has(f.key)) byFilm.set(f.key, { film: f, showtimes: [] });
      byFilm.get(f.key).showtimes.push(s);
    }

    const notable = notableFor(w, tonight);
    const notableSlugs = new Set(notable.map((n) => n.film_slug).filter(Boolean));

    // Ranked: scarcity first when the window covers tonight (a final night or
    // a lone print is the answer to "what should I see"), then breadth of the
    // run, then the earliest curtain.
    const ranked = [...byFilm.values()]
      .map((e) => {
        e.showtimes.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
        e.venue_count = new Set(e.showtimes.map((s) => s.venueId)).size;
        e.is_notable = notableSlugs.has(e.film.slug);
        return e;
      })
      .sort(
        (a, b) =>
          Number(b.is_notable) - Number(a.is_notable) ||
          b.venue_count - a.venue_count ||
          a.showtimes[0].startsAt.localeCompare(b.showtimes[0].startsAt),
      );

    const cap = Math.min(Math.max(args.max_results ?? 12, 1), 25);
    const chosen = ranked.slice(0, cap);

    const data = {
      ...baseOf(w.feed),
      window: w.label,
      nights: w.nights,
      note: w.warning,
      notable,
      film_count: ranked.length,
      films: chosen.map((e) => ({
        ...filmShape(e.film),
        venue_count: e.venue_count,
        showtime_count: e.showtimes.length,
        next_showtime: screeningShape(e.showtimes[0], venues, { detailed: false }),
        // The rows themselves only in detailed — the 2026-09-08 wire ruling.
        // Concise keeps the count and the next curtain; search_showtimes is
        // the tool for full rows scoped to one film or theatre.
        ...(detailed ? { showtimes: e.showtimes.map((s) => screeningShape(s, venues, { detailed })) } : {}),
      })),
    };

    const L = [];
    if (w.warning) L.push(`Note: ${w.warning}`, "");
    L.push(`What's playing on the ${w.feed.region ?? "sf"} board — ${w.label}${w.nights.length === 1 ? `, ${nightLabel(w.nights[0])}` : ""}`);
    if (notable.length) {
      L.push("", "Notable tonight — scarcity facts, with evidence:");
      for (const n of notable.slice(0, 6)) {
        L.push(`  • ${n.title} — ${n.venue}, ${n.local_time}${n.reasons.length ? ` (${n.reasons.join("; ")})` : ""}`);
      }
    }
    L.push("", `${ranked.length} film${ranked.length === 1 ? "" : "s"}, ${screenings.length} screening${screenings.length === 1 ? "" : "s"}.`);
    if (!ranked.length) {
      L.push("", "Nothing on the board matches. Widen the window or drop a filter.");
    }
    L.push("");
    chosen.forEach((e, i) => {
      const f = e.film;
      const facts = [f.year, f.runtimeMin ? `${f.runtimeMin} min` : null, (f.genres ?? []).slice(0, 3).join(", ") || null];
      L.push(`${String(i + 1).padStart(2)}. ${f.title} — ${facts.filter(Boolean).join(" · ")}`);
      const first = e.showtimes[0];
      L.push(
        `    ${e.venue_count} theater${e.venue_count === 1 ? "" : "s"} · next ${displayTime(first.startsAt)} at ${venues.get(first.venueId)?.short ?? first.venueId}`,
      );
      const h = hook(f);
      if (h) L.push(`    ${h}`);
      if (detailed) {
        for (const s of e.showtimes.slice(0, 8)) {
          const v = venues.get(s.venueId);
          L.push(
            `      ${displayTime(s.startsAt)} ${v?.short ?? s.venueId}${s.tags?.length ? ` [${s.tags.join(", ")}]` : ""} — ${s.ticketUrl} (${s.confidence ?? "?"}, verified ${s.verified_at ?? "?"})`,
          );
        }
        if (e.showtimes.length > 8) L.push(`      …${e.showtimes.length - 8} more`);
      }
      L.push(`    ${SITE}/film/${f.slug}`);
    });
    return both(finish(data, L), data);
  },
);

// The hosted server's refusal, word for word (NEITHER in its tools.ts):
// neither a film nor a venue is not an empty result, and the same sentence
// rides in structuredContent.refusal on both transports.
const NEITHER =
  "scenef_search_showtimes needs either a film or at least one venue. It answers " +
  "'where is this film playing' and 'what is on at this theater' — not 'what is on " +
  "anywhere'. For the whole board, call scenef_whats_playing.";

tool(
  "scenef_search_showtimes",
  {
    title: "Search showtimes for a film",
    description:
      `Showtimes scoped by FILM or by THEATER — pass at least one. With \`film\`: where that film is playing (title or slug; fuzzy-matched, ambiguous queries return candidates). With \`venues\` and no film: everything on at those theaters, each showtime naming its film. Grouped by theater with local times, tags (35mm/qa/sold-out), the night each show belongs to, and a ticket link per showtime. Optional date and time-window filters apply to both. For the whole board with no film or theater in mind, call scenef_whats_playing instead. ${DETAILED_CARRIES_ACCURACY}`,
    inputSchema: {
      film: z
        .string()
        .optional()
        .describe(
          "Film title, or a SceneF slug taken from films[].slug / scenef_whats_playing. " +
            "A title that is not on the board answers with a miss and points at " +
            "scenef_whats_playing, so guessing is safe but browsing is faster. " +
            "Optional when `venues` is given — omit it to ask what is on at a theater.",
        ),
      date: z.string().optional().describe("Restrict to one night, YYYY-MM-DD."),
      time_after: z.string().optional().describe('Only shows at or after this local time, "HH:MM" 24h.'),
      time_before: z.string().optional().describe('Only shows at or before this local time, "HH:MM" 24h.'),
      venues: z
        .array(z.string())
        .optional()
        .describe(
          'Restrict to these theaters (ids or names), e.g. ["roxie", "Balboa"]. ' + "Required when `film` is omitted.",
        ),
      response_format: responseFormat,
      region: regionParam,
    },
    outputSchema: searchOut.shape,
    annotations: READ_ONLY,
  },
  async (args) => {
    const detailed = isDetailed(args);
    const feed = await listings({
      ...(args.date ? { night: args.date } : {}),
      ...(args.region ? { region: args.region } : {}),
    });
    const venues = venueIndex(feed);
    const films = new Map(feed.films.map((f) => [f.key, f]));
    const base = baseOf(feed);

    const askedVenues = args.venues ?? [];
    if (!args.film && !askedVenues.length) {
      const refusal = NEITHER;
      return both(finish(base, [refusal]), {
        ...base,
        query: null,
        matched: false,
        refusal,
        unknown_venues: [],
        coverage_note: null,
        showtime_count: 0,
        venues: [],
      });
    }

    // Theaters first: an unresolvable name is reported, never dropped.
    const resolved = [];
    const unknown_venues = [];
    for (const q of askedVenues) {
      const { venue } = matchVenue(feed, q);
      if (venue) resolved.push(venue);
      else unknown_venues.push(q);
    }
    const venueIds = new Set(resolved.map((v) => v.id));

    let film = null;
    let candidates = [];
    if (args.film) {
      const m = matchFilm(feed, args.film);
      film = m.film;
      candidates = m.candidates;
      if (!film) {
        // The same miss scenef_film_details gives, from the same function —
        // the hosted server renders both through one filmCandidatesText().
        // This said '"X" is not on the la-central board right now' while
        // film_details said 'No film matching "X" in the current Central Los
        // Angeles listings' — one contract, two sentences.
        const text = finish(base, filmCandidatesText(base, args.film, candidates));
        return both(text, {
          ...base,
          query: args.film,
          matched: false,
          filtered_by: "film",
          candidates: candidates.map((c) => filmShape(c)),
          unknown_venues,
          coverage_note: null,
          showtime_count: 0,
          venues: [],
        });
      }
    }

    let screenings = feed.screenings;
    if (film) screenings = screenings.filter((s) => s.filmKey === film.key);
    if (venueIds.size) screenings = screenings.filter((s) => venueIds.has(s.venueId));
    if (args.date) screenings = screenings.filter((s) => s.nightOf === args.date);
    screenings = timeFiltered(screenings, args.time_after, args.time_before);
    screenings.sort((a, b) => a.startsAt.localeCompare(b.startsAt));

    const grouped = new Map();
    for (const s of screenings) {
      if (!grouped.has(s.venueId)) grouped.set(s.venueId, []);
      grouped.get(s.venueId).push(s);
    }

    const venueMode = !film;
    const data = {
      ...base,
      query: film ? args.film : null,
      matched: screenings.length > 0,
      filtered_by: film ? "film" : "venue",
      ...(film ? { film: filmShape(film) } : {}),
      unknown_venues,
      coverage_note: unknown_venues.length
        ? `Not on the board: ${unknown_venues.join(", ")}. Theater ids come from scenef_theater_info or venues[] in the feed.`
        : null,
      showtime_count: screenings.length,
      venues: [...grouped.entries()].map(([id, list]) => ({
        ...venueShape(venues.get(id) ?? { id, name: id, short: id }),
        showtimes: list.map((s) => ({
          ...screeningShape(s, venues, { detailed }),
          ...(venueMode ? { film: filmShape(films.get(s.filmKey)) } : {}),
        })),
      })),
    };

    const L = [];
    L.push(
      film
        ? `${film.title}${film.year ? ` (${film.year})` : ""} — ${screenings.length} showtime${screenings.length === 1 ? "" : "s"}`
        : `${resolved.map((v) => v.name).join(", ") || "Selected theaters"} — ${screenings.length} showtime${screenings.length === 1 ? "" : "s"}`,
    );
    if (data.coverage_note) L.push(`Note: ${data.coverage_note}`);
    if (!screenings.length) L.push("", "Nothing matches those filters on the current board.");
    for (const [id, list] of grouped) {
      const v = venues.get(id);
      L.push("", `${v?.name ?? id}${v?.neighborhood ? ` · ${v.neighborhood}` : ""}`);
      for (const s of list) {
        const bits = [displayTime(s.startsAt), venueMode ? films.get(s.filmKey)?.title ?? "" : ""].filter(Boolean);
        const tags = s.tags?.length ? ` [${s.tags.join(", ")}]` : "";
        L.push(`  ${bits.join(" — ")}${tags}  ${s.nightOf}`);
        L.push(`    ${s.ticketUrl}${detailed ? `  (${s.confidence ?? "?"} · ${s.source_tier ?? "?"} · verified ${s.verified_at ?? "?"})` : ""}`);
      }
    }
    return both(finish(base, L), data);
  },
);

tool(
  "scenef_theater_info",
  {
    title: "Theater info",
    description:
      `One theater's card: address, neighborhood, website, ticketing note, structured discounts (label/detail/day), amenities, its next 5 showtimes with ticket links, and its calendar feed url. ${DETAILED_CARRIES_ACCURACY}`,
    inputSchema: {
      theater: z.string().describe('Theater id or name, e.g. "roxie" or "Balboa Theater".'),
      response_format: responseFormat,
      region: regionParam,
    },
    outputSchema: theaterOut.shape,
    annotations: READ_ONLY,
  },
  async (args) => {
    const detailed = isDetailed(args);
    const feed = await listings(args.region ? { region: args.region } : {});
    const base = baseOf(feed);
    const { venue, candidates } = matchVenue(feed, args.theater);

    if (!venue) {
      // The hosted words: 'No theater on this board matching "X".' and the
      // whole id list after 'Known:', joined with ", " and never truncated.
      const text = finish(base, theaterCandidatesText(args.theater, candidates, feed.venues));
      return both(text, {
        ...base,
        query: args.theater,
        matched: false,
        candidates: candidates.map((c) => venueShape(c)),
        covered_venue_ids: feed.venues.map((v) => v.id),
      });
    }

    const venues = venueIndex(feed);
    const films = new Map(feed.films.map((f) => [f.key, f]));
    const now = Date.now();
    const upcoming = feed.screenings
      .filter((s) => s.venueId === venue.id && new Date(s.startsAt).getTime() >= now)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      .slice(0, 5);

    const card = venueCard(venue);
    const data = {
      ...base,
      query: args.theater,
      matched: true,
      venue: card,
      upcoming_count: upcoming.length,
      upcoming: upcoming.map((s) => ({
        ...screeningShape(s, venues, { detailed }),
        film: filmShape(films.get(s.filmKey)),
      })),
    };

    const L = [`${venue.name}${venue.neighborhood ? ` · ${venue.neighborhood}` : ""}`];
    if (card.address) L.push(card.address);
    if (card.website) L.push(card.website);
    if (card.ticketing_note) L.push(`Ticketing: ${card.ticketing_note}`);
    if (card.preshow_min) L.push(`Advertised start runs about ${card.preshow_min} min before the feature.`);
    if (card.amenities.length) L.push(`Amenities: ${card.amenities.join(", ")}`);
    if (card.nonprofit?.org) L.push(`Nonprofit: ${card.nonprofit.org}${card.nonprofit.url ? ` — ${card.nonprofit.url}` : ""}`);
    if (card.discounts.length) {
      L.push("", "Discounts:");
      for (const d of card.discounts) L.push(`  • ${d.label} — ${d.detail}${d.day !== null ? ` (day ${d.day})` : ""}`);
    }
    L.push("", `Next ${upcoming.length} showtime${upcoming.length === 1 ? "" : "s"}:`);
    if (!upcoming.length) L.push("  Nothing further on the board for this theater.");
    for (const s of upcoming) {
      L.push(`  ${s.nightOf} ${displayTime(s.startsAt)} — ${films.get(s.filmKey)?.title ?? s.filmKey}`);
      L.push(`    ${s.ticketUrl}${detailed ? `  (${s.confidence ?? "?"} · ${s.source_tier ?? "?"} · verified ${s.verified_at ?? "?"})` : ""}`);
    }
    L.push("", `Calendar feed: ${card.calendar_feed}`);
    return both(finish(base, L), data);
  },
);

tool(
  "scenef_film_details",
  {
    title: "Film details",
    description:
      `The full card for one film: title, year, runtime, genres, directors, cast, overview, rating, trailer and poster urls when present, every upcoming showtime with venue/time/ticket link, and a last-night flag when the run is ending. ${DETAILED_CARRIES_ACCURACY}`,
    inputSchema: {
      film: z.string().describe("Film title or SceneF slug."),
      response_format: responseFormat,
      region: regionParam,
    },
    outputSchema: filmDetailsOut.shape,
    annotations: READ_ONLY,
  },
  async (args) => {
    const detailed = isDetailed(args);
    const feed = await listings(args.region ? { region: args.region } : {});
    const base = baseOf(feed);
    const { film, candidates } = matchFilm(feed, args.film);

    if (!film) {
      // The miss names the board it looked at, in the hosted server's words.
      // This said "the San Francisco board" for every region while its own
      // structuredContent said la-central — a caller reading the prose was
      // told the wrong city had been searched. The sentence is shared with
      // scenef_search_showtimes, as it is on the hosted server.
      const text = finish(base, filmCandidatesText(base, args.film, candidates));
      return both(text, {
        ...base,
        query: args.film,
        matched: false,
        candidates: candidates.map((c) => filmShape(c)),
      });
    }

    const venues = venueIndex(feed);
    const now = Date.now();
    const showtimes = feed.screenings
      .filter((s) => s.filmKey === film.key && new Date(s.startsAt).getTime() >= now)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const nights = [...new Set(showtimes.map((s) => s.nightOf))].sort();
    const final_night = nights.length ? nights[nights.length - 1] : null;
    const tonight = await tonightNight(args.region);

    const card = filmShape(film, { full: true });
    const data = {
      ...base,
      query: args.film,
      matched: true,
      film: card,
      final_night,
      // The run ends tonight: every remaining showtime belongs to this night.
      is_last_night: Boolean(final_night && final_night === tonight && nights.length === 1),
      showtime_count: showtimes.length,
      showtimes: showtimes.map((s) => screeningShape(s, venues, { detailed })),
    };

    const L = [`${film.title}${film.year ? ` (${film.year})` : ""}`];
    const facts = [
      film.runtimeMin ? `${film.runtimeMin} min` : null,
      film.mpaa || null,
      (film.genres ?? []).join(", ") || null,
    ].filter(Boolean);
    if (facts.length) L.push(facts.join(" · "));
    if (film.directors?.length) L.push(`Directed by ${film.directors.join(", ")}`);
    if (film.cast?.length) L.push(`With ${film.cast.slice(0, 5).join(", ")}`);
    if (film.overview) L.push("", film.overview);
    if (card.trailer_url) L.push("", `Trailer: ${card.trailer_url}`);
    if (data.is_last_night) L.push("", "LAST NIGHT — this run ends tonight.");
    L.push("", `${showtimes.length} upcoming showtime${showtimes.length === 1 ? "" : "s"}${final_night ? `, through ${nightLabel(final_night)}` : ""}:`);
    if (!showtimes.length) L.push("  Nothing further on the board.");
    for (const s of showtimes.slice(0, 40)) {
      const v = venues.get(s.venueId);
      L.push(`  ${s.nightOf} ${displayTime(s.startsAt)} — ${v?.name ?? s.venueId}${s.tags?.length ? ` [${s.tags.join(", ")}]` : ""}`);
      L.push(`    ${s.ticketUrl}${detailed ? `  (${s.confidence ?? "?"} · ${s.source_tier ?? "?"} · verified ${s.verified_at ?? "?"})` : ""}`);
    }
    L.push("", `${SITE}/film/${film.slug}`);
    return both(finish(base, L), data);
  },
);

tool(
  "scenef_plan_movie_night",
  {
    title: "Plan a movie night",
    description:
      `The concierge: give it a window and a taste profile and it returns 2-4 complete plans — film + specific showtime + theater + why it fits — each with ticket and calendar links, plus one wildcard pick outside the stated genres. Rankings are pure preference-fit; never pay-ranked. ${DETAILED_CARRIES_ACCURACY}`,
    inputSchema: {
      when: whenParam,
      party_size: z.number().int().min(1).optional().describe("How many people are going."),
      preferences: z
        .object({
          likes: z.array(z.string()).optional().describe('Genres to favor, e.g. ["horror", "comedy"].'),
          avoids: z.array(z.string()).optional().describe("Genres to steer away from."),
          window: z
            .enum(["matinee", "early", "evening", "late"])
            .optional()
            .describe(
              "Preferred start-time window — a soft tilt. For a time you " +
                "genuinely cannot make, use time_after/time_before instead.",
            ),
          time_after: z
            .string()
            .optional()
            .describe(
              'HARD earliest start, "HH:MM" local 24h, e.g. "20:00" for ' +
                '"nothing before 8". Unlike the other preferences this does NOT ' +
                "degrade: if nothing starts that late the tool says so rather than " +
                "ranking a show you cannot get to.",
            ),
          time_before: z.string().optional().describe('HARD latest start, "HH:MM" local 24h. Same no-fallback rule.'),
          no_matinee: z.boolean().optional().describe("Penalize daytime shows."),
          formats: z.array(z.string()).optional().describe('Formats to favor, e.g. ["35mm", "70mm"].'),
          home_venues: z.array(z.string()).optional().describe('Home-theater venue ids to nudge upward, e.g. ["roxie"].'),
          discounts_only: z
            .boolean()
            .optional()
            .describe("Only screenings at theaters with a discount active that night."),
        })
        .optional()
        .describe(
          "Bring-your-own taste profile. Everything here tilts the ranking " +
            "and degrades gracefully EXCEPT time_after/time_before, which are " +
            "hard bounds.",
        ),
      response_format: responseFormat,
      region: regionParam,
    },
    outputSchema: planOut.shape,
    annotations: READ_ONLY,
  },
  async (args) => {
    const detailed = isDetailed(args);
    const p = args.preferences ?? {};

    // The ranking is the SITE'S, not this process's: the profile grammar goes
    // to the feed, which returns the same board ordered best-match-first with
    // match.score and match.why on every screening. Re-deriving taste here
    // would be a second opinion nobody asked for, and it would drift.
    const avoids = [...(p.avoids ?? []), ...(p.no_matinee ? ["matinee"] : [])];
    const profile = {
      likes: p.likes?.length ? p.likes.join(",") : undefined,
      no: avoids.length ? avoids.join(",") : undefined,
      formats: p.formats?.length ? p.formats.join(",") : undefined,
      home: p.home_venues?.length ? p.home_venues.join(",") : undefined,
      window: p.window,
      discounts: p.discounts_only ? "only" : undefined,
    };

    const w = await windowFor(args.when, args.region ? { ...profile, region: args.region } : profile);
    const venues = venueIndex(w.feed);
    const films = new Map(w.feed.films.map((f) => [f.key, f]));

    // HARD bounds, applied here and never relaxed.
    const bounded = timeFiltered(w.screenings, p.time_after, p.time_before);
    const boundedOut = w.screenings.length - bounded.length;
    const hardBound = p.time_after || p.time_before;

    const notes = [];
    if (w.warning) notes.push(w.warning);
    if (w.feed.profile?.ignored?.length) notes.push(`Ignored, not in any vocabulary: ${w.feed.profile.ignored.join(", ")}.`);
    const discountNote = w.feed.profile?.discounts_note ?? w.feed.profile?.note_discounts ?? null;
    const discounts_relaxed = Boolean(p.discounts_only && discountNote);
    if (discountNote) notes.push(discountNote);

    // One plan per film — four showings of the same picture is one idea.
    const seen = new Set();
    const picks = [];
    for (const s of bounded) {
      if (seen.has(s.filmKey)) continue;
      seen.add(s.filmKey);
      picks.push(s);
      if (picks.length >= 4) break;
    }

    const likes = lower(p.likes);
    const wildcardPick =
      likes.length
        ? bounded.find((s) => {
            const f = films.get(s.filmKey);
            return f && !lower(f.genres).some((g) => likes.includes(g)) && !picks.slice(0, 3).includes(s);
          }) ?? null
        : null;

    const planOf = (s, is_wildcard) => ({
      is_wildcard,
      score: s.match?.score ?? 0,
      why: is_wildcard
        ? [...(s.match?.why ?? []), "Wildcard — outside the genres you named"]
        : s.match?.why ?? [],
      film: filmShape(films.get(s.filmKey)),
      showtime: screeningShape(s, venues, { detailed: true }),
    });

    const plans = picks.slice(0, wildcardPick ? 3 : 4).map((s) => planOf(s, false));
    if (wildcardPick) plans.push(planOf(wildcardPick, true));

    const data = {
      ...baseOf(w.feed),
      window: w.label,
      nights: w.nights,
      party_size: args.party_size ?? null,
      note: notes.length ? notes.join(" ") : null,
      discounts_relaxed,
      plan_count: plans.length,
      plans,
      wildcard: wildcardPick
        ? { why: planOf(wildcardPick, true).why, showtime: screeningShape(wildcardPick, venues, { detailed: true }) }
        : null,
    };

    const L = [`Movie night — ${w.label}${args.party_size ? `, party of ${args.party_size}` : ""}`];
    if (data.note) L.push(`Note: ${data.note}`);
    if (hardBound && !bounded.length) {
      L.push(
        "",
        `Nothing starts inside your hard time bounds (${p.time_after ?? "—"}–${p.time_before ?? "—"}). ${boundedOut} showtime${boundedOut === 1 ? "" : "s"} fell outside them, and none is offered: a plan you cannot get to is not a plan.`,
      );
    } else if (!plans.length) {
      L.push("", "Nothing on the board fits that profile. Widen the window or drop a constraint.");
    }
    plans.forEach((pl, i) => {
      const s = pl.showtime;
      L.push("");
      L.push(`${i + 1}. ${pl.film?.title ?? "—"}${pl.film?.year ? ` (${pl.film.year})` : ""}${pl.is_wildcard ? "  — WILDCARD" : ""}`);
      L.push(`   ${s.venue.name} · ${s.night_of} · ${s.local_time}${s.tags?.length ? ` [${s.tags.join(", ")}]` : ""}`);
      if (pl.why.length) L.push(`   Why: ${pl.why.join("; ")}`);
      L.push(`   Tickets: ${s.ticket_url}`);
      L.push(`   Calendar: ${s.calendar_feed}`);
      if (detailed) L.push(`   ${s.confidence ?? "?"} · ${s.source_tier ?? "?"} · verified ${s.verified_at ?? "?"}`);
    });
    L.push("", "Ranking is preference-fit only — never pay-ranked, and nothing is hidden from you.");
    return both(finish(data, L), data);
  },
);

tool(
  "scenef_discounts",
  {
    title: "Discount grid",
    description:
      "Every structured discount across one board's theaters — venue, label, detail, and day-bound days — with the ones that apply today flagged.",
    inputSchema: { response_format: responseFormat, region: regionParam },
    outputSchema: discountsOut.shape,
    annotations: READ_ONLY,
  },
  async (args) => {
    void args;
    const feed = await listings(args.region ? { region: args.region } : {});
    const base = baseOf(feed);
    const tonight = await tonightNight(args.region);
    const { dowOf, dayName } = await import("./shape.js");
    const today_dow = dowOf(tonight);
    const today_name = dayName(tonight);

    let applies_today_count = 0;
    const venues = feed.venues
      .filter((v) => (v.discounts ?? []).length)
      .map((v) => ({
        ...venueShape(v),
        discounts: (v.discounts ?? []).map((d) => {
          // A discount with no day runs every day; a day-bound one only counts
          // today when today is that day.
          const applies_today = d.day === undefined || d.day === null ? true : d.day === today_dow;
          if (applies_today) applies_today_count += 1;
          return {
            label: d.label,
            kind: d.kind ?? "other",
            day: d.day ?? null,
            detail: d.detail ?? "",
            applies_today,
          };
        }),
      }));

    const data = { ...base, today_dow, today_name, applies_today_count, venues };

    const L = [`Theater discounts on this board — ${applies_today_count} active today (${today_name})`];
    for (const v of venues) {
      L.push("", `${v.name}${v.neighborhood ? ` · ${v.neighborhood}` : ""}`);
      for (const d of v.discounts) {
        L.push(`  ${d.applies_today ? "•" : "·"} ${d.label} — ${d.detail}${d.day !== null ? ` (${d.applies_today ? "today" : "day " + d.day})` : ""}`);
      }
    }
    return both(finish(base, L), data);
  },
);

tool(
  "scenef_coming_soon",
  {
    title: "Coming soon (on-sale radar)",
    description:
      `Films whose first screening on this board is more than 48 hours out, sorted by first night — the on-sale radar for runs worth booking early. Configurable horizon. ${DETAILED_CARRIES_ACCURACY}`,
    inputSchema: {
      horizon_days: z
        .number()
        .int()
        .min(1)
        .max(90)
        .optional()
        .describe("How far ahead to look (default 21 days)."),
      response_format: responseFormat,
      region: regionParam,
    },
    outputSchema: comingOut.shape,
    annotations: READ_ONLY,
  },
  async (args) => {
    void args;
    const horizon_days = Math.min(Math.max(args.horizon_days ?? 21, 1), 90);
    const feed = await listings(args.region ? { region: args.region } : {});
    const base = baseOf(feed);
    const venues = venueIndex(feed);
    const films = new Map(feed.films.map((f) => [f.key, f]));

    const cutoff = Date.now() + 48 * 3600_000;
    const horizonEnd = Date.now() + horizon_days * 86_400_000;

    const first = new Map();
    for (const s of feed.screenings) {
      const t = new Date(s.startsAt).getTime();
      const prev = first.get(s.filmKey);
      if (!prev || t < prev.t) first.set(s.filmKey, { t, screening: s });
    }

    const rows = [...first.entries()]
      .filter(([, v]) => v.t > cutoff && v.t <= horizonEnd)
      .map(([key, v]) => {
        const openingIds = [
          ...new Set(feed.screenings.filter((s) => s.filmKey === key && s.nightOf === v.screening.nightOf).map((s) => s.venueId)),
        ];
        return {
          film: films.get(key),
          first_night: v.screening.nightOf,
          opening_venues: openingIds.map((id) => venues.get(id)?.name ?? id),
        };
      })
      .filter((r) => r.film)
      .sort((a, b) => a.first_night.localeCompare(b.first_night) || a.film.title.localeCompare(b.film.title));

    const data = {
      ...base,
      horizon_days,
      film_count: rows.length,
      films: rows.map((r) => ({ ...filmShape(r.film), first_night: r.first_night, opening_venues: r.opening_venues })),
    };

    const L = [`Coming soon — ${rows.length} film${rows.length === 1 ? "" : "s"} whose first screening on this board is more than 48 hours out, within ${horizon_days} days.`];
    if (!rows.length) L.push("", "Nothing that far ahead on the board yet — repertory calendars post close to the date.");
    // The prose is capped; the structured payload is not. A cap nobody is told
    // about reads as "that is all of them", which is the one thing it is not.
    const PROSE_CAP = 40;
    if (rows.length > PROSE_CAP) {
      L.push("", `Listing the first ${PROSE_CAP} by date — all ${rows.length} are in the structured payload.`);
    }
    for (const r of rows.slice(0, PROSE_CAP)) {
      L.push("");
      L.push(`${nightLabel(r.first_night)} — ${r.film.title}${r.film.year ? ` (${r.film.year})` : ""}`);
      L.push(`  ${r.opening_venues.join(", ")}`);
      L.push(`  ${SITE}/film/${r.film.slug}`);
    }
    return both(finish(base, L), data);
  },
);

// ——— scenef_resolve_board — THE TRANSLATION AN AGENT WAS DOING BY GUESS ———
//
// Every other tool takes `region`, our handle. A person says "Pasadena" or
// "94121", and until now the agent had to map that to a handle itself —
// which means guessing, and a wrong guess returns another city's showtimes
// with a 200. This does the translation from a table built out of the
// venue and census data, and REFUSES in three distinguishable ways rather
// than picking.
//
// It does not break the explicit-region law. That law forbids inferring a
// region from where the CALLER is; this reads a place the caller stated
// and echoes back what it matched, so the same input always gives the same
// board and the reasoning is visible rather than trusted.
//
// The table lives on the site. This server reads it through the public
// door (/api/boards?place=, see feed.js) and picks the answer to the shape
// advertised below — the accuracy lesson, again: a verbatim passthrough
// turns the door's next field into a validation crash in every client.
tool(
  "scenef_resolve_board",
  {
    title: "Which board covers this place",
    description:
      "Translate a city, 5-digit ZIP, neighborhood or board alias into the region handle every other tool takes. Returns the board and WHAT matched it. Refuses rather than guessing: an ambiguous name returns candidates (Gainesville is a town in Texas and another in Florida), a place we cover but have not published returns outside_coverage with the nearest published boards, and an unknown string returns unknown with no fallback board. Coordinates are not accepted — this reads names, not locations.",
    inputSchema: {
      place: z
        .string()
        .describe('A city ("Pasadena"), a 5-digit ZIP ("94121"), a neighborhood ("the Mission") or a board alias ("the East Bay", "sf").'),
    },
    outputSchema: placeOut.shape,
    annotations: READ_ONLY,
  },
  async (args) => {
    const r = await resolvePlace(args.place);
    const data = {
      ok: r.ok,
      input: typeof r.input === "string" ? r.input : String(args.place ?? "").trim(),
      ...(r.matched ? { matched: r.matched } : {}),
      ...(r.region ? { region: r.region } : {}),
      ...(r.region_name ? { region_name: r.region_name } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
      ...(Array.isArray(r.candidates)
        ? { candidates: r.candidates.map((c) => ({ region: c.region, region_name: c.region_name, why: c.why })) }
        : {}),
      ...(Array.isArray(r.nearest_lit)
        ? { nearest_lit: r.nearest_lit.map((n) => ({ region: n.region, region_name: n.region_name, miles: n.miles })) }
        : {}),
      ...(typeof r.note === "string" ? { note: r.note } : {}),
    };
    // The hosted server's line, word for word.
    const line = data.ok
      ? `${data.input} is on the ${data.region_name} board (region=${data.region}), matched by ${data.matched}.`
      : data.reason === "ambiguous"
        ? `"${data.input}" names more than one board: ${(data.candidates ?? []).map((c) => `${c.region} (${c.region_name})`).join(", ")}. Ask which, rather than choosing.`
        : data.reason === "outside_coverage"
          ? `${data.note ?? ""}${(data.nearest_lit ?? []).length ? ` Nearest published: ${(data.nearest_lit ?? []).map((n) => `${n.region_name} (${n.miles}mi)`).join(", ")}.` : ""}`
          : `I do not know "${data.input}". Call scenef_now for the boards I do publish.`;
    return both(line, data);
  },
);

tool(
  "scenef_now",
  {
    title: "Right now",
    description:
      `The cheap is-anything-on call: how many screenings tonight, the next 5 curtains across this board with venue/time/film, and dataset freshness per source. ${DETAILED_CARRIES_ACCURACY}`,
    inputSchema: { response_format: responseFormat, region: regionParam },
    outputSchema: nowOut.shape,
    annotations: READ_ONLY,
  },
  async (args) => {
    const detailed = isDetailed(args);
    const extra = args.region ? { region: args.region } : {};

    // THE HOSTED RULE, EXACTLY — three numbers from two sets.
    //
    //   screenings_tonight  the board's OWN tonight slice. `when=tonight` is
    //                       the site's tonight(d).screenings: the live night
    //                       in the board's timezone, a show kept while it is
    //                       still inside the site's catchable grace.
    //   still_to_come       that slice minus anything whose curtain has gone
    //                       up: Date.parse(startsAt) >= Date.now(). startsAt
    //                       carries the venue's own offset, so the instant it
    //                       names is the theatre's wall clock — Honolulu's on
    //                       the Oahu board — never this process's.
    //   next_curtains       the WHOLE board through the same filter, soonest
    //                       first, five of them. A spent evening therefore
    //                       rolls into tomorrow's matinees, and each one says
    //                       which night it belongs to.
    //
    // The version before this drew next_curtains from the tonight slice
    // UNFILTERED and counted the same slice as still_to_come, on the theory
    // that the site had already decided what was catchable. It had decided
    // what to KEEP; the hosted server still asks the clock. So a 3:25 PM show
    // led "next curtains" at 3:41 PM, and still_to_come disagreed with the
    // hosted answer for the same board and the same minute. scenef_whats_playing
    // reporting MORE showtimes for tonight than this tool says are still to
    // come is correct: that list is the slice, this number is the clock.
    const [feed, board] = await Promise.all([listings({ when: "tonight", ...extra }), listings(extra)]);
    const now = Date.now();
    const notStarted = (s) => Date.parse(s.startsAt) >= now;

    // Which night the board is calling tonight, and whether it is: the feed
    // labels its own roll-forward (tonight_is, 2026-09-05), so a dark or spent
    // evening is reported as the next lit night rather than as an empty
    // tonight. Older payloads without the label fall back to the night the
    // slice's screenings sit on.
    const tonightIs = feed.tonight_is && typeof feed.tonight_is === "object" ? feed.tonight_is : null;
    const tonight = tonightIs?.night ?? (await tonightNight(args.region));
    const is_tonight = tonightIs ? tonightIs.label === "tonight" : true;

    const base = baseOf(feed);
    const venues = venueIndex(board);
    const films = new Map(board.films.map((f) => [f.key, f]));

    const all = feed.screenings;
    const stillToCome = all.filter(notStarted);
    const next = board.screenings
      .filter(notStarted)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      .slice(0, 5);

    // Freshness per source, computed from the whole board: a source is healthy
    // when its most recent verification landed within the last 24 hours. Stated
    // rather than assumed — `basis` says exactly what the number means.
    //
    // RECORDED GAP (2026-09-08 review), left as is on purpose. The hosted
    // server's sources.healthy/total counts d.sourceHealth — one entry per
    // venue, ok when that venue's own fetch succeeded — so it reports e.g.
    // 17/17 where this reports 9/9 distinct sources verified within 24h. No
    // public REST door exposes sourceHealth, so the two numbers cannot be
    // made to agree from this side without inventing one; the fix is a REST
    // door on the hosted side, not an approximation here. The description
    // is shared with the hosted server and must not change for this.
    const latest = new Map();
    for (const s of board.screenings) {
      for (const src of s.sources ?? [s.provenance?.source].filter(Boolean)) {
        const at = s.verified_at ?? s.provenance?.lastVerifiedAt ?? null;
        if (!at) continue;
        const prev = latest.get(src);
        if (!prev || at > prev) latest.set(src, at);
      }
    }
    const healthy = [...latest.values()].filter((at) => now - new Date(at).getTime() < 86_400_000).length;

    const boards = await boardsList();
    const data = {
      ...base,
      boards: boards ?? [],
      night_of: tonight,
      is_tonight,
      screenings_tonight: all.length,
      still_to_come: stillToCome.length,
      next_curtains: next.map((s) => ({
        ...screeningShape(s, venues, { detailed }),
        film: filmShape(films.get(s.filmKey)),
      })),
      sources: {
        healthy,
        total: latest.size,
        basis: "A source is healthy when its most recent verification landed within the last 24 hours.",
      },
    };

    const L = [
      is_tonight
        ? `${nightLabel(tonight)} — ${all.length} screening${all.length === 1 ? "" : "s"} tonight, ${stillToCome.length} still to come.`
        : `${nightLabel(tonight)} (the next lit night) — ${all.length} screening${all.length === 1 ? "" : "s"}.`,
      `Sources: ${healthy}/${latest.size} verified within 24 hours. Data as of ${base.data_as_of}.`,
    ];
    L.push("", "Next curtains city-wide:");
    if (!next.length) L.push("  No upcoming curtains on the books.");
    for (const s of next) {
      L.push(
        `  ${displayTime(s.startsAt)}${s.nightOf !== tonight ? ` (${nightLabel(s.nightOf)})` : ""} ${venues.get(s.venueId)?.short ?? s.venueId} — ${films.get(s.filmKey)?.title ?? s.filmKey}`,
      );
      L.push(`    ${s.ticketUrl}${detailed ? `  (${s.confidence ?? "?"} · verified ${s.verified_at ?? "?"})` : ""}`);
    }
    // The instructions promise this tool names the boards — each id with the
    // place it names, from /api/boards (see boardsList). When the roster is
    // unavailable the pointer is honest instead of the list being invented.
    L.push("", `This board: ${base.region_name} (${base.region}) · ${base.timezone}.`);
    if (boards?.length) {
      L.push(
        `Pass region= to any tool to read another. ${boards.length} boards:`,
        boards.map((b) => `${b.region} — ${b.name} [${b.timezone}]`).join(", "),
      );
    } else {
      L.push("Pass region= to any tool to read another board; the current set is listed at https://scenef.com/api/boards.");
    }
    return both(finish(base, L), data);
  },
);

tool(
  "scenef_accuracy",
  {
    title: "The accuracy record",
    description: `${ACCURACY_CONTRACT} This tool returns that record: the site-wide confidence mix, the counts of verification checks confirmed / missing / unreachable over the record's window (window_days in the payload — 30 days at present) with the pass rate and the exact denominator it was computed from, the same per venue with source tier and last-verified time, and the definitions of every level. Checks that could not run — a bot wall, a client-rendered page — are graded unreachable and excluded from the pass rate rather than counted as passes. Quote these numbers directly; they are recomputed on every call.`,
    inputSchema: { response_format: responseFormat, region: regionParam },
    outputSchema: accuracyOutput.shape,
    annotations: READ_ONLY,
  },
  async (args) => {
    const detailed = isDetailed(args);
    const payload = await accuracyRecord(args.region);
    // The API's record, picked to the advertised schema rather than passed
    // verbatim: the feed grew a `scope` field (2026-09-08) and verbatim
    // passthrough turned that growth into a validation crash for every
    // client. An explicit pick means the API can evolve without breaking
    // the contract this tool advertises.
    const record = {
      data_as_of: payload.data_as_of,
      attribution: payload.attribution,
      site: payload.site,
      venues: payload.venues,
      method: payload.method,
      docs: payload.docs,
    };
    const s = payload.site;

    const L = [
      `SceneF accuracy record — data as of ${payload.data_as_of}`,
      "",
      `${s.checks} verification checks over ${s.window_days} days: ${s.confirmed} confirmed, ${s.missing} missing, ${s.unreachable} unreachable.`,
      `Pass rate ${s.pass_rate === null ? "not yet computable" : `${(s.pass_rate * 100).toFixed(2)}%`} — ${s.pass_rate_basis}`,
      `${s.screenings} screenings on the board. Confidence mix: ${Object.entries(s.confidence_mix).map(([k, v]) => `${k} ${v}`).join(" · ")}`,
    ];

    const venues = [...payload.venues].sort((a, b) => b.checks - a.checks);
    L.push("", "By theater:");
    for (const v of detailed ? venues : venues.slice(0, 10)) {
      L.push(
        `  ${v.name} — ${v.source_tier ?? "?"} · ${v.screenings} screenings · ${v.checks} checks${v.pass_rate === null ? "" : ` · ${(v.pass_rate * 100).toFixed(1)}%`} · last verified ${v.last_verified_at ?? "never"}`,
      );
    }
    if (!detailed && venues.length > 10) L.push(`  …${venues.length - 10} more — call with response_format "detailed".`);

    if (detailed) {
      L.push("", "Confidence levels:");
      for (const [k, v] of Object.entries(payload.method.confidence_levels)) L.push(`  ${k}: ${v}`);
      L.push("", `Rings: ${payload.method.rings.join(" · ")}`);
    }
    // The one tool whose tail is its own, mirrored per tool: the hosted
    // accuracySnapshot() does not go through finish(). It ends with the
    // record's url and method page, then the attribution line WITHOUT the
    // "accuracy record:" suffix — this answer IS the record.
    L.push(
      "",
      `Full JSON: ${SITE}/api/accuracy · method: ${payload.docs}`,
      `— Showtimes via SceneF.com, data as of ${payload.data_as_of}`,
    );
    return both(L.join("\n"), record);
  },
);
