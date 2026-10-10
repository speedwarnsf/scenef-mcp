<img src="scenef-mark.png" alt="SceneF" width="72" />

# SceneF — Movie Showtimes for California, Florida & Hawaii (MCP server)

Built by movie lovers, for movie lovers and their assistants.

SceneF started in San Francisco — one of the last great moviegoing cities:
single-screen neighborhood houses from the 1920s, repertory calendars that
change nightly, 35mm and 70mm prints, midnight movies, and yes, the
multiplexes too. It now runs **56 regional boards across California, Florida and
Hawaii** — Los Angeles to Sacramento, San Diego to Maui, Miami to Pensacola.
Each board brings venue schedules and a third-party showtimes data service
together, with source confidence and freshness so callers can see what the
listings are based on.

Remote MCP server, streamable HTTP, no API key, read-only — and a local
stdio server in this repo, running the same ten tools.

**Every tool except `scenef_resolve_board` takes a `region`** — `"sf"`, `"la-central"`, `"oahu"`,
`"sacramento"`, … — and omitting it means the default board (`sf`), never a
guess from where you are. Use `scenef_resolve_board` for a named place and
`scenef_now` with no region for the current list of boards.
Times are each theatre's own wall clock: Hawaii runs two or three hours off Pacific
and keeps no DST, and each board reports its timezone with its data.

```
https://scenef.com/mcp
```

## Connect

**Claude Code**

```bash
claude mcp add --transport http scenef https://scenef.com/mcp
```

**Claude Desktop / any MCP client** (`.mcp.json` / client config)

```json
{
  "mcpServers": {
    "scenef": {
      "type": "http",
      "url": "https://scenef.com/mcp"
    }
  }
}
```

Also listed in the official MCP registry as `com.scenef/showtimes`.

## Or run it locally

This repo is also a **local MCP server** — Node, stdio, no proxy. It speaks
the protocol itself and reads the same board over SceneF's public REST API.
The same ten public tools and matching rules are available on either
transport. REST caching can make the two responses differ briefly.

```bash
npx -y github:speedwarnsf/scenef-mcp
```

**Claude Desktop / any stdio client**

```json
{
  "mcpServers": {
    "scenef": {
      "command": "npx",
      "args": ["-y", "github:speedwarnsf/scenef-mcp"]
    }
  }
}
```

**From a clone, or Docker**

```bash
npm install && npm start
```

```bash
docker build -t scenef-mcp . && docker run --rm -i scenef-mcp
```

No API key, no account, no configuration. It sends `User-Agent:
scenef-mcp-local/1.1`, issues nothing but `GET`, and has no write path
anywhere in it.

`npm test` first runs offline regressions against the saved hosted schema
contract and fixture feeds. `test/contract.js` calls all ten tools against
the live board and validates every payload against the output schema the
server advertises, and `test/parity.js` diffs this server's tool definitions
against the hosted endpoint's. For a local preview, set both
`SCENEF_BASE_URL=http://localhost:3017` and
`SCENEF_MCP_URL=http://localhost:3017/mcp`. No external schema refresh is
claimed by a successful offline run. If that preview has a limited dataset,
set `SCENEF_PARITY_REGION=oahu` (or another populated nondefault board) for
the regional probes; the default is `la-central`.

## Tools

| Tool | What it answers |
| --- | --- |
| `scenef_whats_playing` | Ranked films for tonight / tomorrow / the weekend / a date — when the window covers tonight, opens with **Notable tonight**: scarcity facts with receipts (measured seat counts, final nights, lone 35/70mm prints, posted discounts, live events) |
| `scenef_search_showtimes` | Showtimes for one film or theater, with date and hard time filters |
| `scenef_theater_info` | One theater: address, neighborhood, standing discounts, upcoming board |
| `scenef_film_details` | Year, runtime, rating, cast, trailer, the nearest upcoming showtimes |
| `scenef_plan_movie_night` | Constraints in (time window, genres, formats, theaters), a plan out |
| `scenef_discounts` | The cheap nights, board-wide |
| `scenef_coming_soon` | What's opening next |
| `scenef_resolve_board` | A city, ZIP, neighborhood or alias to the board that covers it — or a refusal that says which kind of no |
| `scenef_now` | Right-now snapshot: what's catchable at this hour |
| `scenef_accuracy` | Our own verification record — checks run, failed, and unreachable |

Board-reading tools answer for one regional board at a time — pass `region`
to pick it. Preserve every returned ticket, calendar and film URL exactly,
including regional paths and `?region=` hints. Invalid hard date/time filters
return a refusal and warnings, never an unfiltered success. No ads or paid
ranking. The repertory houses get the same billing as the chains — a lone
35mm print at a neighborhood house is exactly the kind of thing this server
exists to surface, whether that house is in the Richmond or in Hilo.

`scenef_whats_playing` in concise mode returns the total `showtime_count`
and just the next screening in `showtimes`; detailed mode adds showtime rows,
about 200 across the answer. `scenef_film_details` and
`scenef_search_showtimes` return the 40 nearest showtimes in concise mode and
up to 200 in detailed. `showtime_count` is always the total and
`showtimes_complete` says whether the array is all of it; narrow by date or
theater for the rest.

## Why trust it

- Showtimes come from venue schedules and a third-party showtimes data
  service. Many showtimes, including most chain theaters and some
  independents, come from that service rather than from the theater itself;
  they are labelled `source_tier: licensed-feed` and carry the weakest claim
  on the site. Every returned screening carries `confidence`, `source_tier`,
  `sources`, and `verified_at` in both concise and detailed modes.
- `data_as_of` is the dataset publication time. `verified_at` and `freshness`
  describe a screening's source evidence; a fresh dataset can retain older
  rows. Freshness measures recency, not correctness. Confirm stale or retained
  listings with the theater before relying on them.
- The verification record is public — including the checks that failed:
  [scenef.com/api/accuracy](https://scenef.com/api/accuracy).

The local `scenef_now.sources` summary counts theater health the way the
hosted server does, one theater at a time, and names each theater whose
listings may be out of date in the hosted words. It reads that health from
each listing's `freshness.source_status`, so a theater with no listings on
the board is not visible locally and is not counted; the hosted count can be
higher by those theaters, and the payload's `basis` and the prose's closing
`Data:` line say so. Apart from that line, the edge-cache note below and
input-validation errors (the MCP SDK words those differently; the limits are
the same), every answer's prose is the hosted server's, line for line. Per-screening freshness
comes from the canonical REST feed on both transports; the local server keeps
the feed's allowance, `retained` and `source_status`, and ages `age_hours` and
`status` from `verified_at` at call time, as the hosted server does.

The REST doors are served through an edge cache that, once a copy expires,
answers the next request from the expired copy while it refreshes. The hosted
server reads the current dataset and never sees such a copy. The local server
asks again (three retries over about three seconds) when the edge reports a
stale copy; if the edge is still serving it after that, the answer is built on
it and says so in one line after the footer, and `data_as_of` is that copy's.

## Prefer plain HTTP?

The same data is served REST-style — see
[scenef.com/agents](https://scenef.com/agents) for the full contract:
[`/api/listings`](https://scenef.com/api/listings?when=tonight&compact=1) ·
[`/ask`](https://scenef.com/ask?q=what+is+playing+on+35mm+tonight) ·
[OpenAPI](https://scenef.com/openapi.json) ·
[llms.txt](https://scenef.com/llms.txt)

## Contact

info@scenef.com · [scenef.com](https://scenef.com)
