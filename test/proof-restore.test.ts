import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';
import { captureProofRestoreD1 } from '../src/server/proof-recovery-drill';

it('includes accepted admission stops in the private D1 restore boundary', async () => {
  await env.DB.prepare("UPDATE operations_control SET games_stopped=0 WHERE id='product'").run();
  const before = await captureProofRestoreD1(env.DB);
  await env.DB.prepare("UPDATE operations_control SET games_stopped=1 WHERE id='product'").run();
  const later = await captureProofRestoreD1(env.DB);
  expect(before.authority.sha256).not.toBe(later.authority.sha256);
});
