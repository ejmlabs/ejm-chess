import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CapacityAccountFixtures } from '../src/server/capacity-fixtures';
import { CapacityNativeMeter } from '../src/server/capacity-meter';
import { capacityAccountId } from '../src/shared/capacity-corpus';
import { hasRecoveryEmail } from '../src/server/auth';
import { capacityFixtureManifest } from './capacity-fixtures';
import { capacityReadEvidence, explainCapacityReads } from './capacity-read-evidence';

describe('fixed native capacity account fixtures', () => {
  it('reuses primary sessions with two read-only auth queries and enforces signed ownership', async ({ task }) => {
    const stub = env.COMPETITION.get(env.COMPETITION.idFromName(`capacity-accounts-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_object, state) => {
      const manifest = capacityFixtureManifest(Date.now() - 1_000);
      const meter = new CapacityNativeMeter(), evidence = capacityReadEvidence(env.DB);
      const fixtures = new CapacityAccountFixtures(meter.d1(evidence.db), state.storage.sql, { AUTH_SECRET: env.AUTH_SECRET }, manifest);
      const prepared = await fixtures.prepare(0);
      const request = (cookie?: string) => new Request(`https://${manifest.host}/capacity/step/0`, { headers: cookie ? { Cookie: cookie } : {} });
      const before = meter.snapshot();
      const readStart = evidence.reads.length;
      const actor = await fixtures.authenticate(request(prepared.cookie), 0);
      const after = meter.snapshot();
      expect(after.d1Statements - before.d1Statements).toBe(2);
      expect(after.d1RowsWritten - before.d1RowsWritten).toBe(0);
      expect(after.unresolvedD1).toBe(0);
      expect(after.uncertain).toBe(false);
      expect(after.d1RowsRead - before.d1RowsRead).toBeLessThanOrEqual(8);
      (task.meta as Record<string, unknown>).qualification = { kind: 'warm-primary-auth-read-bound', runtime: 'native local Worker',
        statements: after.d1Statements - before.d1Statements, rowsRead: after.d1RowsRead - before.d1RowsRead,
        rowsWritten: after.d1RowsWritten - before.d1RowsWritten,
        queries: await explainCapacityReads(evidence.reads.slice(readStart)) };
      expect(actor.id).toBe(capacityAccountId(0));
      expect(actor.accountReady).toBe(true);
      expect(actor.isAnonymous).toBe(false);
      expect(hasRecoveryEmail(actor.email)).toBe(false);
      expect(actor.sessionExpiresAt).toBe(manifest.hardCloseAt);
      expect((await fixtures.prepare(0)).cookie === prepared.cookie).toBe(true);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM session WHERE userId=?').bind(actor.id).first<{ count: number }>())?.count).toBe(1);
      await expect(fixtures.authenticate(request(), 0)).rejects.toThrow('capacity_session_invalid');
      await expect(fixtures.authenticate(request(prepared.cookie), 1)).rejects.toThrow('capacity_session_invalid');
      await expect(fixtures.authenticate(request(prepared.cookie + 'altered'), 0)).rejects.toThrow('capacity_session_invalid');
      await env.DB.prepare("DELETE FROM account WHERE userId=? AND providerId='credential'").bind(actor.id).run();
      await expect(fixtures.authenticate(request(prepared.cookie), 0)).rejects.toThrow('capacity_session_invalid');
    });
  });

  it('does not recreate a revoked primary session or credential', async () => {
    const stub = env.COMPETITION.get(env.COMPETITION.idFromName(`capacity-accounts-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_object, state) => {
      const fixtures = new CapacityAccountFixtures(env.DB, state.storage.sql, env, capacityFixtureManifest(Date.now() - 1_000));
      const prepared = await fixtures.prepare(2);
      await env.DB.prepare('DELETE FROM session WHERE userId=?').bind(capacityAccountId(2)).run();
      await expect(fixtures.authenticate(new Request('https://chess.ejmlabs.com', { headers: { Cookie: prepared.cookie } }), 2))
        .rejects.toThrow('capacity_session_invalid');
      await expect(fixtures.prepare(2)).rejects.toThrow('capacity_fixture_primary_state_unresolved');
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM session WHERE userId=?').bind(capacityAccountId(2)).first<{ count: number }>())?.count).toBe(0);
    });
  });

  it('retains an uncertain fixture intent without another batch or replacement account', async () => {
    const stub = env.COMPETITION.get(env.COMPETITION.idFromName(`capacity-accounts-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_object, state) => {
      let batches = 0;
      const failed = new Proxy(env.DB, { get(target, key) {
        if (key === 'batch') return async () => { batches++; throw new Error('lost-fixture-batch'); };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const manifest = capacityFixtureManifest(Date.now() - 1_000);
      const first = new CapacityAccountFixtures(failed, state.storage.sql, env, manifest);
      await expect(first.prepare(3)).rejects.toThrow('lost-fixture-batch');
      const resumed = new CapacityAccountFixtures(failed, state.storage.sql, env, manifest);
      await expect(resumed.prepare(3)).rejects.toThrow('capacity_fixture_primary_state_unresolved');
      expect(batches).toBe(1);
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM user WHERE id=?').bind(capacityAccountId(3)).first<{ count: number }>())?.count).toBe(0);
    });
  });

  it('recovers the same primary session after a committed batch loses its reply', async () => {
    const stub = env.COMPETITION.get(env.COMPETITION.idFromName(`capacity-accounts-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_object, state) => {
      let batches = 0;
      const lost = new Proxy(env.DB, { get(target, key) {
        if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
          batches++;
          const result = await target.batch(statements);
          if (batches === 1) throw new Error('committed-fixture-reply-lost');
          return result;
        };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const manifest = capacityFixtureManifest(Date.now() - 1_000);
      await expect(new CapacityAccountFixtures(lost, state.storage.sql, env, manifest).prepare(5))
        .rejects.toThrow('committed-fixture-reply-lost');
      const original = await env.DB.prepare('SELECT token FROM session WHERE id=?')
        .bind(`${capacityAccountId(5)}:session`).first<{ token: string }>();
      const resumed = new CapacityAccountFixtures(lost, state.storage.sql, env, manifest);
      const prepared = await resumed.prepare(5);
      const actor = await resumed.authenticate(new Request(`https://${manifest.host}/capacity/step/5`,
        { headers: { Cookie: prepared.cookie } }), 5);
      const retained = await env.DB.prepare('SELECT token FROM session WHERE id=?')
        .bind(actor.sessionId).first<{ token: string }>();
      expect(Boolean(original && retained && original.token === retained.token)).toBe(true);
      for (const table of ['user', 'account', 'session']) {
        const owner = table === 'user' ? 'id' : 'userId';
        expect((await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${owner}=?`)
          .bind(actor.id).first<{ count: number }>())?.count).toBe(1);
      }
      expect(actor.id).toBe(capacityAccountId(5));
      expect(state.storage.sql.exec('SELECT ready FROM capacity_fixture_accounts WHERE account_index=5').one().ready).toBe(1);
    });
  });

  it('rejects setup after its fixed deadline before creating primary records', async () => {
    const stub = env.COMPETITION.get(env.COMPETITION.idFromName(`capacity-accounts-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_object, state) => {
      const fixtures = new CapacityAccountFixtures(env.DB, state.storage.sql, env, capacityFixtureManifest(Date.now() - 601_000));
      await expect(fixtures.prepare(4)).rejects.toThrow('capacity_fixture_expired');
      expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM user WHERE id=?').bind(capacityAccountId(4)).first<{ count: number }>())?.count).toBe(0);
    });
  });
});
