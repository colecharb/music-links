import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext, type D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import type { FetchFn } from '../src/http';
import type { ResolvedEntry } from '../src/types';

const SP_ID = '2qQ3IRCPx3aESBFomT2n2N';

const ENTRY: ResolvedEntry = {
  kind: 'track',
  title: 'Ouelli El Darek',
  artist: 'Khaled',
  album: 'Sahra',
  durationMs: 189360,
  releaseYear: 1996,
  art: 'https://i.scdn.co/image/ab67616d0000b273e1b1864f0ac9fc86215c3c85',
  resolvedAt: '2026-10-26T00:00:00.000Z',
  appleMode: 'itunes',
  links: {
    spotify: { url: `https://open.spotify.com/track/${SP_ID}`, match: 'exact' },
    apple: { url: 'https://music.apple.com/song/1444130134', match: 'fuzzy' },
    deezer: { url: 'https://www.deezer.com/track/515038112', match: 'fuzzy' },
    youtubeMusic: { url: 'https://music.youtube.com/search?q=Ouelli%20El%20Darek%20Khaled', match: 'search' },
    amazon: { url: 'https://music.amazon.com/search/Ouelli%20El%20Darek%20Khaled', match: 'search' },
  },
};

/** Upstream fetch that fails the test if called. */
const noUpstream: FetchFn = async (url) => {
  throw new Error(`unexpected upstream call: ${url}`);
};

async function request(path: string, init: RequestInit = {}, fetchFn: FetchFn = noUpstream, origin = 'http://localhost') {
  const app = createApp({ fetch: fetchFn });
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(origin + path, { redirect: 'manual', ...init }), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.LINKS.put(`sp:t:${SP_ID}`, JSON.stringify(ENTRY));
});

describe('home', () => {
  it('renders the form', async () => {
    const res = await request('/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="u"');
  });

  it('redirects a submitted link to its canonical path', async () => {
    const u = encodeURIComponent(`https://open.spotify.com/intl-fr/track/${SP_ID}?si=abc`);
    const res = await request(`/?u=${u}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/sp/t/${SP_ID}`);
  });

  it.each(['not a link', 'https://example.com/song/1', 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'])(
    're-renders the form with an error for %s',
    async (u) => {
      const res = await request(`/?u=${encodeURIComponent(u)}`);
      expect(res.status).toBe(400);
      const html = await res.text();
      expect(html).toContain('role="alert"');
      expect(html).toContain('name="u"');
    },
  );
});

describe('prefix trick', () => {
  it.each([
    `/https://open.spotify.com/track/${SP_ID}`,
    `/https://open.spotify.com/track/${SP_ID}?si=123`,
    `/open.spotify.com/track/${SP_ID}`,
    `/${encodeURIComponent(`https://open.spotify.com/track/${SP_ID}`)}`,
  ])('%s -> 301 canonical', async (path) => {
    const res = await request(path);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(`/sp/t/${SP_ID}`);
  });

  it('keeps the embedded query string (Apple ?i= track links)', async () => {
    const res = await request('/https://music.apple.com/us/album/sahra/1444129774?i=1444130134');
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/am/t/1444130134');
  });

  it('404s for paths that are not links', async () => {
    expect((await request('/favicon.ico')).status).toBe(404);
  });
});

describe('share page', () => {
  it('serves a cache hit without upstream calls and with preview tags', async () => {
    const res = await request(`/sp/t/${SP_ID}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('og:title');
    expect(html).toContain('Ouelli El Darek — Khaled');
    expect(html).toContain(ENTRY.art);
    expect(html).toContain(`/go/apple/sp/t/${SP_ID}`);
    expect(new TextEncoder().encode(html).length).toBeLessThan(15000);
  });

  it('redirects to the preferred service when its match is direct', async () => {
    const res = await request(`/sp/t/${SP_ID}`, { headers: { cookie: 'pref=apple' } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(ENTRY.links.apple.url);
  });

  it('stays on the page with ?stay', async () => {
    const res = await request(`/sp/t/${SP_ID}?stay`, { headers: { cookie: 'pref=apple' } });
    expect(res.status).toBe(200);
  });

  it('never auto-redirects to a search link', async () => {
    const res = await request(`/sp/t/${SP_ID}`, { headers: { cookie: 'pref=youtubeMusic' } });
    expect(res.status).toBe(200);
  });

  it('ignores unknown preference values', async () => {
    const res = await request(`/sp/t/${SP_ID}`, { headers: { cookie: 'pref=napster' } });
    expect(res.status).toBe(200);
  });

  it('falls through to the prefix handler for invalid ids', async () => {
    expect((await request('/sp/t/short')).status).toBe(404);
  });

  it('shows not-found when the source item does not exist', async () => {
    const fetchFn: FetchFn = async () =>
      new Response('<html><head><title>Spotify</title></head><body></body></html>', {
        status: 404,
        headers: { 'content-type': 'text/html' },
      });
    const res = await request('/sp/t/0000000000000000000000', {}, fetchFn);
    expect(res.status).toBe(404);
    expect(await env.LINKS.get('sp:t:0000000000000000000000')).toBeNull();
  });

  it('shows a retry page and caches nothing when the source is unreachable', async () => {
    const fetchFn: FetchFn = async () => {
      throw new TypeError('network down');
    };
    const res = await request('/sp/t/1111111111111111111111', {}, fetchFn);
    expect(res.status).toBe(502);
    expect(await env.LINKS.get('sp:t:1111111111111111111111')).toBeNull();
  });
});

describe('go route', () => {
  it('sets the preference cookie and redirects to the stored link', async () => {
    const res = await request(`/go/deezer/sp/t/${SP_ID}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(ENTRY.links.deezer.url);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^pref=deezer;/);
    expect(cookie).toMatch(/Max-Age=31536000/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).not.toMatch(/Secure/);
  });

  it('marks the cookie Secure over https', async () => {
    const res = await request(`/go/deezer/sp/t/${SP_ID}`, {}, noUpstream, 'https://links.example');
    expect(res.headers.get('set-cookie')).toMatch(/Secure/);
  });

  it('also redirects to search links', async () => {
    const res = await request(`/go/amazon/sp/t/${SP_ID}`);
    expect(res.headers.get('location')).toBe(ENTRY.links.amazon.url);
  });

  it('404s for unknown services', async () => {
    expect((await request(`/go/napster/sp/t/${SP_ID}`)).status).toBe(404);
  });
});

describe('debug api', () => {
  it('is disabled unless DEBUG_API=1', async () => {
    expect((await request(`/api/resolve/sp/t/${SP_ID}`)).status).toBe(404);
  });
});
