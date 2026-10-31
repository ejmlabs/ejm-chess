import { env } from 'cloudflare:workers';
import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { RULES_VERSION } from '../src/shared/protocol';
import { reserveMonthlyWork } from '../src/server/budget';
import type { DrillEnv } from '../src/server/recovery-drill-controls';

const drillEnv = env as typeof env & DrillEnv;

interface FixtureStatus {
  game: { terminalAck: string | null; pendingDelivery: boolean; archived: boolean };
  projection: { status: string; settlement: string; projection_epoch: number; ended_at: number; storage_state: string | null };
  authority: { watermarks: { results: number; ratings: number }; publishedEpochs: { blitz: number } };
}

/** Rows only. A D1 result also carries per-call timings that never repeat. */
async function controlRows() {
  return (await env.DB.prepare('SELECT * FROM operations_control').all()).results;
}

async function operation(body: Record<string, unknown>) {
  return SELF.fetch('https://isolated.example/drill', { method: 'POST', headers: { 'Content-Type': 'application/json',
    Authorization: 'Bearer local-test-private-recovery-token-at-least-32-bytes' }, body: JSON.stringify(body) });
}

it('isolates synthetic active and ranked delivery fixtures without using production bindings or provider restore', async () => {
  const gameId = crypto.randomUUID();
  const seeded = await operation({ operation: 'seed', gameId, rated: true });
  expect(seeded.status, await seeded.clone().text()).toBe(200);
  const start = await seeded.json<{ status: string; version: number; deadline: number }>();
  expect(start.status).toBe('active');
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM active_game_seats WHERE game_id=? AND released_at IS NULL').bind(gameId).first('count')).toBe(2);
  const control = await controlRows();
  const budget = await (await operation({ operation: 'reserve-budget', gameId })).json<{ accepted: boolean; receipt: unknown }>();
  expect(budget.accepted).toBe(true);
  const budgetRetry = await (await operation({ operation: 'reserve-budget', gameId })).json<typeof budget>();
  expect(budgetRetry.receipt).toEqual(budget.receipt);
  expect(await controlRows()).toEqual(control);
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM budget_receipts WHERE kind=? AND id=?').bind('games', `recovery:${gameId}`).first('count')).toBe(1);
  // Accepted work remains recognized when the real deployment stop is used again.
  expect(await reserveMonthlyWork(env, 'games', `recovery:${gameId}`)).toBe(true);
  expect(await reserveMonthlyWork(env, 'games', `recovery:unaccepted:${gameId}`)).toBe(false);
  const deniedRestore = await operation({ operation: 'prepare-restore', gameId, kind: 'Game', manifest: {} });
  expect(deniedRestore.status).toBe(409);
  expect((await deniedRestore.json<{ error: string }>()).error).toBe('DRILL_MANIFEST_UNAPPROVED');
  const command = { type: 'move', id: crypto.randomUUID(), expectedVersion: start.version, from: 'e2', to: 'e4' };
  const accepted = await operation({ operation: 'command', gameId, color: 'w', command });
  const move = await accepted.json<{ ok: boolean; receipt: unknown; snapshot: { version: number; clocks: { deadline: number } } }>();
  expect(move.ok).toBe(true);
  const captured = await operation({ operation: 'capture', gameId, d1Bookmark: 'local-placeholder-not-provider-evidence' });
  const capture = await captured.json<{ error?: string; probeBoundary?: unknown; points?: { game: { policies: { rules: string }; metadata: { version: number } } } }>();
  // workerd's native local APIs may not implement PITR. An explicit failure is required.
  if (captured.status === 503) expect(capture.error).toBe('RECOVERY_CAPTURE_UNAVAILABLE');
  else {
    expect(captured.status).toBe(200);
    expect(capture.points?.game.metadata.version).toBe(move.snapshot.version);
    expect(capture.points?.game.policies.rules).toBe(RULES_VERSION);
    expect(capture.probeBoundary).toEqual({ schema: 'ejm-chess-drill-probes-v1', d1: 'original', game: 'original', competition: 'original' });
  }
  const retried = await operation({ operation: 'command', gameId, color: 'w', command });
  const retry = await retried.json<{ ok: boolean; receipt: unknown; snapshot: { version: number; clocks: { deadline: number } } }>();
  expect(retry.ok).toBe(true);
  expect(retry.receipt).toEqual(move.receipt);
  expect(retry.snapshot.clocks.deadline).toBe(move.snapshot.clocks.deadline);
  const changed = await operation({ operation: 'change-probes', gameId });
  expect(changed.status).toBe(200);
  expect(await (await operation({ operation: 'probes', gameId })).json()).toEqual({ d1: 'changed', game: 'changed', competition: 'changed' });
  // A persisted armed marker must prevent a reset from concealing an unverified restore.
  const guardId = `local-reset-guard-${gameId}`;
  await env.DB.prepare("INSERT INTO recovery_drill_restores(object_id,manifest_digest,receipt,armed) VALUES(?,'local-guard','{}',1)").bind(guardId).run();
  try {
    const blocked = await operation({ operation: 'reset-probes', gameId });
    expect(blocked.status).toBe(409);
    expect((await blocked.json<{ error: string }>()).error).toBe('DRILL_RESTORE_ARMED');
    for (const mutation of [
      { operation: 'reserve-budget' }, { operation: 'terminal-ack', action: 'arm' },
      { operation: 'terminal-ack', action: 'release' }, { operation: 'correction', action: 'restrict' },
      { operation: 'correction', action: 'clear' }, { operation: 'retire-aged' },
      { operation: 'privacy', action: 'prepare' },
    ]) {
      const response = await operation({ ...mutation, gameId });
      expect(response.status).toBe(409);
      expect((await response.json<{ error: string }>()).error).toBe('DRILL_RESTORE_ARMED');
    }
    expect(await (await operation({ operation: 'probes', gameId })).json()).toEqual({ d1: 'changed', game: 'changed', competition: 'changed' });
  } finally {
    await env.DB.prepare('DELETE FROM recovery_drill_restores WHERE object_id=?').bind(guardId).run();
  }
  const reset = await operation({ operation: 'reset-probes', gameId });
  expect(reset.status).toBe(200);
  expect(await (await operation({ operation: 'probes', gameId })).json()).toEqual({ d1: 'original', game: 'original', competition: 'original' });
  const afterReset = await (await operation({ operation: 'command', gameId, color: 'w', command })).json<typeof move>();
  expect(afterReset.ok).toBe(true);
  expect(afterReset.receipt).toEqual(move.receipt);
  expect(afterReset.snapshot.version).toBe(move.snapshot.version);
  expect(afterReset.snapshot.clocks.deadline).toBe(move.snapshot.clocks.deadline);
  const resigned = await operation({ operation: 'command', gameId, color: 'b', command: { type: 'resign', id: crypto.randomUUID(), expectedVersion: retry.snapshot.version } });
  expect((await resigned.json<{ ok: boolean }>()).ok).toBe(true);
  const delivery = await operation({ operation: 'flush', gameId });
  expect(delivery.status, await delivery.clone().text()).toBe(200);
  await operation({ operation: 'flush', gameId });
  const game = await env.DB.prepare('SELECT status,settlement FROM games WHERE id=?').bind(gameId).first();
  expect(game).toEqual({ status: 'finished', settlement: 'settled' });
  const seats = await env.DB.prepare('SELECT COUNT(*) AS count FROM active_game_seats WHERE game_id=? AND released_at IS NULL').bind(gameId).first<{ count: number }>();
  expect(seats?.count).toBe(0);
  const settled = await (await operation({ operation: 'fixture-status', gameId })).json<FixtureStatus>();
  expect(settled.authority.watermarks.ratings).toBeGreaterThan(0);
  expect(settled.game.pendingDelivery).toBe(false);
  let expectedEpoch = settled.authority.publishedEpochs.blitz;
  for (const [action, voided] of [['restrict', 1], ['clear', 0]] as const) {
    let complete = false;
    for (let step = 0; step < 16 && !complete; step++) {
      const correction = await operation({ operation: 'correction', gameId, action });
      expect(correction.status, await correction.clone().text()).toBe(200);
      complete = (await correction.json<{ status: { complete: boolean } }>()).status.complete;
    }
    expect(complete).toBe(true);
    expect(await env.DB.prepare('SELECT rating_voided FROM games WHERE id=?').bind(gameId).first('rating_voided')).toBe(voided);
    const corrected = await (await operation({ operation: 'fixture-status', gameId })).json<FixtureStatus>();
    expect(corrected.authority.watermarks).toMatchObject({ results: settled.authority.watermarks.results, ratings: settled.authority.watermarks.ratings });
    expect(corrected.authority.publishedEpochs.blitz).toBe(++expectedEpoch);
    expect(corrected.projection.projection_epoch).toBe(corrected.authority.publishedEpochs.blitz);
  }
});

it('reapplies a preserved synthetic account closure after local D1 boundary reconstruction while its Competition fence stays current', async () => {
  const gameId = crypto.randomUUID();
  const userId = `recovery-${gameId}-w`;
  const privacy = (action: string, fields: Record<string, unknown> = {}) => operation({ operation: 'privacy', gameId, action, ...fields });
  const seeded = await operation({ operation: 'seed', gameId, rated: true });
  expect(seeded.status).toBe(200);
  expect((await privacy('prepare')).status).toBe(409);
  const start = await seeded.json<{ version: number }>();
  expect((await (await operation({ operation: 'command', gameId, color: 'b', command: {
    type: 'resign', id: crypto.randomUUID(), expectedVersion: start.version,
  } })).json<{ ok: boolean }>()).ok).toBe(true);
  expect((await operation({ operation: 'flush', gameId })).status).toBe(200);
  const prepared = await privacy('prepare');
  expect(prepared.status, await prepared.clone().text()).toBe(200);
  expect(prepared.headers.has('Set-Cookie')).toBe(false);
  expect(await prepared.json()).toMatchObject({ prepared: true, exported: { profile: 1, games: 1, recoveryEmail: null },
    checks: { identityRetained: true, historyRetained: true, watermarksRetained: true, noRecoveryEmail: true, oldCookieDenied: false } });
  for (const fields of [{ userId: 'real-account-id' }, { email: 'real@example.test' }, { password: 'untrusted-password' }]) {
    expect((await privacy('prepare', fields)).status).toBe(400);
  }
  expect((await privacy('close')).status).toBe(409);
  // A synthetic orphan reset record makes deletion and post-restore deletion non-vacuous.
  const reset = { id: `privacy-reset-${gameId}`, identifier: `privacy-reset-${gameId}`, value: userId,
    expiresAt: new Date(Date.now() + 900_000).toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await env.DB.prepare('INSERT INTO verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
    .bind(reset.id, reset.identifier, reset.value, reset.expiresAt, reset.createdAt, reset.updatedAt).run();
  const profile = (await env.DB.prepare('SELECT * FROM user WHERE id=?').bind(userId).first())!;
  const credentials = (await env.DB.prepare('SELECT * FROM account WHERE userId=?').bind(userId).all()).results;
  const sessions = (await env.DB.prepare('SELECT * FROM session WHERE userId=?').bind(userId).all()).results;
  const history = await env.DB.prepare('SELECT * FROM games WHERE id=?').bind(gameId).first();
  const control = await controlRows();
  const boundary = await privacy('boundary', { d1Bookmark: 'local-only-boundary-not-native-provider-evidence' });
  expect(boundary.status).toBe(200);
  expect(await boundary.json()).toMatchObject({ boundary: { gameId, sourceRevision: drillEnv.RECOVERY_SOURCE_REVISION,
    d1: { bookmark: 'local-only-boundary-not-native-provider-evidence' } } });
  interface Closed {
    receipt: { requestId: string; userId: string; policyVersion: string; completedAt: number };
    checks: { counts: { credentials: number; sessions: number; resets: number; receipts: number }; closedFence: boolean;
      identityRetained: boolean; historyRetained: boolean; watermarksRetained: boolean; profileMinimized: boolean; oldCookieDenied: boolean; signInDenied: boolean };
  }
  const closedResponse = await privacy('close');
  expect(closedResponse.status, await closedResponse.clone().text()).toBe(200);
  const closedText = await closedResponse.text();
  const closed = JSON.parse(closedText) as Closed;
  expect(closed).toMatchObject({ receipt: { userId, policyVersion: 'account-2026-10-v1' }, checks: {
    counts: { credentials: 0, sessions: 0, resets: 0, receipts: 1 }, closedFence: true, profileMinimized: true, oldCookieDenied: true, signInDenied: true,
    identityRetained: true, historyRetained: true, watermarksRetained: true,
  } });
  for (const secret of [drillEnv.RECOVERY_DRILL_TOKEN, credentials[0].password, ...sessions.map(row => row.token)]) expect(closedText).not.toContain(String(secret));
  expect((await privacy('reapply', { receipt: closed.receipt })).status).toBe(409);
  expect((await privacy('reapply', { receipt: { ...closed.receipt, completedAt: closed.receipt.completedAt - 1 }, privateReceiptSaved: true })).status).toBe(409);
  // Local workerd supplies no native D1 PITR API. Reconstruct only this private
  // fixture's earlier D1 rows to exercise reapplication, never as provider proof.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM account_closure_receipts WHERE user_id=?').bind(userId),
    env.DB.prepare('UPDATE user SET name=?,email=?,emailVerified=?,image=?,isAnonymous=?,username=?,updatedAt=? WHERE id=?')
      .bind(profile.name, profile.email, profile.emailVerified, profile.image, profile.isAnonymous, profile.username, profile.updatedAt, userId),
    ...credentials.map(row => env.DB.prepare('INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)')
      .bind(row.id, row.accountId, row.providerId, row.userId, row.password, row.createdAt, row.updatedAt)),
    ...sessions.map(row => env.DB.prepare('INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt,ipAddress,userAgent) VALUES(?,?,?,?,?,?,?,?)')
      .bind(row.id, row.userId, row.token, row.expiresAt, row.createdAt, row.updatedAt, row.ipAddress, row.userAgent)),
    env.DB.prepare('INSERT INTO verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
      .bind(reset.id, reset.identifier, reset.value, reset.expiresAt, reset.createdAt, reset.updatedAt),
  ]);
  const restored = await privacy('status');
  expect(restored.status).toBe(200);
  expect(await restored.json()).toMatchObject({ checks: { counts: { credentials: 1, sessions: sessions.length, resets: 1, receipts: 0 },
    closedFence: true, oldCookieDenied: false, signInDenied: null } });
  await env.DB.prepare('UPDATE games SET pgn=? WHERE id=?').bind('changed local fixture', gameId).run();
  expect((await privacy('reapply', { receipt: closed.receipt, privateReceiptSaved: true })).status).toBe(409);
  await env.DB.prepare('UPDATE games SET pgn=? WHERE id=?').bind(history!.pgn, gameId).run();
  for (let retry = 0; retry < 2; retry++) {
    const response = await privacy('reapply', { receipt: closed.receipt, privateReceiptSaved: true });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual(closed);
  }
  expect(await env.DB.prepare('SELECT * FROM games WHERE id=?').bind(gameId).first()).toEqual(history);
  expect(await controlRows()).toEqual(control);
  expect(env.RANKED_ENABLED).toBe('false');
  expect(env.NEW_WORK_STOPPED).toBe('true');
});

it('holds a real accepted terminal result until explicit release and keeps a fresh casual payload retained', async () => {
  const gameId = crypto.randomUUID();
  const seeded = await operation({ operation: 'seed', gameId });
  expect(seeded.status, await seeded.clone().text()).toBe(200);
  const start = await seeded.json<{ version: number }>();
  expect((await operation({ operation: 'terminal-ack', gameId, action: 'arm' })).status).toBe(200);
  const command = { type: 'resign', id: crypto.randomUUID(), expectedVersion: start.version };
  expect((await (await operation({ operation: 'command', gameId, color: 'b', command })).json<{ ok: boolean }>()).ok).toBe(true);
  expect((await operation({ operation: 'flush', gameId })).status).toBe(200);
  const held = await (await operation({ operation: 'fixture-status', gameId })).json<FixtureStatus>();
  expect(held.game).toMatchObject({ terminalAck: 'held', pendingDelivery: true, archived: false });
  expect(held.projection).toMatchObject({ status: 'finished', settlement: 'unrated', storage_state: 'retained' });
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM active_game_seats WHERE game_id=? AND released_at IS NULL').bind(gameId).first('count')).toBe(2);
  const released = await operation({ operation: 'terminal-ack', gameId, action: 'release' });
  expect(released.status, await released.clone().text()).toBe(200);
  const duplicate = await operation({ operation: 'terminal-ack', gameId, action: 'release' });
  expect(duplicate.status).toBe(200);
  const final = await (await operation({ operation: 'fixture-status', gameId })).json<FixtureStatus>();
  expect(final.game).toMatchObject({ terminalAck: 'released', pendingDelivery: false, archived: false });
  expect(final.authority.watermarks).toEqual(held.authority.watermarks);
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM active_game_seats WHERE game_id=? AND released_at IS NULL').bind(gameId).first('count')).toBe(0);
  const reuse = await operation({ operation: 'seed', gameId });
  expect(reuse.status).toBe(409);
  expect((await reuse.json<{ error: string }>()).error).toBe('DRILL_SEED_CONFLICT');
  const freshRetirement = await operation({ operation: 'retire-aged', gameId, now: Date.now() + 86_400_000 });
  expect(freshRetirement.status).toBe(200);
  expect((await freshRetirement.json<{ retirement: { completed: number }; game: { archived: boolean } }>()))
    .toMatchObject({ retirement: { completed: 0 }, game: { archived: false } });
  const retained = await env.DB.prepare('SELECT ended_at,terminal_digest FROM games WHERE id=?').bind(gameId).first();
  expect(retained?.ended_at).toBe(final.projection.ended_at);
  expect(retained?.terminal_digest).toBeTruthy();
  // Natural one-hour retirement, native restore and tombstone ID-reuse refusal remain provider gates.
});
