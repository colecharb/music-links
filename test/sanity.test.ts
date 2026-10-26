import { env, applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { it, expect } from 'vitest';

it('boots the default worker export and applies migrations', async () => {
  const res = await exports.default.fetch('http://example.com/');
  expect(res.status).toBe(200);
  await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  const r = await env.DB.prepare('select count(*) as n from misses').first<{ n: number }>();
  expect(r?.n).toBe(0);
});
