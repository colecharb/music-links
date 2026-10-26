import { it, expect } from 'vitest';
import { FIXTURES, fixtureCtx } from './helpers/fixtures';
import { fetchWithTimeout } from '../src/http';

it('replays recorded fixtures through the injected fetch', async () => {
  expect(FIXTURES.size).toBeGreaterThan(0);
  const ctx = fixtureCtx();
  const res = await fetchWithTimeout(ctx, 'https://open.spotify.com/track/2qQ3IRCPx3aESBFomT2n2N');
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('og:title');
  await expect(fetchWithTimeout(ctx, 'https://example.com/none')).rejects.toThrow(/No fixture/);
});
