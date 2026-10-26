import { describe, expect, it } from 'vitest';
import { UpstreamError } from '../src/http';
import {
  deezerAlbumByUpc,
  deezerSearchQueries,
  deezerSearchUrl,
  deezerTrackByIsrc,
  deezerUrl,
  getDeezerItem,
  isoDate,
  mapDeezerAlbum,
  mapDeezerTrack,
  mergeById,
  normalizeIsrc,
  recordType,
  searchDeezer,
  upcVariants,
} from '../src/sources/deezer';
import type { AlbumMeta, ItemMeta, SearchQuery, TrackMeta } from '../src/types';
import type { HttpFixture } from './helpers/fixtures';
import { FIXTURES, fixtureCtx } from './helpers/fixtures';

const API = 'https://api.deezer.com';
const cover = (hash: string) => `https://cdn-images.dzcdn.net/images/cover/${hash}/1000x1000-000000-80-0-0.jpg`;

const KHALED_TITLE = `${API}/search/track?q=Ouelli%20El%20Darek&limit=15`;
const KHALED_PLAIN = `${API}/search/track?q=Khaled%20Ouelli%20El%20Darek&limit=15`;
const KHALED_QUERY: SearchQuery = { kind: 'track', title: 'Ouelli El Darek', artist: 'Khaled' };

/** Hand-written response in Deezer's format: HTTP 200 with a JSON body. */
function fixture(url: string, body: unknown, status = 200): HttpFixture {
  return {
    request: { url, method: 'GET' },
    response: { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) },
  };
}

/** Parsed body of a recorded fixture, as the basis for variations on the real format. */
function recorded(url: string): Record<string, unknown> {
  const f = FIXTURES.get(url);
  if (!f) throw new Error(`missing fixture ${url}`);
  return JSON.parse(f.response.body) as Record<string, unknown>;
}

/** Documented error bodies (https://developers.deezer.com/api/errors). */
const QUOTA_ERROR = { error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } };
const BUSY_ERROR = { error: { type: 'Exception', message: 'Service busy', code: 700 } };

async function rejection(p: Promise<unknown>): Promise<UpstreamError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(UpstreamError);
  return err as UpstreamError;
}

// ---------------------------------------------------------------------------------------------
// Expected mappings of the recorded responses

const HARDER_BETTER: TrackMeta = {
  kind: 'track',
  id: '3135556',
  url: 'https://www.deezer.com/track/3135556',
  title: 'Harder, Better, Faster, Stronger',
  artists: ['Daft Punk'],
  artist: 'Daft Punk',
  album: 'Discovery',
  durationMs: 226_000,
  durationPrecisionMs: 1000,
  isrc: 'GBDUW0000059',
  explicit: false,
  // The album's date (2001-03-07), not the track's own release_date (2001-03-12).
  releaseDate: '2001-03-07',
  trackNumber: 4,
  art: cover('5718f7c81c27e0b2417e2a4c45224f8a'),
};

const OUELLI_BEST_OF: TrackMeta = {
  kind: 'track',
  id: '515038112',
  url: 'https://www.deezer.com/track/515038112',
  title: 'Ouelli El Darek',
  artists: ['Khaled'],
  artist: 'Khaled',
  album: 'Best Of',
  durationMs: 192_000,
  durationPrecisionMs: 1000,
  isrc: 'FRZ019601820',
  explicit: false,
  // The track's own release_date is 2018-06-22, a re-delivery of the 2007 album.
  releaseDate: '2007-11-26',
  trackNumber: 5,
  art: cover('e28d75ea1f645fe0cc6b69e741ee5756'),
};

const GET_LUCKY: TrackMeta = {
  kind: 'track',
  id: '67238735',
  url: 'https://www.deezer.com/track/67238735',
  title: 'Get Lucky (feat. Pharrell Williams and Nile Rodgers)',
  artists: ['Daft Punk', 'Pharrell Williams', 'Nile Rodgers'],
  artist: 'Daft Punk',
  album: 'Random Access Memories',
  durationMs: 367_000,
  durationPrecisionMs: 1000,
  isrc: 'USQX91300108',
  explicit: false,
  releaseDate: '2013-05-17',
  trackNumber: 8,
  art: cover('311bba0fc112d15f72c8b5a65f0456c1'),
};

const OUELLI_SAHRA: TrackMeta = {
  kind: 'track',
  id: '920717',
  url: 'https://www.deezer.com/track/920717',
  title: 'Ouelli El Darek',
  artists: ['Khaled'],
  artist: 'Khaled',
  album: 'Sahra',
  durationMs: 192_000,
  durationPrecisionMs: 1000,
  isrc: 'FRZ019601820',
  explicit: false,
  releaseDate: '1996-01-01',
  trackNumber: 5,
  art: cover('9e8f179f3eb62e85b913ff3b70fd769b'),
};

const BEST_OF: AlbumMeta = {
  kind: 'album',
  id: '66071352',
  url: 'https://www.deezer.com/album/66071352',
  title: 'Best Of',
  artists: ['Khaled'],
  artist: 'Khaled',
  trackCount: 15,
  upc: '602567759461',
  albumType: 'album',
  releaseDate: '2007-11-26',
  explicit: false,
  art: cover('e28d75ea1f645fe0cc6b69e741ee5756'),
};

// Search results carry no contributors, track_position or release dates.
const SEARCH_OUELLI: TrackMeta = {
  kind: 'track',
  id: '515038112',
  url: 'https://www.deezer.com/track/515038112',
  title: 'Ouelli El Darek',
  artists: ['Khaled'],
  artist: 'Khaled',
  album: 'Best Of',
  durationMs: 192_000,
  durationPrecisionMs: 1000,
  isrc: 'FRZ019601820',
  explicit: false,
  art: cover('e28d75ea1f645fe0cc6b69e741ee5756'),
};

const SEARCH_OUELLI_LIVE: TrackMeta = {
  kind: 'track',
  id: '2298124',
  url: 'https://www.deezer.com/track/2298124',
  title: 'Ouelli El Darek (Live)',
  artists: ['Khaled'],
  artist: 'Khaled',
  album: 'Hafla',
  durationMs: 270_000,
  durationPrecisionMs: 1000,
  isrc: 'FRZ019800090',
  explicit: false,
  art: cover('7bad03985abf1e8fcf4f1365c92d9252'),
};

// ---------------------------------------------------------------------------------------------

describe('URL builders', () => {
  it.each([
    ['track', '3135556', 'https://www.deezer.com/track/3135556'],
    ['album', '66071352', 'https://www.deezer.com/album/66071352'],
  ] as const)('deezerUrl(%s, %s)', (kind, id, url) => {
    expect(deezerUrl(kind, id)).toBe(url);
  });

  it.each([
    ['track', 'Khaled Ouelli El Darek', 15, KHALED_PLAIN],
    ['track', 'Ouelli El Darek', 15, KHALED_TITLE],
    ['album', 'Daft Punk Discovery', 15, `${API}/search/album?q=Daft%20Punk%20Discovery&limit=15`],
    ['track', 'Rock & Roll', 15, `${API}/search/track?q=Rock%20%26%20Roll&limit=15`],
    ['track', '#1 Crush a+b c/d e=f?', 15, `${API}/search/track?q=%231%20Crush%20a%2Bb%20c%2Fd%20e%3Df%3F&limit=15`],
    ['track', '방탄소년단 Dynamite', 15, `${API}/search/track?q=%EB%B0%A9%ED%83%84%EC%86%8C%EB%85%84%EB%8B%A8%20Dynamite&limit=15`],
    ['track', 'Aïcha', 15, `${API}/search/track?q=A%C3%AFcha&limit=15`],
    ['track', 'x', 0, `${API}/search/track?q=x&limit=1`],
    ['track', 'x', 7.9, `${API}/search/track?q=x&limit=7`],
    ['track', 'x', 500, `${API}/search/track?q=x&limit=100`],
    ['track', 'x', Number.NaN, `${API}/search/track?q=x&limit=15`],
  ] as const)('deezerSearchUrl(%s, %j, %d)', (kind, text, limit, url) => {
    expect(deezerSearchUrl(kind, text, limit)).toBe(url);
    expect(new URL(url).searchParams.get('q')).toBe(text);
  });
});

describe('deezerSearchQueries', () => {
  it.each<[string, SearchQuery, string[]]>([
    ['track: artist + title, then title alone', KHALED_QUERY, ['Khaled Ouelli El Darek', 'Ouelli El Darek']],
    ['album', { kind: 'album', title: 'Discovery', artist: 'Daft Punk' }, ['Daft Punk Discovery', 'Discovery']],
    ['credits: title + last credit', { kind: 'track', title: 'despacito remix', artist: 'Luis Fonsi', credits: ['Daddy Yankee', 'Justin Bieber'] }, ['Luis Fonsi despacito remix', 'despacito remix Justin Bieber']],
    ['blank credits ignored', { kind: 'track', title: 'Didi', artist: 'Khaled', credits: [' ', ''] }, ['Khaled Didi', 'Didi']],
    ['quotes and backslashes verbatim', { kind: 'track', title: '"Heroes" a\\b', artist: 'David Bowie' }, ['David Bowie "Heroes" a\\b', '"Heroes" a\\b']],
    ['& and non-Latin kept verbatim', { kind: 'track', title: 'Rock & Roll', artist: '방탄소년단' }, ['방탄소년단 Rock & Roll', 'Rock & Roll']],
    ['album field is not used', { kind: 'track', title: 'One More Time', artist: 'Daft Punk', album: 'Discovery' }, ['Daft Punk One More Time', 'One More Time']],
    ['trimmed', { kind: 'track', title: '  Didi ', artist: ' Khaled  ' }, ['Khaled Didi', 'Didi']],
    ['no artist: one query', { kind: 'track', title: 'Didi', artist: ' ' }, ['Didi']],
    ['no title: one query', { kind: 'album', title: '', artist: 'Khaled' }, ['Khaled']],
    ['nothing', { kind: 'track', title: ' ', artist: '' }, []],
  ])('%s', (_label, q, expected) => {
    expect(deezerSearchQueries(q)).toEqual(expected);
  });
});

describe('getDeezerItem (recorded)', () => {
  it.each<[string, 'track' | 'album', string, ItemMeta]>([
    ['track with contributors', 'track', '3135556', HARDER_BETTER],
    ['track, album date preferred over a later track date', 'track', '515038112', OUELLI_BEST_OF],
    ['track with several Main contributors', 'track', '67238735', GET_LUCKY],
    ['album', 'album', '66071352', BEST_OF],
  ])('%s (%s %s)', async (_label, kind, id, expected) => {
    const calls: string[] = [];
    const item = await getDeezerItem(fixtureCtx({ calls }), kind, id);
    expect(item).toStrictEqual(expected);
    expect(calls).toEqual([`${API}/${kind}/${id}`]);
  });

  it('missing item ("no data", code 800 with HTTP 200) -> 404', async () => {
    const err = await rejection(getDeezerItem(fixtureCtx(), 'track', '1'));
    expect(err.status).toBe(404);
  });

  it.each(['abc', '12/34', '', '1 2', '-5'])('invalid id %j -> 404 without a request', async (id) => {
    const calls: string[] = [];
    const err = await rejection(getDeezerItem(fixtureCtx({ calls }), 'track', id));
    expect(err.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('quota error (code 4) -> 429', async () => {
    const ctx = fixtureCtx({ extra: [fixture(`${API}/album/66071352`, QUOTA_ERROR)] });
    const err = await rejection(getDeezerItem(ctx, 'album', '66071352'));
    expect(err.status).toBe(429);
    expect(err.message).toContain('Quota limit exceeded');
  });

  it('other error objects -> UpstreamError without a 404', async () => {
    const ctx = fixtureCtx({ extra: [fixture(`${API}/track/3135556`, BUSY_ERROR)] });
    const err = await rejection(getDeezerItem(ctx, 'track', '3135556'));
    expect(err.status).toBeUndefined();
    expect(err.message).toContain('Service busy');
    expect(err.message).toContain('700');
  });

  it('HTTP error status passes through', async () => {
    const ctx = fixtureCtx({ extra: [fixture(`${API}/track/3135556`, 'oops', 503)] });
    expect((await rejection(getDeezerItem(ctx, 'track', '3135556'))).status).toBe(503);
  });

  it.each([[[]], [{}], [{ id: 3135556 }], ['text']])('malformed body %j -> UpstreamError, not 404', async (body) => {
    const ctx = fixtureCtx({ extra: [fixture(`${API}/track/3135556`, body)] });
    expect((await rejection(getDeezerItem(ctx, 'track', '3135556'))).status).toBeUndefined();
  });
});

describe('deezerTrackByIsrc', () => {
  it('finds the track (recorded)', async () => {
    const calls: string[] = [];
    expect(await deezerTrackByIsrc(fixtureCtx({ calls }), 'FRZ019601820')).toStrictEqual(OUELLI_SAHRA);
    expect(calls).toEqual([`${API}/track/isrc:FRZ019601820`]);
  });

  it.each(['frz019601820', 'FR-Z01-96-01820', ' FRZ019601820 '])('normalizes %j before the lookup', async (isrc) => {
    const calls: string[] = [];
    expect((await deezerTrackByIsrc(fixtureCtx({ calls }), isrc))?.id).toBe('920717');
    expect(calls).toEqual([`${API}/track/isrc:FRZ019601820`]);
  });

  it('miss ("no data") -> null (recorded)', async () => {
    expect(await deezerTrackByIsrc(fixtureCtx(), 'XX0000000000')).toBeNull();
  });

  it.each(['', 'nope', 'FRZ01960182', 'FRZ0196018200', '12Z019601820', 'FRZ01960182X'])('malformed ISRC %j -> null without a request', async (isrc) => {
    const calls: string[] = [];
    expect(await deezerTrackByIsrc(fixtureCtx({ calls }), isrc)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('a track carrying a different ISRC is not an identifier match', async () => {
    const body = { ...recorded(`${API}/track/isrc:FRZ019601820`), isrc: 'FRZ019800090' };
    const ctx = fixtureCtx({ extra: [fixture(`${API}/track/isrc:FRZ019601820`, body)] });
    expect(await deezerTrackByIsrc(ctx, 'FRZ019601820')).toBeNull();
  });

  it('quota error -> 429', async () => {
    const ctx = fixtureCtx({ extra: [fixture(`${API}/track/isrc:FRZ019601820`, QUOTA_ERROR)] });
    expect((await rejection(deezerTrackByIsrc(ctx, 'FRZ019601820'))).status).toBe(429);
  });

  it('other error -> UpstreamError', async () => {
    const ctx = fixtureCtx({ extra: [fixture(`${API}/track/isrc:FRZ019601820`, BUSY_ERROR)] });
    expect((await rejection(deezerTrackByIsrc(ctx, 'FRZ019601820'))).status).toBeUndefined();
  });
});

describe('deezerAlbumByUpc', () => {
  it('finds the album (recorded)', async () => {
    const calls: string[] = [];
    expect(await deezerAlbumByUpc(fixtureCtx({ calls }), '602567759461')).toStrictEqual(BEST_OF);
    expect(calls).toEqual([`${API}/album/upc:602567759461`]);
  });

  it('EAN-13 with a leading zero: Deezer misses it, the 12-digit UPC-A finds it (recorded)', async () => {
    const calls: string[] = [];
    expect(await deezerAlbumByUpc(fixtureCtx({ calls }), '0602567759461')).toStrictEqual(BEST_OF);
    expect(calls).toEqual([`${API}/album/upc:0602567759461`, `${API}/album/upc:602567759461`]);
  });

  it('prefers the UPC as given when both forms answer', async () => {
    const other = { ...recorded(`${API}/album/upc:602567759461`), id: 123, upc: '0602567759461' };
    const ctx = fixtureCtx({ extra: [fixture(`${API}/album/upc:0602567759461`, other)] });
    expect((await deezerAlbumByUpc(ctx, '0602567759461'))?.id).toBe('123');
  });

  it('miss ("no data") -> null (recorded)', async () => {
    expect(await deezerAlbumByUpc(fixtureCtx(), '999999999999')).toBeNull();
  });

  it.each(['', 'abc', '1234567', '123456789012345', '60256775946x'])('malformed UPC %j -> null without a request', async (upc) => {
    const calls: string[] = [];
    expect(await deezerAlbumByUpc(fixtureCtx({ calls }), upc)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('an album carrying a different UPC is not an identifier match', async () => {
    const body = { ...recorded(`${API}/album/upc:602567759461`), upc: '602567759478' };
    const ctx = fixtureCtx({ extra: [fixture(`${API}/album/upc:602567759461`, body)] });
    expect(await deezerAlbumByUpc(ctx, '602567759461')).toBeNull();
  });

  it('quota error -> 429', async () => {
    const ctx = fixtureCtx({ extra: [fixture(`${API}/album/upc:602567759461`, QUOTA_ERROR)] });
    expect((await rejection(deezerAlbumByUpc(ctx, '602567759461'))).status).toBe(429);
  });

  it('a failed alternate lookup does not hide a hit', async () => {
    const ctx = fixtureCtx({ extra: [fixture(`${API}/album/upc:0602567759461`, BUSY_ERROR)] });
    expect(await deezerAlbumByUpc(ctx, '0602567759461')).toStrictEqual(BEST_OF);
  });

  it('a miss plus a failed lookup is an error, not a miss', async () => {
    const ctx = fixtureCtx({ extra: [fixture(`${API}/album/upc:602567759461`, QUOTA_ERROR)] });
    expect((await rejection(deezerAlbumByUpc(ctx, '0602567759461'))).status).toBe(429);
  });
});

describe('searchDeezer', () => {
  it('artist + title query first, then title alone (recorded)', async () => {
    const calls: string[] = [];
    const items = await searchDeezer(fixtureCtx({ calls }), KHALED_QUERY);
    expect(calls).toEqual([KHALED_PLAIN, KHALED_TITLE]);
    expect(items.slice(0, 2)).toStrictEqual([SEARCH_OUELLI, SEARCH_OUELLI_LIVE]);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(items.length).toBeGreaterThan(2);
  });

  it('album search (recorded)', async () => {
    const calls: string[] = [];
    const items = await searchDeezer(fixtureCtx({ calls }), { kind: 'album', title: 'Discovery', artist: 'Daft Punk' });
    expect(calls).toEqual([`${API}/search/album?q=Daft%20Punk%20Discovery&limit=15`, `${API}/search/album?q=Discovery&limit=15`]);
    expect(items.slice(0, 2)).toStrictEqual<AlbumMeta[]>([
      {
        kind: 'album',
        id: '302127',
        url: 'https://www.deezer.com/album/302127',
        title: 'Discovery',
        artists: ['Daft Punk'],
        artist: 'Daft Punk',
        trackCount: 14,
        albumType: 'album',
        explicit: false,
        art: cover('5718f7c81c27e0b2417e2a4c45224f8a'),
      },
      {
        kind: 'album',
        id: '74901252',
        url: 'https://www.deezer.com/album/74901252',
        title: 'Discovery',
        artists: ['Data Punk'],
        artist: 'Data Punk',
        trackCount: 16,
        albumType: 'album',
        explicit: false,
        art: cover('4ff21b23662026086ec6145e406b6b0e'),
      },
    ]);
  });

  it('merges the first query\'s results first and drops duplicates', async () => {
    const plain = recorded(KHALED_PLAIN) as { data: Record<string, unknown>[] };
    const [best, live] = plain.data;
    const extraHit = { ...best, id: 1111, title: 'Ouelli El Darek (Remix)', title_version: '(Remix)' };
    const ctx = fixtureCtx({
      extra: [
        fixture(KHALED_PLAIN, { data: [live, best], total: 2 }),
        fixture(KHALED_TITLE, { data: [best, extraHit, live], total: 3 }),
      ],
    });
    const items = await searchDeezer(ctx, KHALED_QUERY);
    expect(items.map((i) => i.id)).toEqual(['2298124', '515038112', '1111']);
    expect(items[2]?.title).toBe('Ouelli El Darek (Remix)');
  });

  it('limit applies to each query; the merged list can be longer', async () => {
    const plain = recorded(KHALED_PLAIN) as { data: Record<string, unknown>[] };
    const [best, live] = plain.data;
    const pl = `${API}/search/track?q=Khaled%20Ouelli%20El%20Darek&limit=1`;
    const t = `${API}/search/track?q=Ouelli%20El%20Darek&limit=1`;
    const calls: string[] = [];
    const ctx = fixtureCtx({ calls, extra: [fixture(pl, { data: [best] }), fixture(t, { data: [live] })] });
    expect((await searchDeezer(ctx, KHALED_QUERY, 1)).map((i) => i.id)).toEqual(['515038112', '2298124']);
    expect(calls).toEqual([pl, t]);
  });

  it('encodes quotes, & and non-Latin text', async () => {
    const pl = `${API}/search/track?q=%EB%B0%A9%ED%83%84%EC%86%8C%EB%85%84%EB%8B%A8%20Rock%20%26%20Roll%20%22Live%22&limit=15`;
    const t = `${API}/search/track?q=Rock%20%26%20Roll%20%22Live%22&limit=15`;
    const calls: string[] = [];
    const empty = { data: [], total: 0 };
    const ctx = fixtureCtx({ calls, extra: [fixture(pl, empty), fixture(t, empty)] });
    expect(await searchDeezer(ctx, { kind: 'track', title: 'Rock & Roll "Live"', artist: '방탄소년단' })).toEqual([]);
    expect(calls).toEqual([pl, t]);
    expect(new URL(pl).searchParams.get('q')).toBe('방탄소년단 Rock & Roll "Live"');
  });

  it('one failed query still returns the other one', async () => {
    const ctx = fixtureCtx({ extra: [fixture(KHALED_TITLE, QUOTA_ERROR)] });
    expect((await searchDeezer(ctx, KHALED_QUERY)).map((i) => i.id)).toEqual(['515038112', '2298124']);
  });

  it('both queries failing -> UpstreamError', async () => {
    const ctx = fixtureCtx({ extra: [fixture(KHALED_PLAIN, QUOTA_ERROR), fixture(KHALED_TITLE, QUOTA_ERROR)] });
    expect((await rejection(searchDeezer(ctx, KHALED_QUERY))).status).toBe(429);
  });

  it('skips malformed entries and tolerates a missing data array', async () => {
    const plain = recorded(KHALED_PLAIN) as { data: Record<string, unknown>[] };
    const ctx = fixtureCtx({
      extra: [fixture(KHALED_TITLE, { total: 0 }), fixture(KHALED_PLAIN, { data: [null, { id: 5 }, { title: 'x' }, plain.data[0]] })],
    });
    expect((await searchDeezer(ctx, KHALED_QUERY)).map((i) => i.id)).toEqual(['515038112']);
  });

  it('empty query -> no requests', async () => {
    const calls: string[] = [];
    expect(await searchDeezer(fixtureCtx({ calls }), { kind: 'track', title: '', artist: ' ' })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('artist only -> plain query only', async () => {
    const url = `${API}/search/album?q=Khaled&limit=15`;
    const calls: string[] = [];
    const ctx = fixtureCtx({ calls, extra: [fixture(url, { data: [], total: 0 })] });
    expect(await searchDeezer(ctx, { kind: 'album', title: '', artist: 'Khaled' })).toEqual([]);
    expect(calls).toEqual([url]);
  });
});

describe('mapping', () => {
  const track = () => recorded(`${API}/track/515038112`);
  const album = () => recorded(`${API}/album/66071352`);
  const contributor = (name: string, role: string) => ({ id: 1, name, type: 'artist', role });

  it('orders contributors Main, then Featured, then other roles, without duplicates', () => {
    const t = mapDeezerTrack({
      ...track(),
      contributors: [
        contributor('Feat One', 'Featured'),
        contributor('Khaled', 'Main'),
        contributor('Remixer', 'Remixer'),
        contributor('Second Main', 'Main'),
        contributor('khaled', 'Featured'),
        contributor('Feat Two', 'Featured'),
        { id: 2, role: 'Main' },
      ],
    });
    expect(t?.artists).toEqual(['Khaled', 'Second Main', 'Feat One', 'Feat Two', 'Remixer']);
    expect(t?.artist).toBe('Khaled');
  });

  it.each([[undefined], [[]], ['nope']])('contributors %j -> [artist.name]', (contributors) => {
    const t = mapDeezerTrack({ ...track(), contributors });
    expect(t?.artists).toEqual(['Khaled']);
  });

  it('artist display falls back to the contributors', () => {
    const t = mapDeezerTrack({ ...track(), artist: undefined, contributors: [contributor('A', 'Main'), contributor('B', 'Featured')] });
    expect(t).toMatchObject({ artists: ['A', 'B'], artist: 'A, B' });
  });

  it.each([
    ['Ouelli El Darek (Live)', '(Live)', 'Ouelli El Darek (Live)'],
    ['Ouelli El Darek', '(Live)', 'Ouelli El Darek (Live)'],
    ['Ouelli El Darek (live)', '(Live)', 'Ouelli El Darek (live)'],
    ['Ouelli El Darek', '', 'Ouelli El Darek'],
  ])('title %j + title_version %j -> %j', (title, title_version, expected) => {
    expect(mapDeezerTrack({ ...track(), title, title_version })?.title).toBe(expected);
  });

  it('ignores Deezer\'s link field and keeps the canonical URL', () => {
    const t = mapDeezerTrack({ ...track(), link: 'https://www.deezer.com/fr/track/515038112?utm=x' });
    expect(t?.url).toBe('https://www.deezer.com/track/515038112');
  });

  it('falls back to the track\'s release_date when the album has none', () => {
    const t = track();
    const t2 = mapDeezerTrack({ ...t, album: { ...(t.album as object), release_date: undefined } });
    expect(t2?.releaseDate).toBe('2018-06-22');
  });

  it('maps a record_type on the embedded album', () => {
    const t = track();
    expect(mapDeezerTrack({ ...t, album: { ...(t.album as object), record_type: 'compile' } })?.albumType).toBe('compilation');
  });

  it('omits unknown or invalid optional fields', () => {
    const t = mapDeezerTrack({
      id: 42,
      title: 'Song',
      artist: { name: 'Someone' },
      duration: 0,
      track_position: 0,
      explicit_lyrics: 1,
      release_date: '0000-00-00',
      isrc: '',
      album: { title: '', cover_xl: 'https://cdn-images.dzcdn.net/images/cover//1000x1000-000000-80-0-0.jpg' },
    });
    expect(t).toStrictEqual<TrackMeta>({
      kind: 'track',
      id: '42',
      url: 'https://www.deezer.com/track/42',
      title: 'Song',
      artists: ['Someone'],
      artist: 'Someone',
    });
  });

  it('uses cover_big when cover_xl is missing', () => {
    const t = track();
    const big = 'https://cdn-images.dzcdn.net/images/cover/e28d75ea1f645fe0cc6b69e741ee5756/500x500-000000-80-0-0.jpg';
    expect(mapDeezerTrack({ ...t, album: { ...(t.album as object), cover_xl: undefined } })?.art).toBe(big);
    expect(mapDeezerAlbum({ ...album(), cover_xl: null })?.art).toBe(big);
  });

  it.each([[null], [[]], ['x'], [{ title: 'x' }], [{ id: 1 }], [{ id: -3, title: 'x' }], [{ id: 0, title: 'x' }], [{ id: 1.5, title: 'x' }], [{ id: 1, title: '  ' }]])(
    'rejects %j',
    (raw) => {
      expect(mapDeezerTrack(raw)).toBeNull();
      expect(mapDeezerAlbum(raw)).toBeNull();
    },
  );

  it('accepts numeric-string ids', () => {
    expect(mapDeezerAlbum({ ...album(), id: '66071352' })?.id).toBe('66071352');
  });

  it.each([
    ['album', 'album'],
    ['single', 'single'],
    ['ep', 'ep'],
    ['compile', 'compilation'],
    ['compilation', undefined],
    ['Album', undefined],
    ['constructor', undefined],
    [undefined, undefined],
    [3, undefined],
  ])('recordType(%j) -> %j', (raw, expected) => {
    expect(recordType(raw)).toBe(expected);
    expect(mapDeezerAlbum({ ...album(), record_type: raw })?.albumType).toBe(expected);
  });

  it.each([
    ['2007-11-26', '2007-11-26'],
    ['2007-11', '2007-11'],
    ['2007', '2007'],
    ['2007-11-00', '2007-11'],
    ['2007-00-00', '2007'],
    ['0000-00-00', undefined],
    ['26/11/2007', undefined],
    ['', undefined],
    [null, undefined],
    [20071126, undefined],
  ])('isoDate(%j) -> %j', (raw, expected) => {
    expect(isoDate(raw)).toBe(expected);
  });
});

describe('identifier helpers', () => {
  it.each([
    ['FRZ019601820', 'FRZ019601820'],
    ['frz019601820', 'FRZ019601820'],
    ['FR-Z01-96-01820', 'FRZ019601820'],
    ['US QX9 13 00108', 'USQX91300108'],
    ['FRZ01960182', null],
    ['1RZ019601820', null],
    ['', null],
  ])('normalizeIsrc(%j) -> %j', (raw, expected) => {
    expect(normalizeIsrc(raw)).toBe(expected);
  });

  it.each([
    ['602567759461', ['602567759461']],
    ['0602567759461', ['0602567759461', '602567759461']],
    ['00602567759461', ['00602567759461', '602567759461']],
    ['0012345678905', ['0012345678905', '012345678905']],
    ['3700187670214', ['3700187670214']],
    ['12345678', ['12345678']],
  ])('upcVariants(%j) -> %j', (upc, expected) => {
    expect(upcVariants(upc)).toEqual(expected);
  });

  it('mergeById keeps the first occurrence in list order', () => {
    const t = (id: string): TrackMeta => ({ kind: 'track', id, url: deezerUrl('track', id), title: id, artists: [], artist: '' });
    expect(mergeById([[t('1'), t('2')], [t('2'), t('3'), t('1')], []]).map((i) => i.id)).toEqual(['1', '2', '3']);
    expect(mergeById([])).toEqual([]);
  });
});
