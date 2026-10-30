import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { publicProfile } from '../src/server/profile';
import { RULES_VERSION, type Actor, type Pool } from '../src/shared/protocol';
import { player } from './authority-helpers';

const DAY = 86_400_000;
async function projection(actor: Actor, pool: Pool, options: { games?: number; opponents?: number; rd?: number; lastPlayedAt?: number; eligible?: number } = {}) {
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO leaderboard_entries(pool,user_id,display_name,rating,rating_display,rd,vol,games,distinct_opponents,account_created_at,last_played_at,eligible,epoch,version,projected_at)
    VALUES(?,?,?,1600.25,1600,?,0.06,?,?,?,?,?,1,1,?)`).bind(pool, actor.id, actor.name, options.rd ?? 80,
    options.games ?? 25, options.opponents ?? 10, now - 30 * DAY, options.lastPlayedAt ?? now, options.eligible ?? 1, now).run();
}

describe('bounded public player profiles', () => {
  it('returns credential-backed profiles with or without recovery email and a bounded safe rating contract', async () => {
    const [actor, guest, unverified, withoutUsername, withoutCredential] = await Promise.all([player(false, { recoveryEmail: false }), player(true), player(), player(), player()]);
    await env.DB.prepare('UPDATE user SET emailVerified=0 WHERE id=?').bind(unverified.id).run();
    await env.DB.prepare('UPDATE user SET username=NULL WHERE id=?').bind(withoutUsername.id).run();
    await env.DB.prepare('DELETE FROM account WHERE userId=?').bind(withoutCredential.id).run();
    await projection(withoutUsername, 'blitz');
    await projection(withoutCredential, 'blitz');
    await projection(unverified, 'blitz');
    await projection(actor, 'blitz');
    await projection(actor, 'rapid', { games: 4, opponents: 4, rd: 180, eligible: 0 });
    expect(await publicProfile(env, guest.id)).toBeNull();
    expect((await publicProfile(env, unverified.id))?.pools[0]).toMatchObject({ pool: 'blitz', eligible: true });
    expect(await publicProfile(env, withoutUsername.id)).toBeNull();
    expect(await publicProfile(env, withoutCredential.id)).toBeNull();
    expect(await publicProfile(env, 'ai:invalid')).toBeNull();
    expect(await publicProfile(env, crypto.randomUUID())).toBeNull();
    const profile = await publicProfile(env, actor.id);
    expect(profile).toMatchObject({ id: actor.id, name: actor.name, rankedOpen: false,
      pools: [{ pool: 'blitz', rating: 1600, status: 'established', eligible: true }, { pool: 'rapid', status: 'provisional', eligible: false }] });
    expect(profile?.pools).toHaveLength(2);
    expect(Object.keys(profile!).sort()).toEqual(['id', 'name', 'pools', 'rankedOpen']);
    expect(Object.keys(profile!.pools[0]).sort()).toEqual(['deviation', 'distinctOpponents', 'eligible', 'games', 'lastPlayedAt', 'pending', 'pool', 'rating', 'status', 'updatedAt']);
    expect(JSON.stringify(profile)).not.toContain('@example.test');
    expect(JSON.stringify(profile)).not.toContain('placeholder.invalid');
    expect(JSON.stringify(profile)).not.toContain(actor.sessionId);
    expect(await env.DB.prepare('SELECT emailVerified FROM user WHERE id=?').bind(actor.id).first('emailVerified')).toBe(0);
  });

  it('rechecks current age, activity and password credential instead of trusting an old eligible projection', async () => {
    const actor = await player();
    await projection(actor, 'blitz', { lastPlayedAt: Date.now() - 31 * DAY });
    await projection(actor, 'rapid');
    expect((await publicProfile(env, actor.id))?.pools[0]).toMatchObject({ status: 'inactive', eligible: false });
    await env.DB.prepare('UPDATE user SET createdAt=? WHERE id=?').bind(new Date(Date.now() - DAY).toISOString(), actor.id).run();
    expect((await publicProfile(env, actor.id))?.pools[1]).toMatchObject({ status: 'provisional', eligible: false });
    const password = await env.DB.prepare("SELECT password FROM account WHERE userId=? AND providerId='credential'").bind(actor.id).first<string>('password');
    await env.DB.prepare("UPDATE account SET password=NULL WHERE userId=? AND providerId='credential'").bind(actor.id).run();
    expect(await publicProfile(env, actor.id)).toBeNull();
    await env.DB.prepare("UPDATE account SET password=? WHERE userId=? AND providerId='credential'").bind(password, actor.id).run();
    expect(await publicProfile(env, actor.id)).toMatchObject({ id: actor.id });
  });

  it('uses generic unranked status during a current restriction and never reveals its private reason', async () => {
    const [actor, reviewer] = await Promise.all([player(), player()]);
    await projection(actor, 'blitz');
    const now = Date.now();
    const caseId = crypto.randomUUID();
    const decisionId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO fairplay_cases(id,subject_id,game_id,status,created_at,updated_at) VALUES(?,?,?,'decided',?,?)").bind(caseId, actor.id, crypto.randomUUID(), now, now),
      env.DB.prepare(`INSERT INTO fairplay_decisions(id,case_id,subject_id,reviewer_id,outcome,reason,review_note,corroboration,evidence_ids,request_hash,created_at,appeal_until)
        VALUES(?,?,?,?,'restrict',?,'Private review notes.','Private evidence.','[]',?,?,?)`).bind(decisionId, caseId, actor.id, reviewer.id, 'Private restriction reason.', decisionId, now, now + 7 * DAY),
      env.DB.prepare(`INSERT INTO restrictions(id,user_id,case_id,decision_id,reason,starts_at,expires_at) VALUES(?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), actor.id, caseId, decisionId, 'Private restriction reason.', now, now + DAY),
    ]);
    const profile = await publicProfile(env, actor.id);
    expect(profile?.pools[0]).toMatchObject({ status: 'unranked', eligible: false, rating: 1600 });
    const content = JSON.stringify(profile);
    for (const privateValue of [caseId, decisionId, reviewer.id, 'Private restriction reason.', 'Private review notes.', actor.sessionId]) expect(content).not.toContain(privateValue);
    expect((await publicProfile(env, actor.id, now + DAY + 1))?.pools[0]).toMatchObject({ status: 'established', eligible: true });
  });

  it('labels pending ranked settlement while retaining the last projected rating', async () => {
    const actor = await player();
    await projection(actor, 'blitz');
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO games(id,pool,rated,white_id,white_name,status,reason,ended_at,created_at,pgn,plies,rules_version,result_version,projection_epoch,projection_version,projected_at,settlement)
      VALUES(?,'blitz',1,?,'Player','pending-adjudication','timeout-needs-review',?,?,'*',0,?,1,1,1,?,'pending')`)
      .bind(crypto.randomUUID(), actor.id, now, now, RULES_VERSION, now).run();
    expect((await publicProfile(env, actor.id))?.pools).toMatchObject([
      { pool: 'blitz', rating: 1600, games: 25, pending: true, status: 'pending' },
      { pool: 'rapid', rating: null, games: 0, pending: false, status: 'provisional' },
    ]);
  });
});
