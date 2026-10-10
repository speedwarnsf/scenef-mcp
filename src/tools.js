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

// The declared dependency bundles v4; use the same JSON Schema dialect as
// the hosted MCP server, including input-mode object handling.
import { z } from "zod/v4";
import {
  SITE,
  accuracyRecord,
  boardFeed,
  edgeStaleness,
  boardsList,
  cityNow,
  liveNight,
  minutesOf,
  night,
  nightClockOf,
  resolvePlace,
  shiftDate,
  tonight,
} from "./feed.js";
import {
  DAY_NAMES,
  baseOf,
  both,
  displayTime,
  dowOf,
  echoInput,
  edgeStaleNote,
  filmCandidatesText,
  filmExtras,
  filmShape,
  filmUrl,
  finish,
  matchFilm,
  matchVenue,
  nightLabel,
  normText,
  provDetail,
  screeningShape,
  shownDiscount,
  tagBadge,
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

// ——— BOUNDS ON EVERYTHING A CALLER CAN TYPE ——— the hosted inputs.ts, as
// written. Misses echo their input, so nothing a caller types is unbounded;
// the limits sit well above anything a real question needs.
const TEXT_MAX = 120;
const LIST_MAX = 10;
const ITEM_MAX = 80;
const text = () => z.string().max(TEXT_MAX);
const list = () => z.array(z.string().max(ITEM_MAX)).max(LIST_MAX);

const responseFormat = z
  .enum(["concise", "detailed"])
  .optional()
  .describe(
    'Output size. "concise" (default) is tight text plus a structured summary. In whats_playing, each film has the total showtime_count, next_showtime, and a showtimes array containing only that next screening; "detailed" adds showtime rows with ids, ticket urls and accuracy metadata, about 200 across the answer. film_details and search_showtimes return the 40 nearest showtimes in "concise" and up to 200 in "detailed". showtime_count is always the total and showtimes_complete says whether the array is all of it; narrow by date or theater for the rest.',
  );

const whenParam = text()
  .optional()
  .describe(
    'When to look: "tonight" (default), "tomorrow", "weekend" (Fri/Sat/Sun of the current week), or a YYYY-MM-DD date.',
  );

/** The hosted DEFAULT_BOARD and BOARD_SCOPE, resolved. The hosted server
 *  interpolates them from its region table (DEFAULT_REGION and its name;
 *  activeRegions().length and siteWhere()); this package has no region
 *  table, and tools/list must not wait on the network, so they are the
 *  live values written down. test/parity.js compares every description and
 *  the instructions verbatim, so the day a board lights or the default
 *  changes on the hosted side, it goes red here rather than drifting. */
const DEFAULT_BOARD = '"sf" (San Francisco)';
const BOARD_SCOPE = "SceneF publishes 56 boards, in California, Florida and Hawaii only";

// The hosted server's words, verbatim — every board-reading tool takes it
// (ONE CONTRACT, TWO TRANSPORTS, above). The feed refuses an unknown region
// with a 400, and boardFeed (feed.js) turns that into the hosted sentence,
// so the "error, not a fallback" promise below is the API's own behavior.
const regionParam = text()
  .optional()
  .describe(
    "Which regional board to read: a board id such as \"sf\", \"oahu\" or \"miami\", not a city name " +
      "(\"Honolulu\" or \"Chicago\" is rejected). " +
      `Omitted means ${DEFAULT_BOARD}; it is never inferred from where you are. ` +
      "For a city, ZIP or neighborhood call scenef_resolve_board first; scenef_now with no region lists every id. " +
      "An unknown region is an error, not a fallback.",
  );

/**
 * ALL FOUR HINTS, EXPLICITLY, ON EVERY TOOL — AND openWorldHint IS TRUE ON
 * ALL TEN. Copied from the hosted server, which is the contract. OpenAI
 * rejected the v1.1.0 listing on 2026-09-30 because openWorldHint was false
 * under ITS definition ("true for public or open-ended entities, including …
 * arbitrary destinations") and idempotentHint was absent. Nine tools
 * describe public cinemas and link out to their box offices. The tenth,
 * scenef_resolve_board, held out as false for a while: an exact lookup in
 * SceneF's own place table, no geocoder, no search — still exactly how it
 * works. But what it takes is a public place name, and the definition turns
 * on public entities, not on how the lookup is done; claiming an open world
 * for a closed lookup errs in the safe direction. The hosted server made it
 * ONE constant and deleted the closed one (1b13eec); so does this file. No
 * tool writes; repeat calls change nothing. test/parity.js holds every value
 * to the hosted one, and test/contract.js pins all four.
 */
const LISTING = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

/** What a tool call does and does not cause — the hosted READS_ONLY.
 *  readOnlyHint is true because the CALL records nothing. */
const READS_ONLY = "Read-only: the call itself records nothing.";

/** The hosted GO_ROW_FIELDS: what the /go redirect logs when anyone follows a
 *  ticket link, in a reader's words. The instructions reuse it. */
export const GO_ROW_FIELDS =
  "time, the screening with its film and theater, client type, browser family, referring site, link source tag, and whether the showtime was gone; no IP address, cookie or account";

/** The hosted ticket-link disclosure, on every tool that returns one. */
const TICKET_LINKS = `${READS_ONLY} SceneF does not sell, hold or book tickets. Ticket links are https://scenef.com/go/{id} redirects to the theater's own site or the ticket seller it uses (a link to a showtime that is gone lands back on SceneF); whoever follows one, a person or a client, is logged once anonymously (${GO_ROW_FIELDS}) and forwarded.`;

/** One sentence the instructions hand to a caller verbatim — the hosted
 *  ACCURACY_CONTRACT. */
export const ACCURACY_CONTRACT =
  "Every showtime carries a confidence level, a source tier and a last-verified time, and the running record of SceneF's own verification checks, failures included, is public at https://scenef.com/api/accuracy (add ?region= for a board).";

// Every emitted screening has the same evidence fields in both modes.
const DETAILED_CARRIES_ACCURACY =
  "Every emitted showtime carries confidence, source tier, reporting sources and verified_at.";

const isDetailed = (args) => args?.response_format === "detailed";

/** Upcoming rows a film or a search hands back per call, nearest first — the
 *  hosted CONCISE_ROW_CAP / DETAILED_ROW_CAP / rowCap(). The total always
 *  rides alongside as showtime_count, and showtimes_complete says when the
 *  list was cut. */
const CONCISE_ROW_CAP = 40;
const DETAILED_ROW_CAP = 200;
const rowCap = (detailed) => (detailed ? DETAILED_ROW_CAP : CONCISE_ROW_CAP);

/** The sentence a cut list carries, in both renderers — the hosted cutNote(). */
function cutNote(shown, total, film) {
  if (shown >= total) return null;
  return `Showing the nearest ${shown} of ${total} showtimes. Narrow by date or theater for more${film ? ` (scenef_search_showtimes with film "${film.slug}" and date or venues)` : " (date, time_after/time_before or venues)"}.`;
}

/** "the San Francisco", "the East Bay" — a board's name ready for
 *  "on … board", the hosted theBoard(). */
const theBoard = (base) => (/^the /i.test(base.region_name) ? base.region_name : `the ${base.region_name}`);

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
  if (Number(m[1]) > 23 || Number(m[2]) > 59) return undefined;
  let mins = Number(m[1]) * 60 + Number(m[2]);
  if (mins < 4 * 60) mins += 1440;
  return mins;
}

/** "35mm", "35mm or 70mm", "35mm, 70mm or 16mm" — the hosted orList(). */
function orList(xs) {
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`;
}

/** The window as it reads after "in San Francisco" — the hosted
 *  windowPhrase(): "tonight", "tomorrow, Friday, October 2", "this weekend
 *  (…)", or "on Friday, October 2". */
function windowPhrase(label) {
  return /^(tonight|tomorrow|this weekend)/i.test(label) ? label : `on ${label}`;
}

function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T12:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
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
  if (isCalendarDate(token)) {
    return { nights: [token], label: nightLabel(token) };
  }
  return {
    nights: [],
    label: token,
    error: `Unrecognized "when": "${echoInput(when)}". Use "tonight", "tomorrow", "weekend", or a YYYY-MM-DD date.`,
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
export function notableItem(n, tz) {
  return {
    title: n.title,
    venue: n.venue,
    local_time: n.time ?? displayTime(n.startsAt, tz),
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
    .map((n) => notableItem(n, feed.timezone));
}

/** The rows each film carries, from ONE budget shared by both renderers —
 *  the hosted whatsPlayingRows(). Concise is the next screening only;
 *  detailed spends about DETAILED_ROW_CAP rows down the ranked list, and
 *  every film keeps at least its next showtime so the array is never empty. */
function whatsPlayingRows(entries, detailed) {
  if (!detailed) return entries.map(({ shows }) => shows.slice(0, 1));
  let left = DETAILED_ROW_CAP;
  return entries.map(({ shows }) => {
    const take = Math.max(1, Math.min(shows.length, left));
    left = Math.max(0, left - take);
    return shows.slice(0, take);
  });
}

// ——————————————————————————————————————————————————————————— the tools

export const TOOLS = [];
const tool = (name, config, handler) => TOOLS.push({ name, config, handler });

tool(
  "scenef_whats_playing",
  {
    title: "What's playing",
    description:
      `Use this when someone asks what is showing in one area tonight, tomorrow, this weekend or on a date. Reads ONE regional board per call; ${BOARD_SCOPE}. Pass region; it defaults to ${DEFAULT_BOARD} when omitted. For a city, ZIP or neighborhood, call scenef_resolve_board first. Returns a ranked list of films, with optional genre and format filters. When the window covers tonight it opens with Notable tonight: scarcity facts with evidence (measured seat counts, final nights, lone prints, posted discounts, live elements). Each entry carries year, runtime, genres, a one-line hook, venue count, showtime_count, the next showtime and the film's SceneF url. "detailed" adds showtime rows, about 200 across the answer; scenef_search_showtimes lists the times for one film or theater. ${TICKET_LINKS} ${DETAILED_CARRIES_ACCURACY}`,
    inputSchema: {
      when: whenParam,
      genres: list().optional().describe('Genre filters, e.g. ["horror", "comedy"].'),
      formats: list()
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
    annotations: LISTING,
  },
  async (args) => {
    const detailed = isDetailed(args);
    const feed = await boardFeed(args.region);
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

    // The rows each film carries, from one budget both renderers read.
    const rows = whatsPlayingRows(entries, detailed);
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
      films: entries.map(({ film, shows }, i) => {
        // A held film's entry carries no hook key at all — see filmExtras.
        const extras = filmExtras(film);
        return {
          ...filmShape(film, { region: base.region }),
          ...(extras ? { hook: extras.hook } : {}),
          venue_count: new Set(shows.map((s) => s.venueId)).size,
          showtime_count: shows.length,
          next_showtime: screeningShape(shows[0], venues, { detailed, region: base.region, tz: base.timezone }),
          // Older installed definitions require an array in both modes.
          // The total and completeness flag make a partial array explicit.
          showtimes: rows[i].map((s) => screeningShape(s, venues, { detailed, region: base.region, tz: base.timezone })),
          showtimes_complete: rows[i].length === shows.length,
        };
      }),
    };

    // THE HOSTED whatsPlaying() PROSE, line for line (src/lib/mcp/tools.ts):
    // the notable lead when the window covers tonight, the header, then each
    // film on one line — year, runtime and genres in parentheses, how many
    // venues, the next curtain, the hook — and its film page. Detailed adds
    // the film key and slug, then each row with its night, tags, ticket link
    // and accuracy stamp (provDetail).
    const L = [];
    if (notable.length) {
      L.push("Notable tonight — scarcity facts with receipts, not taste:");
      for (const n of notable) L.push(`- ${n.title}, ${n.local_time} at ${n.venue} — ${n.evidence} · ${n.ticket_url}`);
      L.push("");
    }
    // The label already carries the night for tomorrow and date windows
    // ("tomorrow, Thursday, September 10"); nothing is appended to it.
    L.push(`Playing ${w.label} — ${entries.length} film${entries.length === 1 ? "" : "s"}:`, "");
    entries.forEach(({ film, shows }, i) => {
      const venueIds = [...new Set(shows.map((s) => s.venueId))];
      const next = shows[0];
      const meta = [
        film.year ? String(film.year) : undefined,
        film.runtimeMin ? `${film.runtimeMin} min` : undefined,
        (film.genres ?? []).length ? film.genres.join(", ") : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
      const h = filmExtras(film)?.hook;
      L.push(
        `${i + 1}. ${film.title}${meta ? ` (${meta})` : ""} — ${venueIds.length} venue${venueIds.length === 1 ? "" : "s"}, next ${displayTime(next.startsAt, base.timezone)} at ${venues.get(next.venueId)?.short ?? next.venueId}${h ? ` — ${h}` : ""}`,
      );
      L.push(`   ${filmUrl(film.slug, base.region)}`);
      if (detailed) {
        L.push(`   film key: ${film.key} · slug: ${film.slug}`);
        rows[i].forEach((s, j) => {
          const row = data.films[i].showtimes[j];
          L.push(
            `   - ${nightLabel(s.nightOf)} · ${displayTime(s.startsAt, base.timezone)} at ${venues.get(s.venueId)?.short ?? s.venueId}${tagBadge(s)} · ${row.ticket_url}`,
          );
          L.push(`     ${provDetail(row)}`);
        });
        if (rows[i].length < shows.length) {
          L.push(`   (+${shows.length - rows[i].length} more — scenef_search_showtimes with film "${film.slug}" and a date or theater lists them)`);
        }
      }
    });
    return both(finish(base, L), data);
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
    title: "Search showtimes by film or theater",
    description:
      `Showtimes scoped by FILM or by THEATER on one board — pass at least one. With \`film\`: where that film is playing (title or slug; fuzzy-matched, ambiguous queries return candidates). With \`venues\` and no film: everything on at those theaters, each showtime naming its film. Grouped by theater with local times, tags (35mm/qa/sold-out), the night each show belongs to, and a ticket link per showtime. Optional date and time-window filters apply to both. Returns the 40 nearest showtimes ("concise") or up to 200 ("detailed"); showtime_count is the total and showtimes_complete says whether the list is whole, so narrow by date or theater for the rest. For the whole board with no film or theater in mind, call scenef_whats_playing instead. ${TICKET_LINKS} ${DETAILED_CARRIES_ACCURACY}`,
    inputSchema: {
      film: text()
        .optional()
        .describe(
          "Film title, or a SceneF slug taken from films[].slug / scenef_whats_playing. " +
            "A title that is not on the board answers with a miss and points at " +
            "scenef_whats_playing, so guessing is safe but browsing is faster. " +
            "Optional when `venues` is given — omit it to ask what is on at a theater.",
        ),
      date: text().optional().describe("Restrict to one night, YYYY-MM-DD."),
      time_after: text().optional().describe('Only shows at or after this local time, "HH:MM" 24h.'),
      time_before: text().optional().describe('Only shows at or before this local time, "HH:MM" 24h.'),
      venues: list()
        .optional()
        .describe(
          'Restrict to these theaters (ids or names), e.g. ["roxie", "Balboa"]. ' + "Required when `film` is omitted.",
        ),
      response_format: responseFormat,
      region: regionParam,
    },
    outputSchema: searchOut.shape,
    annotations: LISTING,
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
    const feed = await boardFeed(args.region);
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
        warnings: [],
        filtered_by: "venue",
        refusal,
        candidates: [],
        showtime_count: 0,
        // Present on every search answer (hosted searchShowtimesData): a
        // refusal ran no search, so showtimes_complete is absent and the
        // note is null.
        note: null,
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
          warnings: [],
          filtered_by: "film",
          candidates: m.candidates.map((c) => filmShape(c, { region: base.region })),
          unknown_venues: [],
          coverage_note: null,
          showtime_count: 0,
          note: null,
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
      const today = liveNight(Date.now(), base.timezone).night;
      const spoken = { tonight: today, today, tomorrow: shiftDate(today, 1) };
      const resolved = isCalendarDate(raw) ? raw : spoken[raw.toLowerCase()];
      if (resolved) shows = shows.filter((s) => s.nightOf === resolved);
      else unusable.push(`date="${echoInput(raw)}" is not a night I can read — use YYYY-MM-DD, or "tonight"/"tomorrow"`);
    }
    const after = parseHHMM(args.time_after);
    const before = parseHHMM(args.time_before);
    if (after !== undefined) shows = shows.filter((s) => eveningMinutes(s, base.timezone) >= after);
    else if (args.time_after !== undefined) unusable.push(`time_after="${echoInput(args.time_after)}" is not a time I can read — use "HH:MM" on a 24-hour clock`);
    if (before !== undefined) shows = shows.filter((s) => eveningMinutes(s, base.timezone) <= before);
    else if (args.time_before !== undefined) unusable.push(`time_before="${echoInput(args.time_before)}" is not a time I can read — use "HH:MM" on a 24-hour clock`);
    if (after !== undefined && before !== undefined && after > before)
      unusable.push("time_after is later than time_before in the same movie night");
    if (unusable.length) {
      const refusal = `No search was run: ${unusable.join("; ")}. Correct the filters and try again.`;
      return both(finish(base, [refusal]), {
        ...base, query: args.film ?? null, matched: false,
        filtered_by: film ? "film" : "venue", refusal, warnings: unusable,
        candidates: [], showtime_count: 0, note: null, venues: [], unknown_venues: [], coverage_note: null,
      });
    }

    // Theaters: every asked name is tested with namesOverlap (shape.js)
    // against each venue's id, name and short name, and a name can reach
    // SEVERAL venues ("amc" is both AMCs). A name that reaches none is a
    // coverage boundary, named in unknown_venues and the note, never an
    // empty result.
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

    const title = film ? `${film.title}${film.year ? ` (${film.year})` : ""}` : askedVenues.map((v) => echoInput(v)).join(", ");
    // Named as THIS board's boundary — the hosted coverageNote, verbatim.
    const coverage_note = unknown_venues.length
      ? `Note: ${unknown_venues.map((v) => `"${echoInput(v)}"`).join(", ")} ${unknown_venues.length === 1 ? "is not a theater" : "are not theaters"} on ${theBoard(base)} board (${feed.venues.map((v) => v.id).join(", ")}). Absence here says nothing about that theater.`
      : null;

    // THE ROWS HANDED BACK are the nearest rowCap() of every match — the
    // hosted searchShowtimesSelect(). showtime_count stays the total, and
    // both renderers group the ROWS, never all the shows.
    const rows = shows.slice(0, rowCap(detailed));
    const cut = cutNote(rows.length, shows.length, film);
    const grouped = new Map();
    for (const s of rows) {
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
      warnings: [],
      filtered_by: film ? "film" : "venue",
      ...(film ? { film: filmShape(film, { region: base.region }) } : {}),
      unknown_venues,
      coverage_note,
      showtime_count: shows.length,
      showtimes_complete: rows.length === shows.length,
      note: cut,
      venues: [...grouped.entries()].map(([id, list]) => ({
        ...venueShape(venues.get(id) ?? { id, name: id, short: id }),
        showtimes: list.map((s) => ({
          ...screeningShape(s, venues, { detailed, region: base.region, tz: base.timezone }),
          ...(venueMode ? { film: filmShape(films.get(s.filmKey), { region: base.region }) } : {}),
        })),
      })),
    };

    const L = [];
    if (!shows.length) {
      // The hosted empty answer, in its order: the absence, then the
      // coverage boundary, then the film page.
      L.push(film ? `No upcoming showtimes for ${title} match those filters.` : `Nothing on at ${title} matches those filters.`);
      if (coverage_note) L.push(coverage_note);
      if (film) L.push(`Film page: ${filmUrl(film.slug, base.region)}`);
      return both(finish(base, L), data);
    }
    // THE HOSTED searchShowtimes() PROSE, line for line: the coverage
    // boundary, the heading, the cut note, then each theater and its rows —
    // night, time, the film in venue mode (there the film is the answer),
    // tags and the ticket link. Detailed adds the screening id, its night,
    // the price note when the feed carries one, the calendar link, and the
    // accuracy stamp.
    if (coverage_note) L.push(coverage_note);
    L.push(film ? `Showtimes for ${title} · ${filmUrl(film.slug, base.region)}` : `What's on at ${title}`);
    if (cut) L.push(cut);
    L.push("");
    [...grouped.entries()].forEach(([id, list], g) => {
      const shaped = data.venues[g].showtimes;
      const v = venues.get(id);
      L.push(`${v?.name ?? id}${v ? ` (${v.neighborhood})` : ""}:`);
      list.forEach((s, j) => {
        const row = shaped[j];
        const f = film ? undefined : films.get(s.filmKey);
        L.push(
          `- ${nightLabel(s.nightOf)} · ${displayTime(s.startsAt, base.timezone)}${f ? ` · ${f.title}${f.year ? ` (${f.year})` : ""}` : ""}${tagBadge(s)} · ${row.ticket_url}`,
        );
        if (detailed) {
          L.push(`  screening ${s.id} · night ${s.nightOf}${s.priceNote ? ` · ${s.priceNote}` : ""} · calendar: ${row.calendar_url}`);
          L.push(`  ${provDetail(row)}`);
        }
      });
      L.push("");
    });
    return both(finish(base, L), data);
  },
);

tool(
  "scenef_theater_info",
  {
    title: "Theater info",
    description:
      `One theater's card: address, neighborhood, website, ticketing note, structured discounts (label/detail/day; membership and discount-card pricing reads "Member pricing; see the theater"), amenities, its next 5 showtimes with ticket links, and its calendar feed url. ${TICKET_LINKS} ${DETAILED_CARRIES_ACCURACY}`,
    inputSchema: {
      theater: text().describe('Theater id or name, e.g. "roxie" or "Balboa Theater".'),
      response_format: responseFormat,
      region: regionParam,
    },
    outputSchema: theaterOut.shape,
    annotations: LISTING,
  },
  async (args) => {
    const detailed = isDetailed(args);
    const feed = await boardFeed(args.region);
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

    const card = venueCard(venue, { region: base.region });
    const data = {
      ...base,
      query: args.theater,
      matched: true,
      venue: card,
      upcoming_count: next.length,
      upcoming: shown.map((s) => ({
        ...screeningShape(s, venues, { detailed, region: base.region, tz: base.timezone }),
        film: filmShape(films.get(s.filmKey), { region: base.region }),
        film_key: s.filmKey,
      })),
    };

    // THE HOSTED theaterInfo() PROSE, line for line: the house and its
    // neighborhood, address, website, ticketing, amenities, the preshow, the
    // discounts (membership and card pricing through shownDiscount), then the
    // next five showtimes — night, time, film, tags, ticket link — and the
    // calendar feed. Detailed adds each row's accuracy stamp and the venue's
    // id, platform and position. The street address stands alone: venue
    // records carry no city, and lat/lng ride in the structured card.
    const L = [`${venue.name} — ${venue.neighborhood}`, `Address: ${venue.address}`, `Website: ${venue.website}`];
    if (venue.ticketingNote) L.push(`Ticketing: ${venue.ticketingNote}`);
    if (venue.amenities?.length) L.push(`Amenities: ${venue.amenities.join(", ")}`);
    if (venue.preshowMin) L.push(`Preshow: ~${venue.preshowMin} min of trailers before the feature`);
    if ((venue.discounts ?? []).length) {
      L.push("", "Discounts:");
      for (const disc of venue.discounts) {
        const day = disc.day !== undefined && disc.day !== null ? ` (${DAY_NAMES[disc.day]}s)` : "";
        const shownDisc = shownDiscount(disc);
        L.push(`- ${shownDisc.label}${day}: ${shownDisc.detail}`);
      }
    }
    L.push("", `Next ${Math.min(5, next.length) || 0} showtimes:`);
    if (!next.length) L.push("- Nothing currently listed.");
    shown.forEach((s, i) => {
      const row = data.upcoming[i];
      L.push(
        `- ${nightLabel(s.nightOf)} · ${displayTime(s.startsAt, base.timezone)} — ${films.get(s.filmKey)?.title ?? s.filmKey}${tagBadge(s)} · ${row.ticket_url}`,
      );
      if (detailed) L.push(`  ${provDetail(row)}`);
    });
    if (next.length > 5) L.push(`(${next.length} upcoming in total)`);
    L.push("", `Calendar feed: ${card.calendar_feed}`);
    if (detailed) L.push(`venue id: ${venue.id} · platform: ${venue.platform} · lat/lng: ${venue.lat}, ${venue.lng}`);
    return both(finish(base, L), data);
  },
);

tool(
  "scenef_film_details",
  {
    title: "Film details",
    description:
      `The card for one film on one board: title, year, runtime, genres, directors, cast, overview, rating, a trailer url and a TMDB poster url when present, its upcoming showtimes nearest first with venue/time/ticket link, and a last-night flag when the run is ending. Returns the 40 nearest showtimes ("concise") or up to 200 ("detailed"); showtime_count is the total and showtimes_complete says whether the list is whole — scenef_search_showtimes with a date or theater narrows the rest. ${TICKET_LINKS} ${DETAILED_CARRIES_ACCURACY}`,
    inputSchema: {
      film: text().describe("Film title or SceneF slug."),
      response_format: responseFormat,
      region: regionParam,
    },
    outputSchema: filmDetailsOut.shape,
    annotations: LISTING,
  },
  async (args) => {
    const detailed = isDetailed(args);
    const feed = await boardFeed(args.region);
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

    // The nearest rowCap() of the upcoming showtimes — the hosted
    // filmDetailsData. showtime_count stays the total.
    const rows = showtimes.slice(0, rowCap(detailed));
    const cut = cutNote(rows.length, showtimes.length, film);
    // The card, and the prose below, reach the synopsis and the art only
    // through filmExtras: a held film's card omits them (shape.js).
    const card = filmShape(film, { full: true, region: base.region });
    const x = filmExtras(film);
    const data = {
      ...base,
      query: args.film,
      matched: true,
      film: card,
      final_night,
      is_last_night: showtimes.length > 0 && final_night === today,
      showtime_count: showtimes.length,
      showtimes_complete: rows.length === showtimes.length,
      note: cut,
      showtimes: rows.map((s) => screeningShape(s, venues, { detailed, region: base.region, tz: base.timezone })),
    };

    // THE HOSTED filmDetails() PROSE, line for line: title, the facts line,
    // director, the first six of the cast, the synopsis (only through
    // filmExtras — a held film has none), the film page, trailer and poster,
    // then the run: the LAST NIGHT banner or the final night, the count, the
    // cut note and the rows — night, time, the house, tags, ticket link.
    // Detailed adds each row's screening id, calendar link and accuracy stamp.
    const L = [`${film.title}${film.year ? ` (${film.year})` : ""}`];
    const meta = [
      film.runtimeMin ? `${film.runtimeMin} min` : undefined,
      film.mpaa,
      (film.genres ?? []).length ? film.genres.join(", ") : undefined,
      film.ratings?.tmdb ? `TMDB ${film.ratings.tmdb.toFixed(1)}/10` : undefined,
    ].filter(Boolean);
    if (meta.length) L.push(meta.join(" · "));
    if (film.directors?.length) L.push(`Directed by ${film.directors.join(", ")}`);
    if (film.cast?.length) L.push(`Cast: ${film.cast.slice(0, 6).join(", ")}`);
    if (x?.overview) L.push("", x.overview);
    L.push("", `Film page: ${card.url}`);
    if (x?.trailer_url) L.push(`Trailer: ${x.trailer_url}`);
    if (x?.poster_url) L.push(`Poster: ${x.poster_url}`);
    L.push("");
    if (!showtimes.length) {
      L.push(final_night ? `No upcoming screenings — last played ${nightLabel(final_night)}.` : `No screenings on the books.`);
    } else {
      if (final_night === today) L.push(`LAST NIGHT — tonight is this film's final night in the listings.`);
      else if (final_night) L.push(`Final night in the listings: ${nightLabel(final_night)}.`);
      L.push(`Upcoming showtimes (${showtimes.length}):`);
      if (cut) L.push(cut);
      rows.forEach((s, i) => {
        const row = data.showtimes[i];
        L.push(
          `- ${nightLabel(s.nightOf)} · ${displayTime(s.startsAt, base.timezone)} at ${venues.get(s.venueId)?.short ?? s.venueId}${tagBadge(s)} · ${row.ticket_url}`,
        );
        if (detailed) L.push(`  screening ${s.id} · calendar: ${row.calendar_url} · ${provDetail(row)}`);
      });
    }
    return both(finish(base, L), data);
  },
);

tool(
  "scenef_plan_movie_night",
  {
    title: "Suggest a movie night",
    description:
      `Suggests 2-4 movie-night options on one board from a window and a taste profile — film + specific showtime + theater + why it fits — plus one wildcard: the highest-ranked film outside the stated genres, or the next film down when no genre is stated. time_after/time_before are hard bounds; genres and formats only tilt the ranking, and when one matches nothing in the window the answer opens with a warning (also in warnings[]) saying so. It books, reserves and saves nothing; each option carries ticket and calendar links for the person to follow. Ranking uses only the stated preferences; no theater or film pays for placement. ${TICKET_LINKS} ${DETAILED_CARRIES_ACCURACY}`,
    inputSchema: {
      when: whenParam,
      party_size: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("How many people are going (1-20). It labels the plan; it does not change which shows are picked."),
      preferences: z
        .object({
          likes: list()
            .optional()
            .describe('Genres to favor, e.g. ["horror", "comedy"]. If no film in the window matches, the plan says so in warnings.'),
          avoids: list().optional().describe("Genres to steer away from."),
          window: z
            .enum(["matinee", "early", "evening", "late"])
            .optional()
            .describe(
              "Preferred start-time window — a soft tilt. For a time you " +
                "genuinely cannot make, use time_after/time_before instead.",
            ),
          time_after: text()
            .optional()
            .describe(
              'HARD earliest start, "HH:MM" local 24h, e.g. "20:00" for ' +
                '"nothing before 8". Unlike the other preferences this does NOT ' +
                "degrade: if nothing starts that late the tool says so rather than " +
                "ranking a show you cannot get to.",
            ),
          time_before: text().optional().describe('HARD latest start, "HH:MM" local 24h. Same no-fallback rule.'),
          no_matinee: z.boolean().optional().describe("Penalize daytime shows."),
          formats: list()
            .optional()
            .describe('Formats to favor, e.g. ["35mm", "70mm"]. If none in the window matches, the plan says so in warnings.'),
          home_venues: list().optional().describe('Home-theater venue ids to nudge upward, e.g. ["roxie"].'),
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
    annotations: LISTING,
  },
  async (args) => {
    const detailed = isDetailed(args);
    const feed = await boardFeed(args.region);
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
        warnings: lines,
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
    const invalid = ["time_after", "time_before"].filter((key) => p[key] !== undefined && parseHHMM(p[key]) === undefined);
    if (invalid.length || (after !== undefined && before !== undefined && after > before)) {
      return problem([invalid.length
        ? `Invalid ${invalid.join(", ")}: use a real local time in HH:MM 24-hour form. No plan was made.`
        : "time_after is later than time_before in the same movie night. No plan was made."], w.label, w.nights);
    }
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

    // ——— A PREFERENCE NOTHING MEETS IS SAID, NOT SWALLOWED ——— the hosted
    // planMovieNightSelect(), as written. Formats and genres are soft tilts,
    // so the picks stand, but a caller who asked for 35mm is told there was
    // none before reading a single pick — in the text and in warnings[].
    // Checked PER ITEM, against the pool AFTER the hard bounds and the
    // discount filter: a 35mm print at 4pm is not one a 7pm caller can reach.
    const prefWarnings = [];
    const where = `in ${feed.region_name ?? "this board"} ${windowPhrase(w.label)}${after !== undefined || before !== undefined ? " within the times you gave" : ""}${prefs.discountsOnly && !discountNote ? " at a theater with a discount that night" : ""}`;
    // The caller's own words go back into the sentence, so each is clipped.
    const said = (xs) => orList(xs.map((x) => echoInput(x, 40)));
    const absentFormats = (prefs.formats ?? []).filter((f) => !pool.some((s) => (s.tags ?? []).includes(f)));
    if (absentFormats.length) {
      const f = said(absentFormats);
      prefWarnings.push(`No ${f} screening ${where}; these picks are not ${f}.`);
    }
    const genresOnBoard = new Set(pool.flatMap((s) => (films.get(s.filmKey)?.genres ?? []).map((g) => g.toLowerCase())));
    const absentGenres = (prefs.likes ?? []).filter((g) => !genresOnBoard.has(g));
    if (absentGenres.length) {
      const g = said(absentGenres);
      prefWarnings.push(`No ${g} film ${where}; these picks are outside ${absentGenres.length === 1 ? "that genre" : "those genres"}.`);
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

    // `detailed: true` in BOTH modes, on purpose: a plan's showtime has
    // always carried this package's `calendar_feed` key (the old plan text
    // printed it), and test/reliability.js pins it on a concise plan. It is
    // the one local-only key on a concise answer — an alias of calendar_url,
    // which the hosted row carries too; the hosted output schema admits it.
    const shape = (r, is_wildcard) => ({
      is_wildcard,
      score: r.score,
      why: r.why,
      film: filmShape(films.get(r.screening.filmKey), { region: base.region }),
      showtime: screeningShape(r.screening, venues, { detailed: true, region: base.region, tz: base.timezone }),
    });

    // The preference warnings, then the discount fallback — the hosted
    // planMovieNightData composition. Both are REAL events a caller may
    // want to surface.
    const notes = [...prefWarnings, ...(discountNote ? [discountNote] : [])];
    const data = {
      ...base,
      window: w.label,
      nights: w.nights,
      party_size: party,
      note: notes.join(" ") || null,
      warnings: notes,
      discounts_relaxed: Boolean(discountNote),
      plan_count: plans.length,
      plans: plans.map((r) => shape(r, false)),
      wildcard: wildcard ? shape(wildcard, true) : null,
    };

    // The warnings LEAD: a caller relaying this answer reads top-down, and
    // the first thing it says must not be a 35mm plan that is not 35mm.
    const L = [
      ...prefWarnings,
      `Movie night ${w.label}${party ? ` for ${party}` : ""} — ${plans.length} plan${plans.length === 1 ? "" : "s"}${wildcard ? " and a wildcard" : ""}:`,
    ];
    if (discountNote) L.push(discountNote);
    L.push("");

    // ——— WHY EACH PICK, IN THE HOSTED WORDS ——— renderPlan()'s reason
    // sentence, as written. A bound the pick meets is not a preference it
    // missed: every pick has already passed the hard bounds and the
    // discount filter, so only the tilts can miss. A held film's sentence
    // falls through to its runtime, genres and director.
    const NEGATIVE = new Set(["outside your genres", "matinee"]);
    const bounded = p.time_after !== undefined || p.time_before !== undefined;
    const discounted = !!p.discounts_only && !discountNote;
    const relaxed = !!p.discounts_only && !!discountNote;
    const tilts = !!(p.likes?.length || p.avoids?.length || p.formats?.length || p.home_venues?.length || p.window || p.no_matinee);
    const met = [bounded && "starts within the times you gave", discounted && "is at a theater with a discount that night"]
      .filter(Boolean)
      .join(" and ");
    const reason = (r, isWildcard) => {
      const film = films.get(r.screening.filmKey);
      const pos = r.why.filter((x) => !NEGATIVE.has(x));
      const h = filmExtras(film)?.hook;
      const dir = film?.directors?.[0];
      const what = h
        ? `${dir ? `${dir}'s ` : ""}${film.title} — ${h}`
        : `${film?.runtimeMin ? `${film.runtimeMin} minutes of ` : ""}${(film?.genres ?? []).join(", ").toLowerCase() || "cinema"}${dir ? `, directed by ${dir}` : ""}.`;
      const why1 = isWildcard
        ? p.likes?.some((x) => String(x).trim())
          ? `Deliberately outside your stated genres: the highest-ranked show that is not one of them${pos.length ? ` (${pos.join(", ")})` : ""}.`
          : `One more option, the next film down the ranking${pos.length ? ` (${pos.join(", ")})` : ""}.`
        : pos.length
          ? `It lines up with what you asked for: ${pos.join(", ")}.`
          : tilts
            ? `No genre, format, time-window or theater preference you gave lifts this show${met ? `; it ${met}` : ""}.`
            : met
              ? `It ${met}; with nothing else to rank by, shows are ordered by start time.`
              : relaxed
                ? `No screening sits under a discount in that window, so shows are ordered by start time.`
                : `No preferences were given, so shows are ordered by start time.`;
      return `${why1} ${what}`;
    };
    // THE HOSTED renderPlan() PROSE, line for line: the film, its time,
    // night, house, neighborhood and tags on one line; the reason; ticket and
    // calendar links on one line; detailed adds the score, the screening id,
    // the film page and the preshow, then the accuracy stamp.
    const render = (pl, r, heading) => {
      const s = r.screening;
      const film = films.get(s.filmKey);
      const v = venues.get(s.venueId);
      if (!film || !v) return;
      L.push(
        `${heading} ${film.title}${film.year ? ` (${film.year})` : ""} — ${displayTime(s.startsAt, base.timezone)}, ${nightLabel(s.nightOf)} at ${v.name} (${v.neighborhood})${tagBadge(s)}`,
      );
      L.push(`   ${reason(r, pl.is_wildcard)}`);
      L.push(`   Tickets: ${pl.showtime.ticket_url} · Calendar: ${pl.showtime.calendar_url}`);
      if (detailed) {
        L.push(`   score ${r.score} · screening ${s.id} · film: ${filmUrl(film.slug, base.region)}${v.preshowMin ? ` · ~${v.preshowMin} min preshow` : ""}`);
        L.push(`   ${provDetail(pl.showtime)}`);
      }
      L.push("");
    };
    data.plans.forEach((pl, i) => render(pl, plans[i], `${i + 1}.`));
    if (data.wildcard) render(data.wildcard, wildcard, "Wildcard:");
    return both(finish(base, L), data);
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
      `Every structured discount across one board's theaters — venue, label, detail, and day-bound days — with the ones that apply today flagged. Membership and discount-card pricing is not listed; it reads "Member pricing; see the theater". ${READS_ONLY}`,
    inputSchema: { response_format: responseFormat, region: regionParam },
    outputSchema: discountsOut.shape,
    annotations: LISTING,
  },
  async (args) => {
    const detailed = isDetailed(args);
    const feed = await boardFeed(args.region);
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
          // The hosted discountsData row, key for key: membership and card
          // pricing through shownDiscount (shape.js), then the kind, the
          // day and its name.
          return {
            ...shownDiscount(d),
            kind: d.kind ?? "other",
            day: d.day ?? null,
            day_name: d.day !== undefined && d.day !== null ? DAY_NAMES[d.day] : null,
            applies_today,
          };
        }),
      }));

    const data = { ...base, today_dow, today_name, applies_today_count, venues };

    // THE HOSTED discounts() PROSE, line for line: what day it is on the
    // board's own calendar, every house with a discount, each discount with
    // its day and an APPLIES TODAY mark when its day is today (detailed adds
    // its kind and the venue id), then the count of day-bound discounts that
    // apply today and the sentence that matinee, membership and card pricing
    // runs any day — so a day with no day-bound discount never reads as a
    // day with no discount at all.
    const L = [`Theater discounts on this board — today is ${today_name}:`, ""];
    for (const v of feed.venues) {
      if (!(v.discounts ?? []).length) continue;
      L.push(`${v.name}:`);
      for (const disc of v.discounts) {
        const bound = disc.day !== undefined && disc.day !== null;
        const shownDisc = shownDiscount(disc);
        L.push(`- ${shownDisc.label}${bound ? ` (${DAY_NAMES[disc.day]}s)` : ""}: ${shownDisc.detail}${bound && disc.day === today_dow ? " · APPLIES TODAY" : ""}`);
        if (detailed) L.push(`  kind: ${disc.kind} · venue: ${v.id}`);
      }
      L.push("");
    }
    const n = applies_today_count;
    L.push(`${n} day-bound discount${n === 1 ? "" : "s"} appl${n === 1 ? "ies" : "y"} today; matinee, membership, and discount-card pricing runs on its own terms any day.`);
    return both(finish(base, L), data);
  },
);

tool(
  "scenef_coming_soon",
  {
    title: "Coming soon",
    description:
      `Lists films whose first screening on this board is more than 48 hours out, sorted by first night. Configurable horizon. It sets no alert, watch or reminder. ${TICKET_LINKS} ${DETAILED_CARRIES_ACCURACY}`,
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
    annotations: LISTING,
  },
  async (args) => {
    const detailed = isDetailed(args);
    const horizon_days = Math.min(Math.max(args.horizon_days ?? 21, 1), 90);
    const feed = await boardFeed(args.region);
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
        first_showtime: screeningShape(r.first, venues, { detailed, region: base.region, tz: base.timezone }),
        opening_venues: r.opening_venues,
      })),
    };

    // THE HOSTED comingSoon() PROSE, line for line. An empty horizon is one
    // sentence. Otherwise each film on one line — title, first night, the
    // houses opening it, the film page — capped at 40 in concise with the
    // cap said; detailed lists every film with its first curtain, ticket
    // link and accuracy stamp. The structured payload is never capped.
    if (!rows.length) {
      return both(finish(base, [`Nothing new opening more than 48 hours out within ${horizon_days} days.`]), data);
    }
    const CONCISE_CAP = 40;
    const shown = detailed ? rows : rows.slice(0, CONCISE_CAP);
    const L = [`Coming soon — first screenings more than 48h out, next ${horizon_days} days (${rows.length}):`, ""];
    shown.forEach((r, i) => {
      L.push(
        `- ${r.film.title}${r.film.year ? ` (${r.film.year})` : ""} — first night ${nightLabel(r.first.nightOf)} at ${r.opening_venues.join(", ")} · ${filmUrl(r.film.slug, base.region)}`,
      );
      if (detailed) {
        const first = data.films[i].first_showtime;
        L.push(`  first curtain ${displayTime(r.first.startsAt, base.timezone)} · tickets: ${first.ticket_url}`);
        L.push(`  ${provDetail(first)}`);
      }
    });
    if (shown.length < rows.length) {
      L.push(`(+${rows.length - shown.length} more — use response_format: "detailed" or a shorter horizon_days for the rest)`);
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
    title: "Find the region for a place",
    description:
      `Translate a city, 5-digit ZIP, neighborhood or board alias into the region handle every other tool takes. Returns the board and WHAT matched it. Refuses rather than guessing: an ambiguous name returns candidates (Hollywood names both the Los Angeles board and the Miami board), a name SceneF knows only as a place outside its published boards returns outside_coverage (with any published board within 100 miles), and any other name it cannot place returns unknown with no fallback board. ${BOARD_SCOPE}. Coordinates are not accepted — this reads names, not locations. It is an exact lookup in SceneF's own place table: no geocoder and no web search. ${READS_ONLY}`,
    inputSchema: {
      place: text()
        .describe('A city ("Pasadena"), a 5-digit ZIP ("94121"), a neighborhood ("the Mission") or a board alias ("the East Bay", "sf").'),
    },
    outputSchema: placeOut.shape,
    annotations: LISTING,
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
    // The hosted server's line, word for word. A staged name in a lit state
    // carries its own note on the unknown branch: SceneF cannot say it covers
    // the place, and cannot say it does not.
    const line = data.ok
      ? `${echoInput(data.input)} is on ${/^the /i.test(data.region_name ?? "") ? data.region_name : `the ${data.region_name}`} board (region=${data.region}), matched by ${data.matched}.`
      : data.reason === "ambiguous"
        ? `"${echoInput(data.input)}" names more than one board: ${(data.candidates ?? []).map((c) => `${c.region} (${c.region_name})`).join(", ")}. Ask which, rather than choosing.`
        : data.reason === "outside_coverage"
          ? `${data.note ?? ""}${(data.nearest_lit ?? []).length ? ` Nearest published: ${(data.nearest_lit ?? []).map((n) => `${n.region_name} (${n.miles}mi)`).join(", ")}.` : ""}`
          : data.note ?? `I do not know "${echoInput(data.input)}". Call scenef_now with no region for the boards SceneF publishes.`;
    return both(line, data);
  },
);

tool(
  "scenef_now",
  {
    title: "Check what is still on tonight",
    description:
      `Use this for a quick check of what is still on tonight on one board: how many screenings tonight, the next 5 showtimes with venue/time/film, when the data was generated and which theaters' listings may be out of date. Called with no region it also lists every board id with its place and timezone. ${TICKET_LINKS} ${DETAILED_CARRIES_ACCURACY}`,
    inputSchema: { response_format: responseFormat, region: regionParam },
    outputSchema: nowOut.shape,
    annotations: LISTING,
  },
  async (args) => {
    const detailed = isDetailed(args);
    // The board list rides only on a call that named no board — the hosted
    // wantsBoardList(). A caller who passed region= already knows the
    // handles.
    const wantsBoardList = !args.region?.trim();

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
    const board = await boardFeed(args.region);
    const t = tonight(board);
    const tonightNight = t.nightIso;
    const is_tonight = t.label === "tonight";

    const base = baseOf(board);
    const venues = venueIndex(board);
    const films = new Map(board.films.map((f) => [f.key, f]));

    const all = t.screenings;
    const stillToCome = all.filter(notStarted);
    const next = upcoming(board).slice(0, 5);

    // SOURCE HEALTH PER THEATER — the hosted nowSnapshotData() count and
    // staleLine() names, read from the one place this transport can see
    // them. The hosted server counts d.sourceHealth: one entry per venue, ok
    // when that venue's own fetch succeeded. Every REST row carries the same
    // verdict as freshness.source_status ("ok"; "failed" or "held" when the
    // fetch did not succeed and the rows are retained), so a theater with
    // rows on the board is counted, and an unhealthy one is named in the
    // hosted words with the age of its newest verified row (the hosted
    // newestVerified()).
    //
    // RECORDED GAP (2026-09-08, narrowed 2026-10-10): a venue whose fetch
    // failed and left no rows is invisible in the feed, so it is neither
    // counted nor named — on 2026-10-10 hosted sf read 16/17 (New People
    // unhealthy, no rows) where this reads 15/15, while oahu read 11/12 on
    // both, naming Consolidated Ward. `basis` says so. The hosted detailed
    // detail[] is not reproduced: its screening_count and notes come from
    // the ingest record, not the rows. The fix for the rest is a REST door
    // on sourceHealth, not an approximation here.
    const health = new Map();
    for (const s of board.screenings) {
      const status = s.freshness?.source_status;
      if (!status) continue;
      const h = health.get(s.venueId) ?? { ok: true, newest: null };
      if (status !== "ok") h.ok = false;
      const at = s.verified_at ?? s.provenance?.lastVerifiedAt ?? null;
      if (at && (!h.newest || Date.parse(at) > Date.parse(h.newest))) h.newest = at;
      health.set(s.venueId, h);
    }
    const venueOrder = [...board.venues.map((v) => v.id).filter((id) => health.has(id)), ...[...health.keys()].filter((id) => !venues.has(id))];
    const unhealthy = venueOrder
      .filter((id) => !health.get(id).ok)
      .map((id) => {
        const name = venues.get(id)?.name ?? id;
        const ago = agoText(health.get(id).newest);
        return { venue_id: id, name, note: `${name}: listings may be out of date${ago ? ` (last updated ${ago})` : ""}` };
      });
    const healthy = health.size - unhealthy.length;

    const boards = wantsBoardList ? await boardsList() : null;
    const data = {
      ...base,
      night_of: tonightNight,
      is_tonight,
      screenings_tonight: all.length,
      still_to_come: stillToCome.length,
      next_curtains: next.map((s) => ({
        ...screeningShape(s, venues, { detailed, region: base.region, tz: base.timezone }),
        film: filmShape(films.get(s.filmKey), { region: base.region }),
        film_key: s.filmKey,
      })),
      // The machine half of the board list, on the same condition.
      ...(wantsBoardList ? { boards: boards ?? [] } : {}),
      sources: {
        healthy,
        total: health.size,
        unhealthy,
        basis: "Counted per theater from each listing's freshness.source_status; a theater with no listings on this board is not visible here and is not counted.",
      },
    };

    // THE HOSTED nowSnapshot() PROSE, line for line: tonight's count and
    // how many are still to come (or the next lit night's count), the next
    // five curtains — time, the night when it is not tonight's, film, house,
    // tags, ticket link, and in detailed the accuracy stamp — then the board
    // and, on a call that named none, every board. The hosted answer ends
    // with "Data: generated … · N/M sources healthy." and a line per
    // unhealthy theater; this one does too, from the rows (SOURCE HEALTH
    // above), and its count says which theaters it covers, since a theater
    // with no listings is not visible here.
    const nightWord = is_tonight ? "tonight" : `${nightLabel(tonightNight)} (the next lit night)`;
    const L = [
      `${all.length} screening${all.length === 1 ? "" : "s"} ${nightWord}${is_tonight ? `, ${stillToCome.length} still to come` : ""}.`,
    ];
    if (next.length) {
      L.push("", "Next showtimes on this board:");
      next.forEach((s, i) => {
        const row = data.next_curtains[i];
        L.push(
          `- ${displayTime(s.startsAt, base.timezone)}${s.nightOf !== tonightNight ? ` (${nightLabel(s.nightOf)})` : ""} — ${films.get(s.filmKey)?.title ?? s.filmKey} at ${venues.get(s.venueId)?.short ?? s.venueId}${tagBadge(s)} · ${row.ticket_url}`,
        );
        if (detailed) L.push(`  ${provDetail(row)}`);
      });
    } else {
      L.push("", "No upcoming showtimes on the books.");
    }
    // The instructions promise this tool, called with no region, names the
    // boards — each id with the place it names (glossed only where the two
    // differ) and its zone where that differs from this board's, the hosted
    // nowSnapshot() list, from /api/boards (see boardsList). When the roster
    // is unavailable the pointer is honest instead of the list being
    // invented. A call that named a board gets the hosted pointer instead.
    L.push("", `This board: ${base.region_name} (${base.region}) · ${base.timezone}.`);
    if (!wantsBoardList) {
      L.push("Call scenef_now with no region for the list of every board.");
    } else if (boards?.length) {
      L.push(
        `Pass region= to any tool to read another. ${boards.length} boards:`,
        boards
          .map((b) => {
            const gloss = b.name && b.name.toLowerCase() !== b.region.toLowerCase() ? ` (${b.name})` : "";
            const tz = b.timezone === base.timezone ? "" : ` [${b.timezone}]`;
            return `${b.region}${gloss}${tz}`;
          })
          .join(", "),
      );
    } else {
      L.push("Pass region= to any tool to read another board; the current set is listed at https://scenef.com/api/boards.");
    }
    L.push("", `Data: generated ${base.data_as_of} · ${healthy}/${health.size} sources healthy (theaters with listings on this board).`);
    for (const u of unhealthy) L.push(`- ${u.note}`);
    return both(finish(base, L), data);
  },
);

/** "20h ago" — how long since an instant, the hosted agoText(). */
function agoText(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const hours = (Date.now() - t) / 3_600_000;
  if (hours < 1) return "less than an hour ago";
  if (hours < 48) return `${Math.floor(hours)}h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

// ——— the accuracy record in prose — the hosted helpers, as written ———

/** A pass rate to one decimal, or "not established" when nothing
 *  gradeable ran — the hosted pct(). */
function pct(rate) {
  return rate === null || rate === undefined ? "not established" : `${Math.round(rate * 1000) / 10}%`;
}

/** "venue-published 697, single-source 1221" — levels with a count only;
 *  the hosted mixText(). */
function mixText(mix) {
  const parts = Object.entries(mix ?? {}).filter(([, n]) => n > 0);
  return parts.length ? parts.map(([k, n]) => `${k} ${n}`).join(", ") : "none published";
}

/** The tally of one record — the hosted tallyText(). */
function tallyText(t) {
  return `${t.checks} check${t.checks === 1 ? "" : "s"} — ${t.confirmed} confirmed, ${t.missing} missing, ${t.unreachable} unreachable · pass rate ${pct(t.pass_rate)}`;
}

/** One venue's line — the hosted venueLine(): a house publishing nothing
 *  carries its note; every other its tier, mix, last verification and tally. */
function venueLine(v) {
  const head = `- ${v.name} (${v.venue_id}): ${v.screenings} screening${v.screenings === 1 ? "" : "s"}`;
  if (!v.screenings) return `${head}${v.note ? ` · ${v.note}` : ""}`;
  return `${head} · ${v.source_tier ?? "tier unrecorded"} · ${mixText(v.confidence_mix)} · last verified ${v.last_verified_at ?? "never"} · ${tallyText(v)}`;
}

tool(
  "scenef_accuracy",
  {
    title: "The accuracy record",
    description: `Returns SceneF's verification record: this board's confidence mix, the counts of verification checks confirmed / missing / unreachable over the record's window (window_days in the payload — 30 days at present) with the pass rate and the exact denominator it was computed from, the same per venue with source tier and last-verified time, and the definitions of every level. Checks that could not run — a bot wall, a client-rendered page — are graded unreachable and excluded from the pass rate rather than counted as passes. Quote these numbers directly; they are recomputed on every call. ${READS_ONLY}`,
    inputSchema: { response_format: responseFormat, region: regionParam },
    outputSchema: accuracyOutput.shape,
    annotations: LISTING,
  },
  async (args) => {
    const detailed = isDetailed(args);
    // The board first, as the hosted datasetFor() does: an unknown region is
    // refused in the hosted sentence before the record is read.
    const feed = await boardFeed(args.region);
    const payload = await accuracyRecord(args.region?.trim() || undefined);
    const base = baseOf(feed);
    // The API's record, picked to the advertised schema rather than passed
    // verbatim: the feed grew a `scope` field (2026-09-08) and verbatim
    // passthrough turned that growth into a validation crash for every
    // client. An explicit pick means the API can evolve without breaking
    // the contract this tool advertises. Since e7b11e5 /api/accuracy serves
    // the hosted accuracyForMcp() shape — no site.computed_from, venue notes
    // scrubbed of fetch errors and upstream urls — so site and venues pass
    // through as served; never add a local scrub or computed_from back.
    const record = {
      ...base,
      data_as_of: payload.data_as_of,
      attribution: payload.attribution,
      site: payload.site,
      venues: payload.venues,
      method: payload.method,
      docs: payload.docs,
    };
    // THE HOSTED accuracySnapshot() PROSE, line for line (pct, mixText,
    // tallyText and venueLine below are its helpers, as written): the board's
    // screenings and confidence mix, the checks and the pass rate to one
    // decimal, the basis, when the record opened and last checked; then
    // EVERY venue publishing showtimes, in the record's order, with its tally
    // — a house with no checks says its rate is not established — and the
    // houses listed but publishing none, with their notes (three in concise,
    // all in detailed). Detailed adds the definitions. It does not go through
    // finish(): it ends with the record's url and method page, then the
    // attribution WITHOUT the "accuracy record:" suffix — this answer IS the
    // record.
    const a = payload;
    const s = a.site;
    const L = [
      `SceneF accuracy record — computed from the dataset and our own verification runs, failures included. Nothing here is asserted.`,
      "",
      `Board: ${s.screenings} screenings · confidence mix: ${mixText(s.confidence_mix)}.`,
      `Checks, last ${s.window_days} days: ${tallyText(s)}.`,
      `Pass rate basis: ${s.pass_rate_basis}`,
      `Record opened ${s.first_check_at ?? "not yet"} · last check ${s.last_check_at ?? "none in window"}.`,
      "",
    ];
    const publishing = (a.venues ?? []).filter((v) => v.screenings > 0);
    const linkOnly = (a.venues ?? []).filter((v) => v.screenings === 0);
    L.push(`Per venue (${publishing.length} publishing showtimes):`);
    for (const v of publishing) L.push(venueLine(v));
    if (linkOnly.length) {
      L.push("", `Listed but publishing no showtimes here (${linkOnly.length}):`);
      for (const v of detailed ? linkOnly : linkOnly.slice(0, 3)) L.push(venueLine(v));
      if (!detailed && linkOnly.length > 3) L.push(`- (+${linkOnly.length - 3} more — response_format: "detailed" for the rest)`);
    }
    if (detailed) {
      L.push("", "Confidence levels (how well a showtime is known):");
      for (const [k, v] of Object.entries(a.method?.confidence_levels ?? {})) L.push(`- ${k}: ${v}`);
      L.push("", "Source tiers (where it came from):");
      for (const [k, v] of Object.entries(a.method?.source_tiers ?? {})) L.push(`- ${k}: ${v}`);
      L.push("", "Check grades (what a verification run can conclude):");
      for (const [k, v] of Object.entries(a.method?.check_grades ?? {})) L.push(`- ${k}: ${v}`);
      L.push("", "The rings:");
      (a.method?.rings ?? []).forEach((r, i) => L.push(`${i + 1}. ${r}`));
    }
    L.push(
      "",
      `Full JSON: ${base.accuracy_url} · method: ${a.docs}`,
      `— Showtimes via SceneF.com, data as of ${a.data_as_of}`,
    );
    // The record and the board are each read through the edge cache; an
    // expired copy of either is said (shape.js edgeStaleNote).
    const stale = edgeStaleNote(edgeStaleness(payload) ?? edgeStaleness(feed));
    if (stale) L.push(stale);
    return both(L.join("\n"), record);
  },
);
