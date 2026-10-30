import type { BudgetEnv } from './budget';
import { stopNewWorkAutomatically } from './operations';
import { ApiError, jsonResponse, readJson } from './security';

export interface BudgetWebhookEnv extends BudgetEnv { BUDGET_STOP_WEBHOOK_SECRET?: string }
const MAX_BODY_BYTES = 8_192;

/** Cloudflare's generic webhook contract has text, not a trusted dollar amount. */
export async function budgetStopWebhook(request: Request, env: BudgetWebhookEnv): Promise<Response> {
  const secret = env.BUDGET_STOP_WEBHOOK_SECRET;
  if (!secret || !/^[A-Za-z0-9_-]{32,128}$/.test(secret)) throw new ApiError(404, 'NOT_FOUND', 'This endpoint is unavailable.');
  if (request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use POST for this endpoint.');
  const provided = request.headers.get('cf-webhook-auth');
  if (!provided || provided.length > 128) throw new ApiError(403, 'WEBHOOK_AUTH_REQUIRED', 'Webhook authentication failed.');
  const encoder = new TextEncoder();
  const [expected, actual] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(secret)),
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
  ]);
  if (!crypto.subtle.timingSafeEqual(expected, actual)) throw new ApiError(403, 'WEBHOOK_AUTH_REQUIRED', 'Webhook authentication failed.');

  // Authenticate before reading the body or touching D1. Provider metadata and
  // message text are never logged, stored, returned, or used to reopen work.
  const body = await readJson(request, MAX_BODY_BYTES);
  if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4_096) {
    throw new ApiError(400, 'INVALID_NOTIFICATION', 'Send a bounded generic notification with text.');
  }
  await stopNewWorkAutomatically(env);
  return jsonResponse({ ok: true, stopped: true });
}
