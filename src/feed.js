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
// standing in. We ask the FEED which night that is (`?when=tonight` is the
// site's own answer) and only compute it locally when the board is empty and
// there is nothing to read the answer off of.

const DEFAULT_TZ = "America/Los_Angeles";
const DOWS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

/** The 4am rule — the hosted liveNight(): before 4am the reader is still
 *  living yesterday's night, exactly as a 12:15am show is filed. */
export function clockNight(timezone = DEFAULT_TZ, at = new Date()) {
  const { date, minutes } = cityNow(timezone, at);
  return minutes < 4 * 60 ? shiftDate(date, -1) : date;
}

/** YYYY-MM-DD plus n days, without dragging in a date library. */
export function shiftDate(date, days) {
  const [y, m, d] = date.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Which night a `when=tonight` slice is, and what that night is RELATIVE TO
 * NOW — the hosted tonight(d) (src/lib/data.ts), read off the feed.
 *
 *   { night: "2026-09-09", label: "tonight" | "tomorrow" | "next" }
 *
 * The feed labels its own roll-forward (`tonight_is`, 2026-09-05): a spent
 * or dark evening is served as the next lit night, and the label says so.
 * When the label is present it is the answer — it was computed by the same
 * function the hosted tools read. Older payloads without it get the hosted
 * rule applied to the slice's first night, in the board's own zone: the
 * live night (4am rule) or today's date is "tonight", the next calendar
 * date is "tomorrow", anything further is "next". An empty slice is the
 * calendar date, labelled tonight, as tonight(d) returns when nothing is
 * lit for a fortnight.
 */
export function tonightIs(feed) {
  const t = feed?.tonight_is;
  if (t && typeof t === "object" && typeof t.night === "string" && t.night) {
    const label = t.label === "tomorrow" || t.label === "next" ? t.label : "tonight";
    return { night: t.night, label };
  }
  const tz = feed?.timezone;
  const { date } = cityNow(tz);
  const nights = (feed?.screenings ?? []).map((s) => s.nightOf).filter(Boolean).sort();
  const night = nights[0];
  if (!night) return { night: date, label: "tonight" };
  const label =
    night === clockNight(tz) || night === date ? "tonight" : night === shiftDate(date, 1) ? "tomorrow" : "next";
  return { night, label };
}

/** Which night the board is currently calling tonight. */
export async function tonightNight(region) {
  const d = await listings(region ? { when: "tonight", region } : { when: "tonight" });
  return tonightIs(d).night;
}
