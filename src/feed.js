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
//
// Every answer this server gives is computed in THIS process from that feed.
// Read-only by construction: nothing here issues anything but a GET, and no
// key, cookie, or credential is ever sent.

const BASE = (process.env.SCENEF_BASE_URL || "https://scenef.com").replace(/\/+$/, "");

/** Honest identification, per the site's robots contract. */
export const USER_AGENT = "scenef-mcp-local/1.0";
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
export function accuracyRecord() {
  return getJson("/api/accuracy");
}

// ——————————————————————————————————————————————— the night, not the date
//
// A showtime at 12:40am belongs to the night before it. The board's day rolls
// at 4am local, so "tonight" after midnight still means the evening you are
// standing in. We ask the FEED which night that is (`?when=tonight` is the
// site's own answer) and only compute it locally when the board is empty and
// there is nothing to read the answer off of.

/** The 4am rule, used only as a fallback when the board has no screenings. */
export function clockNight(timezone = "America/Los_Angeles", at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return Number(get("hour")) < 4 ? shiftDate(date, -1) : date;
}

/** YYYY-MM-DD plus n days, without dragging in a date library. */
export function shiftDate(date, days) {
  const [y, m, d] = date.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Which night the board is currently calling tonight. */
export async function tonightNight() {
  const d = await listings({ when: "tonight" });
  const nights = d.screenings.map((s) => s.nightOf).filter(Boolean).sort();
  return nights[0] ?? clockNight(d.timezone);
}
