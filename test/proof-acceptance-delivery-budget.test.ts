import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { Game } from '../src/server/game';
import type { Env } from '../src/server/env';
import { ProofAcceptanceBudget } from '../src/server/proof-acceptance-budget';
import { reserveProofAdmission } from '../src/server/proof-budget';
import { PROOF_PROFILE } from '../src/server/proof-contract';
import { player } from './authority-helpers';

describe('private acceptance budget and the product result outbox', () => {
  it('allows the actual finished Game to release its two seats and clear its saved delivery', async () => {
    const [white, black] = await Promise.all([player(), player()]);
    const id = crypto.randomUUID();
    const reservationId = crypto.randomUUID();
    // This fixture replaces only the already tested Competition acknowledgement.
    // Game admission, commands, terminal delivery, D1 and the private meter are real.
    const config = { ...env, RANKED_ENABLED: 'true', NEW_WORK_STOPPED: 'false',
      TIMEOUT_PROOF_PROFILE: PROOF_PROFILE, MONTHLY_PROOF_LIMIT: '1000', PROVER: {},
      COMPETITION: { idFromName: (name: string) => name, get: () => ({
        hasTimeoutProofReservation: async () => true,
        settle: async () => ({ accepted: true, pending: false }),
      }) } } as unknown as Env;
    expect(await reserveProofAdmission(config, id)).toBe(true);
    await env.DB.batch([white, black].map(actor => env.DB.prepare(
      'INSERT INTO active_game_seats(user_id,game_id,acquired_at) VALUES(?,?,?)').bind(actor.id, id, Date.now())));
    const carrier = env.GAME.get(env.GAME.idFromName(id));
    const measured = await runInDurableObject(carrier, async (_instance, state) => {
      const budget = new ProofAcceptanceBudget(state, 'Game');
      const game = new Game(state, { ...config, DB: budget.d1(config.DB) }, budget.context);
      budget.sealBootstrap();
      const initial = await budget.run('init', () => game.init({ id, reservationId, format: 'blitz', rated: true,
        white, black, timeoutProof: { reservationId: id, profileVersion: PROOF_PROFILE } }));
      const first = await budget.run('ready-white', () => game.command(white,
        { type: 'ready', id: crypto.randomUUID(), expectedVersion: initial.version }));
      const second = await budget.run('ready-black', () => game.command(black,
        { type: 'ready', id: crypto.randomUUID(), expectedVersion: first.snapshot.version }));
      expect([first.ok, second.ok]).toEqual([true, true]);
      const resigned = await budget.run('resign', () => game.command(white,
        { type: 'resign', id: crypto.randomUUID(), expectedVersion: second.snapshot.version }));
      expect(resigned.ok).toBe(true);
      await budget.run('flush', () => game.flush());
      const pending = state.storage.sql.exec('SELECT value FROM result_delivery').toArray().length;
      const usage = budget.inspect();
      await state.storage.deleteAlarm();
      return { pending, events: usage.events, closed: usage.closed };
    });
    const seats = (await env.DB.prepare('SELECT released_at FROM active_game_seats WHERE game_id=? ORDER BY user_id')
      .bind(id).all<{ released_at: number | null }>()).results;
    console.log('local-product-delivery-budget', JSON.stringify({
      providerQualification: false, seats, ...measured,
    }));
    expect(seats).toHaveLength(2);
    expect(seats.every(seat => typeof seat.released_at === 'number')).toBe(true);
    expect(measured.pending).toBe(0);
    expect(measured.closed).toBe(0);
  });
});
