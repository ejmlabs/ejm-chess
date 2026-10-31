/** Isolated entry point. No class or restore handler here is exported by index.ts. */
import { hashPassword } from 'better-auth/crypto';
import { createPlaceholderEmail } from '@better-auth/core/utils/email';
import { Competition } from './competition';
import { Game } from './game';
import { isGameId } from '../shared/gamePath';
import type { Actor, GameCommand, GameResult, GameSnapshot } from '../shared/protocol';
import { ApiError, errorResponse, jsonResponse, readJson } from './security';
import { admittedRecoveryGame, recoveryInventory, recoverySha256 } from './recovery';
import { reserveMonthlyWork } from './budget';
import { retireGamePayloads } from './maintenance';
import { acquireSeatGuard, beginIdentityChange, createAuth, currentActor, hasRecoveryEmail } from './auth';
import { applyAccountClosure, closeAccount, exportAccount } from './privacy';
import { ACCOUNT_PRIVACY_POLICY, type AccountClosureReceipt, type AccountExportPage } from '../shared/privacy';
import { assertDrillConfiguration, DRILL_SCHEMA, drillD1Schema, drillManifestProbes, drillResources, drillRestoreArmed,
  prepareDrillRestore, restartDrillObject, type DrillEnv, type DrillManifest } from './recovery-drill-controls';
import { UncertainDrillRestore } from './recovery-drill-controls';

type DrillGameStub = DurableObjectStub<RecoveryDrillGame>;
type DrillCompetitionStub = DurableObjectStub<RecoveryDrillCompetition>;
type ProbeValue = 'original' | 'changed';
interface DrillDelivery { result: GameResult; attempts: number; nextAttemptAt: number }
type AckFault = { mode: 'armed' | 'held' | 'released'; event_id: string | null };
const PRIVACY_SCHEMA = 'ejm-chess-drill-privacy-v1';
type PrivacyAction = 'prepare' | 'boundary' | 'close' | 'status' | 'reapply';
interface PrivacyBaseline {
  userId: string; createdAt: string; historySha256: string;
  authority: { watermarks: Record<string, number>; publishedEpochs: Record<string, number> };
}
interface PrivacyFixture {
  cookie: string; baseline: PrivacyBaseline;
  boundary?: { schema: typeof PRIVACY_SCHEMA; gameId: string; scope: string; sourceRevision: string;
    resources: ReturnType<typeof drillResources>; d1: { bookmark: string; schemaSha256: string } };
  receipt?: AccountClosureReceipt;
}

/** Fresh synthetic credentials only. Rotation requires a new fixture, not credential replacement. */
async function syntheticPassword(env: DrillEnv, gameId: string, color: 'w' | 'b'): Promise<string> {
  return recoverySha256(JSON.stringify(['ejm-chess-drill-credential-v1', env.RECOVERY_DRILL_TOKEN, gameId, color]));
}

async function syntheticUserId(env: Pick<DrillEnv, 'DB'>, gameId: string, color: 'w' | 'b'): Promise<string> {
  const fresh = `recovery-${gameId}-${color}`;
  const rows = await env.DB.prepare('SELECT id FROM user WHERE id IN (?,?) LIMIT 2').bind(fresh, `recovery:${gameId}:${color}`).all<{ id: string }>();
  if (rows.results.length > 1) throw new ApiError(409, 'DRILL_ACCOUNT_AMBIGUOUS', 'Use a fresh synthetic fixture.');
  return rows.results[0]?.id ?? fresh;
}

function privacyRequest(env: DrillEnv, gameId: string, path: string, body?: unknown, cookie = ''): Request {
  return new Request(new URL(path, env.AUTH_BASE_URL), { method: body === undefined ? 'GET' : 'POST', headers: {
    Origin: new URL(env.AUTH_BASE_URL).origin, Cookie: cookie, 'Content-Type': 'application/json',
    'CF-Connecting-IP': `192.0.2.${parseInt(gameId.slice(0, 2), 16) % 254 + 1}`,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

/** RPC preserves this data result even when it cannot preserve custom Error fields. */
async function drillResult<T>(operation: () => Promise<T>) {
  try { return { ok: true as const, value: await operation() }; }
  catch (error) {
    return { ok: false as const, error: { status: error instanceof ApiError ? error.status : 503,
      code: error instanceof ApiError ? error.code : 'DRILL_UNAVAILABLE',
      message: error instanceof ApiError ? error.message : 'The isolated drill operation failed.',
      ...(error instanceof UncertainDrillRestore ? { undoReceipt: error.undoReceipt } : {}) } };
  }
}

function createProbe(ctx: DurableObjectState): void {
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS recovery_drill_probe(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)');
  ctx.storage.sql.exec("INSERT OR IGNORE INTO recovery_drill_probe(id,value) VALUES(1,'original')");
}
function probe(ctx: DurableObjectState): ProbeValue {
  const value = ctx.storage.sql.exec<{ value: string }>('SELECT value FROM recovery_drill_probe WHERE id=1').one().value;
  if (value !== 'original' && value !== 'changed') throw new Error('drill_probe_invalid');
  return value;
}
async function setProbe(ctx: DurableObjectState, value: 'original' | 'changed'): Promise<void> {
  ctx.storage.sql.exec('UPDATE recovery_drill_probe SET value=? WHERE id=1', value);
  await ctx.storage.sync();
}

export class RecoveryDrillGame extends Game {
  protected override recoveryDrill = true;
  private holdingAck = false;
  constructor(ctx: DurableObjectState, env: DrillEnv) {
    // Synthetic fixtures can exercise ranked receipts. No public route admits work.
    super(ctx, { ...env, RANKED_ENABLED: 'true' });
    createProbe(ctx);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS recovery_drill_ack(id INTEGER PRIMARY KEY CHECK(id=1),mode TEXT NOT NULL,event_id TEXT)');
  }
  async readDrillProbe() { return probe(this.ctx); }
  async setDrillProbe(value: 'original' | 'changed') { await setProbe(this.ctx, value); }
  async captureDrillPoint(gameId: string) { return drillResult(() => super.captureRecoveryPoint(gameId)); }
  async prepareRecoveryRestore(manifest: DrillManifest) {
    return drillResult(() => prepareDrillRestore(this.ctx, { ...this.env, RANKED_ENABLED: 'false' } as DrillEnv, 'Game', manifest));
  }
  async restartRecovery(input: { manifestSha256: string; undoBookmark: string; privateReceiptSaved: boolean }) {
    return restartDrillObject(this.ctx, { ...this.env, RANKED_ENABLED: 'false' } as DrillEnv, input);
  }
  async terminalAckFault(operation: 'arm' | 'release') {
    const prior = this.ctx.storage.sql.exec<AckFault>('SELECT mode,event_id FROM recovery_drill_ack WHERE id=1').toArray()[0];
    if (operation === 'arm') {
      const state = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM game_state WHERE id=1').toArray()[0];
      if (!state || JSON.parse(state.value).status !== 'active' || prior?.mode === 'held' || prior?.mode === 'released') {
        throw new ApiError(409, 'DRILL_ACK_NOT_READY', 'Arm a new active synthetic game before its terminal command.');
      }
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO recovery_drill_ack(id,mode,event_id) VALUES(1,'armed',NULL)");
      await this.ctx.storage.sync();
    } else {
      if (!prior || !['held', 'released'].includes(prior.mode) || !prior.event_id) {
        throw new ApiError(409, 'DRILL_ACK_NOT_HELD', 'A real accepted terminal result must be held before release.');
      }
      this.ctx.storage.sql.exec("UPDATE recovery_drill_ack SET mode='released' WHERE id=1");
      await this.ctx.storage.sync();
      await this.flush();
    }
    return this.drillFixtureStatus();
  }
  async drillFixtureStatus() {
    const fault = this.ctx.storage.sql.exec<AckFault>('SELECT mode,event_id FROM recovery_drill_ack WHERE id=1').toArray()[0];
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM game_state WHERE id=1').toArray()[0];
    const state = row ? JSON.parse(row.value) as { status: GameSnapshot['status']; rated: boolean } : null;
    return { terminalAck: fault?.mode ?? null, acceptedEventId: fault?.event_id ?? null,
      status: state?.status ?? null, rated: state?.rated ?? null,
      pendingDelivery: Boolean(this.ctx.storage.sql.exec('SELECT 1 FROM result_delivery WHERE id=1').toArray()[0]),
      archived: Boolean(this.ctx.storage.sql.exec('SELECT 1 FROM archived_game WHERE id=1').toArray()[0]) };
  }
  override async status() {
    const status = await super.status();
    if (this.ctx.storage.sql.exec<AckFault>('SELECT mode,event_id FROM recovery_drill_ack WHERE id=1').toArray()[0]?.mode === 'held') {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.sync();
    }
    return status;
  }
  override async flush(): Promise<void> {
    const fault = this.ctx.storage.sql.exec<AckFault>('SELECT mode,event_id FROM recovery_drill_ack WHERE id=1').toArray()[0];
    if (fault?.mode === 'held' || this.holdingAck) return;
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM result_delivery WHERE id=1').toArray()[0];
    const delivery = row ? JSON.parse(row.value) as DrillDelivery : null;
    if (fault?.mode !== 'armed' || delivery?.result.status !== 'finished') return super.flush();
    this.holdingAck = true;
    try {
      // Accept through the real authority, then simulate losing its reply before Game consumes it.
      const accepted = await this.env.COMPETITION.get(this.env.COMPETITION.idFromName('global')).settle(delivery.result);
      if (!accepted.accepted || accepted.pending) throw new Error('drill_terminal_not_settled');
      this.ctx.storage.sql.exec("UPDATE recovery_drill_ack SET mode='held',event_id=? WHERE id=1 AND mode='armed'", delivery.result.eventId);
      // Only the synthetic terminal retry is paused. Its stored outbox and arrival times stay exact.
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.sync();
    } finally { this.holdingAck = false; }
  }
  override async alarm() {
    const held = this.ctx.storage.sql.exec<AckFault>('SELECT mode,event_id FROM recovery_drill_ack WHERE id=1').toArray()[0]?.mode === 'held';
    if (!held && !await drillRestoreArmed(this.env.DB)) await super.alarm();
  }
}

export class RecoveryDrillCompetition extends Competition {
  protected override recoveryDrill = true;
  private privacyWorking = false;
  constructor(ctx: DurableObjectState, env: DrillEnv) {
    super(ctx, { ...env, RANKED_ENABLED: 'true' });
    createProbe(ctx);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS recovery_drill_analysis_omissions(id TEXT PRIMARY KEY,game_id TEXT NOT NULL,recorded_at INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS recovery_drill_privacy(game_id TEXT PRIMARY KEY,value TEXT NOT NULL)');
  }
  private privacyRecord(gameId: string): PrivacyFixture | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM recovery_drill_privacy WHERE game_id=?', gameId).toArray()[0];
    return row ? JSON.parse(row.value) as PrivacyFixture : null;
  }
  private async savePrivacy(gameId: string, value: PrivacyFixture): Promise<void> {
    const encoded = JSON.stringify(value);
    if (new TextEncoder().encode(encoded).byteLength > 16_384) throw new ApiError(409, 'DRILL_PRIVACY_LIMIT', 'The private fixture exceeds its record bound.');
    this.ctx.storage.sql.exec(`INSERT INTO recovery_drill_privacy(game_id,value) VALUES(?,?)
      ON CONFLICT(game_id) DO UPDATE SET value=excluded.value`, gameId, encoded);
    await this.ctx.storage.sync();
  }
  private privacyFence(userId: string) {
    return this.ctx.storage.sql.exec<{ request_id: string; state: string }>(
      'SELECT request_id,state FROM account_closure_fences WHERE user_id=?', userId).toArray()[0];
  }
  private async privacyBaseline(gameId: string): Promise<PrivacyBaseline> {
    const userId = await syntheticUserId(this.env, gameId, 'w');
    const profile = await this.env.DB.prepare('SELECT createdAt FROM user WHERE id=?').bind(userId).first<{ createdAt: string }>();
    const history = await this.env.DB.prepare(`SELECT id,white_id,black_id,white_name,black_name,pgn,status,rated,rules_version,
      terminal_digest,settlement,rating_voided,result_version,projection_epoch,projection_version FROM games
      WHERE id=? AND white_id=? AND status='finished'`).bind(gameId, userId).first();
    const game = await (this.env.GAME.get(this.env.GAME.idFromName(gameId)) as DrillGameStub).drillFixtureStatus();
    if (!profile || !history || !['settled', 'unrated'].includes(String(history.settlement)) || game.pendingDelivery) {
      throw new ApiError(409, 'DRILL_PRIVACY_NOT_READY', 'Finish and drain this synthetic game before its privacy fixture.');
    }
    const { watermarks, publishedEpochs } = await super.beginExport();
    return { userId, createdAt: profile.createdAt, historySha256: await recoverySha256(JSON.stringify(history)),
      authority: { watermarks, publishedEpochs } };
  }
  private async privacyChecks(gameId: string, fixture: PrivacyFixture, env: DrillEnv, checkSignIn = false) {
    const userId = fixture.baseline.userId;
    const current = await this.privacyBaseline(gameId);
    const counts = (await env.DB.prepare(`SELECT (SELECT COUNT(*) FROM account WHERE userId=?) AS credentials,
      (SELECT COUNT(*) FROM session WHERE userId=?) AS sessions,(SELECT COUNT(*) FROM verification WHERE value=?) AS resets,
      (SELECT COUNT(*) FROM account_closure_receipts WHERE user_id=?) AS receipts`).bind(userId, userId, userId, userId)
      .first<{ credentials: number; sessions: number; resets: number; receipts: number }>())!;
    const profile = (await env.DB.prepare('SELECT name,username,email,emailVerified,image,isAnonymous FROM user WHERE id=?').bind(userId)
      .first<{ name: string; username: string | null; email: string; emailVerified: number; image: string | null; isAnonymous: number }>())!;
    const fence = this.privacyFence(userId);
    let signInDenied: boolean | null = null;
    if (checkSignIn && counts.credentials === 0 && counts.sessions === 0 && counts.receipts === 1) {
      const result = await createAuth(env).handler(privacyRequest(env, gameId, '/api/auth/sign-in/username', {
        username: `r${gameId.replaceAll('-', '').slice(0, 21)}w`, password: await syntheticPassword(env, gameId, 'w'),
      }));
      signInDenied = result.status === 401;
    }
    return { schema: PRIVACY_SCHEMA, gameId, counts,
      identityRetained: current.userId === fixture.baseline.userId && current.createdAt === fixture.baseline.createdAt,
      historyRetained: current.historySha256 === fixture.baseline.historySha256,
      watermarksRetained: JSON.stringify(current.authority) === JSON.stringify(fixture.baseline.authority),
      noRecoveryEmail: !hasRecoveryEmail(profile.email),
      profileMinimized: profile.name === 'Closed account' && profile.username === null && profile.image === null
        && profile.emailVerified === 0 && profile.isAnonymous === 0
        && profile.email === createPlaceholderEmail({ identifier: userId, namespace: 'closed-chess' }),
      closedFence: fence?.state === 'closed' && fence.request_id === fixture.receipt?.requestId,
      oldCookieDenied: !await currentActor(privacyRequest(env, gameId, '/api/me', undefined, fixture.cookie), env), signInDenied };
  }
  /** Only /drill can call this adapter. Its stored cookie never leaves this object. */
  async privacyFixture(gameId: string, action: PrivacyAction, input: { d1Bookmark?: string; receipt?: AccountClosureReceipt; privateReceiptSaved?: boolean }) {
    return drillResult(async () => {
      const env = { ...this.env, RANKED_ENABLED: 'false' } as DrillEnv;
      assertDrillConfiguration(env);
      if (!isGameId(gameId) || this.privacyWorking) throw new ApiError(409, 'DRILL_PRIVACY_BUSY', 'Use one admitted synthetic privacy fixture at a time.');
      this.privacyWorking = true;
      try {
        // Internal Better Auth requests use the canonical URL but make no HTTP call.
        env.AUTH_SECRET = await recoverySha256(JSON.stringify(['ejm-chess-drill-auth-v1', env.RECOVERY_DRILL_TOKEN]));
        let fixture = this.privacyRecord(gameId);
        if (action === 'prepare') {
          if (fixture) return { prepared: true, checks: await this.privacyChecks(gameId, fixture, env) };
          if (this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM recovery_drill_privacy').one().count >= 8) {
            throw new ApiError(409, 'DRILL_PRIVACY_LIMIT', 'The private drill allows eight privacy fixtures.');
          }
          const baseline = await this.privacyBaseline(gameId);
          if (this.privacyFence(baseline.userId)) throw new ApiError(409, 'DRILL_PRIVACY_CLOSED', 'Use a fresh synthetic account.');
          const password = await syntheticPassword(env, gameId, 'w');
          const signedIn = await createAuth(env).handler(privacyRequest(env, gameId, '/api/auth/sign-in/username', {
            username: `r${gameId.replaceAll('-', '').slice(0, 21)}w`, password,
          }));
          if (!signedIn.ok) throw new ApiError(409, 'DRILL_PRIVACY_CREDENTIAL', 'Use a fresh fixture from this reviewed source and unchanged private token.');
          const cookie = signedIn.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
          const actor = await currentActor(privacyRequest(env, gameId, '/api/me', undefined, cookie), env);
          if (!actor || actor.id !== baseline.userId || hasRecoveryEmail(actor.email)) throw new ApiError(409, 'DRILL_PRIVACY_ACCOUNT', 'Use the existing no-email synthetic white account.');
          for (const category of ['profile', 'games'] as const) {
            const response = await exportAccount(privacyRequest(env, gameId, '/api/account/export', { password, category }, cookie), env, actor);
            const page = await response.json() as AccountExportPage;
            if (page.records.length !== 1 || (category === 'profile' ? page.records[0].email !== null : page.records[0].id !== gameId)) {
              throw new ApiError(409, 'DRILL_PRIVACY_EXPORT', 'The normal owner export did not match this synthetic fixture.');
            }
          }
          fixture = { cookie, baseline };
          await this.savePrivacy(gameId, fixture);
          return { prepared: true, exported: { profile: 1, games: 1, recoveryEmail: null }, checks: await this.privacyChecks(gameId, fixture, env) };
        }
        if (!fixture) throw new ApiError(409, 'DRILL_PRIVACY_REQUIRED', 'Prepare this synthetic privacy fixture first.');
        if (action === 'status') return { receipt: fixture.receipt ?? null, boundary: fixture.boundary ?? null,
          checks: await this.privacyChecks(gameId, fixture, env) };
        const before = await this.privacyChecks(gameId, fixture, env);
        if (!before.identityRetained || !before.historyRetained || !before.watermarksRetained) {
          throw new ApiError(409, 'DRILL_PRIVACY_LATER_WORK', 'Preserve later work and review a new privacy boundary.');
        }
        if (action === 'boundary') {
          if (fixture.receipt || !input.d1Bookmark || input.d1Bookmark.length > 256) throw new ApiError(409, 'DRILL_PRIVACY_BOUNDARY', 'Capture a real native D1 bookmark before closing this account.');
          fixture.boundary = { schema: PRIVACY_SCHEMA, gameId, scope: env.RECOVERY_DRILL_SCOPE, sourceRevision: env.RECOVERY_SOURCE_REVISION,
            resources: drillResources(env), d1: { bookmark: input.d1Bookmark, schemaSha256: await drillD1Schema(env.DB) } };
          await this.savePrivacy(gameId, fixture);
          return { boundary: fixture.boundary, baseline: fixture.baseline };
        }
        if (!fixture.boundary || fixture.boundary.sourceRevision !== env.RECOVERY_SOURCE_REVISION || fixture.boundary.scope !== env.RECOVERY_DRILL_SCOPE
          || JSON.stringify(fixture.boundary.resources) !== JSON.stringify(drillResources(env))
          || fixture.boundary.d1.schemaSha256 !== await drillD1Schema(env.DB)) throw new ApiError(409, 'DRILL_PRIVACY_BOUNDARY', 'Use the saved boundary from this exact source and D1 schema.');
        if (action === 'close' && !fixture.receipt) {
          // Recover a lost reply without creating a second accepted closure.
          const saved = await env.DB.prepare('SELECT request_id AS requestId,user_id AS userId,policy_version AS policyVersion,completed_at AS completedAt FROM account_closure_receipts WHERE user_id=?')
            .bind(fixture.baseline.userId).first<AccountClosureReceipt>();
          if (saved) fixture.receipt = saved;
          else {
            const actor = await currentActor(privacyRequest(env, gameId, '/api/me', undefined, fixture.cookie), env);
            if (!actor || actor.id !== fixture.baseline.userId) throw new ApiError(409, 'DRILL_PRIVACY_SESSION', 'The prepared synthetic owner session is unavailable.');
            const response = await closeAccount(privacyRequest(env, gameId, '/api/account/close', { password: await syntheticPassword(env, gameId, 'w'),
              confirmation: 'CLOSE', requestId: `privacy-close-${gameId}` }, fixture.cookie), env, actor);
            fixture.receipt = await response.json() as AccountClosureReceipt;
          }
          if (fixture.receipt.userId !== fixture.baseline.userId || fixture.receipt.requestId !== `privacy-close-${gameId}`
            || fixture.receipt.policyVersion !== ACCOUNT_PRIVACY_POLICY) throw new ApiError(409, 'DRILL_PRIVACY_RECEIPT', 'This receipt does not belong to the prepared synthetic account.');
          await this.savePrivacy(gameId, fixture);
        } else if (action === 'reapply') {
          const fence = this.privacyFence(fixture.baseline.userId);
          const supplied = input.receipt;
          if (!input.privateReceiptSaved || !fixture.receipt || !supplied || Object.keys(supplied).length !== 4
            || (Object.keys(fixture.receipt) as Array<keyof AccountClosureReceipt>).some(key => supplied[key] !== fixture.receipt![key])
            || fence?.state !== 'closed' || fence.request_id !== fixture.receipt.requestId) {
            throw new ApiError(409, 'DRILL_PRIVACY_RECEIPT', 'Preserve and supply the exact accepted receipt while its committed Competition fence stays current.');
          }
          const lease = await beginIdentityChange(env.DB, fixture.receipt.userId);
          try { await applyAccountClosure(env.DB, fixture.receipt); }
          finally { await env.DB.prepare('DELETE FROM identity_change_leases WHERE user_id=? AND lease_id=?').bind(fixture.receipt.userId, lease).run(); }
        }
        const checks = await this.privacyChecks(gameId, fixture, env, true);
        if (!fixture.receipt || checks.counts.credentials || checks.counts.sessions || checks.counts.resets || checks.counts.receipts !== 1
          || !checks.identityRetained || !checks.historyRetained || !checks.watermarksRetained || !checks.profileMinimized
          || !checks.closedFence || !checks.oldCookieDenied || !checks.signInDenied) {
          throw new ApiError(409, 'DRILL_PRIVACY_UNVERIFIED', 'Keep authentication and admission closed. This account closure is not verified.');
        }
        return { receipt: fixture.receipt, checks };
      } finally { this.privacyWorking = false; }
    });
  }
  async readDrillProbe() { return probe(this.ctx); }
  async setDrillProbe(value: 'original' | 'changed') { await setProbe(this.ctx, value); }
  async captureDrillPoint() { return drillResult(() => super.captureRecoveryPoint()); }
  async prepareRecoveryRestore(manifest: DrillManifest) {
    return drillResult(() => prepareDrillRestore(this.ctx, { ...this.env, RANKED_ENABLED: 'false' } as DrillEnv, 'Competition', manifest));
  }
  async restartRecovery(input: { manifestSha256: string; undoBookmark: string; privateReceiptSaved: boolean }) {
    return restartDrillObject(this.ctx, { ...this.env, RANKED_ENABLED: 'false' } as DrillEnv, input);
  }
  async admitSyntheticRanked(gameId: string, white: Actor, black: Actor): Promise<string> {
    const reservation = `recovery-${gameId}`;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`INSERT OR IGNORE INTO matches(id,reservation_id,pool,white_id,black_id,white_actor,black_actor,status,created_at,next_attempt_at)
        VALUES(?,?,'blitz',?,?,?,?,'live',?,?)`, gameId, reservation, white.id, black.id, JSON.stringify(white), JSON.stringify(black), Date.now(), Date.now() + 60_000);
      for (const actor of [white, black]) this.ctx.storage.sql.exec("INSERT OR IGNORE INTO slots(user_id,state,pool,game_id) VALUES(?,'live','blitz',?)", actor.id, gameId);
    });
    await this.ctx.storage.sync();
    return reservation;
  }
  override async flush(): Promise<void> {
    const rows = this.ctx.storage.sql.exec<{ id: string; payload: string }>('SELECT id,payload FROM outbox WHERE analysed=0 ORDER BY id LIMIT 16').toArray();
    for (const row of rows) {
      const { result } = JSON.parse(row.payload) as { result: GameResult };
      if (result.rated && result.status === 'finished' && result.white.id === await syntheticUserId(this.env, result.id, 'w')
        && result.black?.id === await syntheticUserId(this.env, result.id, 'b')
        && await this.env.DB.prepare('SELECT 1 FROM recovery_drill_probe WHERE id=?').bind(result.id).first()) {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec('INSERT OR IGNORE INTO recovery_drill_analysis_omissions(id,game_id,recorded_at) VALUES(?,?,?)', row.id, result.id, Date.now());
          this.ctx.storage.sql.exec('UPDATE outbox SET analysed=1 WHERE id=?', row.id);
        });
      }
    }
    // Postgame analysis is deliberately omitted in the isolated scope and never claimed as run.
    await super.flush();
  }
  async syntheticCorrection(gameId: string, action: 'restrict' | 'clear') {
    if (!this.ctx.storage.sql.exec('SELECT 1 FROM rating_events WHERE game_id=?', gameId).toArray()[0]) {
      throw new ApiError(409, 'DRILL_RATING_REQUIRED', 'Finish and settle a synthetic rated game before its correction fixture.');
    }
    const subject = await syntheticUserId(this.env, gameId, 'w');
    const now = Date.now();
    const caseId = `recovery-case-${gameId}`;
    const decisionId = `recovery-${action}-${gameId}`;
    if (action === 'clear' && !await this.env.DB.prepare("SELECT 1 FROM fairplay_decisions WHERE id=? AND case_id=? AND subject_id=? AND outcome='restrict'")
      .bind(`recovery-restrict-${gameId}`, caseId, subject).first()) {
      throw new ApiError(409, 'DRILL_RESTRICTION_REQUIRED', 'Complete the synthetic restrict fixture before its reversal.');
    }
    await this.env.DB.batch([
      this.env.DB.prepare("INSERT OR IGNORE INTO fairplay_cases(id,subject_id,game_id,status,created_at,updated_at) VALUES(?,?,?,'decided',?,?)")
        .bind(caseId, subject, gameId, now, now),
      this.env.DB.prepare(`INSERT OR IGNORE INTO fairplay_decisions(id,case_id,subject_id,reviewer_id,outcome,reason,review_note,corroboration,evidence_ids,affected_game_ids,request_hash,created_at,appeal_until)
        VALUES(?,?,?,?,?,'Synthetic recovery drill.','No real person was reviewed.','Isolated deterministic fixture.','[]',?,?,?,?)`)
        .bind(decisionId, caseId, subject, await syntheticUserId(this.env, gameId, 'b'), action, JSON.stringify([gameId]), decisionId, now, now + 7 * 86_400_000),
      this.env.DB.prepare('INSERT OR IGNORE INTO rating_correction_outbox(decision_id,subject_id,action,created_at) VALUES(?,?,?,?)')
        .bind(decisionId, subject, action === 'restrict' ? 'review_replay' : 'reverse_replay', now),
    ]);
    const admission = await super.requestCorrection(decisionId);
    if (admission.accepted && !admission.complete) await super.processCorrections();
    return { decisionId, admission, status: await super.correctionStatus(decisionId), authority: await super.beginExport() };
  }
  override async alarm() {
    if (!await drillRestoreArmed(this.env.DB)) await super.alarm();
  }
}

async function requireDrillToken(request: Request, env: DrillEnv): Promise<void> {
  const secret = env.RECOVERY_DRILL_TOKEN;
  if (!secret || !/^[A-Za-z0-9_-]{32,128}$/.test(secret)) throw new ApiError(404, 'NOT_FOUND', 'This endpoint is unavailable.');
  const value = request.headers.get('Authorization');
  if (!value || !value.startsWith('Bearer ') || value.length > 136) throw new ApiError(403, 'DRILL_AUTH_REQUIRED', 'Private drill authentication is required.');
  const encoder = new TextEncoder();
  const [expected, actual] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(secret)), crypto.subtle.digest('SHA-256', encoder.encode(value.slice(7))),
  ]);
  if (!crypto.subtle.timingSafeEqual(expected, actual)) throw new ApiError(403, 'DRILL_AUTH_REQUIRED', 'Private drill authentication is required.');
}

async function ensureDrillTables(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS recovery_drill_probe(id TEXT PRIMARY KEY,value TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS recovery_drill_restores(object_id TEXT PRIMARY KEY,manifest_digest TEXT NOT NULL,receipt TEXT NOT NULL,armed INTEGER NOT NULL DEFAULT 0)'),
  ]);
}

async function syntheticActor(env: DrillEnv, gameId: string, color: 'w' | 'b'): Promise<Actor> {
  const id = await syntheticUserId(env, gameId, color);
  const sessionId = `${id}:session`;
  const now = Date.now();
  const exists = await env.DB.prepare('SELECT expiresAt FROM session WHERE id=? AND userId=?').bind(sessionId, id).first<{ expiresAt: string }>();
  if (!exists) {
    const stamp = new Date(now).toISOString();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO user(id,name,email,emailVerified,isAnonymous,username,createdAt,updatedAt) VALUES(?,?,?,0,0,?,?,?)')
        .bind(id, `Recovery ${color}`, `${gameId}.${color}@recovery.invalid`, `r${gameId.replaceAll('-', '').slice(0, 21)}${color}`, stamp, stamp),
      env.DB.prepare("INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES(?,?,'credential',?,?,?,?)")
        .bind(`${id}:account`, id, id, await hashPassword(await syntheticPassword(env, gameId, color)), stamp, stamp),
      env.DB.prepare('INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
        .bind(sessionId, id, crypto.randomUUID(), new Date(now + 86_400_000).toISOString(), stamp, stamp),
    ]);
  }
  return { id, name: `Recovery ${color}`, isAnonymous: false, sessionId, sessionExpiresAt: exists ? Date.parse(exists.expiresAt) : now + 86_400_000 };
}

function stubs(env: DrillEnv, gameId: string): { game: DrillGameStub; competition: DrillCompetitionStub } {
  return { game: env.GAME.get(env.GAME.idFromName(gameId)) as DrillGameStub,
    competition: env.COMPETITION.get(env.COMPETITION.idFromName('global')) as DrillCompetitionStub };
}

async function fixtureProbes(env: DrillEnv, gameId: string, game: DrillGameStub, competition: DrillCompetitionStub) {
  const d1 = await env.DB.prepare('SELECT value FROM recovery_drill_probe WHERE id=?').bind(gameId).first<ProbeValue>('value');
  if (d1 !== 'original' && d1 !== 'changed') throw new ApiError(409, 'DRILL_FIXTURE_REQUIRED', 'Seed this synthetic fixture before using its private drill operations.');
  return { schema: 'ejm-chess-drill-probes-v1' as const, d1, game: await game.readDrillProbe(), competition: await competition.readDrillProbe() };
}

async function route(request: Request, env: DrillEnv): Promise<Response> {
  if (new URL(request.url).pathname !== '/drill' || request.method !== 'POST') throw new ApiError(404, 'NOT_FOUND', 'This endpoint was not found.');
  await requireDrillToken(request, env);
  assertDrillConfiguration(env);
  const body = await readJson<Record<string, unknown>>(request, 32_768);
  await ensureDrillTables(env.DB);
  if (body.operation === 'inspect') return jsonResponse({ schema: DRILL_SCHEMA, scope: env.RECOVERY_DRILL_SCOPE,
    resources: drillResources(env), sourceRevision: env.RECOVERY_SOURCE_REVISION, admissionStopped: true });
  if (body.operation === 'inventory') return jsonResponse(await recoveryInventory(env, typeof body.after === 'string' ? body.after : ''));
  if (!isGameId(body.gameId)) throw new ApiError(400, 'INVALID_GAME_ID', 'Use a fresh synthetic UUID game ID.');
  const gameId = body.gameId;
  if (await drillRestoreArmed(env.DB) && !['capture', 'probes', 'prepare-restore', 'restart', 'resume'].includes(String(body.operation))) {
    throw new ApiError(409, 'DRILL_RESTORE_ARMED', 'Verify the isolated restoration and resume its original deadlines before changing synthetic work.');
  }
  if (body.operation !== 'seed' && !await admittedRecoveryGame(env, gameId)) throw new ApiError(404, 'GAME_NOT_FOUND', 'This synthetic admitted game was not found.');
  const { game, competition } = stubs(env, gameId);
  if (body.operation !== 'seed' && !await env.DB.prepare('SELECT 1 FROM recovery_drill_probe WHERE id=?').bind(gameId).first()) {
    throw new ApiError(409, 'DRILL_FIXTURE_REQUIRED', 'Seed this synthetic fixture before using its private drill operations.');
  }
  if (body.operation === 'privacy') {
    const fields = ['operation', 'gameId', 'action', ...(body.action === 'boundary' ? ['d1Bookmark'] : []),
      ...(body.action === 'reapply' ? ['receipt', 'privateReceiptSaved'] : [])];
    if (!['prepare', 'boundary', 'close', 'status', 'reapply'].includes(String(body.action)) || Object.keys(body).some(key => !fields.includes(key))
      || (body.action === 'boundary' && (typeof body.d1Bookmark !== 'string' || !body.d1Bookmark.length || body.d1Bookmark.length > 256))) {
      throw new ApiError(400, 'INVALID_PRIVACY_DRILL', 'Use only this synthetic fixture action and its documented bounded fields.');
    }
    const result = await competition.privacyFixture(gameId, body.action as PrivacyAction, {
      d1Bookmark: body.d1Bookmark as string | undefined, receipt: body.receipt as AccountClosureReceipt | undefined, privateReceiptSaved: body.privateReceiptSaved === true,
    });
    return result.ok ? jsonResponse(result.value) : jsonResponse({ error: result.error.code, message: result.error.message }, result.error.status);
  }
  if (body.operation === 'seed') {
    const prior = await game.drillFixtureStatus();
    if (prior.archived || prior.status === 'finished' || prior.status === 'pending-adjudication'
      || (prior.rated !== null && prior.rated !== (body.rated === true))) {
      throw new ApiError(409, 'DRILL_SEED_CONFLICT', 'Use a fresh synthetic game ID. Finished, archived or different fixture identities cannot be reused.');
    }
    const white = await syntheticActor(env, gameId, 'w');
    const black = await syntheticActor(env, gameId, 'b');
    const rated = body.rated === true;
    const reservationId = rated ? await competition.admitSyntheticRanked(gameId, white, black) : undefined;
    if (!rated) await env.DB.prepare('INSERT OR IGNORE INTO casual_game_admissions(game_id,creator_id,created_at) VALUES(?,?,?)').bind(gameId, white.id, Date.now()).run();
    for (const actor of [white, black]) {
      if (!await acquireSeatGuard({ ...env, RANKED_ENABLED: 'true' }, actor, gameId, rated)) {
        throw new ApiError(409, 'DRILL_SEAT_UNAVAILABLE', 'The synthetic fixture could not acquire its normal account seat.');
      }
    }
    let snapshot: GameSnapshot = await game.init({ id: gameId, format: 'blitz', rated, white, black,
      ...(reservationId ? { reservationId } : {}) });
    for (const [actor, color] of [[white, 'w'], [black, 'b']] as const) {
      if (snapshot.status === 'ready') {
        const reply = await game.command(actor, { type: 'ready', id: `recovery-ready-${color}-${gameId}`, expectedVersion: snapshot.version });
        if (!reply.ok) throw new Error(reply.code);
        snapshot = reply.snapshot;
      }
    }
    await env.DB.prepare("INSERT OR IGNORE INTO recovery_drill_probe(id,value) VALUES(?,'original')").bind(gameId).run();
    return jsonResponse({ gameId, rated, version: snapshot.version, status: snapshot.status, deadline: snapshot.clocks.deadline });
  }
  if (body.operation === 'command') {
    if (body.color !== 'w' && body.color !== 'b') throw new ApiError(400, 'INVALID_COLOR', 'Choose a synthetic seat.');
    const actor = await syntheticActor(env, gameId, body.color);
    return jsonResponse(await game.command(actor, body.command as GameCommand));
  }
  if (body.operation === 'flush') {
    await game.flush();
    await competition.flush();
    return jsonResponse({ status: await game.status(), authority: await competition.beginExport() });
  }
  if (body.operation === 'fixture-status') {
    return jsonResponse({ game: await game.drillFixtureStatus(),
      projection: await env.DB.prepare(`SELECT g.status,g.rated,g.settlement,g.result_version,g.projection_epoch,g.ended_at,
        a.storage_state,a.archived_at FROM games g LEFT JOIN casual_game_admissions a ON a.game_id=g.id WHERE g.id=?`).bind(gameId).first(),
      authority: await competition.beginExport() });
  }
  if (body.operation === 'reserve-budget') {
    // A bounded isolated fixture allowance. The deployment and persistent stop row stay unchanged.
    const accepted = await reserveMonthlyWork({ ...env, NEW_WORK_STOPPED: 'false', MONTHLY_GAME_LIMIT: '6' }, 'games', `recovery:${gameId}`);
    return jsonResponse({ accepted, syntheticMonthlyAllowance: 6,
      receipt: await env.DB.prepare('SELECT period,units,created_at FROM budget_receipts WHERE kind=? AND id=?').bind('games', `recovery:${gameId}`).first(),
      control: await env.DB.prepare("SELECT version,games_stopped,email_stopped,analysis_stopped FROM operations_control WHERE id='product'").first() });
  }
  if (body.operation === 'terminal-ack') {
    if (body.action !== 'arm' && body.action !== 'release') throw new ApiError(400, 'INVALID_DRILL_ACTION', 'Choose arm or release for the synthetic terminal acknowledgement.');
    const fault = await game.terminalAckFault(body.action);
    await competition.flush();
    return jsonResponse({ game: fault, authority: await competition.beginExport() });
  }
  if (body.operation === 'correction') {
    if (body.action !== 'restrict' && body.action !== 'clear') throw new ApiError(400, 'INVALID_DRILL_ACTION', 'Choose the synthetic restrict or clear fixture.');
    return jsonResponse(await competition.syntheticCorrection(gameId, body.action));
  }
  if (body.operation === 'retire-aged') {
    return jsonResponse({ retirement: await retireGamePayloads(env), game: await game.drillFixtureStatus() });
  }
  if (body.operation === 'capture') {
    if (typeof body.d1Bookmark !== 'string' || !body.d1Bookmark || body.d1Bookmark.length > 256) {
      throw new ApiError(400, 'D1_BOOKMARK_REQUIRED', 'Record the real native D1 bookmark externally before capture.');
    }
    const gamePoint = await game.captureDrillPoint(gameId);
    if (!gamePoint.ok) return jsonResponse({ error: gamePoint.error.code, message: gamePoint.error.message }, gamePoint.error.status);
    const competitionPoint = await competition.captureDrillPoint();
    if (!competitionPoint.ok) return jsonResponse({ error: competitionPoint.error.code, message: competitionPoint.error.message }, competitionPoint.error.status);
    const manifest: DrillManifest = { schema: DRILL_SCHEMA, scope: env.RECOVERY_DRILL_SCOPE, sourceRevision: env.RECOVERY_SOURCE_REVISION,
      resources: drillResources(env), d1: { bookmark: body.d1Bookmark, schemaSha256: await drillD1Schema(env.DB) },
      points: { game: gamePoint.value, competition: competitionPoint.value }, probeBoundary: await fixtureProbes(env, gameId, game, competition) };
    return jsonResponse(manifest);
  }
  if (body.operation === 'change-probes' || body.operation === 'reset-probes') {
    const value = body.operation === 'reset-probes' ? 'original' : 'changed';
    await env.DB.prepare('UPDATE recovery_drill_probe SET value=? WHERE id=?').bind(value, gameId).run();
    await game.setDrillProbe(value);
    await competition.setDrillProbe(value);
    return jsonResponse(body.operation === 'reset-probes' ? { reset: true } : { changed: true });
  }
  if (body.operation === 'probes') {
    const { schema: _schema, ...values } = await fixtureProbes(env, gameId, game, competition);
    return jsonResponse(values);
  }
  const target = body.kind === 'Game' ? game : body.kind === 'Competition' ? competition : null;
  if (body.operation === 'prepare-restore') {
    if (!target) throw new ApiError(400, 'INVALID_RECOVERY_KIND', 'Choose Game or Competition.');
    const result = await target.prepareRecoveryRestore(body.manifest as DrillManifest);
    return result.ok ? jsonResponse(result.value) : jsonResponse({ error: result.error.code, message: result.error.message,
      ...(result.error.undoReceipt ? { undoReceipt: result.error.undoReceipt } : {}) }, result.error.status);
  }
  if (body.operation === 'restart') {
    if (!target || typeof body.manifestSha256 !== 'string' || typeof body.undoBookmark !== 'string') throw new ApiError(400, 'DRILL_UNDO_REQUIRED', 'Supply the saved private undo receipt.');
    await target.restartRecovery({ manifestSha256: body.manifestSha256, undoBookmark: body.undoBookmark, privateReceiptSaved: body.privateReceiptSaved === true });
  }
  if (body.operation === 'resume') {
    const manifest = body.manifest as DrillManifest;
    const { verifyDrillManifest } = await import('./recovery-drill-controls');
    await verifyDrillManifest(env, manifest);
    const probes = drillManifestProbes(manifest);
    const [actualGame, actualCompetition] = await Promise.all([game.captureRecoveryPoint(gameId), competition.captureRecoveryPoint()]);
    if (actualGame.authority.sha256 !== manifest.points.game.authority.sha256 || actualCompetition.authority.sha256 !== manifest.points.competition.authority.sha256
      || actualGame.alarm !== manifest.points.game.alarm || actualCompetition.alarm !== manifest.points.competition.alarm
      || await env.DB.prepare('SELECT value FROM recovery_drill_probe WHERE id=?').bind(gameId).first('value') !== probes.d1
      || await game.readDrillProbe() !== probes.game || await competition.readDrillProbe() !== probes.competition) {
      throw new ApiError(409, 'DRILL_RESTORE_UNVERIFIED', 'The restored authority or probe does not match the reviewed capture. Keep the drill paused.');
    }
    await env.DB.prepare('UPDATE recovery_drill_restores SET armed=0 WHERE manifest_digest=?').bind(env.RECOVERY_MANIFEST_SHA256!).run();
    // Original stored deadlines and outboxes resume through the normal authority paths.
    const status = await game.status();
    await game.flush();
    await competition.flush();
    return jsonResponse({ resumed: true, status, authority: await competition.beginExport() });
  }
  throw new ApiError(404, 'NOT_FOUND', 'This drill operation was not found.');
}

export default {
  async fetch(request: Request, env: DrillEnv) {
    try { return await route(request, env); }
    catch (error) { return errorResponse(error); }
  },
};
