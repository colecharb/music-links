import { env, applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { it, expect } from 'vitest';

it('boots the worker and applies migrations', async () => {
  const res = await exports.default.fetch('http://example.com/');
  expect(await res.text()).toBe('ok');
  await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  const r = await env.DB.prepare('select count(*) as n from misses').first<{ n: number }>();
  expect(r?.n).toBe(0);
});
