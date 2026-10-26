import { SignJWT, jwtVerify } from 'jose';
import { CAPACITY_BINDING_HEADER, CAPACITY_CORPUS, capacityAccountId, capacityEventId, capacityIntent } from '../shared/capacity-corpus';
import type { CapacityBoundIntent } from './capacity-intents';
import type { CapacityManifest } from './capacity-run';

export { CAPACITY_BINDING_HEADER };
const ISSUER = 'ejm-chess-capacity-binding-v1';
const encoder = new TextEncoder();
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const BINDING_KEYS = ['intentIndex', 'eventIndex', 'eventId', 'gameId', 'reservationId',
  'whiteId', 'blackId', 'whiteAccountIndex', 'blackAccountIndex', 'generation', 'workflowNonce'];

/** Mint only after the controller has durably prepaid the fixed Game workflow. */
export interface CapacityBindingAuthorization extends CapacityBoundIntent {
  generation: number;
  workflowNonce: string;
}

function key(secret: string): Uint8Array {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('capacity_binding_secret_invalid');
  return encoder.encode(secret);
}

function validate(value: unknown, manifest: CapacityManifest, expectedIndex: number): CapacityBindingAuthorization {
  const intent = capacityIntent(expectedIndex);
  if (!value || typeof value !== 'object') throw new Error('capacity_binding_invalid');
  const binding = value as CapacityBindingAuthorization;
  const first = intent.eventIndex * CAPACITY_CORPUS.accountsPerEvent;
  if (Object.keys(value).length !== BINDING_KEYS.length || BINDING_KEYS.some(name => !Object.hasOwn(value, name))
    || binding.intentIndex !== expectedIndex || binding.eventIndex !== intent.eventIndex
    || binding.eventId !== capacityEventId(intent.eventIndex, manifest.earliestArmAt)
    || !UUID.test(binding.gameId) || !UUID.test(binding.reservationId) || !UUID.test(binding.workflowNonce)
    || !Number.isSafeInteger(binding.generation) || binding.generation < 1
    || !Number.isSafeInteger(binding.whiteAccountIndex) || !Number.isSafeInteger(binding.blackAccountIndex)
    || binding.whiteAccountIndex === binding.blackAccountIndex
    || [binding.whiteAccountIndex, binding.blackAccountIndex].some(index => index < first || index >= first + CAPACITY_CORPUS.accountsPerEvent)
    || binding.whiteId !== capacityAccountId(binding.whiteAccountIndex)
    || binding.blackId !== capacityAccountId(binding.blackAccountIndex)) throw new Error('capacity_binding_invalid');
  return binding;
}

export async function signCapacityBinding(binding: CapacityBindingAuthorization, manifest: CapacityManifest,
  secret: string): Promise<string> {
  validate(binding, manifest, binding.intentIndex);
  return new SignJWT({ manifestDigest: manifest.digest, sourceDigest: manifest.sourceDigest,
    configDigest: manifest.configDigest, binding })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer(ISSUER).setAudience(manifest.runId)
    .setJti(binding.workflowNonce).setExpirationTime(Math.floor(manifest.hardCloseAt / 1_000)).sign(key(secret));
}

/** Verify before namespace lookup, then reverify inside the admitted Game meter. */
export async function readCapacityBinding(request: Request, manifest: CapacityManifest, secret: string,
  expectedIntentIndex: number): Promise<CapacityBindingAuthorization> {
  const proof = request.headers.get(CAPACITY_BINDING_HEADER);
  if (!proof || proof.length > 2_048) throw new Error('capacity_binding_invalid');
  try {
    const { payload, protectedHeader } = await jwtVerify(proof, key(secret), { algorithms: ['HS256'], issuer: ISSUER,
      audience: manifest.runId, currentDate: new Date(Date.now()),
      requiredClaims: ['exp', 'iss', 'aud', 'jti', 'manifestDigest', 'sourceDigest', 'configDigest', 'binding'] });
    const binding = validate(payload.binding, manifest, expectedIntentIndex);
    if (protectedHeader.typ !== 'JWT' || payload.manifestDigest !== manifest.digest
      || payload.sourceDigest !== manifest.sourceDigest || payload.configDigest !== manifest.configDigest
      || payload.exp !== Math.floor(manifest.hardCloseAt / 1_000) || payload.jti !== binding.workflowNonce) {
      throw new Error('capacity_binding_invalid');
    }
    return binding;
  } catch {
    throw new Error('capacity_binding_invalid');
  }
}
