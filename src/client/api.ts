export class RequestFailure extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}

export async function api<T>(path: string, body?: unknown, token?: string): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Turnstile-Token': token } : {}) }, body: JSON.stringify(body) }),
  });
  const data = await response.json() as { error?: string; message?: string };
  if (!response.ok) throw new RequestFailure(response.status, data.message || data.error || `Request failed (${response.status}). Try again.`, data.error);
  return data as T;
}

export interface PublicConfig { ranked: boolean; ai: boolean; tournaments: boolean; reviewAvailable: boolean; turnstileSiteKey: string | null; local: boolean }
export interface Me { id: string; name: string; username: string | null; accountReady: boolean; hasRecoveryEmail: boolean; isAnonymous: boolean; emailVerified: boolean }
