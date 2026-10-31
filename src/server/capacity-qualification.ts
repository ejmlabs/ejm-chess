import { capacityFailureFromError, capacityPrivateFailureCode } from '../shared/capacity-failure';
import { AsyncLocalStorage } from 'node:async_hooks';
import { SEALED_CAPACITY_MANIFEST, VERIFIED_CONTROLLER_PLAN, CapacityTicketCodec, CAPACITY_INGRESS_AUTH_STARTUP_ROWS,
  type CapacityDispatch, type CapacityManifest, type CapacityShutdownReceipt, type CapacityTicket } from './capacity-run';
import { VERIFIED_NATIVE_ENVELOPES, callCapacityWorkflow, retireCapacityGame, type CapacityEnv, type CapacityNativeTiming } from './capacity-native';
import { VERIFIED_GAME_WORKFLOW_PLAN, VERIFIED_DELAYED_GAME_WORKFLOW_PLAN,
  VERIFIED_SOCKET_GAME_WORKFLOW_PLAN, VERIFIED_COMPETITION_WORKFLOW_PLAN } from './capacity-work-plan';
import { CapacityIngressBudget } from './capacity-ingress';
import { arenaRegistrationAdmission } from './arena-registration-admission';
import { readCapacityBinding } from './capacity-binding';
import { authenticateCapacitySession } from './capacity-fixtures';
import type { Actor } from './auth';
import { CapacityNativeMeter, CAPACITY_D1_READ_ATTEMPTS, CAPACITY_WARM_D1_READ_ROWS } from './capacity-meter';
import { serveCapacityStandings } from './capacity-standings';
import { CAPACITY_CORPUS, CAPACITY_STEP_COUNT, CAPACITY_COMPETITION_HEADER, CAPACITY_REGISTRATION_DIAGNOSTIC, capacityRegistrationDiagnosticStep,
  capacitySocketSlot, capacityStep, capacityPreparationAccounts,
  type CapacityStepReply } from '../shared/capacity-corpus';
import { ApiError, readJson } from './security';

export { CapacityRun } from './capacity-run';
export { CapacityGame, CapacityCompetition } from './capacity-native';

/** Remains false until the complete protocol and all work paths are verified. */
export const CAPACITY_PROTOCOL_READY = false;
const ENV_KEYS = new Set(['DB', 'GAME', 'COMPETITION', 'CAPACITY_RUN', 'CAPACITY_TOKEN', 'AUTH_SECRET']);

export function capacityResourcesPrivate(env: CapacityEnv): boolean {
  return Object.keys(env).every(key => ENV_KEYS.has(key)) && Boolean(env.DB && env.GAME && env.COMPETITION && env.CAPACITY_RUN)
    && typeof env.AUTH_SECRET === 'string' && env.AUTH_SECRET.length >= 32
    && typeof env.CAPACITY_TOKEN === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(env.CAPACITY_TOKEN);
}

function authorized(request: Request, env: CapacityEnv): boolean {
  if (!capacityResourcesPrivate(env)) return false;
  const expected = new TextEncoder().encode(`Bearer ${env.CAPACITY_TOKEN}`);
  const supplied = new TextEncoder().encode(request.headers.get('Authorization') ?? '');
  return expected.byteLength === supplied.byteLength && crypto.subtle.timingSafeEqual(expected, supplied);
}

function metadata() {
  const manifest = SEALED_CAPACITY_MANIFEST;
  const blockers = [!manifest && 'sealed-manifest', !VERIFIED_NATIVE_ENVELOPES && 'verified-native-envelopes',
    !VERIFIED_CONTROLLER_PLAN && 'verified-controller-plan',
    !(VERIFIED_GAME_WORKFLOW_PLAN && VERIFIED_DELAYED_GAME_WORKFLOW_PLAN
      && VERIFIED_SOCKET_GAME_WORKFLOW_PLAN && VERIFIED_COMPETITION_WORKFLOW_PLAN) && 'verified-native-workflows',
    !CAPACITY_PROTOCOL_READY && 'complete-protocol-and-metering'].filter(Boolean);
  const schedule = manifest ? Object.fromEntries(['earliestArmAt', 'latestArmAt', 'setupEndsAt', 'streamStartsAt',
    'streamEndsAt', 'admissionsCloseAt', 'issueCloseAt', 'hardCloseAt'].map(key => [key, manifest[key as keyof typeof manifest]])) : null;
  return { ready: blockers.length === 0, armed: null, manifestDigest: manifest?.digest ?? null, blockers, schedule };
}

let ingress: CapacityIngressBudget | null = null;
let failed = false;
const noStore = { 'Cache-Control': 'no-store' };
// Fixed private codes only. Never put arbitrary exception text in a header.
// Keep this set aligned with the private driver receipt allowlist.
function failureHeaders(code: unknown): Record<string, string> {
  return { ...noStore, 'X-Capacity-Failure': capacityPrivateFailureCode(code) ?? 'capacity_run_unresolved' };
}

export function capacityFailureResponse(error: unknown): Response {
  const audit = capacityFailureFromError(error);
  return Response.json({ code: 'CAPACITY_RUN_UNRESOLVED', ...(audit ? { failure: audit } : {}) }, {
    status: 503, headers: { ...failureHeaders(audit?.code ?? (error instanceof Error ? error.message : null)),
      ...(audit ? { 'X-Capacity-Audit': JSON.stringify(audit) } : {}) },
  });
}

/** Keep normal admission throttles visible to the fixed protocol driver. */
export function capacityStepResponse(value: CapacityStepReply, timing?: { authMs: number; authorityMs: number;
  native?: CapacityNativeTiming & { sentAt: number; receivedAt: number } }): Response {
  if (timing && [timing.authMs, timing.authorityMs].some(ms => !Number.isFinite(ms) || ms < 0 || ms > 60_000)) {
    throw new Error('capacity_native_metrics_unavailable');
  }
  if (timing?.native) {
    const { sentAt, receivedAt, enteredAt, ticketAt, claimedAt, methodFinishedAt, returningAt } = timing.native;
    const stages = [enteredAt, ticketAt, claimedAt, methodFinishedAt, returningAt];
    if ([sentAt, receivedAt, ...stages].some(at => !Number.isSafeInteger(at) || at < 1_600_000_000_000)
      || receivedAt < sentAt || receivedAt - sentAt > 60_000 || returningAt - enteredAt > 60_000
      || stages.some((at, index) => index > 0 && at < stages[index - 1])) throw new Error('capacity_native_metrics_unavailable');
  }
  const status = value.httpStatus ?? 200;
  const failure = status >= 500 ? capacityPrivateFailureCode(value.code) : null;
  return Response.json(value, { status, headers: { ...noStore, ...(failure ? { 'X-Capacity-Failure': failure } : {}),
    ...(timing ? { 'X-Capacity-Timing': `auth;dur=${timing.authMs.toFixed(1)},authority;dur=${timing.authorityMs.toFixed(1)}` } : {}),
    ...(timing?.native ? { 'X-Capacity-Native-Timing': JSON.stringify(timing.native) } : {}) } });
}

const authScopes = new AsyncLocalStorage<CapacityNativeMeter>();
let workerAuth: { DB: D1Database; AUTH_SECRET: string } | null = null;

function primaryAuth(env: CapacityEnv): { auth: NonNullable<typeof workerAuth>; cold: boolean } {
  if (workerAuth) {
    if (workerAuth.AUTH_SECRET !== env.AUTH_SECRET) throw new Error('capacity_auth_environment_changed');
    return { auth: workerAuth, cold: false };
  }
  // One qualification deployment has one sealed D1 binding and auth secret.
  // Keep a stable package context even when platform Env wrappers change.
  // Its DB proxy resolves each request's meter across every async continuation.
  const db = new Proxy(env.DB, { get(target, member) {
    const meter = authScopes.getStore();
    if (!meter) throw new Error('capacity_auth_meter_missing');
    const measured = meter.d1(target), value = Reflect.get(measured, member, measured);
    return typeof value === 'function' ? value.bind(measured) : value;
  } });
  workerAuth = { DB: db, AUTH_SECRET: env.AUTH_SECRET };
  return { auth: workerAuth, cold: true };
}

function routeIndex(pathname: string, prefix: string, maximum: number): number | null {
  if (!pathname.startsWith(prefix)) return null;
  const suffix = pathname.slice(prefix.length);
  if (!/^(0|[1-9][0-9]{0,6})$/.test(suffix)) throw new ApiError(400, 'INVALID_CAPACITY_INDEX', 'Invalid workload index.');
  const index = Number(suffix);
  if (index >= maximum) throw new ApiError(400, 'INVALID_CAPACITY_INDEX', 'Invalid workload index.');
  return index;
}

async function primaryActor(request: Request, env: CapacityEnv, manifest: CapacityManifest, index: number): Promise<Actor> {
  const meter = new CapacityNativeMeter();
  const { auth, cold } = primaryAuth(env);
  const reads = cold ? CAPACITY_INGRESS_AUTH_STARTUP_ROWS : CAPACITY_WARM_D1_READ_ROWS;
  meter.allowD1ReadRetries(reads);
  const actor = await authScopes.run(meter, () => authenticateCapacitySession(auth.DB, auth, manifest, request, index));
  const usage = meter.snapshot();
  if (usage.uncertain || usage.unresolvedD1
    || usage.d1RowsRead + usage.d1RetryReadSurcharge > CAPACITY_D1_READ_ATTEMPTS * reads || usage.d1RowsWritten !== 0) {
    throw new Error('capacity_primary_auth_unfunded');
  }
  return actor;
}

async function gameTicket(request: Request, env: CapacityEnv, manifest: CapacityManifest,
  intentIndex: number, role: 'white' | 'black'): Promise<CapacityTicket<CapacityDispatch>> {
  // No Game namespace lookup can precede the permanent signed native binding
  // and a current primary-auth check. The native Game repeats both checks.
  const binding = await readCapacityBinding(request, manifest, env.AUTH_SECRET, intentIndex);
  await primaryActor(request, env, manifest, binding[role === 'white' ? 'whiteAccountIndex' : 'blackAccountIndex']);
  return new CapacityTicketCodec(env.AUTH_SECRET).dispatch({ runId: manifest.runId, manifestDigest: manifest.digest,
    id: binding.workflowNonce, objectKey: `game:${binding.gameId}`, generation: binding.generation,
    operation: 'Game.workflow', mode: 'workflow' });
}

async function emptyBody(request: Request): Promise<void> {
  const body = await readJson(request, 128);
  if (Object.keys(body).length) throw new ApiError(400, 'INVALID_CAPACITY_REQUEST', 'Send an empty object.');
}

async function competitionTicket(request: Request, env: CapacityEnv, manifest: CapacityManifest): Promise<CapacityTicket<CapacityDispatch>> {
  const raw = request.headers.get(CAPACITY_COMPETITION_HEADER);
  if (!raw || raw.length > 1_024) throw new Error('capacity_workflow_ticket_invalid');
  let ticket: CapacityTicket<CapacityDispatch>;
  try { ticket = JSON.parse(raw); } catch { throw new Error('capacity_workflow_ticket_invalid'); }
  if (!await new CapacityTicketCodec(env.AUTH_SECRET).validDispatch(ticket, manifest, 'competition', 'Competition.workflow')
    || ticket.mode !== 'workflow') throw new Error('capacity_workflow_ticket_invalid');
  return ticket;
}

/** Private controls only. No production router, auth handler or optional services. */
export default {
  async fetch(request: Request, env: CapacityEnv): Promise<Response> {
    if (!authorized(request, env)) return new Response('Unauthorized', { status: 401, headers: { 'Cache-Control': 'no-store' } });
    const manifest = SEALED_CAPACITY_MANIFEST;
    const url = new URL(request.url);
    if (manifest && (url.protocol !== 'https:' || url.hostname !== manifest.host || url.port || url.username || url.password)) {
      return new Response('Wrong qualification host', { status: 403, headers: { 'Cache-Control': 'no-store' } });
    }
    const readback = metadata();
    const { blockers } = readback;
    if (url.pathname === '/capacity/manifest' && request.method === 'GET') {
      return Response.json(readback, { status: blockers.length ? 503 : 200, headers: { 'Cache-Control': 'no-store' } });
    }
    if (url.pathname === '/capacity/stop' && request.method === 'POST' && manifest) {
      try { await emptyBody(request); }
      catch (error) {
        if (error instanceof ApiError) return Response.json({ code: error.code }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
        throw error;
      }
      const control = env.CAPACITY_RUN.get(env.CAPACITY_RUN.idFromName(manifest.runId));
      failed = true;
      ingress?.stop();
      try {
        try {
          const ticket = await control.recoverCompetitionWorkflow();
          if (ticket) {
            const reply = await callCapacityWorkflow<CapacityShutdownReceipt>(env.COMPETITION, ticket, 'Competition.finishQualification');
            if (!reply.workflowActual || reply.drained.pendingNative || reply.drained.alarm || reply.drained.sockets
              || !await control.complete(ticket, reply.workflowActual, reply.drained)
              || !await control.confirmShutdown(ticket, reply.value)) throw new Error('capacity_shutdown_unconfirmed');
          }
        } finally { await control.stop(); }
      } catch (error) {
        // A native finish that throws still returns its receipt. The stop stays a failure.
        return capacityFailureResponse(error);
      }
      return Response.json(await control.status(), { headers: { 'Cache-Control': 'no-store' } });
    }
    if (blockers.length) return Response.json({ ready: false, armed: false, blockers }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    const control = env.CAPACITY_RUN.get(env.CAPACITY_RUN.idFromName(manifest!.runId));
    try {
      if (url.pathname === '/capacity/status' && request.method === 'GET') {
        return Response.json(await control.status(), { headers: noStore });
      }
      if (url.search || url.hash || (request.method === 'POST' && request.headers.get('Origin') !== url.origin)) {
        throw new ApiError(400, 'INVALID_CAPACITY_REQUEST', 'Invalid workload request.');
      }
      if (url.pathname === '/capacity/arm' && request.method === 'POST') {
        await emptyBody(request);
        if (!await control.arm()) return Response.json({ armed: false }, { status: 409, headers: noStore });
        const ticket = await control.begin(crypto.randomUUID(), 'competition', 'Competition.workflow',
          VERIFIED_COMPETITION_WORKFLOW_PLAN!.envelope, 'workflow');
        if (!ticket) throw new Error('capacity_native_work_denied');
        return Response.json({ ...await control.status(), competitionTicket: ticket }, { headers: noStore });
      }
      if (failed || Date.now() >= manifest!.issueCloseAt) return new Response('Qualification stopped',
        { status: 503, headers: failureHeaders('capacity_isolate_stopped') });
      const prepare = routeIndex(url.pathname, '/capacity/prepare/', CAPACITY_CORPUS.accounts);
      const prepareBatch = routeIndex(url.pathname, '/capacity/prepare-batch/', CAPACITY_CORPUS.accounts);
      if (prepareBatch !== null) capacityPreparationAccounts(prepareBatch);
      const step = routeIndex(url.pathname, '/capacity/step/', CAPACITY_STEP_COUNT);
      const socket = routeIndex(url.pathname, '/capacity/socket/', CAPACITY_CORPUS.participantSockets * CAPACITY_CORPUS.socketGenerations);
      const standings = routeIndex(url.pathname, '/capacity/standings/', CAPACITY_CORPUS.events * CAPACITY_CORPUS.standingsPagesPerEvent);
      if (manifest!.profile === CAPACITY_REGISTRATION_DIAGNOSTIC.profile
        && !((prepare === 0 || (prepareBatch !== null && prepareBatch < CAPACITY_REGISTRATION_DIAGNOSTIC.accounts))
          || (step !== null && capacityRegistrationDiagnosticStep(step)))) {
        return new Response('Not found', { status: 404, headers: noStore });
      }
      if (!((prepare !== null || prepareBatch !== null || step !== null) && request.method === 'POST')
        && !((socket !== null || standings !== null) && request.method === 'GET')) return new Response('Not found', { status: 404, headers: noStore });
      // Drain this request's bounded stream before awaiting another request's
      // in-flight grant. Expensive dispatch still requires its durable charge.
      if (request.method === 'POST') await emptyBody(request);
      ingress ??= new CapacityIngressBudget(manifest!.issueCloseAt);
      if (!await ingress.consume(id => control.reserveIngress(id))) return new Response('Qualification stopped',
        { status: 503, headers: failureHeaders('capacity_ingress_stopped') });
      if (standings !== null) return serveCapacityStandings(request, env, manifest!, standings);
      const forwarded = new Request(request.url, { headers: request.headers });
      if (socket !== null || (step !== null && capacityStep(step).actor.kind === 'bound-seat')) {
        if (socket !== null && (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket'
          || request.headers.get('Origin') !== url.origin)) throw new ApiError(400, 'INVALID_CAPACITY_SOCKET', 'Invalid socket request.');
        const slot = socket !== null ? capacitySocketSlot(socket) : null;
        const action = step !== null ? capacityStep(step) : null;
        const actor = action?.actor;
        const ticket = await gameTicket(forwarded, env, manifest!, slot?.intentIndex ?? action!.intentIndex!,
          slot?.role ?? (actor!.kind === 'bound-seat' ? actor!.role : 'white'));
        const reply = await callCapacityWorkflow<Response | CapacityStepReply>(env.GAME, ticket,
          socket !== null ? 'Game.qualificationSocket' : 'Game.qualificationStep', [forwarded, socket ?? step!]);
        if (socket !== null) return reply.value as Response;
        const value = reply.value as CapacityStepReply;
        if (action!.action === 'retire' && value.accepted) {
          if (!reply.workflowActual || !await control.complete(ticket, reply.workflowActual, reply.drained)) {
            throw new Error('capacity_workflow_completion_unresolved');
          }
          const envelope = VERIFIED_NATIVE_ENVELOPES!['Game.retire'];
          if (!envelope || !await retireCapacityGame(env.GAME, control, ticket.objectKey, envelope)) {
            throw new Error('capacity_retirement_unconfirmed');
          }
          value.acceptedAt = Date.now();
        }
        return capacityStepResponse(value);
      }
      const ticket = await competitionTicket(request, env, manifest!);
      if (prepareBatch !== null) {
        // Keep Better Auth's one schema check in the existing bounded native
        // event before registration. The batch then reuses that same account.
        const startup = prepareBatch === 0 ? await callCapacityWorkflow(env.COMPETITION, ticket,
          'Competition.prepareQualificationAccount', [0]) : null;
        const reply = await callCapacityWorkflow(env.COMPETITION, ticket, 'Competition.prepareQualificationAccounts', [prepareBatch]);
        const usage = Object.fromEntries((['d1RowsRead', 'd1RowsWritten', 'd1Retries', 'd1RetryReadSurcharge'] as const)
          .map(key => [key, reply.usage[key] + (startup?.usage[key] ?? 0)]));
        return Response.json({ accounts: reply.value, usage }, { headers: noStore });
      }
      if (prepare !== null) {
        const reply = await callCapacityWorkflow(env.COMPETITION, ticket, 'Competition.prepareQualificationAccount', [prepare]);
        return Response.json(reply.value, { headers: noStore });
      }
      const actorIndex = capacityStep(step!).actor;
      if (actorIndex.kind !== 'account') throw new Error('capacity_session_invalid');
      const admitted = async () => {
        // Registration authenticates inside the product's global native guard.
        // Other steps retain their Worker primary authentication.
        const authStart = performance.now();
        const actor = capacityStep(step!).action === 'register' ? null
          : await primaryActor(request, env, manifest!, actorIndex.accountIndex);
        const authorityStart = performance.now();
        const sentAt = Date.now();
        const reply = await callCapacityWorkflow<CapacityStepReply>(env.COMPETITION, ticket, 'Competition.qualificationStep', [forwarded, step!, actor]);
        const receivedAt = Date.now();
        if (capacityStep(step!).fault === 'competition-restart-once' && reply.value.accepted) {
          const stub = env.COMPETITION.get(env.COMPETITION.idFromName('global'));
          let restarted = false;
          try { await stub.restart(ticket); }
          catch (error) { restarted = error instanceof Error && error.message === `capacity-restarted:${manifest!.runId}`; }
          if (!restarted) throw new Error('capacity_competition_restart_unproved');
          reply.value.acceptedAt = Date.now();
        }
        return capacityStepResponse(reply.value, { authMs: authorityStart - authStart, authorityMs: performance.now() - authorityStart,
          ...(reply.nativeTiming ? { native: { sentAt, ...reply.nativeTiming, receivedAt } } : {}) });
      };
      // Match the product's isolate gate after funding ingress and before D1.
      // A shed request remains an ordinary, expected registration denial.
      return await (capacityStep(step!).action === 'register'
        ? arenaRegistrationAdmission.run(admitted, () => capacityStepResponse({ index: step!, accepted: false,
          acceptedAt: null, code: 'ARENA_RETRY', httpStatus: 429 }, { authMs: 0, authorityMs: 0 }))
        : admitted());
    } catch (error) {
      if (error instanceof ApiError) return Response.json({ code: error.code }, { status: error.status, headers: noStore });
      failed = true;
      ingress?.stop();
      // The frozen controller plan includes this one denied/failed-isolate
      // signal. A lost stop reply never returns any prepaid work.
      try { await control.stop(); } catch { /* Preserve the original failure. */ }
      return capacityFailureResponse(error);
    }
  },
};
