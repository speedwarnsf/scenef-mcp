<img src="scenef-mark.png" alt="SceneF" width="72" />

# SceneF — Movie Showtimes for California & Hawaii (MCP server)

Built by movie lovers, for movie lovers and their assistants.

SceneF started in San Francisco — one of the last great moviegoing cities:
single-screen neighborhood houses from the 1920s, repertory calendars that
change nightly, 35mm and 70mm prints, midnight movies, and yes, the
multiplexes too. It now runs **33 regional boards across California and
Hawaii** — Los Angeles to Sacramento, San Diego to Maui — and more states
are soaking. Every board puts every screen in its region on one page and
verifies each showtime against the theater's own box office, so nobody ever
drives to a dark theater.

Remote MCP server, streamable HTTP, no API key, read-only — and a local
stdio server in this repo, running the same ten tools.

**Every tool takes a `region`** — `"sf"`, `"la-central"`, `"oahu"`,
`"sacramento"`, … — and omitting it means the default board (`sf`), never a
guess from where you are. Call `scenef_now` for the current list of boards.
Times are each theatre's own wall clock: Hawaii runs three hours off Pacific
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
Same ten tools, same schemas, same descriptions, same numbers; pick the
transport your client prefers.

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

`npm test` runs two suites: `test/contract.js` calls all ten tools against
the live board and validates every payload against the output schema the
server advertises, and `test/parity.js` diffs this server's tool definitions
against the hosted endpoint's — one contract, two transports, proven rather
than asserted.

## Tools

| Tool | What it answers |
| --- | --- |
| `scenef_whats_playing` | Ranked films for tonight / tomorrow / the weekend / a date — opens with **Notable tonight**: scarcity facts with receipts (measured seat counts, final nights, lone 35/70mm prints, posted discounts, live events) |
| `scenef_search_showtimes` | Showtimes for one film, fuzzy-matched |
| `scenef_theater_info` | One theater: address, neighborhood, standing discounts, upcoming board |
| `scenef_film_details` | Year, runtime, ratings, cast, trailer, every upcoming showtime |
| `scenef_plan_movie_night` | Constraints in (time window, genres, formats, theaters), a plan out |
| `scenef_discounts` | The cheap nights, board-wide |
| `scenef_coming_soon` | What's opening next |
| `scenef_resolve_board` | A city, ZIP, neighborhood or alias to the board that covers it — or a refusal that says which kind of no |
| `scenef_now` | Right-now snapshot: what's catchable at this hour |
| `scenef_accuracy` | Our own verification record — checks run, failed, and unreachable |

Every tool answers for one regional board at a time — pass `region` to pick
it. Every ticket link is a direct door to the theater's own box office. No
ads, no pay-ranking; ranking is pure preference-scoring and nothing is ever
hidden. The repertory houses get the same billing as the chains — a lone
35mm print at a neighborhood house is exactly the kind of thing this server
exists to surface, whether that house is in the Richmond or in Hilo.

## Why trust it

- Showtimes are read from each theater's own ticketing system or venue feed
  where one exists, and corroborated across independent sources where it
  doesn't. Every screening carries `confidence`, `sources`, and `verified_at`.
- The verification record is public — including the checks that failed:
  [scenef.com/api/accuracy](https://scenef.com/api/accuracy).
- Same-day truth: an evening sweep pulls cancelled shows and flips sold-out
  both ways between ingests.

## Prefer plain HTTP?

The same data is served REST-style — see
[scenef.com/agents](https://scenef.com/agents) for the full contract:
[`/api/listings`](https://scenef.com/api/listings?when=tonight&compact=1) ·
[`/ask`](https://scenef.com/ask?q=what+is+playing+on+35mm+tonight) ·
[OpenAPI](https://scenef.com/openapi.json) ·
[llms.txt](https://scenef.com/llms.txt)

## Contact

info@scenef.com · [scenef.com](https://scenef.com)
