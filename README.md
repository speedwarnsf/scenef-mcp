<img src="scenef-mark.png" alt="SceneF" width="72" />

# SceneF — San Francisco Movie Showtimes (MCP server)

Built by movie lovers, for movie lovers and their assistants.

San Francisco is one of the last great moviegoing cities — single-screen
neighborhood houses from the 1920s, repertory calendars that change nightly,
35mm and 70mm prints, midnight movies, and yes, the multiplexes too. SceneF
puts every screen in the city on one board and verifies each showtime against
the theater's own box office, so nobody ever drives to a dark theater.

Remote MCP server, streamable HTTP, no API key, read-only.

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

## Tools

| Tool | What it answers |
| --- | --- |
| `scenef_whats_playing` | Ranked films for tonight / tomorrow / the weekend / a date — opens with **Notable tonight**: scarcity facts with receipts (measured seat counts, final nights, lone 35/70mm prints, posted discounts, live events) |
| `scenef_search_showtimes` | Showtimes for one film, fuzzy-matched |
| `scenef_theater_info` | One theater: address, neighborhood, standing discounts, upcoming board |
| `scenef_film_details` | Year, runtime, ratings, cast, trailer, every upcoming showtime |
| `scenef_plan_movie_night` | Constraints in (time window, genres, formats, theaters), a plan out |
| `scenef_discounts` | The cheap nights, citywide |
| `scenef_coming_soon` | What's opening next |
| `scenef_now` | Right-now snapshot: what's catchable at this hour |
| `scenef_accuracy` | Our own verification record — checks run, failed, and unreachable |

Every ticket link is a direct door to the theater's own box office. No ads,
no pay-ranking; ranking is pure preference-scoring and nothing is ever
hidden. The repertory houses get the same billing as the chains — a lone
35mm print at a neighborhood house is exactly the kind of thing this server
exists to surface.

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
