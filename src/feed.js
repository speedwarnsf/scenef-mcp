// The public REST contract, and nothing else.
//
// This is a LOCAL server, not a proxy. It speaks MCP itself over stdio and
// reads its data from SceneF's published, key-less REST API — the same
// contract documented for any client at https://scenef.com/agents:
//
//   GET /api/listings   the canonical open feed (venues, films, screenings,
//                       notable-tonight) — sliced by ?when= ?night= ?venue=
//                       ?film=, ranked by the bring-your-own-profile grammar
//   GET /api/accuracy   the verification record, failures included
//   GET /api/boards     the roster of lit boards; ?place= resolves a city,
//                       ZIP, neighborhood or alias to one of them, or refuses
//
// Every answer this server gives is computed in THIS process from that feed.
// Read-only by construction: nothing here issues anything but a GET, and no
// key, cookie, or credential is ever sent.

const BASE = (process.env.SCENEF_BASE_URL || "https://scenef.com").replace(/\/+$/, "");

/** Honest identification, per the site's robots contract. */
export const USER_AGENT = "scenef-mcp-local/1.1";
export const SITE = BASE;

// The feed publishes `cache-control: max-age=60` because counts.tonight means
// "still catchable". Holding it exactly that long means nine tool calls in one
// conversation cost one round trip without ever serving a staler board than a
// browser would show.
const TTL_MS = 60_000;

const cache = new Map();

async function getJson(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
    });
  } catch (err) {
    throw new Error(
      `Could not reach ${BASE}${path} (${err?.message ?? err}). This server reads the live SceneF feed and has no offline copy.`,
    );
  }

  if (!res.ok) {
    // The feed refuses unusable parameters with a warnings[] array rather than
    // silently serving the whole board. Pass that reason through — it is the
    // most useful thing a caller can be told.
    let detail = "";
    try {
      const body = await res.json();
      if (Array.isArray(body?.warnings) && body.warnings.length) detail = ` — ${body.warnings.join(" ")}`;
      else if (body?.error) detail = ` — ${body.error}`;
    } catch {
      /* body was not json; the status is the whole story */
    }
    throw new Error(`SceneF ${path} answered ${res.status}${detail}`);
  }

  const value = await res.json();
  cache.set(path, { at: Date.now(), value });
  return value;
}

/** The open feed. Params are the published ones: when, night, venue, film,
 *  compact, plus the profile grammar (likes, no, formats, home, window,
 *  discounts) which RANKS the same screenings rather than hiding any. */
export function listings(params = {}) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  const qs = sp.toString();
  return getJson(`/api/listings${qs ? `?${qs}` : ""}`);
}

/** The verification record — returned by scenef_accuracy verbatim. */
export function accuracyRecord(region) {
  return getJson(`/api/accuracy${region ? `?region=${encodeURIComponent(region)}` : ""}`);
}

// ————————————————————————————————————————————————————— board discovery
//
// /api/boards (added 2026-09-08) is the roster: every LIT board with its
// slug, display name, and timezone. It replaced this function's original
// 400-discovery trick (ask for a region that doesn't exist, read the valid
// list out of the correction). Cached for an hour — boards change on flips,
// not minutes. Each entry is picked to {region, name, timezone}, the shape
// scenef_now's output schema advertises; the endpoint's count field is
// checked against the array so a truncated listing is caught, not served
// (three listings in this estate have hidden one). Any failure returns null
// and the caller says where the list lives instead of inventing one.

let boardsCache = { at: 0, value: null };
const BOARDS_TTL_MS = 3_600_000;

export async function boardsList() {
  if (boardsCache.value && Date.now() - boardsCache.at < BOARDS_TTL_MS) return boardsCache.value;
  try {
    const d = await getJson("/api/boards");
    const raw = Array.isArray(d?.boards) ? d.boards : [];
    if (typeof d?.count === "number" && d.count !== raw.length) return null;
    const value = raw
      .filter((b) => b && b.region && b.name && b.timezone)
      .map((b) => ({ region: b.region, name: b.name, timezone: b.timezone }));
    if (value.length) {
      boardsCache = { at: Date.now(), value };
      return value;
    }
  } catch {
    /* fall through to null — the caller points at the list, never invents it */
  }
  return null;
}

// ————————————————————————————————————————————— a place, resolved to a board
//
// /api/boards?place= is the REST door behind the hosted scenef_resolve_board:
// the same resolvePlace() answers both, from the table built out of the venue
// and census data. This server reads the door rather than carrying a second
// copy of that table — a copy would be right until the first region flipped,
// and then it would hand a caller another city's showtimes with a 200.
//
// A refusal is a 200 with ok:false, never an error: the question was well
// formed and the answer — ambiguous, outside_coverage, unknown — is real.
// getJson passes a genuine failure (unreachable, 5xx) through as one.

export async function resolvePlace(place) {
  const d = await getJson(`/api/boards?place=${encodeURIComponent(String(place ?? ""))}`);
  const r = d?.resolved;
  if (!r || typeof r !== "object" || typeof r.ok !== "boolean") {
    throw new Error(
      `SceneF /api/boards?place= answered without a resolution. This server resolves places through that door and keeps no place table of its own.`,
    );
  }
  return r;
}

// ——————————————————————————————————————————————— the night, not the date
//
// A showtime at 12:40am belongs to the night before it. The board's day rolls
// at 4am local, so "tonight" after midnight still means the evening you are
// standing in.
//
// COMPUTED AT CALL TIME, NEVER READ OFF THE FEED. This server used to take
// the feed's own `tonight_is` label as the answer. The feed is CDN-cached
// (max-age 60, s-maxage 120, stale-while-revalidate 86400) on top of this
// process's 60-second cache, so for minutes after midnight — and for as long
// as an edge kept serving a stale copy — the label was the one computed
// BEFORE the day rolled: "tomorrow" for a night the hosted server was
// already calling tonight. The hosted tools never read a label; they run
// tonight(d) (src/lib/data.ts) against Date.now() and the board's timezone
// on every call. So does this file now. The rows come from the feed; the
// clock is this process's, in the board's zone, through Intl and nothing
// else.

const DEFAULT_TZ = "America/Los_Angeles";
const DOWS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The 4am rollover — the single boundary the whole night law hangs on
 *  (hosted NIGHT_ROLLOVER_MIN, src/lib/time.ts). */
export const NIGHT_ROLLOVER_MIN = 4 * 60;

/** How far INTO a screening it is still honest to call it catchable —
 *  the hosted CATCHABLE_GRACE_MIN (src/lib/clocklaw.ts). tonight() keeps a
 *  show this many minutes past its curtain; everything else asks
 *  notStarted(), which keeps nothing. */
export const CATCHABLE_GRACE_MIN = 20;

/** A zone Intl accepts, or the default — the hosted safeZone(). A feed
 *  that named a zone this runtime lacks must not throw out of every tool. */
function safeZone(tz) {
  if (!tz || typeof tz !== "string") return DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TZ;
  }
}

/**
 * THE BOARD'S WALL CLOCK — the hosted cityNow(tz) (src/lib/time.ts), with
 * Intl and nothing else. `date` is the calendar date where the theaters
 * are, `minutes` the time of day there, `dow` Sunday = 0. This is what
 * "today" means for a discount grid: the hosted discounts handler reads
 * cityNow(d.timezone).dow, never the night. Reading the night instead put
 * this server a day ahead of the hosted one once an evening was spent —
 * the feed's tonight slice had rolled forward to the next lit night, and
 * "today" rolled with it while the calendar had not.
 */
export function cityNow(timezone = DEFAULT_TZ, at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: safeZone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  const dow = DOWS.indexOf(get("weekday").slice(0, 3));
  return { date, minutes, dow };
}

/** Epoch ms → the board's wall-clock parts — the hosted msToCityParts()
 *  (src/lib/time.ts). getHours() would read THIS process's zone, which is
 *  whatever machine the agent runs on; the theatre's clock is the only one
 *  a night can be filed by. */
export function msToCityParts(ms, timezone = DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: safeZone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")),
  };
}

/** The night the reader is living, with its clock — the hosted liveNight():
 *  before 4am that is YESTERDAY'S night at minute 1440+, matching the way a
 *  12:15am show is filed. Compare against nightClockOf() values only — both
 *  sides sit on the same 28-hour dial. */
export function liveNight(nowMs = Date.now(), timezone = DEFAULT_TZ) {
  const { date, minutes } = msToCityParts(nowMs, timezone);
  return minutes < NIGHT_ROLLOVER_MIN
    ? { night: shiftDate(date, -1), minutes: minutes + 1440 }
    : { night: date, minutes };
}

/** A screening's position on ITS OWN night's dial — the hosted
 *  nightClockOf(): a 12:45am curtain is minute 1485 of its evening, not
 *  minute 45 of the next day. Read off the literal HH:MM, which is the
 *  venue's own wall clock. */
export function nightClockOf(startsAt) {
  const m = /T(\d{2}):(\d{2})/.exec(String(startsAt ?? ""));
  const mins = m ? Number(m[1]) * 60 + Number(m[2]) : 0;
  return mins < NIGHT_ROLLOVER_MIN ? mins + 1440 : mins;
}

/** Minutes since midnight of an instant, in the board's zone — the hosted
 *  minutesOf() (src/lib/time.ts), Intl and nothing else. Feeds ONLY the
 *  time_after/time_before filters, as it does there. */
export function minutesOf(iso, timezone = DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeZone(timezone),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return (get("hour") % 24) * 60 + get("minute");
}

/** YYYY-MM-DD plus n days — the hosted shiftDate(), noon-anchored so no
 *  zone or DST step can move the date. */
export function shiftDate(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Screenings for one evening (nightOf), soonest first — the hosted
 *  night(d, nightIso) (src/lib/data.ts). */
export function night(feed, nightIso) {
  return (feed?.screenings ?? [])
    .filter((s) => s.nightOf === nightIso)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/**
 * THE HOSTED tonight(d) (src/lib/data.ts), over the board this process was
 * handed, at the instant it is asked:
 *
 *   { nightIso, label: "tonight" | "tomorrow" | "next", screenings, spent, tonightOver }
 *
 * The live night first (4am rule), clock-filtered to what a reader can
 * still get to — a curtain within CATCHABLE_GRACE_MIN of now stays — then
 * the calendar forward, up to a fortnight, until a night has a catchable
 * screening. Only the live night is filtered by the clock: a future night
 * has no "past". Labels are colloquial: the live night is "tonight" even
 * when its date is yesterday's; once it is spent, the coming evening
 * (today's date) is also "tonight"; the next calendar date is "tomorrow";
 * anything further is "next". A board dark for a fortnight is today's date,
 * labelled tonight, with no screenings.
 *
 * nowMs is injectable so the boundary can be held still in a test.
 */
export function tonight(feed, nowMs = Date.now()) {
  const tz = feed?.timezone;
  const { date } = msToCityParts(nowMs, tz);
  const live = liveNight(nowMs, tz);
  let tonightOver = false;
  const nights = live.night === date ? [] : [live.night];
  for (let i = 0; i < 14; i++) nights.push(shiftDate(date, i));
  for (const nightIso of nights) {
    const isLive = nightIso === live.night;
    const s = night(feed, nightIso);
    if (!s.length) {
      // Sources delist past sessions; an empty live night late in the
      // evening means spent, not dark.
      if (isLive && live.minutes >= 21 * 60) tonightOver = true;
      continue;
    }
    const showable = isLive ? s.filter((x) => nightClockOf(x.startsAt) >= live.minutes - CATCHABLE_GRACE_MIN) : s;
    const spent = isLive ? s.filter((x) => nightClockOf(x.startsAt) < live.minutes - CATCHABLE_GRACE_MIN) : [];
    if (!showable.length) {
      tonightOver = true;
      continue;
    }
    const label = isLive || nightIso === date ? "tonight" : nightIso === shiftDate(date, 1) ? "tomorrow" : "next";
    return { nightIso, label, screenings: showable, spent, tonightOver };
  }
  return { nightIso: date, label: "tonight", screenings: [], spent: [], tonightOver };
}
