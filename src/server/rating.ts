import { Glicko2, type Player } from 'glicko2';
import type { RatingState } from '../shared/protocol';

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const INITIAL = { rating: 1500, rd: 350, vol: 0.06 };

function glicko(): Glicko2 { return new Glicko2({ ...INITIAL, tau: 0.5 }); }

/** Monday-based UTC calendar weeks, persisted so replay uses identical empty periods. */
function utcWeek(now: number): number { return Math.floor((now + 3 * DAY) / WEEK); }

export function initialRating(now: number): RatingState {
  return { ...INITIAL, games: 0, lastPlayedAt: null, inactivityWeek: utcWeek(now), version: 0 };
}

function ratingPlayer(ranking: Glicko2, state: RatingState): Player {
  const player = ranking.makePlayer(state.rating, state.rd, state.vol);
  // The package's constructor treats zero as its default; its public setter preserves an exact zero rating.
  player.setRating(state.rating);
  return player;
}

function inactiveRating(before: RatingState, now: number): RatingState {
  const state = { ...before };
  const lastWholeWeek = utcWeek(now) - 1;
  if (state.lastPlayedAt === null || state.inactivityWeek >= lastWholeWeek) return state;
  const ranking = glicko();
  const player = ratingPlayer(ranking, state);
  while (state.inactivityWeek < lastWholeWeek && state.rd < INITIAL.rd) {
    ranking.updateRatings([]);
    state.rd = Math.min(INITIAL.rd, player.getRd());
    state.inactivityWeek++;
  }
  state.inactivityWeek = lastWholeWeek;
  return state;
}

/** Rates both players from the same pre-game values. Whole inactive weeks only widen uncertainty. */
export function rateMatch(white: RatingState, black: RatingState, score: 0 | 0.5 | 1, now: number): [RatingState, RatingState] {
  const before = [inactiveRating(white, now), inactiveRating(black, now)];
  const ranking = glicko();
  const players = before.map(state => ratingPlayer(ranking, state));
  ranking.updateRatings([[players[0], players[1], score]]);
  return before.map((state, index) => {
    const next: RatingState = {
      rating: players[index].getRating(), rd: Math.min(INITIAL.rd, players[index].getRd()), vol: players[index].getVol(),
      games: state.games + 1, lastPlayedAt: now, inactivityWeek: utcWeek(now), version: state.version + 1,
    };
    if (![next.rating, next.rd, next.vol].every(Number.isFinite) || next.rd <= 0 || next.vol <= 0) throw new Error('invalid_rating_calculation');
    return next;
  }) as [RatingState, RatingState];
}
