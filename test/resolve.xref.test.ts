// Direct Spotify links learned from Spotify-sourced resolutions (src/xref.ts): resolution with an
// in-memory cross-reference, and the route-level flows on D1 + KV with recorded fixtures.
import { env, applyD1Migrations, createExecutionContext, waitOnExecutionContext, type D1Migration } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '../src/http';
import { createApp } from '../src/index';
import { resolveRef, xrefIdentifiers, XREF_LOOKUP_TIMEOUT_MS, type ResolveResult } from '../src/resolve';
import { getSpotifyItem } from '../src/sources/spotify';
import { readEntry, writeEntry } from '../src/store';
import type { ItemMeta, SourceRef, TrackMeta } from '../src/types';
import { fixtureCtx, fixtureFetch } from './helpers/fixtures';
import { itunesRecord, ITUNES, musicKit, songFixture } from './helpers/musickit';
import { d1Xref, recordXref } from '../src/xref';
import { MemoryXref } from './helpers/xref';

const sp = (kind: 'track' | 'album', id: string): SourceRef => ({ platform: 'sp', kind, id });
const dz = (kind: 'track' | 'album', id: string): SourceRef => ({ platform: 'dz', kind, id });
const am = (kind: 'track' | 'album', id: string): SourceRef => ({ platform: 'am', kind, id });

// "Blinding Lights": the Spotify test link and its Deezer match (a Deezer test link too), ISRC USUG11904206.
const SP_BLINDING = '0VjIjW4GlUZAMYd2vXMi3b';
const DZ_BLINDING = '908604612';
const BLINDING_ISRC = 'USUG11904206';
const SP_URL = `https://open.spotify.com/track/${SP_BLINDING}`;

const spotifyTrack = async (id = SP_BLINDING) => (await getSpotifyItem(fixtureCtx(), 'track', id)) as TrackMeta;
const spotifyOutcome = (r: ResolveResult) => `${r.details.spotify.outcome}:${r.details.spotify.via}:${r.details.spotify.item?.id ?? ''}`;
const describeSpotify = (r: ResolveResult) => JSON.stringify({ ...r.details.spotify, item: r.details.spotify.item?.title });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolving with learned Spotify mappings', () => {
  it('learned from the recorded Spotify resolution, the Deezer link of the same recording gets a direct Spotify link', async () => {
    const xref = new MemoryXref();
    const spotifySourced = await resolveRef(fixtureCtx(), sp('track', SP_BLINDING), { xref });
    expect(xref.lookups, 'a Spotify source never looks itself up').toEqual([]);
    expect(spotifySourced.details.spotify.via).toBe('source');
    const ids = xrefIdentifiers(spotifySourced);
    expect(ids).toEqual([BLINDING_ISRC]);
    await xref.learn(spotifySourced.source, ids);

    const r = await resolveRef(fixtureCtx(), dz('track', DZ_BLINDING), { xref });
    expect(spotifyOutcome(r), describeSpotify(r)).toBe(`fuzzy:xref:${SP_BLINDING}`);
    expect(r.details.spotify).toMatchObject({ match: 'fuzzy', url: SP_URL, identifier: BLINDING_ISRC });
    expect(r.details.spotify.score).toBeGreaterThanOrEqual(0.7);
    expect(r.entry.links.spotify).toEqual({ url: SP_URL, match: 'fuzzy' });
    // Unchanged: the other services, and Spotify outcomes stay out of the misses log.
    expect(r.details.deezer.via).toBe('source');
    expect(r.details.apple.outcome).toBe('fuzzy');
    expect(r.misses.map((m) => m.service)).toEqual(['apple']);
    expect(xref.lookups).toEqual([[BLINDING_ISRC]]);
  });

  it('the source identifier is looked up right away, before any matching request', async () => {
    const calls: string[] = [];
    const xref = new MemoryXref().set('track', BLINDING_ISRC, await spotifyTrack());
    let callsAtLookup = -1;
    xref.onLookup = () => {
      callsAtLookup = calls.length;
    };
    await resolveRef(fixtureCtx({ calls }), dz('track', DZ_BLINDING), { xref });
    expect(callsAtLookup, calls.join(' ')).toBe(1);
    expect(calls[0]).toBe(`https://api.deezer.com/track/${DZ_BLINDING}`);
  });

  it.each<[string, (t: TrackMeta) => ItemMeta, RegExp]>([
    ['a live version', (t) => ({ ...t, title: `${t.title} (Live)`, album: 'Live At SoFi Stadium' }), /live/],
    ['a 5 s duration gap', (t) => ({ ...t, durationMs: (t.durationMs ?? 0) + 5000 }), /duration/],
    ['another artist', (t) => ({ ...t, artists: ['Loren Allred'], artist: 'Loren Allred' }), /artist/],
    ['an album', (t) => ({ kind: 'album', id: t.id, url: t.url, title: 'After Hours', artists: t.artists, artist: t.artist }), /^$/],
  ])('a mapped Spotify item that fails the fuzzy rules is a search link: %s', async (_why, vary, reason) => {
    const xref = new MemoryXref().set('track', BLINDING_ISRC, vary(await spotifyTrack()));
    const r = await resolveRef(fixtureCtx(), dz('track', DZ_BLINDING), { xref });
    expect(spotifyOutcome(r), describeSpotify(r)).toBe('search:search-url:');
    expect(r.details.spotify.url).toMatch(/^https:\/\/open\.spotify\.com\/search\//);
    expect(r.entry.links.spotify.match).toBe('search');
    if (reason.source !== '^$') {
      expect(r.details.spotify.rejected?.item.id).toBe(SP_BLINDING);
      expect(r.details.spotify.rejected?.reason).toMatch(reason);
    }
    expect(r.misses.some((m) => m.service === 'spotify')).toBe(false);
  });

  it('a failing lookup is a search link with a note; nothing else changes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const plain = await resolveRef(fixtureCtx(), dz('track', DZ_BLINDING));
    const xref = new MemoryXref();
    xref.onLookup = () => {
      throw new Error('D1_ERROR: no such table');
    };
    const r = await resolveRef(fixtureCtx(), dz('track', DZ_BLINDING), { xref });
    expect(spotifyOutcome(r)).toBe('search:search-url:');
    expect(r.details.spotify.note).toMatch(/xref lookup failed: D1_ERROR/);
    expect(r.entry.links).toEqual(plain.entry.links);
    expect(r.misses).toEqual(plain.misses);
  });

  it('a lookup that throws synchronously is a search link too', async () => {
    const xref = new MemoryXref();
    xref.lookup = () => {
      throw new Error('binding missing');
    };
    const r = await resolveRef(fixtureCtx(), dz('track', DZ_BLINDING), { xref });
    expect(spotifyOutcome(r)).toBe('search:search-url:');
  });

  it('a hung lookup times out into a search link', async () => {
    const xref = new MemoryXref().set('track', BLINDING_ISRC, await spotifyTrack());
    xref.onLookup = () => new Promise<void>(() => {});
    const t0 = Date.now();
    const r = await resolveRef(fixtureCtx(), dz('track', DZ_BLINDING), { xref });
    expect(spotifyOutcome(r)).toBe('search:search-url:');
    expect(r.details.spotify.note).toMatch(/timeout/);
    expect(Date.now() - t0).toBeLessThan(XREF_LOOKUP_TIMEOUT_MS + 2000);
  });

  describe('source and derived identifiers', () => {
    // Apple (MusicKit) source "Ouelli El Darek" (Khaled, Sahra) given an ISRC Deezer doesn't know: the
    // Deezer search match then carries another ISRC. Both are looked up, the source's first.
    const OUELLI = itunesRecord(`${ITUNES}/lookup?id=1444130134&country=us&entity=song`, 1444130134);
    const SOURCE_ISRC = 'FRZ019699999';
    const ctx = () => musicKit([songFixture(OUELLI, SOURCE_ISRC)], fixtureFetch({ extra: [songFixture(OUELLI, SOURCE_ISRC)], missing: '404' }));
    const khaled = () => spotifyTrack('2qQ3IRCPx3aESBFomT2n2N');

    it('a mapping found by the identifier of the Deezer match', async () => {
      const probe = await resolveRef(ctx(), am('track', '1444130134'));
      const derived = probe.details.deezer.item?.kind === 'track' ? probe.details.deezer.item.isrc : undefined;
      expect(probe.details.deezer.outcome, JSON.stringify(probe.details.deezer)).toBe('fuzzy');
      expect(derived).toBeTruthy();
      expect(derived).not.toBe(SOURCE_ISRC);

      const xref = new MemoryXref().set('track', derived ?? '', await khaled());
      const r = await resolveRef(ctx(), am('track', '1444130134'), { xref });
      expect(xref.lookups).toEqual([[SOURCE_ISRC], [derived]]);
      expect(spotifyOutcome(r), describeSpotify(r)).toBe('fuzzy:xref:2qQ3IRCPx3aESBFomT2n2N');
      expect(r.details.spotify.identifier).toBe(derived);
      expect(xrefIdentifiers(r)).toEqual([SOURCE_ISRC, derived]);
    });

    it('a mapping found by the source identifier', async () => {
      const xref = new MemoryXref().set('track', SOURCE_ISRC, await khaled());
      const r = await resolveRef(ctx(), am('track', '1444130134'), { xref });
      expect(spotifyOutcome(r), describeSpotify(r)).toBe('fuzzy:xref:2qQ3IRCPx3aESBFomT2n2N');
      expect(r.details.spotify.identifier).toBe(SOURCE_ISRC);
    });
  });

  it('YouTube and iTunes-mode Apple sources use the identifier of their Deezer match', async () => {
    // Apple source in iTunes mode (no ISRC): Nirvana's MTV Unplugged "Where Did You Sleep Last Night".
    const xref = new MemoryXref();
    const r = await resolveRef(fixtureCtx(), am('track', '1440893075'), { xref });
    const deezerIsrc = r.details.deezer.item?.kind === 'track' ? r.details.deezer.item.isrc : undefined;
    expect(deezerIsrc).toBeTruthy();
    expect(xref.lookups).toEqual([[deezerIsrc]]);
  });

  it('a different live recording mapped to the same identifier is rejected', async () => {
    // A (wrong) mapping from the Unplugged recording's Deezer ISRC to Spotify's Del Mar 1991 live track.
    const probe = await resolveRef(fixtureCtx(), am('track', '1440893075'));
    const deezerIsrc = probe.details.deezer.item?.kind === 'track' ? (probe.details.deezer.item.isrc ?? '') : '';
    const xref = new MemoryXref().set('track', deezerIsrc, await spotifyTrack('6mpyO7bJaCrHzE0iQEtZiN'));
    const r = await resolveRef(fixtureCtx(), am('track', '1440893075'), { xref });
    expect(spotifyOutcome(r), describeSpotify(r)).toBe('search:search-url:');
    expect(r.details.spotify.rejected?.item.id).toBe('6mpyO7bJaCrHzE0iQEtZiN');
  });

  it('albums: learned by UPC (leading zeros dropped), then matched from the Deezer album', async () => {
    const xref = new MemoryXref();
    const spotifySourced = await resolveRef(fixtureCtx(), sp('album', '4m2880jivSbbyEGAKfITCa'));
    const ids = xrefIdentifiers(spotifySourced);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(/^[1-9]\d*$/);
    await xref.learn(spotifySourced.source, ids);

    const deezerId = spotifySourced.details.deezer.item?.id ?? '';
    const r = await resolveRef(fixtureCtx({ missing: '404' }), dz('album', deezerId), { xref });
    expect(spotifyOutcome(r), describeSpotify(r)).toBe('fuzzy:xref:4m2880jivSbbyEGAKfITCa');
    expect(r.entry.links.spotify).toEqual({ url: 'https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa', match: 'fuzzy' });
    expect(r.entry.trackCount).toBeGreaterThan(0);
    expect(r.entry.trackCount).toBe(r.source.kind === 'album' ? r.source.trackCount : undefined);
  });

  it('without a cross-reference, nothing changes (the former third argument, a clock, still works)', async () => {
    let t = 1_000;
    const r = await resolveRef(fixtureCtx(), dz('track', DZ_BLINDING), () => (t += 10));
    expect(spotifyOutcome(r)).toBe('search:search-url:');
    expect(r.entry.resolvedAt).toMatch(/^1970-01-01T00:00:01/);
  });
});

// ---------------------------------------------------------------------------------------------
// Routes: D1 + KV

const SP_KEY = `sp:t:${SP_BLINDING}`;
const DZ_KEY = `dz:t:${DZ_BLINDING}`;

/** A D1Database whose every call throws. */
const BROKEN_DB = {
  prepare() {
    throw new Error('D1 is down');
  },
  batch() {
    throw new Error('D1 is down');
  },
  exec() {
    throw new Error('D1 is down');
  },
} as unknown as D1Database;

function client(fetchFn: FetchFn = fixtureFetch(), bindings: Partial<typeof env> = {}) {
  const app = createApp({ fetch: fetchFn });
  return async (path: string) => {
    const ctx = createExecutionContext();
    const res = await app.fetch(new Request(`http://localhost${path}`, { redirect: 'manual' }), { ...env, ...bindings }, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
}

describe('routes', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  });

  beforeEach(async () => {
    await Promise.all([env.LINKS.delete(SP_KEY), env.LINKS.delete(DZ_KEY)]);
    await env.DB.batch([env.DB.prepare('DELETE FROM spotify_xref'), env.DB.prepare('DELETE FROM spotify_xref_waiting')]);
  });

  it('a Spotify link learns a mapping; the Deezer link of the same recording then gets a direct Spotify link', async () => {
    const get = client();
    expect((await get(`/sp/t/${SP_BLINDING}`)).status).toBe(200);
    const row = await env.DB.prepare('SELECT kind, identifier, spotify_id FROM spotify_xref').all();
    expect(row.results).toEqual([{ kind: 'track', identifier: BLINDING_ISRC, spotify_id: SP_BLINDING }]);

    const page = await get(`/dz/t/${DZ_BLINDING}`);
    const html = await page.text();
    expect(html).toContain(`href="/go/spotify/dz/t/${DZ_BLINDING}" rel="nofollow">Spotify<`);
    expect((await readEntry(env.LINKS, DZ_KEY))?.links.spotify).toEqual({ url: SP_URL, match: 'fuzzy' });
    const go = await get(`/go/spotify/dz/t/${DZ_BLINDING}`);
    expect(go.headers.get('location')).toBe(SP_URL);
    // Matched directly: nothing to wait for.
    const waiting = await env.DB.prepare('SELECT COUNT(*) AS n FROM spotify_xref_waiting').first<{ n: number }>();
    expect(waiting?.n).toBe(0);
  });

  it('back-fill: a Deezer link cached with a Spotify search link is patched once the Spotify link is resolved', async () => {
    const get = client();
    const before = await (await get(`/dz/t/${DZ_BLINDING}`)).text();
    expect(before).toContain('Search on Spotify');
    expect((await readEntry(env.LINKS, DZ_KEY))?.links.spotify.match).toBe('search');
    const waiting = await env.DB.prepare('SELECT kind, identifier, cache_key FROM spotify_xref_waiting').all();
    expect(waiting.results).toEqual([{ kind: 'track', identifier: BLINDING_ISRC, cache_key: DZ_KEY }]);

    // A cache hit (fresh isolate, KV) makes no upstream call and no D1 query.
    const used: string[] = [];
    const db = {
      prepare: (sql: string) => used.push(sql) && BROKEN_DB.prepare(sql),
      batch: () => used.push('batch') && BROKEN_DB.batch([]),
    } as unknown as D1Database;
    const hit = client(async (url) => Promise.reject(new Error(`unexpected upstream call: ${url}`)), { DB: db });
    expect((await hit(`/dz/t/${DZ_BLINDING}`)).status).toBe(200);
    expect((await hit(`/go/apple/dz/t/${DZ_BLINDING}`)).status).toBe(302);
    expect(used).toEqual([]);

    expect((await get(`/sp/t/${SP_BLINDING}`)).status).toBe(200);
    const patched = await readEntry(env.LINKS, DZ_KEY);
    expect(patched?.links.spotify).toEqual({ url: SP_URL, match: 'fuzzy' });
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM spotify_xref_waiting').first<{ n: number }>();
    expect(left?.n).toBe(0);

    // The same isolate's memory copy is patched too, and a fresh one reads the patched KV entry.
    expect((await get(`/go/spotify/dz/t/${DZ_BLINDING}`)).headers.get('location')).toBe(SP_URL);
    expect((await client()(`/go/spotify/dz/t/${DZ_BLINDING}`)).headers.get('location')).toBe(SP_URL);
  });

  it('a broken D1 never changes a response: each page is what it is without the cross-reference', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const paths = [`/dz/t/${DZ_BLINDING}`, `/sp/t/${SP_BLINDING}`, `/go/spotify/dz/t/${DZ_BLINDING}`, `/go/deezer/sp/t/${SP_BLINDING}`];
    const fresh = async () => {
      await Promise.all([env.LINKS.delete(SP_KEY), env.LINKS.delete(DZ_KEY)]);
      await env.DB.batch([env.DB.prepare('DELETE FROM spotify_xref'), env.DB.prepare('DELETE FROM spotify_xref_waiting')]);
    };
    const view = async (res: Response) => [res.status, res.headers.get('location'), await res.text()] as const;
    for (const path of paths) {
      await fresh();
      const working = await view(await client()(path));
      await fresh();
      const broken = await view(await client(fixtureFetch(), { DB: BROKEN_DB })(path));
      expect(broken, path).toEqual(working);
      expect([200, 302], path).toContain(broken[0]);
    }

    // The whole back-fill sequence on a broken D1: every response still works, Spotify stays a search.
    await fresh();
    const get = client(fixtureFetch(), { DB: BROKEN_DB });
    for (const path of paths) expect([200, 302], path).toContain((await get(path)).status);
    expect((await get(`/go/spotify/dz/t/${DZ_BLINDING}`)).headers.get('location')).toMatch(/^https:\/\/open\.spotify\.com\/search\//);
    expect(log).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// Review findings

const xrefInput = (r: ResolveResult) => ({
  key: r.key,
  source: r.source,
  entry: r.entry,
  spotify: r.details.spotify,
  identifiers: xrefIdentifiers(r),
});

describe('several Spotify copies of one recording', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
  });

  beforeEach(async () => {
    await Promise.all([env.LINKS.delete(SP_KEY), env.LINKS.delete(DZ_KEY)]);
    await env.DB.batch([env.DB.prepare('DELETE FROM spotify_xref'), env.DB.prepare('DELETE FROM spotify_xref_waiting')]);
  });

  it.each([
    ['learned after the original', false],
    ['learned before the original', true],
  ])('a compilation/explicit copy of the same ISRC never displaces the original (%s)', async (_why, compilationFirst) => {
    const xref = d1Xref(env.DB);
    const original = await spotifyTrack();
    expect(original.explicit).toBe(false);
    const compilation: TrackMeta = {
      ...original,
      id: 'compilationcopy0000000',
      url: 'https://open.spotify.com/track/compilationcopy0000000',
      album: 'The Highlights',
      albumType: 'compilation',
      explicit: true,
    };
    for (const item of compilationFirst ? [compilation, original] : [original, compilation]) await xref.learn(item, [BLINDING_ISRC]);
    const r = await resolveRef(fixtureCtx(), dz('track', DZ_BLINDING), { xref });
    expect(spotifyOutcome(r), describeSpotify(r)).toBe(`fuzzy:xref:${SP_BLINDING}`);
    expect(r.details.spotify.score).toBeGreaterThan(0.95);
  });

  it('a Spotify source is not learned under the identifier of a match of the other edition (explicit vs clean)', async () => {
    const r = await resolveRef(fixtureCtx(), sp('track', SP_BLINDING));
    expect(r.source.explicit).toBe(false);
    expect(xrefIdentifiers(r)).toEqual([BLINDING_ISRC]);
    const withExplicit = (s: 'deezer' | 'apple', patch: Partial<TrackMeta>): ResolveResult => {
      const d = r.details[s];
      return { ...r, details: { ...r.details, [s]: { ...d, item: { ...d.item, ...patch } as ItemMeta } } };
    };
    expect(xrefIdentifiers(withExplicit('deezer', { explicit: true })), JSON.stringify(r.details.deezer.item)).toEqual([]);
    expect(xrefIdentifiers(withExplicit('deezer', { explicit: undefined }))).toEqual([BLINDING_ISRC]);
    // The Apple match (iTunes mode) carries no ISRC; with one (MusicKit mode) the same rule applies.
    expect(xrefIdentifiers(withExplicit('apple', { explicit: true }))).toEqual([BLINDING_ISRC]);
    expect(xrefIdentifiers(withExplicit('apple', { explicit: true, isrc: BLINDING_ISRC }))).toEqual([]);
    // Only learning is guarded: a non-Spotify result waits under all its identifiers (back-fill verifies).
    const deezerSourced = await resolveRef(fixtureCtx(), dz('track', DZ_BLINDING));
    const flipped = { ...deezerSourced, source: { ...deezerSourced.source, explicit: true } };
    expect(xrefIdentifiers(flipped)).toEqual([BLINDING_ISRC]);
  });

  it('a mapping learned while a Deezer link is resolving (after its lookup) is used once its entry is cached', async () => {
    const xref = d1Xref(env.DB);
    const deezerSourced = await resolveRef(fixtureCtx(), dz('track', DZ_BLINDING), { xref });
    expect(deezerSourced.entry.links.spotify.match).toBe('search');
    const spotifySourced = await resolveRef(fixtureCtx(), sp('track', SP_BLINDING), { xref });
    await recordXref(xref, env.LINKS, xrefInput(spotifySourced)); // nothing is waiting yet
    await writeEntry(env.LINKS, DZ_KEY, deezerSourced.entry);
    await recordXref(xref, env.LINKS, xrefInput(deezerSourced));
    expect((await readEntry(env.LINKS, DZ_KEY))?.links.spotify).toEqual({ url: SP_URL, match: 'fuzzy' });
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM spotify_xref_waiting').first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('routes: a back-fill never replaces a newer resolution held in isolate memory', async () => {
    const get = client();
    await get(`/dz/t/${DZ_BLINDING}`); // memory and KV: resolution E2, Spotify search, waiting
    const newer = await readEntry(env.LINKS, DZ_KEY);
    expect(newer?.links.spotify.match).toBe('search');
    // KV (as read elsewhere) and the waiting row describe an older resolution E1.
    const older = { ...newer!, resolvedAt: '2026-01-01T00:00:00.000Z' };
    await writeEntry(env.LINKS, DZ_KEY, older);
    await env.DB.prepare('UPDATE spotify_xref_waiting SET resolved_at = ?').bind(older.resolvedAt).run();

    expect((await get(`/sp/t/${SP_BLINDING}`)).status).toBe(200); // learns; back-fills E1 in KV
    expect(await readEntry(env.LINKS, DZ_KEY)).toEqual({ ...older, links: { ...older.links, spotify: { url: SP_URL, match: 'fuzzy' } } });
    // This isolate keeps serving its own (newer) resolution.
    expect((await get(`/go/spotify/dz/t/${DZ_BLINDING}`)).headers.get('location')).toBe(newer?.links.spotify.url);
  });

  it('routes: Spotify and Deezer links of one recording resolved at the same time; the Deezer entry gets the direct link', async () => {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const atGate = new Promise<void>((r) => (reached = r));
    const base = fixtureFetch();
    // The Deezer resolve has looked its ISRC up (a miss) and is waiting on Apple when the Spotify one runs.
    const slowApple: FetchFn = async (input, init) => {
      if (String(input).startsWith(ITUNES)) {
        reached();
        await gate;
      }
      return base(input, init);
    };
    const deezerPage = client(slowApple)(`/dz/t/${DZ_BLINDING}`);
    await atGate;
    expect((await client()(`/sp/t/${SP_BLINDING}`)).status).toBe(200);
    release();
    expect(await (await deezerPage).text()).toContain('Search on Spotify');

    expect((await readEntry(env.LINKS, DZ_KEY))?.links.spotify).toEqual({ url: SP_URL, match: 'fuzzy' });
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM spotify_xref_waiting').first<{ n: number }>();
    expect(n?.n).toBe(0);
    expect((await client()(`/go/spotify/dz/t/${DZ_BLINDING}`)).headers.get('location')).toBe(SP_URL);
  });
});
