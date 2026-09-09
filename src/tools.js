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
import {
  SITE,
  accuracyRecord,
  boardsList,
  cityNow,
  listings,
  liveNight,
  minutesOf,
  night,
  nightClockOf,
  resolvePlace,
  shiftDate,
  tonight,
} from "./feed.js";
import {
  baseOf,
  both,
  displayTime,
  dowOf,
  filmCandidatesText,
  filmShape,
  filmUrl,
  finish,
  matchFilm,
  matchVenue,
  nightLabel,
  normText,
  screeningShape,
  theaterCandidatesText,
  venueCard,
  venueHit,
  venueIndex,
  venueShape,
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

/** The hosted DAY_NAMES, indexed by cityNow().dow (Sunday = 0). */
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The hosted sitePlace(): the states the lit boards sit in, serially —
 *  "California and Hawaii" while each has a board. It names the
 *  whats_playing title and the search coverage note. The parity test
 *  compares the title verbatim, so a third state lit on the hosted side
 *  goes red here rather than drifting. */
const SITE_PLACE = "California and Hawaii";

// —————————————————————————————————————————————————————————— the clock
//
// Every selection below is made AT CALL TIME from Date.now() and the board's
// timezone, exactly where the hosted tools make it. The feed is the rows;
// which of them are tonight, which have started, and what "tomorrow" means
// are this process's to compute. This server used to reuse the feed's served
// slices and labels for all three, and a CDN copy a minute old answered for
// a minute that had passed — most visibly right after midnight, when the
// slice still said "tomorrow" for the night the hosted server was calling
// tonight, and all evening, when film_count and showtime_count included
// shows whose curtain had gone up.

/** The hosted notStarted(): a screening whose curtain is still ahead. The
 *  instant in startsAt carries the venue's own offset, so this is the
 *  theatre's clock against the caller's, with no zone lookup. */
const notStarted = (s) => Date.parse(s.startsAt) >= Date.now();

/** All screenings that have not started yet, soonest first — the hosted
 *  upcoming(d). scenef_search_showtimes, scenef_theater_info,
 *  scenef_film_details and scenef_now's next curtains start from here;
 *  scenef_whats_playing and scenef_plan_movie_night apply notStarted to a
 *  night's pool; scenef_discounts and scenef_coming_soon apply neither, as
 *  on the hosted server. */
const upcoming = (feed) => feed.screenings.filter(notStarted).sort((a, b) => a.startsAt.localeCompare(b.startsAt));

/** Minutes since midnight with past-midnight shows folded onto the evening
 *  (24:00+) — the hosted eveningMinutes(), over minutesOf(), which converts
 *  the instant in the board's zone. Feeds ONLY the time_after/time_before
 *  filters, as it does there. */
const eveningMinutes = (s, tz) => {
  const m = minutesOf(s.startsAt, tz);
  return m < 4 * 60 ? m + 1440 : m;
};

/** Parse "HH:MM"; values before 4am are treated as late-night (same
 *  evening) — the hosted parseHHMM(). Garbage is undefined, and the caller
 *  REPORTS it rather than dropping the filter. */
function parseHHMM(text) {
  if (!text) return undefined;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
  if (!m) return undefined;
  let mins = Number(m[1]) * 60 + Number(m[2]);
  if (mins < 4 * 60) mins += 1440;
  return mins;
}

// ————————————————————————————————————————————————————————— the window
//
// THE HOSTED resolveWhen() (src/lib/mcp/tools.ts), word for word. It decides
// what "tonight", "tomorrow" and "weekend" MEAN, so it reads the board's
// clock, and every window-taking tool routes through it:
//
//   tonight      the board's live night per tonight() — the label says which
//                night that turned out to be: "tonight", "tomorrow (nothing
//                tonight)", or "<Weekday, Month D> (next lit night)"
//   tomorrow     the night after whatever tonight resolves to — the one rule
//                that keeps the two tokens disjoint at every hour
//   weekend      Fri/Sat/Sun of the current calendar week, nights already
//                past dropped; once the weekend is spent, the next one
//   YYYY-MM-DD   that night
//
// Anything else — "today" included — is REFUSED: no window, no nights, and
// the sentence below as the note. This server used to read "today" as
// tonight and answer an unknown token for tonight with a warning; the
// hosted server answers neither, and a caller who learned the grammar there
// must find the same wall here.
function resolveWhen(feed, when) {
  const token = String(when ?? "tonight").trim().toLowerCase();
  const { date, dow } = cityNow(feed.timezone);
  if (token === "tonight" || token === "") {
    const t = tonight(feed);
    const label =
      t.label === "tonight"
        ? "tonight"
        : t.label === "tomorrow"
          ? "tomorrow (nothing tonight)"
          : `${nightLabel(t.nightIso)} (next lit night)`;
    return { nights: [t.nightIso], label };
  }
  if (token === "tomorrow") {
    const n = shiftDate(tonight(feed).nightIso, 1);
    return { nights: [n], label: `tomorrow, ${nightLabel(n)}` };
  }
  if (token === "weekend") {
    const toFri = dow === 6 ? -1 : dow === 0 ? -2 : 5 - dow;
    const fri = shiftDate(date, toFri);
    let nights = [fri, shiftDate(fri, 1), shiftDate(fri, 2)].filter((n) => n >= date);
    if (!nights.length) {
      const nextFri = shiftDate(fri, 7);
      nights = [nextFri, shiftDate(nextFri, 1), shiftDate(nextFri, 2)];
    }
    return { nights, label: `this weekend (${nights.map(nightLabel).join(" · ")})` };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(token)) {
    return { nights: [token], label: nightLabel(token) };
  }
  return {
    nights: [],
    label: token,
    error: `Unrecognized "when": "${when}". Use "tonight", "tomorrow", "weekend", or a YYYY-MM-DD date.`,
  };
}

/** ONE NOTABLE ITEM ON THE WIRE — the hosted whatsPlayingData map over a
 *  NotableItem (tools.ts), key for key: title, venue, local_time, night_of,
 *  evidence, ticket_url, and nothing else. The feed carries the hosted
 *  NotableItem verbatim (api/listings serializes notable.items as computed),
 *  so `venue` is already the venue's SHORT name and `time` already the wall
 *  clock in the board's zone; both pass straight through. `evidence` is the
 *  PRIMARY reason's receipt: reasons[] arrives priority-sorted (measured
 *  urgency, then finality, then print, live, price) and the hosted mapping
 *  reads reasons[0]?.evidence ?? null — one receipt, never a join of them.
 *  This server shipped film_slug, screening_id and a reasons[] array on
 *  every item, so the same fact answered in two shapes. The two fallbacks
 *  (`?? displayTime`, `?? null`) only keep the key present if a feed row
 *  ever omits the field; when it is there the value is the hosted one.
 *  Exported so the parity test can assert the key set without a live fact. */
export function notableItem(n) {
  return {
    title: n.title,
    venue: n.venue,
    local_time: n.time ?? displayTime(n.startsAt),
    night_of: n.nightOf,
    evidence: n.reasons?.[0]?.evidence ?? null,
    ticket_url: n.ticketUrl ?? null,
  };
}

/** At most this many notable items ride structuredContent — the hosted
 *  `.slice(0, 5)` in whatsPlayingData. The lead is a headline, not the list. */
const NOTABLE_CAP = 5;

/** The notable lead is strictly about tonight, so — the hosted rule — an
 *  item ships only when ITS night is inside the window asked for; then the
 *  cap, then the shape. This server shipped every qualifying item. */
function notableFor(feed, nights) {
  return (feed.notable?.items ?? [])
    .filter((n) => nights.includes(n.nightOf))
    .slice(0, NOTABLE_CAP)
    .map(notableItem);
}

/** First sentence of the overview, as the one-line hook — the hosted hook(). */
function hook(film) {
  const o = String(film?.overview ?? "").trim();
  if (!o) return null;
  const m = o.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : o).trim();
}

// ——————————————————————————————————————————————————————————— the tools

export const TOOLS = [];
const tool = (name, config, handler) => TOOLS.push({ name, config, handler });

tool(
  "scenef_whats_playing",
  {
    title: `What's playing in ${SITE_PLACE}`,
    description:
      `Ranked list of films playing ${SITE_PLACE} theaters in a given window (tonight, tomorrow, the weekend, or a date), with optional genre and format filters. When the window covers tonight, opens with Notable tonight — scarcity facts with evidence (measured seat counts, final nights, lone prints, posted discounts, live elements); lead with those when asked what to see. Each entry carries year, runtime, genres, a one-line hook, venue count, showtime_count, the next showtime, and the film's SceneF url. The full per-showtime rows are in "detailed", or from scenef_search_showtimes scoped to one film or theatre. ${DETAILED_CARRIES_ACCURACY}`,
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
    const feed = await listings(args.region ? { region: args.region } : {});
    const base = baseOf(feed);
    const venues = venueIndex(feed);
    const films = new Map(feed.films.map((f) => [f.key, f]));

    // THE ONE SELECTION — the hosted whatsPlayingSelect(), step for step:
    // the window, the night's pool with started shows dropped, the format
    // filter on raw tags, films grouped in curtain order, the genre filter,
    // the ranking, the cap. Both renderers below read it and neither
    // re-derives it.
    const max = Math.min(Math.max(args.max_results ?? 12, 1), 25);
    const w = resolveWhen(feed, args.when);
    const notable = w.error ? [] : notableFor(feed, w.nights);

    // A bad window or an empty match is a RESULT, not an error: the note
    // says which, the prose is the same lines, and the counts are zero.
    const problem = (lines, label, nights) => {
      const data = { ...base, window: label, nights, note: lines.join(" "), notable, film_count: 0, films: [] };
      return both(finish(base, lines), data);
    };
    if (w.error) return problem([w.error], "", []);

    let pool = w.nights
      .flatMap((n) => night(feed, n))
      .filter(notStarted)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    if (args.formats?.length) {
      const wanted = args.formats.map((f) => String(f).trim().toLowerCase());
      pool = pool.filter((s) => (s.tags ?? []).some((t) => wanted.includes(t)));
    }

    const byFilm = new Map();
    for (const s of pool) {
      const arr = byFilm.get(s.filmKey) ?? [];
      arr.push(s);
      byFilm.set(s.filmKey, arr);
    }

    // RANKED AS THE HOSTED SERVER RANKS: breadth of the run (distinct
    // venues), then depth (showtimes), then the TMDB rating. Nothing about
    // scarcity and nothing about the earliest curtain — this server put
    // notable films first and broke ties on the first showtime, and the
    // same board came back in a different order on the two transports.
    const wantedGenres = args.genres?.map((g) => String(g).trim().toLowerCase());
    const entries = [...byFilm.entries()]
      .map(([key, shows]) => ({ film: films.get(key), shows }))
      .filter((e) => e.film)
      .filter((e) => !wantedGenres?.length || (e.film.genres ?? []).some((g) => wantedGenres.includes(g.toLowerCase())))
      .sort((a, b) => {
        const av = new Set(a.shows.map((s) => s.venueId)).size;
        const bv = new Set(b.shows.map((s) => s.venueId)).size;
        return bv - av || b.shows.length - a.shows.length || (b.film.ratings?.tmdb ?? 0) - (a.film.ratings?.tmdb ?? 0);
      })
      .slice(0, max);

    if (!entries.length) {
      return problem(
        [`Nothing matching those filters ${w.label}.`, `Try widening the genres/formats, or a different date.`],
        w.label,
        w.nights,
      );
    }

    const data = {
      ...base,
      window: w.label,
      nights: w.nights,
      note: null,
      notable,
      // THE NUMBER RETURNED, not the number matched — the hosted
      // whatsPlayingData reports sel.entries.length, and its selection is
      // already capped at max_results, so film_count is the length of
      // films[].
      film_count: entries.length,
      films: entries.map(({ film, shows }) => ({
        ...filmShape(film, { region: base.region }),
        hook: hook(film),
        venue_count: new Set(shows.map((s) => s.venueId)).size,
        showtime_count: shows.length,
        next_showtime: screeningShape(shows[0], venues, { detailed: false }),
        // The rows themselves only in detailed — the 2026-09-08 wire ruling.
        // Concise keeps the count and the next curtain; search_showtimes is
        // the tool for full rows scoped to one film or theatre.
        ...(detailed ? { showtimes: shows.map((s) => screeningShape(s, venues, { detailed })) } : {}),
      })),
    };

    const L = [];
    if (notable.length) {
      // The same five items the JSON carries, each with its one receipt —
      // the hosted prose also prints reasons[0].evidence and stops at five.
      L.push("Notable tonight — scarcity facts, with evidence:");
      for (const n of notable) {
        L.push(`  • ${n.title} — ${n.venue}, ${n.local_time}${n.evidence ? ` (${n.evidence})` : ""}`);
      }
      L.push("");
    }
    // THE HOSTED HEADER LINE, verbatim. The label already carries the night
    // for tomorrow and date windows ("tomorrow, Thursday, September 10"),
    // and this server appended nightLabel again — "tomorrow, Thursday,
    // September 10, Thursday, September 10".
    L.push(`Playing ${w.label} — ${entries.length} film${entries.length === 1 ? "" : "s"}:`, "");
    entries.forEach(({ film: f, shows }, i) => {
      const venue_count = new Set(shows.map((s) => s.venueId)).size;
      const facts = [f.year, f.runtimeMin ? `${f.runtimeMin} min` : null, (f.genres ?? []).slice(0, 3).join(", ") || null];
      L.push(`${String(i + 1).padStart(2)}. ${f.title} — ${facts.filter(Boolean).join(" · ")}`);
      const first = shows[0];
      L.push(
        `    ${venue_count} theater${venue_count === 1 ? "" : "s"} · ${shows.length} showtime${shows.length === 1 ? "" : "s"} · next ${displayTime(first.startsAt)} at ${venues.get(first.venueId)?.short ?? first.venueId}`,
      );
      const h = hook(f);
      if (h) L.push(`    ${h}`);
      if (detailed) {
        for (const s of shows.slice(0, 8)) {
          const v = venues.get(s.venueId);
          L.push(
            `      ${displayTime(s.startsAt)} ${v?.short ?? s.venueId}${s.tags?.length ? ` [${s.tags.join(", ")}]` : ""} — ${s.ticketUrl} (${s.confidence ?? "?"}, verified ${s.verified_at ?? "?"})`,
          );
        }
        if (shows.length > 8) L.push(`      …${shows.length - 8} more`);
      }
      L.push(`    ${filmUrl(f.slug, base.region)}`);
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
    // THE WHOLE BOARD, THEN THE FILTERS — the hosted searchShowtimesSelect().
    // This server fetched the night slice when a date was given, so the film
    // matcher saw only that night's films: a title playing every other night
    // of the week was "not on the board", and an ambiguous query listed
    // different candidates depending on the date beside it. The hosted
    // server matches the film over the board and only then narrows the
    // screenings to the night and the hours asked for.
    const feed = await listings(args.region ? { region: args.region } : {});
    const venues = venueIndex(feed);
    const films = new Map(feed.films.map((f) => [f.key, f]));
    const base = baseOf(feed);

    const wantFilm = args.film?.trim();
    const askedVenues = args.venues ?? [];
    if (!wantFilm && !askedVenues.length) {
      const refusal = NEITHER;
      // The hosted searchShowtimesData refusal, key for key and in its
      // order (tools.ts). The three search answers — refusal, ambiguity,
      // match — form a union with ONE key set, so a caller can ask
      // `.filtered_by` or `.candidates` of any search payload and get a
      // straight answer: "venue" (the mode the selection reports when no
      // film carried the query) and [] here. This server omitted both, and
      // wrote query:null where the hosted server echoes p.film ?? null —
      // the same null for an absent film, the caller's own blank for a
      // whitespace one.
      return both(finish(base, [refusal]), {
        ...base,
        query: args.film ?? null,
        matched: false,
        filtered_by: "venue",
        refusal,
        candidates: [],
        showtime_count: 0,
        venues: [],
        unknown_venues: [],
        coverage_note: null,
      });
    }

    let film = null;
    if (wantFilm) {
      const m = matchFilm(feed, wantFilm);
      if (!m.film) {
        // The same miss scenef_film_details gives, from the same function —
        // the hosted server renders both through one filmCandidatesText().
        const text = finish(base, filmCandidatesText(base, wantFilm, m.candidates));
        return both(text, {
          ...base,
          query: args.film,
          matched: false,
          filtered_by: "film",
          candidates: m.candidates.map((c) => filmShape(c, { region: base.region })),
          unknown_venues: [],
          coverage_note: null,
          showtime_count: 0,
          venues: [],
        });
      }
      film = m.film;
    }

    // Started shows are gone from a search: the hosted selection starts
    // from upcoming(d), never the raw board. This counted 54 showtimes for
    // Akira on la-central where the hosted server counted the 30 still ahead.
    let shows = upcoming(feed);
    if (film) shows = shows.filter((s) => s.filmKey === film.key);

    // A FILTER WE CANNOT HONOUR IS REPORTED, NEVER DROPPED — and "tonight",
    // "today" and "tomorrow" are ACCEPTED for `date`, as they are on the
    // hosted server, read off the board's calendar date. This server sent
    // date=tonight to the feed as a night and answered with a 400.
    const unusable = [];
    if (args.date !== undefined) {
      const raw = String(args.date).trim();
      const today = cityNow(base.timezone).date;
      const spoken = { tonight: today, today, tomorrow: shiftDate(today, 1) };
      const resolved = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : spoken[raw.toLowerCase()];
      if (resolved) shows = shows.filter((s) => s.nightOf === resolved);
      else if (raw) unusable.push(`date="${raw}" is not a night I can read — use YYYY-MM-DD, or "tonight"/"tomorrow"`);
    }
    const after = parseHHMM(args.time_after);
    const before = parseHHMM(args.time_before);
    if (after !== undefined) shows = shows.filter((s) => eveningMinutes(s, base.timezone) >= after);
    else if (args.time_after) unusable.push(`time_after="${args.time_after}" is not a time I can read — use "HH:MM" on a 24-hour clock`);
    if (before !== undefined) shows = shows.filter((s) => eveningMinutes(s, base.timezone) <= before);
    else if (args.time_before) unusable.push(`time_before="${args.time_before}" is not a time I can read — use "HH:MM" on a 24-hour clock`);

    // Theaters: every asked name is an either-way substring test against
    // each venue's id, name and short name, and a name can reach SEVERAL
    // venues ("amc" is both AMCs). A name that reaches none is a coverage
    // boundary, named in unknown_venues and the note, never an empty result.
    const unknown_venues = [];
    if (askedVenues.length) {
      const wanted = askedVenues.map((v) => normText(v));
      for (let i = 0; i < wanted.length; i++) {
        if (!feed.venues.some((v) => venueHit(v, wanted[i]))) unknown_venues.push(askedVenues[i]);
      }
      shows = shows.filter((s) => {
        const v = venues.get(s.venueId);
        return wanted.some((q) => q === s.venueId || (v && venueHit(v, q)));
      });
    }

    const title = film ? `${film.title}${film.year ? ` (${film.year})` : ""}` : askedVenues.join(", ");
    const coverage_note = unknown_venues.length
      ? `Note: ${unknown_venues.map((v) => `"${v}"`).join(", ")} ${unknown_venues.length === 1 ? "is not a covered venue" : "are not covered venues"} — SceneF covers ${SITE_PLACE} theaters only (${feed.venues.map((v) => v.id).join(", ")}). Absence here says nothing about that theater.`
      : null;

    const grouped = new Map();
    for (const s of shows) {
      if (!grouped.has(s.venueId)) grouped.set(s.venueId, []);
      grouped.get(s.venueId).push(s);
    }

    const venueMode = !film;
    const data = {
      ...base,
      query: args.film ?? null,
      // Matched means the QUERY resolved — the hosted answer, where an empty
      // filtered list under a real film is still matched:true. This said
      // false whenever the filters left nothing, which reads as "no such film".
      matched: true,
      filtered_by: film ? "film" : "venue",
      ...(film ? { film: filmShape(film, { region: base.region }) } : {}),
      unknown_venues,
      coverage_note,
      showtime_count: shows.length,
      venues: [...grouped.entries()].map(([id, list]) => ({
        ...venueShape(venues.get(id) ?? { id, name: id, short: id }),
        showtimes: list.map((s) => ({
          ...screeningShape(s, venues, { detailed }),
          ...(venueMode ? { film: filmShape(films.get(s.filmKey), { region: base.region }) } : {}),
        })),
      })),
    };

    const L = [];
    // The unusable filters lead, before any result. A caller who reads the
    // showtimes first and the note second has already believed the answer.
    if (unusable.length) {
      L.push(`Unrecognized and NOT applied: ${unusable.join("; ")}. The results below are unfiltered by ${unusable.length === 1 ? "it" : "them"}.`);
    }
    if (!shows.length) {
      // The hosted empty answer, in its order: the absence, then the
      // coverage boundary, then the film page.
      L.push(film ? `No upcoming showtimes for ${title} match those filters.` : `Nothing on at ${title} matches those filters.`);
      if (coverage_note) L.push(coverage_note);
      if (film) L.push(`Film page: ${filmUrl(film.slug, base.region)}`);
      return both(finish(base, L), data);
    }
    if (coverage_note) L.push(coverage_note);
    L.push(`${title} — ${shows.length} showtime${shows.length === 1 ? "" : "s"}`);
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
    // The hosted count is EVERYTHING still ahead at this theater; only the
    // rows are cut to five. This reported the length of the cut.
    const next = upcoming(feed).filter((s) => s.venueId === venue.id);
    const shown = next.slice(0, 5);

    const card = venueCard(venue);
    const data = {
      ...base,
      query: args.theater,
      matched: true,
      venue: card,
      upcoming_count: next.length,
      upcoming: shown.map((s) => ({
        ...screeningShape(s, venues, { detailed }),
        film: filmShape(films.get(s.filmKey), { region: base.region }),
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
    L.push("", `Next ${shown.length} showtime${shown.length === 1 ? "" : "s"}:`);
    if (!shown.length) L.push("  Nothing further on the board for this theater.");
    for (const s of shown) {
      L.push(`  ${s.nightOf} ${displayTime(s.startsAt)} — ${films.get(s.filmKey)?.title ?? s.filmKey}`);
      L.push(`    ${s.ticketUrl}${detailed ? `  (${s.confidence ?? "?"} · ${s.source_tier ?? "?"} · verified ${s.verified_at ?? "?"})` : ""}`);
    }
    if (next.length > 5) L.push(`  (${next.length} upcoming in total)`);
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
        candidates: candidates.map((c) => filmShape(c, { region: base.region })),
      });
    }

    const venues = venueIndex(feed);
    const showtimes = upcoming(feed).filter((s) => s.filmKey === film.key);
    // The film's LAST night on the board — the hosted lastNightOf(), over
    // every screening it has, started or not. This read it off the upcoming
    // rows only, so a run whose final curtain had gone up had no last night.
    const final_night =
      feed.screenings
        .filter((s) => s.filmKey === film.key)
        .map((s) => s.nightOf)
        .sort()
        .pop() ?? null;
    // THE LIVE NIGHT, not the rolled-forward one — the hosted rule. At
    // 12:30am the reader is still living yesterday's night, and a catchable
    // 12:45am final show must print the LAST NIGHT banner; conversely, a
    // "tonight" that rolled forward to tomorrow's matinees must NOT flag a
    // film whose last night is tomorrow. This compared against the feed's
    // rolled-forward tonight and required every remaining show to sit on
    // one night; the hosted server compares the last night to the live one.
    const today = liveNight(Date.now(), base.timezone).night;

    const card = filmShape(film, { full: true, region: base.region });
    const data = {
      ...base,
      query: args.film,
      matched: true,
      film: card,
      final_night,
      is_last_night: showtimes.length > 0 && final_night === today,
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
    if (!showtimes.length) {
      L.push("", final_night ? `No upcoming screenings — last played ${nightLabel(final_night)}.` : "No screenings on the books.");
    } else {
      L.push("", `${showtimes.length} upcoming showtime${showtimes.length === 1 ? "" : "s"}${final_night ? `, through ${nightLabel(final_night)}` : ""}:`);
    }
    for (const s of showtimes.slice(0, 40)) {
      const v = venues.get(s.venueId);
      L.push(`  ${s.nightOf} ${displayTime(s.startsAt)} — ${v?.name ?? s.venueId}${s.tags?.length ? ` [${s.tags.join(", ")}]` : ""}`);
      L.push(`    ${s.ticketUrl}${detailed ? `  (${s.confidence ?? "?"} · ${s.source_tier ?? "?"} · verified ${s.verified_at ?? "?"})` : ""}`);
    }
    L.push("", card.url);
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
    const feed = await listings(args.region ? { region: args.region } : {});
    const base = baseOf(feed);
    const venues = venueIndex(feed);
    const films = new Map(feed.films.map((f) => [f.key, f]));
    const p = args.preferences ?? {};
    const prefs = toPreferences(p);
    const party = args.party_size && args.party_size > 0 ? args.party_size : null;

    // THE ONE SELECTION for the flagship — the hosted planMovieNightSelect(),
    // step for step: the window, the night's pool with started and sold-out
    // shows dropped, the hard bounds (first, never relaxed), the discount
    // filter with its fallback, rankForPrefs, one screening per film, THREE
    // plans and a wildcard found beyond them. This server asked the feed to
    // rank a served slice and returned four plans with no wildcard object;
    // the plan count, the plan set and the why[] lines all differed from the
    // hosted answer for the same board and the same minute.
    const problem = (lines, label, nights) => {
      const data = {
        ...base,
        window: label,
        nights,
        party_size: party,
        note: lines.join(" "),
        discounts_relaxed: false,
        plan_count: 0,
        plans: [],
        wildcard: null,
      };
      return both(finish(base, lines), data);
    };

    const w = resolveWhen(feed, args.when);
    if (w.error) return problem([w.error], "", []);

    let pool = w.nights
      .flatMap((n) => night(feed, n))
      .filter(notStarted)
      .filter((s) => !(s.tags ?? []).includes("sold-out"));

    // The hard bounds run FIRST and never fall back. They also run before
    // the discount fallback, so "no discount in that window" can never
    // widen a window the caller said they cannot make.
    const after = parseHHMM(p.time_after);
    const before = parseHHMM(p.time_before);
    if (after !== undefined || before !== undefined) {
      const bounded = pool.filter((s) => {
        const m = eveningMinutes(s, base.timezone);
        return (after === undefined || m >= after) && (before === undefined || m <= before);
      });
      if (!bounded.length) {
        const bound = [after !== undefined ? `after ${p.time_after}` : "", before !== undefined ? `before ${p.time_before}` : ""]
          .filter(Boolean)
          .join(" and ");
        return problem(
          [
            `Nothing bookable ${w.label} starts ${bound}.`,
            `That is a real absence, not a filter to relax — every other showtime ${w.label} falls outside the time you gave.`,
            `Try scenef_whats_playing for the full board, or a different date.`,
          ],
          w.label,
          w.nights,
        );
      }
      pool = bounded;
    }

    let discountNote;
    if (prefs.discountsOnly) {
      const kept = pool.filter((s) => {
        const v = venues.get(s.venueId);
        return v ? discountActiveOn(v, s.nightOf) : false;
      });
      if (kept.length) pool = kept;
      else discountNote = "No screening sits under an active discount in that window — showing the full board instead.";
    }

    if (!pool.length) {
      return problem(
        [`Nothing bookable ${w.label} — the board is dark or sold out.`, `Try scenef_whats_playing with a different date.`],
        w.label,
        w.nights,
      );
    }

    const ranked = rankForPrefs(films, pool, prefs);

    // Best screening per film, in rank order.
    const seen = new Set();
    const perFilm = [];
    for (const r of ranked) {
      if (seen.has(r.screening.filmKey)) continue;
      seen.add(r.screening.filmKey);
      perFilm.push(r);
    }

    const likes = prefs.likes ?? [];
    const plans = perFilm.slice(0, Math.min(3, perFilm.length));
    // The wildcard is the best-ranked film BEYOND the plans that sits
    // outside the named genres — or, with no genres named, simply the next
    // one. Its why[] is its own ranking reasons, nothing appended.
    const wildcard =
      perFilm.find((r) => {
        if (plans.includes(r)) return false;
        const genres = (films.get(r.screening.filmKey)?.genres ?? []).map((g) => g.toLowerCase());
        return likes.length ? !genres.some((g) => likes.includes(g)) : true;
      }) ?? null;

    const shape = (r, is_wildcard) => ({
      is_wildcard,
      score: r.score,
      why: r.why,
      // BARE, ON PURPOSE. The hosted planMovieNightData shapes this film
      // with filmJson(film) and no region slug (tools.ts, the one call site
      // without one), so a plan's film.url is /film/{slug} on every board —
      // verified against la-central 2026-09-08. Every other tool scopes the
      // url to the board; this one mirrors the hosted answer as it is, not
      // as it should be. When the hosted side threads the slug through, add
      // `{ region: ... }` here and nowhere else.
      film: filmShape(films.get(r.screening.filmKey)),
      showtime: screeningShape(r.screening, venues, { detailed: true }),
    });

    const data = {
      ...base,
      window: w.label,
      nights: w.nights,
      party_size: party,
      note: discountNote ?? null,
      // The discount fallback is a REAL event a caller may want to surface.
      discounts_relaxed: Boolean(discountNote),
      plan_count: plans.length,
      plans: plans.map((r) => shape(r, false)),
      wildcard: wildcard ? shape(wildcard, true) : null,
    };

    const L = [
      `Movie night — ${w.label}${party ? `, party of ${party}` : ""} — ${plans.length} plan${plans.length === 1 ? "" : "s"}${wildcard ? " and a wildcard" : ""}`,
    ];
    if (discountNote) L.push(`Note: ${discountNote}`);
    const render = (pl, heading) => {
      const s = pl.showtime;
      L.push("");
      L.push(`${heading} ${pl.film?.title ?? "—"}${pl.film?.year ? ` (${pl.film.year})` : ""}`);
      L.push(`   ${s.venue.name} · ${s.night_of} · ${s.local_time}${s.tags?.length ? ` [${s.tags.join(", ")}]` : ""}`);
      if (pl.why.length) L.push(`   Why: ${pl.why.join("; ")}`);
      L.push(`   Tickets: ${s.ticket_url}`);
      L.push(`   Calendar: ${s.calendar_feed}`);
      if (detailed) L.push(`   score ${pl.score} · ${s.confidence ?? "?"} · ${s.source_tier ?? "?"} · verified ${s.verified_at ?? "?"}`);
    };
    data.plans.forEach((pl, i) => render(pl, `${i + 1}.`));
    if (data.wildcard) render(data.wildcard, "Wildcard:");
    L.push("", "Ranking is preference-fit only — never pay-ranked, and nothing is hidden from you.");
    return both(finish(data, L), data);
  },
);

// ——— the taste engine, as the site scores it ———
//
// The hosted plan does not ask the feed to rank; it scores the pool itself
// with rankForPrefs (src/lib/data.ts) and the feed's profile grammar is the
// same function behind a different door. Every input it reads — genres,
// tags, venue id, the literal wall clock in startsAt — is on the public
// feed, so the scores and the why[] lines can be computed here identically
// rather than approximated from a served ordering.

/** The hosted toPreferences(): trimmed, lowercased lists, the flags as
 *  flags. `avoids` is NOT relieved of "matinee" — that is no_matinee's job. */
function toPreferences(p = {}) {
  const list = (xs) => xs?.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  const prefs = {};
  const likes = list(p.likes);
  const avoids = list(p.avoids);
  const formats = list(p.formats);
  const home = list(p.home_venues);
  if (likes?.length) prefs.likes = likes;
  if (avoids?.length) prefs.avoids = avoids;
  if (formats?.length) prefs.formats = formats;
  if (home?.length) prefs.homeVenues = home;
  if (p.window) prefs.window = p.window;
  if (p.no_matinee) prefs.noMatinee = true;
  if (p.discounts_only) prefs.discountsOnly = true;
  return prefs;
}

/** Is one of this venue's standing discounts live on that night? A discount
 *  with no day runs every day. */
function discountActiveOn(v, nightIso) {
  const dow = dowOf(nightIso);
  return (v.discounts ?? []).some((d) => d.day === undefined || d.day === null || d.day === dow);
}

/** Start-time windows on the screening's own night dial (nightClockOf), so
 *  "late" runs to 27:00 and a 12:45am show is a late show, not a matinee. */
const WINDOWS = {
  matinee: [0, 17 * 60],
  early: [16 * 60, 19 * 60 + 30],
  evening: [18 * 60, 22 * 60],
  late: [21 * 60, 27 * 60],
};

/** The hosted rankForPrefs(): pure ranking — never hides, never pay-ranked.
 *  Score desc, then the earlier curtain; the why[] lines are the product. */
function rankForPrefs(films, screenings, prefs) {
  return screenings
    .map((screening) => {
      const film = films.get(screening.filmKey);
      const why = [];
      let score = 0;
      const filmGenres = film?.genres ?? [];
      const genres = filmGenres.map((g) => g.toLowerCase());
      const tags = screening.tags ?? [];
      if (prefs.likes?.some((g) => genres.includes(g))) {
        score += 3;
        why.push(`${filmGenres.find((g) => prefs.likes?.includes(g.toLowerCase()))} pick`);
      }
      if (prefs.avoids?.some((g) => genres.includes(g))) {
        score -= 4;
        why.push("outside your genres");
      }
      const mins = nightClockOf(screening.startsAt);
      if (prefs.noMatinee && mins < 16 * 60) {
        score -= 3;
        why.push("matinee");
      }
      if (prefs.window) {
        const [lo, hi] = WINDOWS[prefs.window];
        if (mins >= lo && mins <= hi) {
          score += 2;
          why.push(`${prefs.window} show`);
        } else score -= 1;
      }
      if (prefs.formats?.some((f) => tags.includes(f))) {
        score += 2;
        why.push(tags.find((t) => prefs.formats?.includes(t)) ?? "format");
      }
      // A named home theater outranks a genre: it is a fact about the
      // reader's life, not a mood, and it leads why[] for the same reason.
      if (prefs.homeVenues?.includes(screening.venueId)) {
        score += 4;
        why.unshift("your theater");
      }
      return { screening, score, why };
    })
    .sort((a, b) => b.score - a.score || a.screening.startsAt.localeCompare(b.screening.startsAt));
}

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
    // TODAY IS THE BOARD'S CALENDAR DATE, not the night — the hosted
    // discountsData reads cityNow(d.timezone).dow. This derived it from the
    // feed's tonight slice, which rolls forward to the NEXT lit night once
    // the evening is spent, so at 11pm on a Tuesday this said Wednesday's
    // discounts applied while the hosted server, and the box office, said
    // Tuesday's. The zone is the feed's; the clock is Intl's.
    const { dow: today_dow } = cityNow(base.timezone);
    const today_name = DAY_NAMES[today_dow];

    let applies_today_count = 0;
    const venues = feed.venues
      .filter((v) => (v.discounts ?? []).length)
      .map((v) => ({
        ...venueShape(v),
        discounts: (v.discounts ?? []).map((d) => {
          // The hosted rule: applies_today is `disc.day === dow`, so only a
          // DAY-BOUND discount whose day is today applies today, and the
          // count is of those. A discount with no day — matinee, membership,
          // a discount card — "runs on its own terms any day" in the hosted
          // prose and is not counted; this counted every one of them.
          const applies_today = d.day !== undefined && d.day !== null && d.day === today_dow;
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
    const detailed = isDetailed(args);
    const horizon_days = Math.min(Math.max(args.horizon_days ?? 21, 1), 90);
    const feed = await listings(args.region ? { region: args.region } : {});
    const base = baseOf(feed);
    const venues = venueIndex(feed);
    const films = new Map(feed.films.map((f) => [f.key, f]));

    // THE ONE SELECTION for coming_soon — the hosted comingSoonSelect(): the
    // 48h cutoff on the instant, the horizon on the NIGHT (today's calendar
    // date plus horizon_days, in the board's zone — not now plus N days of
    // milliseconds, which cut a late show off the last night), and the rows
    // in order of FIRST CURTAIN. This ordered by first night then title, so
    // the first row differed from the hosted one on every board; and the
    // opening venues are the SHORT names, as there.
    const nowMs = Date.now();
    const cutoffMs = nowMs + 48 * 3600_000;
    const lastNight = shiftDate(cityNow(base.timezone).date, horizon_days);

    const firstByFilm = new Map();
    for (const s of feed.screenings) {
      const cur = firstByFilm.get(s.filmKey);
      if (!cur || s.startsAt < cur.startsAt) firstByFilm.set(s.filmKey, s);
    }

    const rows = [...firstByFilm.values()]
      .filter((s) => Date.parse(s.startsAt) > cutoffMs && s.nightOf <= lastNight)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      .map((first) => ({
        film: films.get(first.filmKey),
        first,
        opening_venues: [
          ...new Set(
            feed.screenings
              .filter((s) => s.filmKey === first.filmKey && s.nightOf === first.nightOf)
              .map((s) => venues.get(s.venueId)?.short ?? s.venueId),
          ),
        ],
      }))
      .filter((r) => r.film);

    const data = {
      ...base,
      horizon_days,
      film_count: rows.length,
      films: rows.map((r) => ({
        ...filmShape(r.film, { region: base.region }),
        first_night: r.first.nightOf,
        first_showtime: screeningShape(r.first, venues, { detailed }),
        opening_venues: r.opening_venues,
      })),
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
      L.push(`${nightLabel(r.first.nightOf)} — ${r.film.title}${r.film.year ? ` (${r.film.year})` : ""}`);
      L.push(`  ${r.opening_venues.join(", ")} · first curtain ${displayTime(r.first.startsAt)}`);
      L.push(`  ${filmUrl(r.film.slug, base.region)}`);
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

    // THE HOSTED RULE, EXACTLY — three numbers from two sets, computed HERE
    // at call time from the board and the clock:
    //
    //   screenings_tonight  tonight(board).screenings — the live night in
    //                       the board's timezone, a show kept while it is
    //                       still inside the 20-minute catchable grace.
    //   still_to_come       that set minus anything whose curtain has gone
    //                       up: Date.parse(startsAt) >= Date.now(). startsAt
    //                       carries the venue's own offset, so the instant it
    //                       names is the theatre's wall clock — Honolulu's on
    //                       the Oahu board — never this process's.
    //   next_curtains       the WHOLE board through the same filter, soonest
    //                       first, five of them. A spent evening therefore
    //                       rolls into tomorrow's matinees, and each one says
    //                       which night it belongs to.
    //
    // The version before this read the feed's `when=tonight` slice and its
    // tonight_is label. Both are the same function on the hosted side — and
    // both were CDN-cached, so right after midnight this tool said "the next
    // lit night" (is_tonight false) for the night the hosted server was
    // already calling tonight. The rows are the feed's; the night is decided
    // now, in the board's zone.
    const board = await listings(extra);
    const t = tonight(board);
    const tonightNight = t.nightIso;
    const is_tonight = t.label === "tonight";
    const now = Date.now();

    const base = baseOf(board);
    const venues = venueIndex(board);
    const films = new Map(board.films.map((f) => [f.key, f]));

    const all = t.screenings;
    const stillToCome = all.filter(notStarted);
    const next = upcoming(board).slice(0, 5);

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
      night_of: tonightNight,
      is_tonight,
      screenings_tonight: all.length,
      still_to_come: stillToCome.length,
      next_curtains: next.map((s) => ({
        ...screeningShape(s, venues, { detailed }),
        film: filmShape(films.get(s.filmKey), { region: base.region }),
      })),
      sources: {
        healthy,
        total: latest.size,
        basis: "A source is healthy when its most recent verification landed within the last 24 hours.",
      },
    };

    const L = [
      is_tonight
        ? `${nightLabel(tonightNight)} — ${all.length} screening${all.length === 1 ? "" : "s"} tonight, ${stillToCome.length} still to come.`
        : `${nightLabel(tonightNight)} (the next lit night) — ${all.length} screening${all.length === 1 ? "" : "s"}.`,
      `Sources: ${healthy}/${latest.size} verified within 24 hours. Data as of ${base.data_as_of}.`,
    ];
    L.push("", "Next curtains city-wide:");
    if (!next.length) L.push("  No upcoming curtains on the books.");
    for (const s of next) {
      L.push(
        `  ${displayTime(s.startsAt)}${s.nightOf !== tonightNight ? ` (${nightLabel(s.nightOf)})` : ""} ${venues.get(s.venueId)?.short ?? s.venueId} — ${films.get(s.filmKey)?.title ?? s.filmKey}`,
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
