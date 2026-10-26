import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CapacityIntentLedger } from '../src/server/capacity-intents';
import { capacityAccountId, capacityEventId } from '../src/shared/capacity-corpus';
import type { ArenaReservation } from '../src/server/arena';
import { capacityFixtureManifest } from './capacity-fixtures';

const manifest = () => capacityFixtureManifest(Date.UTC(2026, 9, 25, 17, 50));

describe('private immutable native intent binding', () => {
  it('retains pending ordinals and binds real seats once across reconstruction', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const result = await runInDurableObject(game, (_instance, state) => {
      const m = manifest();
      const create = () => new CapacityIntentLedger(state.storage.sql, run => state.storage.transactionSync(run), m);
      let ledger = create();
      const before = ledger.reserve(0);
      ledger = create();
      const pending = ledger.binding(0);
      const observation: ArenaReservation = { eventId: capacityEventId(0, m.earliestArmAt),
        gameId: crypto.randomUUID(), reservationId: crypto.randomUUID(),
        whiteId: capacityAccountId(1_500), blackId: capacityAccountId(45), status: 'creating' };
      const bound = ledger.bind(0, observation);
      ledger = create();
      return { before, pending, bound, repeated: ledger.bind(0, { ...observation, status: 'live' }),
        retained: ledger.reserve(0), rows: state.storage.sql.exec('SELECT COUNT(*) AS count FROM capacity_intents').one() };
    });
    expect(result.before.binding).toBeNull();
    expect(result.pending).toBeNull();
    expect(result.bound).toMatchObject({ intentIndex: 0, eventIndex: 0, whiteAccountIndex: 1_500, blackAccountIndex: 45 });
    expect(result.repeated).toEqual(result.bound);
    expect(result.retained.binding).toEqual(result.bound);
    expect(result.rows.count).toBe(1);
  });

  it.each(['game', 'reservation', 'seats'] as const)('fences conflicting %s mappings without selecting a replacement', async conflict => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const result = await runInDurableObject(game, (_instance, state) => {
      const m = manifest();
      const create = () => new CapacityIntentLedger(state.storage.sql, run => state.storage.transactionSync(run), m);
      let ledger = create();
      ledger.reserve(0); ledger.reserve(1);
      const first: ArenaReservation = { eventId: capacityEventId(0, m.earliestArmAt),
        gameId: crypto.randomUUID(), reservationId: crypto.randomUUID(),
        whiteId: capacityAccountId(8), blackId: capacityAccountId(1_008), status: 'allocating' };
      const bound = ledger.bind(0, first);
      const second = { ...first, gameId: conflict === 'game' ? first.gameId : crypto.randomUUID(),
        reservationId: conflict === 'reservation' ? first.reservationId : crypto.randomUUID(),
        whiteId: conflict === 'seats' ? first.blackId : first.whiteId,
        blackId: conflict === 'seats' ? first.whiteId : first.blackId };
      let failure: string | null = null;
      try { ledger.bind(conflict === 'seats' ? 0 : 1, second); }
      catch (error) { failure = (error as Error).message; }
      ledger = create();
      let fenced: string | null = null;
      try { ledger.reserve(2); } catch (error) { fenced = (error as Error).message; }
      return { bound, failure, fenced,
        rows: state.storage.sql.exec('SELECT intent_index,game_id,reservation_id,white_id,black_id FROM capacity_intents ORDER BY intent_index').toArray() };
    });
    expect(result.failure).toBe('capacity_intent_binding_conflict');
    expect(result.fenced).toBe('capacity_intent_ledger_fenced');
    expect(result.rows).toEqual([
      { intent_index: 0, game_id: result.bound.gameId, reservation_id: result.bound.reservationId,
        white_id: result.bound.whiteId, black_id: result.bound.blackId },
      { intent_index: 1, game_id: null, reservation_id: null, white_id: null, black_id: null },
    ]);
  });
});
