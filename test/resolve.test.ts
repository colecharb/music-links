// Fixture-based integration: full resolutions replayed from responses recorded by
// `npm run smoke -- --record` (test/fixtures/http). Deterministic and offline.
import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext, type D1Migration } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { parseMusicUrl } from '../src/parse';
import { resolveRef } from '../src/resolve';
import { TTL_COMPLETE_SECONDS, TTL_PARTIAL_SECONDS, ttlFor } from '../src/store';
import { SERVICES, type SourceRef } from '../src/types';
import { TEST_LINKS } from '../scripts/test-links';
import { fixtureCtx, fixtureFetch, FIXTURES } from './helpers/fixtures';

/** Expected `outcome:via:id` for Apple and Deezer, verified by hand against the live smoke run. */
const EXPECTED: Record<string, { apple: string; deezer: string }> = {
  // Khaled: Apple has the same-album (Sahra) recording; Deezer only has it on Best Of. Live versions rejected.
  'sp:t:2qQ3IRCPx3aESBFomT2n2N': { apple: 'fuzzy:search:1444130134', deezer: 'fuzzy:search:515038112' },
  'sp:t:7tFiyTwD0nx5a1eklYtX2J': { apple: 'fuzzy:search:6781024437', deezer: 'fuzzy:search:4091937401' },
  // Radio edit: Apple's catalog search has only the album version and remixes (rejected by duration/version).
  'sp:t:2Foc5Q5nqNiosCNqttzHof': { apple: 'search:search-url:', deezer: 'fuzzy:search:66609426' },
  'sp:t:6rPO02ozF3bM7NnOV4h6s2': { apple: 'fuzzy:search:1447401626', deezer: 'fuzzy:search:623698182' },
  'sp:t:03UrZgTINDqvnUMbbIMhql': { apple: 'fuzzy:search:1445144527', deezer: 'fuzzy:search:60726278' },
  // Live: both point at the same Del Mar 1991 recording on From the Muddy Banks of the Wishkah.
  'sp:t:6mpyO7bJaCrHzE0iQEtZiN': { apple: 'fuzzy:search:1440917612', deezer: 'fuzzy:search:1105768' },
  'sp:t:0VjIjW4GlUZAMYd2vXMi3b': { apple: 'fuzzy:search:1499386265', deezer: 'fuzzy:search:908604612' },
  // Albums: Apple by the UPC of the Deezer match, re-verified with the full rules.
  'sp:a:4m2880jivSbbyEGAKfITCa': { apple: 'exact:upc:617154241', deezer: 'fuzzy:search:6575789' },
  'sp:a:5eA0qtE7Yu29XiMlwoby2G': { apple: 'exact:upc:1586410660', deezer: 'fuzzy:search:270615252' },
  'am:t:1440893075': { apple: 'exact:source:1440893075', deezer: 'fuzzy:search:1105746' },
  'am:a:1444129774': { apple: 'exact:source:1444129774', deezer: 'fuzzy:search:155932012' },
  'dz:t:824731152': { apple: 'fuzzy:search:1490256995', deezer: 'exact:source:824731152' },
  'dz:t:448260732': { apple: 'fuzzy:search:1333011553', deezer: 'exact:source:448260732' },
  'dz:t:4304169612': { apple: 'fuzzy:search:6814997425', deezer: 'exact:source:4304169612' },
  'dz:t:96996588': { apple: 'fuzzy:search:975981523', deezer: 'exact:source:96996588' },
  'dz:a:1002561451': { apple: 'fuzzy:search:6779097512', deezer: 'exact:source:1002561451' },
  // No duration from YouTube: Deezer's only candidate is the 2023 "(Pianoforte)" re-recording -> search link.
  'yt:t:dQw4w9WgXcQ': { apple: 'fuzzy:search:1559885421', deezer: 'search:search-url:' },
  'yt:t:lYBUbBu4W08': { apple: 'fuzzy:search:1559885421', deezer: 'search:search-url:' },
};

function refOf(url: string): SourceRef {
  const p = parseMusicUrl(url);
  if (p.type !== 'ref') throw new Error(`not a ref: ${url}`);
  return p.ref;
}

describe('recorded resolutions', () => {
  it('covers every test link', () => {
    const keys = TEST_LINKS.map((l) => refOf(l.url)).map((r) => `${r.platform}:${r.kind[0]}:${r.id}`);
    expect(keys.sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(TEST_LINKS.map((l) => [l.why, l.url] as const))('%s', async (_why, url) => {
    const ref = refOf(url);
    const r = await resolveRef(fixtureCtx(), ref);
    const got = Object.fromEntries(
      (['apple', 'deezer'] as const).map((s) => [s, `${r.details[s].outcome}:${r.details[s].via}:${r.details[s].item?.id ?? ''}`]),
    );
    expect(got).toEqual(EXPECTED[r.key]);

    // Every service gets a link; direct links point at the matched item, everything else is a search.
    for (const service of SERVICES) {
      const link = r.entry.links[service];
      const d = r.details[service];
      expect(link).toEqual({ url: d.url, match: d.match });
      if (d.match === 'search') expect(d.item).toBeUndefined();
      else expect(link.url).toBe(d.item?.url);
    }
    expect(r.entry.appleMode).toBe('itunes');
    expect(r.entry.title).toBe(r.source.title);

    // Misses: every non-exact Apple/Deezer outcome that wasn't the source itself.
    const expectedMisses = (['apple', 'deezer'] as const).filter(
      (s) => r.details[s].via !== 'source' && r.details[s].outcome !== 'exact',
    );
    expect(r.misses.map((m) => m.service).sort()).toEqual([...expectedMisses].sort());
    for (const m of r.misses) {
      expect(m.source_key).toBe(r.key);
      expect(m.outcome).toBe(r.details[m.service].outcome);
    }
  });
});

describe('entry details', () => {
  it('caches for 30 days when Apple and Deezer both have direct links, 6 hours otherwise', async () => {
    const full = await resolveRef(fixtureCtx(), refOf('https://open.spotify.com/track/2qQ3IRCPx3aESBFomT2n2N'));
    expect(ttlFor(full.entry)).toBe(TTL_COMPLETE_SECONDS);
    const partial = await resolveRef(fixtureCtx(), refOf('https://open.spotify.com/track/2Foc5Q5nqNiosCNqttzHof'));
    expect(ttlFor(partial.entry)).toBe(TTL_PARTIAL_SECONDS);
  });

  it('logs the best rejected candidate and its reason for a search outcome', async () => {
    const r = await resolveRef(fixtureCtx(), refOf('https://open.spotify.com/track/2Foc5Q5nqNiosCNqttzHof'));
    const miss = r.misses.find((m) => m.service === 'apple');
    expect(miss).toMatchObject({ outcome: 'search', source_title: r.source.title, source_duration_ms: 247632 });
    expect(miss?.candidate_title).toBeTruthy();
    expect(miss?.note).toMatch(/duration|version/);
  });

  it('uses square cover art from a match instead of a YouTube video thumbnail', async () => {
    const r = await resolveRef(fixtureCtx(), refOf('https://www.youtube.com/watch?v=dQw4w9WgXcQ'));
    expect(r.source.art).toMatch(/ytimg\.com/);
    expect(r.entry.art).toMatch(/mzstatic\.com/);
  });

  it('keeps the derived identifiers of exact matches', async () => {
    const r = await resolveRef(fixtureCtx(), refOf('https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa'));
    expect(r.entry.upc).toBeTruthy();
  });
});

describe('failure isolation', () => {
  const KHALED = refOf('https://open.spotify.com/track/2qQ3IRCPx3aESBFomT2n2N');
  const appleUrls = [...FIXTURES.keys()].filter((u) => u.startsWith('https://itunes.apple.com/search?term=Khaled'));

  it('an Apple failure only affects Apple', async () => {
    expect(appleUrls.length).toBeGreaterThan(0);
    const extra = appleUrls.map((url) => ({ request: { url }, response: { status: 503, body: 'down' } }));
    const r = await resolveRef(fixtureCtx({ extra }), KHALED);
    expect(r.details.apple).toMatchObject({ outcome: 'error', match: 'search' });
    expect(r.details.apple.url).toMatch(/^https:\/\/music\.apple\.com\/search\?term=/);
    expect(r.details.deezer).toMatchObject({ outcome: 'fuzzy' });
    expect(r.misses.find((m) => m.service === 'apple')).toMatchObject({ outcome: 'error' });
    expect(ttlFor(r.entry)).toBe(TTL_PARTIAL_SECONDS);
  });

  it('a hung upstream times out instead of hanging the page', async () => {
    const hang: typeof fetch = (input, init) =>
      String(input).includes('api.deezer.com')
        ? new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
        : fixtureFetch()(String(input), init);
    const r = await resolveRef({ ...fixtureCtx(), fetch: hang, timeoutMs: 50 }, KHALED);
    expect(r.details.deezer.outcome).toBe('error');
    expect(r.details.apple.outcome).toBe('fuzzy');
  });
});

describe('routes on a cache miss', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  });

  it('resolves, renders, caches with the TTL and logs misses', async () => {
    const app = createApp({ fetch: fixtureFetch() });
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request('http://localhost/sp/t/2qQ3IRCPx3aESBFomT2n2N'), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/go/apple/sp/t/2qQ3IRCPx3aESBFomT2n2N"');
    expect(html).toContain('property="og:title" content="Ouelli El Darek — Khaled"');

    const { keys } = await env.LINKS.list({ prefix: 'sp:t:2qQ3IRCPx3aESBFomT2n2N' });
    expect(keys).toHaveLength(1);
    const ttl = (keys[0]?.expiration ?? 0) - Date.now() / 1000;
    expect(ttl).toBeGreaterThan(TTL_COMPLETE_SECONDS - 60);

    const rows = await env.DB.prepare('select service, outcome from misses where source_key = ? order by service')
      .bind('sp:t:2qQ3IRCPx3aESBFomT2n2N')
      .all<{ service: string; outcome: string }>();
    expect(rows.results).toEqual([
      { service: 'apple', outcome: 'fuzzy' },
      { service: 'deezer', outcome: 'fuzzy' },
    ]);

    // The button click that follows needs no upstream call.
    const go = await app.fetch(new Request('http://localhost/go/deezer/sp/t/2qQ3IRCPx3aESBFomT2n2N'), env, createExecutionContext());
    expect(go.status).toBe(302);
    expect(go.headers.get('location')).toBe('https://www.deezer.com/track/515038112');
  });
});
