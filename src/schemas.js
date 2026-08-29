// The published output shapes, ported from the hosted server.
//
// LOOSE on nested objects, EXACT on the fields a caller branches on. Pinning
// every field would turn an added field into a validation error for every
// existing client, and this contract is published in two places at once: the
// hosted endpoint at scenef.com/mcp and this local server. One contract, two
// transports — an agent that learned the shape from either must be able to
// read the other without a second code path.
//
// A declared outputSchema that rejects its own payload is worse than none:
// the tool fails at call time, in the caller's client, with a validation
// error the server never saw in testing. test/contract.js calls all nine
// tools against the live feed for exactly that reason.

import { z } from "zod";

/** zod v3 spelling of the hosted server's looseObject. */
const loose = (shape) => z.object(shape).passthrough();

/** Provenance every structured payload carries. */
const baseOut = {
  data_as_of: z.string(),
  attribution: z.string(),
  accuracy_url: z.string(),
};

export const venueOut = loose({
  venue_id: z.string(),
  name: z.string(),
  short: z.string(),
  neighborhood: z.string().nullable(),
});

export const screeningOut = loose({
  screening_id: z.string(),
  venue: venueOut,
  starts_at: z.string(),
  night_of: z.string(),
  local_time: z.string(),
  tags: z.array(z.string()),
  ticket_url: z.string(),
});

export const filmOut = loose({
  key: z.string(),
  slug: z.string(),
  title: z.string(),
  year: z.number().nullable(),
  runtime_min: z.number().nullable(),
  genres: z.array(z.string()),
  directors: z.array(z.string()),
  url: z.string(),
});

export const whatsPlayingOut = z.object({
  ...baseOut,
  window: z.string(),
  nights: z.array(z.string()),
  note: z.string().nullable(),
  notable: z.array(loose({ title: z.string(), venue: z.string(), local_time: z.string() })),
  film_count: z.number(),
  films: z.array(filmOut.extend({ venue_count: z.number(), showtimes: z.array(screeningOut) })),
});

export const searchOut = z.object({
  ...baseOut,
  // Null when the search was scoped by venue rather than by film.
  query: z.string().nullable(),
  // matched:false is a real answer, not an error — a caller branches here
  // before reading `film`, and gets `candidates` when the name was ambiguous.
  matched: z.boolean(),
  // Which parameter carried the query. A venue-scoped answer has no `film`
  // BY DESIGN, and without this a caller cannot tell that from a film-scoped
  // answer that lost one.
  filtered_by: z.enum(["film", "venue"]).optional(),
  // Set when the call named neither a film nor a venue. Refusing is an
  // answer; silently returning the whole board would answer a different
  // question than the one asked.
  refusal: z.string().optional(),
  film: filmOut.optional(),
  candidates: z.array(filmOut).optional(),
  unknown_venues: z.array(z.string()),
  coverage_note: z.string().nullable(),
  showtime_count: z.number(),
  // In venue mode each showtime carries its own film — there the film is the
  // answer rather than the query, and a bare list of times is unreadable.
  venues: z.array(
    venueOut.extend({
      showtimes: z.array(screeningOut.extend({ film: filmOut.nullable().optional() })),
    }),
  ),
});

export const theaterOut = z.object({
  ...baseOut,
  query: z.string(),
  matched: z.boolean(),
  venue: venueOut.optional(),
  candidates: z.array(venueOut).optional(),
  covered_venue_ids: z.array(z.string()).optional(),
  upcoming_count: z.number().optional(),
  upcoming: z.array(screeningOut.extend({ film: filmOut.nullable() })).optional(),
});

export const filmDetailsOut = z.object({
  ...baseOut,
  query: z.string(),
  matched: z.boolean(),
  film: filmOut.optional(),
  candidates: z.array(filmOut).optional(),
  final_night: z.string().nullable().optional(),
  is_last_night: z.boolean().optional(),
  showtime_count: z.number().optional(),
  showtimes: z.array(screeningOut).optional(),
});

export const planOut = z.object({
  ...baseOut,
  window: z.string(),
  nights: z.array(z.string()),
  party_size: z.number().nullable(),
  note: z.string().nullable(),
  discounts_relaxed: z.boolean(),
  plan_count: z.number(),
  plans: z.array(
    loose({
      is_wildcard: z.boolean(),
      score: z.number(),
      why: z.array(z.string()),
      film: filmOut.nullable(),
      showtime: screeningOut,
    }),
  ),
  wildcard: loose({ why: z.array(z.string()), showtime: screeningOut }).nullable(),
});

export const discountsOut = z.object({
  ...baseOut,
  today_dow: z.number(),
  today_name: z.string(),
  applies_today_count: z.number(),
  venues: z.array(
    venueOut.extend({
      discounts: z.array(
        loose({
          label: z.string(),
          kind: z.string(),
          day: z.number().nullable(),
          detail: z.string(),
          applies_today: z.boolean(),
        }),
      ),
    }),
  ),
});

export const comingOut = z.object({
  ...baseOut,
  horizon_days: z.number(),
  film_count: z.number(),
  films: z.array(filmOut.extend({ first_night: z.string(), opening_venues: z.array(z.string()) })),
});

export const nowOut = z.object({
  ...baseOut,
  night_of: z.string(),
  is_tonight: z.boolean(),
  screenings_tonight: z.number(),
  still_to_come: z.number(),
  next_curtains: z.array(screeningOut.extend({ film: filmOut.nullable() })),
  sources: loose({ healthy: z.number(), total: z.number() }),
});

/** The published shape of the accuracy record. Loose where the record may
 *  grow, exact on the numbers a caller would quote. */
export const accuracyOutput = z.object({
  data_as_of: z.string(),
  attribution: z.string(),
  site: loose({
    checks: z.number(),
    confirmed: z.number(),
    missing: z.number(),
    unreachable: z.number(),
    pass_rate: z.number().nullable(),
    window_days: z.number(),
    pass_rate_basis: z.string(),
    screenings: z.number(),
    confidence_mix: z.record(z.string(), z.number()),
  }),
  venues: z.array(
    loose({
      venue_id: z.string(),
      name: z.string(),
      source_tier: z.string().nullable(),
      screenings: z.number(),
      confidence_mix: z.record(z.string(), z.number()),
      last_verified_at: z.string().nullable(),
      checks: z.number(),
      pass_rate: z.number().nullable(),
    }),
  ),
  method: loose({
    rings: z.array(z.string()),
    confidence_levels: z.record(z.string(), z.string()),
  }),
  docs: z.string(),
});
