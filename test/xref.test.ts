import { env, applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSpotifyItem } from '../src/sources/spotify';
import { readEntry, writeEntry } from '../src/store';
import type { AlbumMeta, ItemMeta, ResolvedEntry, Service, TrackMeta } from '../src/types';
import {
  backfill,
  XREF_ABSENT_GRACE_MS,
  XREF_MAX_PER_IDENTIFIER,
  type WaitingRow,
  type XrefHit,
  type XrefResolution,
  d1Xref,
  entryAsItem,
  fromSnapshot,
  normalizeIdentifier,
  normalizeIdentifiers,
  recordXref,
  toSnapshot,
  XREF_MAX_IDENTIFIERS,
  XREF_WAITING_MAX_AGE_SECONDS,
} from '../src/xref';
import { fixtureCtx } from './helpers/fixtures';
import { MemoryXref } from './helpers/xref';

const BLINDING_ISRC = 'USUG11904206';
const RESOLVED_AT = '2026-11-01T00:00:00.000Z';
const spotifyTrack = async () => (await getSpotifyItem(fixtureCtx(), 'track', '0VjIjW4GlUZAMYd2vXMi3b')) as TrackMeta;

const ALBUM: AlbumMeta = {
  kind: 'album',
  id: '4m2880jivSbbyEGAKfITCa',
  url: 'https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa',
  title: 'Random Access Memories',
  artists: ['Daft Punk'],
  artist: 'Daft Punk',
  trackCount: 13,
  albumType: 'album',
  releaseDate: '2013-05-17',
  explicit: false,
  art: 'https://i.scdn.co/image/x',
};

/** Cached entry of a Deezer-sourced Blinding Lights with a Spotify search link. */
function entry(patch: Partial<ResolvedEntry> = {}, spotify: 'search' | 'fuzzy' = 'search'): ResolvedEntry {
  const link = (s: Service) => ({ url: `https://example.com/${s}/1`, match: 'fuzzy' as const });
  return {
    kind: 'track',
    title: 'Blinding Lights',
    artist: 'The Weeknd',
    album: 'After Hours',
    durationMs: 200_000,
    releaseYear: 2020,
    isrc: BLINDING_ISRC,
    explicit: false,
    resolvedAt: RESOLVED_AT,
    appleMode: 'itunes',
    links: {
      spotify: { url: 'https://open.spotify.com/search/Blinding%20Lights%20The%20Weeknd', match: spotify },
      apple: link('apple'),
      deezer: { url: 'https://www.deezer.com/track/908604612', match: 'exact' },
      youtubeMusic: { url: 'https://music.youtube.com/search?q=x', match: 'search' },
      amazon: { url: 'https://music.amazon.com/search/x', match: 'search' },
    },
    ...patch,
  };
}

/** A D1Database whose every call throws, as when the binding is broken or D1 is down. */
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

/** recordXref input for a Spotify-sourced resolution (learns). */
function learning(source: ItemMeta, identifiers = [BLINDING_ISRC]): XrefResolution {
  return { key: `sp:t:${source.id}`, source, entry: entry(), spotify: { via: 'source', match: 'exact' }, identifiers };
}

/** recordXref input for a non-Spotify resolution cached with a Spotify search link (waits). */
function waiting(key: string, source: ItemMeta, e: ResolvedEntry = entry()): XrefResolution {
  return { key, source, entry: e, spotify: { via: 'search-url', match: 'search' }, identifiers: [BLINDING_ISRC] };
}

const row = (cacheKey: string, resolvedAt = RESOLVED_AT, identifier = BLINDING_ISRC): WaitingRow => ({ identifier, cacheKey, resolvedAt });
const hitsOf = async (...items: ItemMeta[]): Promise<XrefHit[]> => items.map((item) => ({ identifier: BLINDING_ISRC, item }));

let seq = 0;
const freshKey = () => `dz:t:${Date.now()}${seq++}`;

beforeAll(async () => {
  await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM spotify_xref'), env.DB.prepare('DELETE FROM spotify_xref_waiting')]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('normalizeIdentifier', () => {
  it.each([
    ['USUG11904206', 'USUG11904206'],
    ['usug11904206', 'USUG11904206'],
    ['US-UG1-19-04206', 'USUG11904206'],
    [' US UG1 19 04206 ', 'USUG11904206'],
    ['USUG1190420', null],
    ['1234567890123', null],
    ['', null],
  ])('ISRC %j -> %j', (raw, want) => {
    expect(normalizeIdentifier('track', raw)).toBe(want);
  });

  it.each([
    // Deezer and Apple disagree on 12/13/14-digit forms of one GTIN: all of them are one key.
    ['602567759461', '602567759461'],
    ['0602567759461', '602567759461'],
    ['00602567759461', '602567759461'],
    ['00731453398924', '731453398924'],
    ['0060-2567-759461', '602567759461'],
    ['000000000000', null],
    ['1234567', null],
    ['123456789012345', null],
    ['USUG11904206', null],
  ])('UPC %j -> %j', (raw, want) => {
    expect(normalizeIdentifier('album', raw)).toBe(want);
  });

  it('normalizeIdentifiers dedupes, drops missing and malformed ones, and caps the count', () => {
    expect(normalizeIdentifiers('track', ['usug11904206', undefined, 'USUG11904206', 'bad', 'GBUM71029604'])).toEqual([
      'USUG11904206',
      'GBUM71029604',
    ]);
    expect(normalizeIdentifiers('album', ['0602567759461', '602567759461'])).toEqual(['602567759461']);
    const many = Array.from({ length: 20 }, (_, i) => `USUG1190${String(4200 + i)}`);
    expect(normalizeIdentifiers('track', many)).toHaveLength(XREF_MAX_IDENTIFIERS);
  });
});

describe('snapshots', () => {
  it('round-trip a Spotify track (url rebuilt from the id, nothing else lost that matching reads)', async () => {
    const track = await spotifyTrack();
    const snap = toSnapshot(track);
    expect(snap).toMatchObject({ kind: 'track', id: track.id, title: 'Blinding Lights', album: 'After Hours' });
    expect(Object.keys(snap)).not.toContain('url');
    const back = fromSnapshot(JSON.parse(JSON.stringify(snap)));
    const { trackNumber: _n, ...rest } = track;
    expect(back).toEqual(rest);
    expect(back?.url).toBe('https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b');
  });

  it('round-trip an album', () => {
    const back = fromSnapshot(JSON.parse(JSON.stringify(toSnapshot(ALBUM))));
    expect(back).toEqual(ALBUM);
  });

  it.each([
    ['not an object', 'x'],
    ['no id', { ...toSnapshot(ALBUM), id: '' }],
    ['bad kind', { ...toSnapshot(ALBUM), kind: 'playlist' }],
    ['artists not strings', { ...toSnapshot(ALBUM), artists: [1] }],
    ['trackCount a string', { ...toSnapshot(ALBUM), trackCount: '13' }],
    ['unknown album type', { ...toSnapshot(ALBUM), albumType: 'mixtape' }],
  ])('reject a malformed snapshot: %s', (_why, v) => {
    expect(fromSnapshot(v)).toBeNull();
  });

  it('reject a snapshot of the other kind', () => {
    expect(fromSnapshot(toSnapshot(ALBUM), 'track')).toBeNull();
    expect(fromSnapshot(toSnapshot(ALBUM), 'album')).not.toBeNull();
  });

  it('entryAsItem keeps what matching reads', () => {
    expect(entryAsItem(entry())).toEqual({
      kind: 'track',
      id: '',
      url: '',
      title: 'Blinding Lights',
      artists: ['The Weeknd'],
      artist: 'The Weeknd',
      album: 'After Hours',
      durationMs: 200_000,
      explicit: false,
      releaseDate: '2020',
    });
    const album = entryAsItem(entry({ kind: 'album', title: 'After Hours', album: undefined, durationMs: undefined, trackCount: 14 }));
    expect(album).toMatchObject({ kind: 'album', trackCount: 14 });
  });
});

describe('D1 store', () => {
  const store = () => d1Xref(env.DB);

  it('learns and looks up by normalized identifier', async () => {
    const track = await spotifyTrack();
    expect((await store().learn(track, [BLINDING_ISRC])).waiting).toEqual([]);
    const hits = await store().lookup('track', [BLINDING_ISRC, 'GBUM71029604']);
    expect(hits).toEqual([{ identifier: BLINDING_ISRC, item: fromSnapshot(toSnapshot(track)) }]);
    expect(await store().lookup('album', [BLINDING_ISRC])).toEqual([]);
    expect(await store().lookup('track', [])).toEqual([]);

    const row = await env.DB.prepare('SELECT * FROM spotify_xref').first<Record<string, string>>();
    expect(row).toMatchObject({ kind: 'track', identifier: BLINDING_ISRC, spotify_id: track.id });
    expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps several Spotify items per identifier, most recently learned first, re-learning one refreshes it', async () => {
    const track = await spotifyTrack();
    const copy = (id: string) => ({ ...track, id, url: `https://open.spotify.com/track/${id}` });
    await store().learn(track, [BLINDING_ISRC]);
    await store().learn(copy('7MXVkk9YMctZqd1Srtv4MB'), [BLINDING_ISRC]);
    expect((await store().lookup('track', [BLINDING_ISRC])).map((h) => h.item.id)).toEqual(['7MXVkk9YMctZqd1Srtv4MB', track.id]);
    const { hits } = await store().learn({ ...track, title: 'Blinding Lights (renamed)' }, [BLINDING_ISRC]);
    expect(hits.map((h) => [h.item.id, h.item.title])).toEqual([
      [track.id, 'Blinding Lights (renamed)'],
      ['7MXVkk9YMctZqd1Srtv4MB', 'Blinding Lights'],
    ]);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM spotify_xref').first<{ n: number }>();
    expect(n?.n).toBe(2);
  });

  it(`keeps at most ${XREF_MAX_PER_IDENTIFIER} items per identifier (the most recent), other identifiers untouched`, async () => {
    const track = await spotifyTrack();
    await store().learn(track, ['GBUM71029604']);
    const ids = Array.from({ length: XREF_MAX_PER_IDENTIFIER + 2 }, (_, i) => `copy${i}`);
    for (const id of ids) await store().learn({ ...track, id }, [BLINDING_ISRC]);
    const hits = await store().lookup('track', [BLINDING_ISRC]);
    expect(hits.map((h) => h.item.id)).toEqual(ids.slice(-XREF_MAX_PER_IDENTIFIER).reverse());
    expect((await store().lookup('track', ['GBUM71029604'])).map((h) => h.item.id)).toEqual([track.id]);
  });

  it('skips rows whose snapshot is unreadable', async () => {
    await env.DB.prepare('INSERT INTO spotify_xref (kind, identifier, spotify_id, snapshot) VALUES (?, ?, ?, ?)')
      .bind('track', BLINDING_ISRC, 'x', '{not json')
      .run();
    expect(await store().lookup('track', [BLINDING_ISRC])).toEqual([]);
  });

  it('waiting rows come back when their mapping is learned, and go on unwait', async () => {
    const key = freshKey();
    await store().wait('track', [BLINDING_ISRC, 'GBUM71029604'], key, '2026-01-01T00:00:00.000Z');
    await store().wait('track', [BLINDING_ISRC], key, RESOLVED_AT); // idempotent; the latest resolution
    await store().wait('album', ['602567759461'], 'dz:a:1', RESOLVED_AT);
    const track = await spotifyTrack();
    const { waiting, hits } = await store().learn(track, [BLINDING_ISRC]);
    expect(waiting).toEqual([{ identifier: BLINDING_ISRC, cacheKey: key, resolvedAt: RESOLVED_AT }]);
    expect(hits.map((h) => h.item.id)).toEqual([track.id]);
    await store().unwait([key]);
    const left = await env.DB.prepare('SELECT kind, identifier, cache_key FROM spotify_xref_waiting ORDER BY kind').all();
    expect(left.results).toEqual([{ kind: 'album', identifier: '602567759461', cache_key: 'dz:a:1' }]);
  });

  it('prunes waiting rows older than the longest KV TTL', async () => {
    const old = new Date(Date.now() - (XREF_WAITING_MAX_AGE_SECONDS + 3600) * 1000).toISOString();
    const recent = new Date(Date.now() - (XREF_WAITING_MAX_AGE_SECONDS - 3600) * 1000).toISOString();
    const insert = env.DB.prepare(
      'INSERT INTO spotify_xref_waiting (kind, identifier, cache_key, resolved_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    await env.DB.batch([
      insert.bind('track', 'GBUM71029604', 'dz:t:old', old, old, old),
      insert.bind('track', 'GBUM71029604', 'dz:t:recent', recent, recent, recent),
    ]);
    await store().wait('track', [BLINDING_ISRC], 'dz:t:new', RESOLVED_AT);
    const left = await env.DB.prepare('SELECT cache_key FROM spotify_xref_waiting ORDER BY cache_key').all();
    expect(left.results.map((r) => r.cache_key)).toEqual(['dz:t:new', 'dz:t:recent']);
  });

  it('a broken D1 is logged: lookups reject (resolve turns that into a search link), writes resolve', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = d1Xref(BROKEN_DB);
    await expect(broken.lookup('track', [BLINDING_ISRC])).rejects.toThrow('D1 is down');
    await expect(broken.learn(await spotifyTrack(), [BLINDING_ISRC])).resolves.toEqual({ waiting: [], hits: [] });
    await expect(broken.wait('track', [BLINDING_ISRC], 'dz:t:1', RESOLVED_AT)).resolves.toEqual([]);
    await expect(broken.unwait(['dz:t:1'])).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(4);
  });
});

describe('back-fill', () => {
  it('patches a waiting entry that still has a Spotify search link and passes the fuzzy rules', async () => {
    const key = freshKey();
    const store = new MemoryXref();
    await writeEntry(env.LINKS, key, entry());
    await store.wait('track', [BLINDING_ISRC], key, RESOLVED_AT);
    const track = await spotifyTrack();
    const patched: string[] = [];
    await recordXref(store, env.LINKS, learning(track), (k) => patched.push(k));
    const after = await readEntry(env.LINKS, key);
    expect(after?.links.spotify).toEqual({ url: track.url, match: 'fuzzy' });
    expect({ ...after, links: { ...after?.links, spotify: entry().links.spotify } }).toEqual(entry());
    expect(patched).toEqual([key]);
    expect(store.waiting).toEqual([]);
    expect(store.mappings.get(`track:${BLINDING_ISRC}`)?.map((i) => i.id)).toEqual([track.id]);
  });

  it.each<[string, Partial<ResolvedEntry>]>([
    ['a 5 s duration gap', { durationMs: 205_000 }],
    ['a live version', { title: 'Blinding Lights (Live)', album: 'Live At SoFi Stadium', durationMs: 200_000 }],
    ['another artist', { artist: 'Loren Allred' }],
  ])('keeps the entry and its waiting row when the Spotify item is rejected: %s', async (_why, patch) => {
    const key = freshKey();
    const store = new MemoryXref();
    await writeEntry(env.LINKS, key, entry(patch));
    await store.wait('track', [BLINDING_ISRC], key, RESOLVED_AT);
    await backfill(store, env.LINKS, 'track', [row(key)], await hitsOf(await spotifyTrack()));
    expect((await readEntry(env.LINKS, key))?.links.spotify.match).toBe('search');
    expect(store.waiting.map((w) => w.cacheKey)).toEqual([key]);
  });

  it('forgets entries that are gone, already have a direct Spotify link, or are of the other kind', async () => {
    const gone = freshKey();
    const direct = freshKey();
    const album = freshKey();
    await writeEntry(env.LINKS, direct, entry({}, 'fuzzy'));
    await writeEntry(env.LINKS, album, entry({ kind: 'album', title: 'After Hours', album: undefined, durationMs: undefined }));
    const store = new MemoryXref();
    const longAgo = new Date(Date.now() - XREF_ABSENT_GRACE_MS - 1000).toISOString();
    await store.wait('track', [BLINDING_ISRC], gone, longAgo);
    for (const key of [direct, album]) await store.wait('track', [BLINDING_ISRC], key, RESOLVED_AT);
    const before = await env.LINKS.get(direct);
    await backfill(store, env.LINKS, 'track', [row(gone, longAgo), row(direct), row(album)], await hitsOf(await spotifyTrack()));
    expect(store.waiting).toEqual([]);
    expect(await env.LINKS.get(direct)).toBe(before);
    expect(await env.LINKS.get(gone)).toBeNull();
    expect((await readEntry(env.LINKS, album))?.links.spotify.match).toBe('search');
  });

  it('a non-Spotify result on a Spotify search link waits; one with a direct link or no identifiers does not', async () => {
    const store = new MemoryXref();
    const source = entryAsItem(entry());
    await recordXref(store, env.LINKS, waiting('dz:t:1', source));
    await recordXref(store, env.LINKS, { ...waiting('dz:t:2', source), spotify: { via: 'xref', match: 'fuzzy' } });
    await recordXref(store, env.LINKS, { ...waiting('yt:t:3', source), identifiers: [] });
    expect(store.waiting).toEqual([{ kind: 'track', identifier: BLINDING_ISRC, cacheKey: 'dz:t:1', resolvedAt: RESOLVED_AT }]);
    expect(store.mappings.size).toBe(0);
  });

  it('end to end on D1: wait, learn, patch, forget', async () => {
    const key = freshKey();
    const store = d1Xref(env.DB);
    await writeEntry(env.LINKS, key, entry());
    await recordXref(store, env.LINKS, waiting(key, entryAsItem(entry())));
    const track = await spotifyTrack();
    await recordXref(store, env.LINKS, learning(track));
    expect((await readEntry(env.LINKS, key))?.links.spotify).toEqual({ url: track.url, match: 'fuzzy' });
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM spotify_xref_waiting').first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('never throws, whatever the store does', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new MemoryXref();
    store.learn = () => Promise.reject(new Error('boom'));
    await expect(
      recordXref(store, env.LINKS, learning(await spotifyTrack())),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// Review findings: back-fill safety

/** env.LINKS with some operations replaced (a failing or not-yet-consistent KV). */
function kvWith(patch: { get?: (key: string) => Promise<string | null>; put?: () => Promise<void> }): KVNamespace {
  return {
    get: patch.get ?? ((key: string) => env.LINKS.get(key, 'text')),
    put: patch.put ?? ((key: string, value: string, opts?: KVNamespacePutOptions) => env.LINKS.put(key, value, opts)),
  } as unknown as KVNamespace;
}

describe('back-fill safety', () => {
  it('chooses among every Spotify copy mapped to the identifier: the original album over a compilation', async () => {
    const key = freshKey();
    const store = new MemoryXref();
    await writeEntry(env.LINKS, key, entry());
    await store.wait('track', [BLINDING_ISRC], key, RESOLVED_AT);
    const original = await spotifyTrack();
    const compilation: TrackMeta = {
      ...original,
      id: 'compilationcopy0000000',
      url: 'https://open.spotify.com/track/compilationcopy0000000',
      album: 'The Highlights',
      albumType: 'compilation',
      explicit: true,
    };
    store.set('track', BLINDING_ISRC, original);
    await recordXref(store, env.LINKS, learning(compilation));
    expect(store.mappings.get(`track:${BLINDING_ISRC}`)?.map((i) => i.id)).toEqual([compilation.id, original.id]);
    expect((await readEntry(env.LINKS, key))?.links.spotify).toEqual({ url: original.url, match: 'fuzzy' });
  });

  it.each([
    ['a newer resolution (it waits for itself)', '2026-11-02T00:00:00.000Z'],
    ['a stale read of an older one', '2026-10-01T00:00:00.000Z'],
  ])('never patches another resolution than the one that waited: %s', async (_why, resolvedAt) => {
    const key = freshKey();
    const store = new MemoryXref();
    const other = entry({ resolvedAt, links: { ...entry().links, apple: { url: 'https://music.apple.com/song/NEWER', match: 'fuzzy' } } });
    await writeEntry(env.LINKS, key, other);
    await store.wait('track', [BLINDING_ISRC], key, RESOLVED_AT);
    const before = await env.LINKS.get(key);
    const patched: string[] = [];
    await backfill(store, env.LINKS, 'track', [row(key)], await hitsOf(await spotifyTrack()), (k) => patched.push(k));
    expect(await env.LINKS.get(key)).toBe(before);
    expect(patched).toEqual([]);
    expect(store.waiting.map((w) => w.cacheKey)).toEqual([key]);
  });

  it('a failed KV write keeps the waiting row and reports nothing patched', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const key = freshKey();
    const store = new MemoryXref();
    await writeEntry(env.LINKS, key, entry());
    await store.wait('track', [BLINDING_ISRC], key, RESOLVED_AT);
    const kv = kvWith({ put: () => Promise.reject(new Error('KV PUT failed: 429 Too Many Requests')) });
    const patched: string[] = [];
    await recordXref(store, kv, learning(await spotifyTrack()), (k) => patched.push(k));
    expect(patched).toEqual([]);
    expect((await readEntry(env.LINKS, key))?.links.spotify.match).toBe('search');
    expect(store.waiting.map((w) => w.cacheKey)).toEqual([key]);
  });

  it('a failed KV read, or an entry not visible here yet, keeps the waiting row', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new MemoryXref();
    const justNow = new Date(Date.now() - 1000).toISOString();
    await store.wait('track', [BLINDING_ISRC], 'dz:t:failing', RESOLVED_AT);
    await store.wait('track', [BLINDING_ISRC], 'dz:t:not-yet', justNow);
    const kv = kvWith({ get: (key) => (key === 'dz:t:failing' ? Promise.reject(new Error('KV GET failed')) : Promise.resolve(null)) });
    await backfill(store, kv, 'track', [row('dz:t:failing'), row('dz:t:not-yet', justNow)], await hitsOf(await spotifyTrack()));
    expect(store.waiting.map((w) => w.cacheKey).sort()).toEqual(['dz:t:failing', 'dz:t:not-yet']);
  });

  it('on D1: a mapping learned before the entry waits is used right away (learn, then wait)', async () => {
    const key = freshKey();
    const store = d1Xref(env.DB);
    const track = await spotifyTrack();
    await recordXref(store, env.LINKS, learning(track)); // nothing waiting yet
    await writeEntry(env.LINKS, key, entry());
    const patched: Array<[string, ResolvedEntry]> = [];
    await recordXref(store, env.LINKS, waiting(key, entryAsItem(entry())), (k, e) => patched.push([k, e]));
    const after = await readEntry(env.LINKS, key);
    expect(after?.links.spotify).toEqual({ url: track.url, match: 'fuzzy' });
    expect(patched).toEqual([[key, after]]);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM spotify_xref_waiting').first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('learn, then wait: a mapping that fails the fuzzy rules, or a failed write, leaves the row waiting', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = d1Xref(env.DB);
    const track = await spotifyTrack();
    await recordXref(store, env.LINKS, learning({ ...track, durationMs: (track.durationMs ?? 0) + 5000 }));
    const rejected = freshKey();
    await writeEntry(env.LINKS, rejected, entry());
    await recordXref(store, env.LINKS, waiting(rejected, entryAsItem(entry())));
    expect((await readEntry(env.LINKS, rejected))?.links.spotify.match).toBe('search');
    const waitingKeys = async () =>
      (await env.DB.prepare('SELECT cache_key FROM spotify_xref_waiting ORDER BY cache_key').all()).results.map((r) => r.cache_key);
    expect(await waitingKeys()).toEqual([rejected]);

    // The right copy learned later back-fills it (both copies are candidates; the rejected one stays rejected).
    await recordXref(store, env.LINKS, learning(track));
    expect((await readEntry(env.LINKS, rejected))?.links.spotify).toEqual({ url: track.url, match: 'fuzzy' });
    expect(await waitingKeys()).toEqual([]);

    const unwritten = freshKey();
    await writeEntry(env.LINKS, unwritten, entry());
    const kv = kvWith({ put: () => Promise.reject(new Error('KV PUT failed')) });
    await recordXref(store, kv, waiting(unwritten, entryAsItem(entry())));
    expect((await readEntry(env.LINKS, unwritten))?.links.spotify.match).toBe('search');
    expect(await waitingKeys()).toEqual([unwritten]);
  });
});
