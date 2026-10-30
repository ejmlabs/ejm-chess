import type { Color } from '../shared/protocol';

/** Private timeout proof protocol. These ceilings do not qualify the provider. */
export const PROOF_RULES_VERSION = 'online-2026-10-v3-proof';
export const PROOF_PROFILE = 'cha-native-3484c7e6-v1';
export const PROOF_SOLVER_COMMIT = '3484c7e65247003fac8705a9290dc2b5d0978b94';
export const PROOF_VALIDATOR_VERSION = 'python-chess-1.11.2-online-v1';
export const PROOF_INSTANCE = 'timeout-proof-v1-singleton';
export const PROOF_SLOTS = 4;
export const PROOF_REQUEST_BYTES = 131_072;
export const PROOF_RESULT_BYTES = 16_384;
export const PROOF_WAIT_MS = 30_000;
export const PROOF_MAX_PLIES = 12_700;
export const PROOF_MAX_WITNESS = 512;

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const DIGEST = /^[a-f0-9]{64}$/;
const REASONS = ['solver-undetermined', 'resource-limit', 'invalid-input', 'invalid-output', 'invalid-witness',
  'unsupported-policy', 'expired', 'transient-start', 'interrupted'] as const;
export type ProofReason = typeof REASONS[number];

export interface TimeoutProofRequest {
  v: 1;
  rulesVersion: typeof PROOF_RULES_VERSION;
  profileVersion: typeof PROOF_PROFILE;
  gameId: string;
  reservationId: string;
  pendingVersion: number;
  requestId: string;
  survivor: Color;
  initialFen: string;
  fen: string;
  moves: string[];
  historyDigest: string;
  positionDigest: string;
  expiresAt: number;
  attempt: 1 | 2;
}

export interface TimeoutProofResult extends Omit<TimeoutProofRequest, 'initialFen' | 'fen' | 'moves'> {
  solverCommit: typeof PROOF_SOLVER_COMMIT;
  validatorVersion: typeof PROOF_VALIDATOR_VERSION;
  verdict: 'winnable' | 'unwinnable' | 'unknown';
  witness: string[];
  reason: ProofReason | null;
}

const REQUEST_FIELDS = ['v', 'rulesVersion', 'profileVersion', 'gameId', 'reservationId', 'pendingVersion', 'requestId',
  'survivor', 'initialFen', 'fen', 'moves', 'historyDigest', 'positionDigest', 'expiresAt', 'attempt'];
const IDENTITY_FIELDS = REQUEST_FIELDS.filter(key => !['initialFen', 'fen', 'moves'].includes(key));
const RESULT_FIELDS = [...IDENTITY_FIELDS, 'solverCommit', 'validatorVersion', 'verdict', 'witness', 'reason'];

function record(value: unknown, fields: string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)));
}

function validIdentity(item: Record<string, unknown>): boolean {
  return item.v === 1 && item.rulesVersion === PROOF_RULES_VERSION && item.profileVersion === PROOF_PROFILE
    && typeof item.gameId === 'string' && /^[\w-]{8,100}$/.test(item.gameId) && item.reservationId === item.gameId
    && Number.isSafeInteger(item.pendingVersion) && Number(item.pendingVersion) > 0
    && item.requestId === `timeout:${item.gameId}:${item.pendingVersion}` && (item.survivor === 'w' || item.survivor === 'b')
    && typeof item.historyDigest === 'string' && DIGEST.test(item.historyDigest)
    && typeof item.positionDigest === 'string' && DIGEST.test(item.positionDigest)
    && Number.isSafeInteger(item.expiresAt) && Number(item.expiresAt) > 0 && (item.attempt === 1 || item.attempt === 2);
}

export function parseProofRequest(value: unknown): TimeoutProofRequest | null {
  if (!record(value, REQUEST_FIELDS) || !validIdentity(value)
    || !['initialFen', 'fen'].every(key => typeof value[key] === 'string' && /^[\x20-\x7e]{1,128}$/.test(value[key] as string))
    || !Array.isArray(value.moves) || value.moves.length > PROOF_MAX_PLIES
    || !value.moves.every(move => typeof move === 'string' && UCI.test(move))) return null;
  return value as unknown as TimeoutProofRequest;
}

export function parseProofResult(value: unknown, request: TimeoutProofRequest): TimeoutProofResult | null {
  if (!record(value, RESULT_FIELDS) || !validIdentity(value)
    || !IDENTITY_FIELDS.every(key => value[key] === request[key as keyof TimeoutProofRequest])
    || value.solverCommit !== PROOF_SOLVER_COMMIT || value.validatorVersion !== PROOF_VALIDATOR_VERSION
    || !['winnable', 'unwinnable', 'unknown'].includes(String(value.verdict))
    || !Array.isArray(value.witness) || value.witness.length > PROOF_MAX_WITNESS
    || !value.witness.every(move => typeof move === 'string' && UCI.test(move))) return null;
  if (value.verdict === 'winnable' ? value.witness.length === 0 || value.reason !== null
    : value.witness.length !== 0 || (value.verdict === 'unwinnable' ? value.reason !== null : !REASONS.includes(value.reason as ProofReason))) return null;
  return value as unknown as TimeoutProofResult;
}

export async function proofHash(value: unknown[]): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function proofDigests(input: Pick<TimeoutProofRequest, 'initialFen' | 'moves' | 'rulesVersion' | 'gameId' | 'pendingVersion' | 'fen' | 'survivor'>) {
  const historyDigest = await proofHash([input.initialFen, input.moves]);
  const positionDigest = await proofHash([input.rulesVersion, input.gameId, input.pendingVersion, input.fen, input.survivor, historyDigest]);
  return { historyDigest, positionDigest };
}

export function unknownProof(request: TimeoutProofRequest, reason: ProofReason): TimeoutProofResult {
  const { initialFen: _initial, fen: _fen, moves: _moves, ...identity } = request;
  return { ...identity, solverCommit: PROOF_SOLVER_COMMIT, validatorVersion: PROOF_VALIDATOR_VERSION,
    verdict: 'unknown', witness: [], reason };
}

export function transientProof(result: TimeoutProofResult): boolean {
  return result.verdict === 'unknown' && (result.reason === 'transient-start' || result.reason === 'interrupted');
}
