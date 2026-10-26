import { decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpstreamCtx } from '../src/http';
import { UpstreamError } from '../src/http';
import {
  albumTypeOf,
  appleAlbumsByUpc,
  appleTracksByIsrc,
  appleUrl,
  getAppleAuth,
  getAppleItem,
  REJECTED_TOKEN_COOLDOWN_S,
  searchApple,
  SECRETS_WARNING,
  splitReleaseSuffix,
  toPkcs8Pem,
  TOKEN_REFRESH_MARGIN_S,
  TOKEN_TTL_S,
} from '../src/sources/apple';
import type { AlbumMeta, AppEnv, ItemMeta, TrackMeta } from '../src/types';
import type { HttpFixture } from './helpers/fixtures';
import { FIXTURES, fixtureCtx } from './helpers/fixtures';

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// Fixture helpers

const ITUNES = 'https://itunes.apple.com';
const MK = 'https://api.music.apple.com/v1/catalog';

const SAHRA_ART = 'https://is1-ssl.mzstatic.com/image/thumb/Music123/v4/ef/0b/15/ef0b1594-461e-f4bf-93d4-e1df560a3972/06UMGIM00831.rgb.jpg';
const BEST_OF_ART = 'https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/46/58/84/4658840b-982e-8456-04f0-1df278920774/00602567759461.rgb.jpg';

const lookupUrl = (id: string, country = 'us') => `${ITUNES}/lookup?id=${id}&country=${country}&entity=song`;
const songSearchUrl = (term: string, country = 'us', limit = 20) =>
  `${ITUNES}/search?term=${term}&country=${country}&media=music&entity=song&limit=${limit}`;
const albumSearchUrl = (term: string, country = 'us', limit = 20) =>
  `${ITUNES}/search?term=${term}&country=${country}&media=music&entity=album&limit=${limit}`;

function fixture(url: string, body: unknown, status = 200): HttpFixture {
  return {
    request: { url },
    response: {
      status,
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
  };
}

function recordedBody(url: string): string {
  const f = FIXTURES.get(new URL(url).toString());
  if (!f) throw new Error(`missing fixture ${url}`);
  return f.response.body;
}

/** The real response iTunes gives for an id it doesn't know. */
const ITUNES_MISS = () => recordedBody(lookupUrl('1'));

/** Observed iTunes answer (HTTP 400) for a country it has no store in. */
const ITUNES_BAD_COUNTRY = {
  errorMessage: 'Invalid value(s) for key(s): [country]',
  queryParameters: {
    output: 'json',
    callback: 'A javascript function to handle your search results',
    country: 'ISO-2A country code',
    limit: 'The number of search results to return',
    term: 'A search string',
    lang: 'ISO-2A language code',
  },
};

/** Records the Authorization header sent with each request. */
function authLog(ctx: UpstreamCtx): string[] {
  const seen: string[] = [];
  const inner = ctx.fetch;
  ctx.fetch = (url, init) => {
    seen.push(`${new Headers(init?.headers).get('authorization') ?? '-'} ${url}`);
    return inner(url, init);
  };
  return seen;
}

function byId<T extends ItemMeta>(items: T[], id: string): T {
  const item = items.find((i) => i.id === id);
  if (!item) throw new Error(`no item ${id} in ${items.map((i) => i.id).join(',')}`);
  return item;
}

// ---------------------------------------------------------------------------------------------
// Hand-written MusicKit responses, modeled on Apple's documented resource format:
// { data: [ { id, type, href, attributes, relationships: { <name>: { href, data: [...] } } } ] }.

const mkArtwork = (base: string, size = 1400) => ({
  width: size,
  height: size,
  url: `${base}/{w}x{h}bb.jpg`,
  bgColor: 'd9cfb7',
  textColor1: '0f0c09',
  textColor2: '2e2416',
  textColor3: '3b352c',
  textColor4: '544a3b',
});

const KHALED = {
  id: '384924',
  type: 'artists',
  href: '/v1/catalog/us/artists/384924',
  attributes: { name: 'Khaled', genreNames: ['Worldwide'], url: 'https://music.apple.com/us/artist/khaled/384924' },
};

const SAHRA_ATTRS = {
  artistName: 'Khaled',
  artwork: mkArtwork(SAHRA_ART),
  copyright: 'An Island Records Release; ℗ 1997 UMG Recordings, Inc.',
  genreNames: ['Worldwide', 'Music'],
  isCompilation: false,
  isComplete: true,
  isMasteredForItunes: false,
  isSingle: false,
  name: 'Sahra',
  playParams: { id: '1444129774', kind: 'album' },
  recordLabel: 'Barclay',
  releaseDate: '1996-11-08',
  trackCount: 12,
  upc: '00731453398924',
  url: 'https://music.apple.com/us/album/sahra/1444129774',
};

const SAHRA = { id: '1444129774', type: 'albums', href: '/v1/catalog/us/albums/1444129774', attributes: SAHRA_ATTRS };

const OUELLI_ATTRS = {
  albumName: 'Sahra',
  artistName: 'Khaled',
  artwork: mkArtwork(SAHRA_ART),
  composerName: 'Khaled Hadj Brahim',
  discNumber: 1,
  durationInMillis: 191093,
  genreNames: ['Worldwide', 'Music'],
  hasLyrics: false,
  isAppleDigitalMaster: false,
  isrc: 'FRZ019601820',
  name: 'Ouelli el Darek',
  playParams: { id: '1444130134', kind: 'song' },
  previews: [{ url: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview115/v4/aa/bb/cc/preview.plus.aac.p.m4a' }],
  releaseDate: '1996-11-08',
  trackNumber: 5,
  url: 'https://music.apple.com/us/album/ouelli-el-darek/1444129774?i=1444130134',
};

function mkSong(id: string, attributes: Record<string, unknown>, album?: object, artists: object[] = [KHALED]) {
  return {
    id,
    type: 'songs',
    href: `/v1/catalog/us/songs/${id}`,
    attributes,
    relationships: {
      albums: { href: `/v1/catalog/us/songs/${id}/albums`, data: album ? [album] : [] },
      artists: { href: `/v1/catalog/us/songs/${id}/artists`, data: artists },
    },
  };
}

const OUELLI = mkSong('1444130134', OUELLI_ATTRS, SAHRA);

/** Search results carry attributes only. */
const searchHit = (r: { id: string; type: string; href: string; attributes: object }) => ({
  id: r.id,
  type: r.type,
  href: r.href,
  attributes: r.attributes,
});

const mkSongUrl = (id: string, sf = 'us') => `${MK}/${sf}/songs/${id}?include=albums,artists`;
const mkAlbumUrl = (id: string, sf = 'us') => `${MK}/${sf}/albums/${id}?include=artists`;
const mkIsrcUrl = (isrc: string) => `${MK}/us/songs?filter[isrc]=${isrc}&include=albums,artists`;
const mkUpcUrl = (upc: string) => `${MK}/us/albums?filter[upc]=${upc}&include=artists`;
const mkSearchUrl = (term: string, types: string, limit = 20, sf = 'us') =>
  `${MK}/${sf}/search?term=${term}&types=${types}&limit=${limit}`;

const MK_NOT_FOUND = {
  errors: [
    {
      id: 'GQVYZ3FRMBQGSJ3L6ZMCVOJ3UE',
      title: 'Resource Not Found',
      detail: 'Resource with requested id was not found',
      code: '40400',
      status: '404',
    },
  ],
};

const mkCtx = (extra: HttpFixture[], calls?: string[], storefront = 'us') =>
  fixtureCtx({ apple: { token: 'test' }, extra, calls, storefront });

// ---------------------------------------------------------------------------------------------

describe('appleUrl', () => {
  it.each([
    ['track', '1444130134', 'https://music.apple.com/song/1444130134'],
    ['album', '1444129774', 'https://music.apple.com/album/1444129774'],
  ] as const)('%s %s', (kind, id, url) => {
    expect(appleUrl(kind, id)).toBe(url);
  });
});

describe('release names', () => {
  it.each([
    ['Borracho - Single', { title: 'Borracho', suffix: 'Single' }],
    ['Take Me to Church - EP', { title: 'Take Me to Church', suffix: 'EP' }],
    ['Old Town Road (feat. Billy Ray Cyrus) [Remix] - Single', { title: 'Old Town Road (feat. Billy Ray Cyrus) [Remix]', suffix: 'Single' }],
    ['Sahra', { title: 'Sahra' }],
    ['7', { title: '7' }],
    // Only Apple's exact " - Single" / " - EP" convention is a marker.
    ['Mcp Performs Lil Nas X: 7 Ep', { title: 'Mcp Performs Lil Nas X: 7 Ep' }],
    ['Single', { title: 'Single' }],
    ['The Singles - single', { title: 'The Singles - single' }],
    ['Taylor Swift - The Life of a Showgirl - Piano Covers', { title: 'Taylor Swift - The Life of a Showgirl - Piano Covers' }],
  ])('splitReleaseSuffix(%j)', (name, expected) => {
    expect(splitReleaseSuffix(name)).toEqual(expected);
  });

  it.each([
    [{ isCompilation: true, isSingle: false }, 'compilation'],
    [{ variousArtists: true }, 'compilation'],
    [{ isSingle: true, isCompilation: false }, 'single'],
    [{ suffix: 'Single' as const }, 'single'],
    [{ suffix: 'EP' as const, isSingle: false }, 'ep'],
    [{ isSingle: false, isCompilation: false }, 'album'],
    // iTunes has no isSingle flag and Apple doesn't suffix every EP.
    [{}, undefined],
  ])('albumTypeOf(%j) = %s', (markers, type) => {
    expect(albumTypeOf(markers)).toBe(type);
  });
});

// ---------------------------------------------------------------------------------------------
// Developer token

const TEAM_ID = 'ABCDE12345';
const KEY_ID = 'XYZ987WVUT';
const NOW = 1_790_000_000;

interface TestKey {
  pem: string;
  base64: string;
  publicKey: CryptoKey;
}

async function generateKey(): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  let bin = '';
  for (const b of der) bin += String.fromCharCode(b);
  const base64 = btoa(bin);
  const pem = `-----BEGIN PRIVATE KEY-----\n${(base64.match(/.{1,64}/g) ?? []).join('\n')}\n-----END PRIVATE KEY-----\n`;
  return { pem, base64, publicKey: pair.publicKey };
}

/** Env with the test team and key ids; `ids` overrides them (undefined removes one). */
function appleEnv(privateKey: string | undefined, ids: { teamId?: string; keyId?: string } = {}): AppEnv {
  const { teamId, keyId } = { teamId: TEAM_ID, keyId: KEY_ID, ...ids };
  return { APPLE_TEAM_ID: teamId, APPLE_KEY_ID: keyId, APPLE_PRIVATE_KEY: privateKey } as AppEnv;
}

describe('getAppleAuth', () => {
  it('warns once per isolate when secrets are missing', async () => {
    vi.resetModules();
    const fresh = await import('../src/sources/apple');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await fresh.getAppleAuth(appleEnv(undefined), NOW)).toBeNull();
    expect(await fresh.getAppleAuth(appleEnv(undefined, { teamId: undefined, keyId: undefined }), NOW)).toBeNull();
    expect(await fresh.getAppleAuth(appleEnv('not a key'), NOW)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(SECRETS_WARNING);
  });

  it.each<[string, (k: TestKey) => AppEnv]>([
    ['no private key', () => appleEnv(undefined)],
    ['blank private key', () => appleEnv('  ')],
    ['no team id', (k) => appleEnv(k.pem, { teamId: undefined })],
    ['no key id', (k) => appleEnv(k.pem, { keyId: undefined })],
    ['empty key id', (k) => appleEnv(k.pem, { keyId: '' })],
    ['garbage key', () => appleEnv('-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----')],
    ['truncated key', (k) => appleEnv(k.base64.slice(0, 40))],
  ])('returns null for %s', async (_, makeEnv) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await getAppleAuth(makeEnv(await generateKey()), NOW)).toBeNull();
  });

  it.each<[string, (k: TestKey) => string]>([
    ['PEM with real newlines', (k) => k.pem],
    ['literal \\n escapes (one-line env var)', (k) => k.pem.replace(/\n/g, '\\n')],
    ['CRLF newlines', (k) => k.pem.replace(/\n/g, '\r\n')],
    ['base64 only, one line', (k) => k.base64],
    ['base64 lines without BEGIN/END', (k) => (k.base64.match(/.{1,64}/g) ?? []).join('\n')],
    ['wrapped in quotes', (k) => `"${k.pem.replace(/\n/g, '\\n')}"`],
  ])('accepts a private key as %s', async (_, variant) => {
    const key = await generateKey();
    expect(toPkcs8Pem(variant(key))).toBe(key.pem);

    const auth = await getAppleAuth(appleEnv(variant(key)), NOW);
    expect(auth).not.toBeNull();
    const token = auth?.token ?? '';
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'ES256', kid: KEY_ID });
    const { payload } = await jwtVerify(token, key.publicKey, { issuer: TEAM_ID, currentDate: new Date(NOW * 1000) });
    expect(payload).toEqual({ iss: TEAM_ID, iat: NOW, exp: NOW + TOKEN_TTL_S });
    expect(TOKEN_TTL_S).toBe(12 * 3600);
  });

  it('caches the token until an hour before expiry', async () => {
    const key = await generateKey();
    const env = appleEnv(key.pem);
    const first = await getAppleAuth(env, NOW);
    const refreshAt = NOW + TOKEN_TTL_S - TOKEN_REFRESH_MARGIN_S;
    expect(TOKEN_REFRESH_MARGIN_S).toBe(3600);

    for (const t of [NOW + 1, NOW + 3600, refreshAt - 1]) {
      expect((await getAppleAuth(env, t))?.token).toBe(first?.token);
    }
    // A fresh env object with the same secrets shares the cache.
    expect((await getAppleAuth(appleEnv(key.pem), NOW + 10))?.token).toBe(first?.token);

    const renewed = await getAppleAuth(env, refreshAt);
    expect(renewed?.token).not.toBe(first?.token);
    expect(decodeJwt(renewed?.token ?? '')).toMatchObject({ iat: refreshAt, exp: refreshAt + TOKEN_TTL_S });
    expect((await getAppleAuth(env, refreshAt + 5))?.token).toBe(renewed?.token);
  });

  it('signs a new token when the secrets change', async () => {
    const env = appleEnv((await generateKey()).pem);
    const other = await generateKey();
    const a = await getAppleAuth(env, NOW);
    const b = await getAppleAuth(appleEnv(other.pem, { teamId: 'TEAM000002', keyId: 'KEY0000002' }), NOW + 1);
    expect(b?.token).not.toBe(a?.token);
    const { payload, protectedHeader } = await jwtVerify(b?.token ?? '', other.publicKey, { currentDate: new Date(NOW * 1000) });
    expect(payload.iss).toBe('TEAM000002');
    expect(protectedHeader.kid).toBe('KEY0000002');
  });
});

// ---------------------------------------------------------------------------------------------
// iTunes mode (recorded responses)

const OUELLI_ITUNES: TrackMeta = {
  kind: 'track',
  id: '1444130134',
  url: 'https://music.apple.com/song/1444130134',
  title: 'Ouelli el Darek',
  artists: ['Khaled'],
  artist: 'Khaled',
  album: 'Sahra',
  durationMs: 191093,
  durationPrecisionMs: 1,
  explicit: false,
  releaseDate: '1996-11-08',
  trackNumber: 5,
  art: `${SAHRA_ART}/600x600bb.jpg`,
};

const SAHRA_ITUNES: AlbumMeta = {
  kind: 'album',
  id: '1444129774',
  url: 'https://music.apple.com/album/1444129774',
  title: 'Sahra',
  artists: ['Khaled'],
  artist: 'Khaled',
  trackCount: 12,
  explicit: false,
  releaseDate: '1996-11-08',
  art: `${SAHRA_ART}/600x600bb.jpg`,
};

const BEST_OF_ITUNES: AlbumMeta = {
  kind: 'album',
  id: '1400380382',
  url: 'https://music.apple.com/album/1400380382',
  title: 'Best Of',
  artists: ['Khaled'],
  artist: 'Khaled',
  trackCount: 15,
  explicit: false,
  releaseDate: '2007-01-01',
  art: `${BEST_OF_ART}/600x600bb.jpg`,
};

describe('iTunes mode: getAppleItem', () => {
  it('maps a song lookup', async () => {
    const calls: string[] = [];
    const ctx = fixtureCtx({ calls });
    expect(await getAppleItem(ctx, 'track', '1444130134')).toEqual(OUELLI_ITUNES);
    expect(calls).toEqual([lookupUrl('1444130134')]);
  });

  it('maps an album lookup (collection followed by its songs)', async () => {
    expect(await getAppleItem(fixtureCtx(), 'album', '1444129774')).toEqual(SAHRA_ITUNES);
  });

  it.each([
    ['an unknown id', 'track', '1'],
    ['an album id requested as a track', 'track', '1444129774'],
    ['a track id requested as an album', 'album', '1444130134'],
  ] as const)('throws 404 for %s', async (_, kind, id) => {
    const calls: string[] = [];
    const err = await getAppleItem(fixtureCtx({ calls }), kind, id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).status).toBe(404);
    // Already in the fallback storefront: no retry.
    expect(calls).toHaveLength(1);
  });

  it('retries once in the US storefront when the item is not sold in the visitor storefront', async () => {
    const calls: string[] = [];
    const ctx = fixtureCtx({ storefront: 'fr', calls, extra: [fixture(lookupUrl('1444130134', 'fr'), ITUNES_MISS())] });
    expect(await getAppleItem(ctx, 'track', '1444130134')).toEqual(OUELLI_ITUNES);
    expect(calls).toEqual([lookupUrl('1444130134', 'fr'), lookupUrl('1444130134')]);
  });

  it('retries in the US storefront when iTunes has no store for the visitor country', async () => {
    const calls: string[] = [];
    const ctx = fixtureCtx({ storefront: 'xx', calls, extra: [fixture(lookupUrl('1444129774', 'xx'), ITUNES_BAD_COUNTRY, 400)] });
    expect(await getAppleItem(ctx, 'album', '1444129774')).toEqual(SAHRA_ITUNES);
    expect(calls).toEqual([lookupUrl('1444129774', 'xx'), lookupUrl('1444129774')]);
  });

  it('uses the visitor storefront when the item is there', async () => {
    const calls: string[] = [];
    const ctx = fixtureCtx({ storefront: 'fr', calls, extra: [fixture(lookupUrl('1444130134', 'fr'), recordedBody(lookupUrl('1444130134')))] });
    expect(await getAppleItem(ctx, 'track', '1444130134')).toEqual(OUELLI_ITUNES);
    expect(calls).toEqual([lookupUrl('1444130134', 'fr')]);
  });

  it('throws 404 when neither storefront has the item', async () => {
    const calls: string[] = [];
    const ctx = fixtureCtx({ storefront: 'fr', calls, extra: [fixture(lookupUrl('1', 'fr'), ITUNES_MISS())] });
    await expect(getAppleItem(ctx, 'track', '1')).rejects.toMatchObject({ status: 404 });
    expect(calls).toEqual([lookupUrl('1', 'fr'), lookupUrl('1')]);
  });
});

describe('iTunes mode: identifiers', () => {
  it('looks albums up by UPC', async () => {
    const calls: string[] = [];
    expect(await appleAlbumsByUpc(fixtureCtx({ calls }), '602567759461')).toEqual([BEST_OF_ITUNES]);
    expect(calls).toEqual([`${ITUNES}/lookup?upc=602567759461&country=us`]);
  });

  it('returns no tracks by ISRC without calling upstream', async () => {
    const calls: string[] = [];
    expect(await appleTracksByIsrc(fixtureCtx({ calls }), 'FRZ019601820')).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('iTunes mode: searchApple', () => {
  it('searches songs with "artist title" and maps every hit', async () => {
    const calls: string[] = [];
    const hits = await searchApple(fixtureCtx({ calls }), { kind: 'track', title: 'Ouelli El Darek', artist: 'Khaled' });
    expect(calls).toEqual([songSearchUrl('Khaled+Ouelli+El+Darek')]);
    expect(hits.map((h) => [h.id, h.title, h.kind === 'track' ? h.album : ''])).toEqual([
      ['1444130134', 'Ouelli el Darek', 'Sahra'],
      ['1444050118', 'Ouelli el Darek', 'Hafla (Live)'],
      ['1400382182', 'Ouelli El Darek', 'Best Of'],
    ]);
    expect(hits[0]).toEqual(OUELLI_ITUNES);
  });

  it.each<[string, Partial<TrackMeta>]>([
    // Single suffix stripped from the album, kept as the release type.
    ['1479239196', { title: 'Panini (DaBaby Remix)', album: 'Panini (DaBaby Remix)', albumType: 'single', artist: 'Lil Nas X & DaBaby', artists: ['Lil Nas X & DaBaby'] }],
    ['1458638381', { album: 'Old Town Road (feat. Billy Ray Cyrus) [Remix]', albumType: 'single' }],
    // "7" is an EP without Apple's suffix: the type stays unknown.
    ['1468166328', { title: 'Panini', album: '7', durationMs: 114893, releaseDate: '2019-06-20' }],
    // Various Artists collections are compilations.
    ['1634891293', { title: 'Panini', album: 'Pop Internacional 2022', albumType: 'compilation' }],
    // "cleaned" is the edited version.
    ['1586182264', { title: 'THATS WHAT I WANT', album: 'MONTERO', explicit: false }],
  ])('maps song hit %s', async (id, expected) => {
    const hits = await searchApple(fixtureCtx(), { kind: 'track', title: 'Panini', artist: 'Lil Nas X' });
    const hit = byId(hits, id);
    expect(hit).toMatchObject(expected);
    if (!('albumType' in expected)) expect(hit).not.toHaveProperty('albumType');
  });

  it('searches albums and strips single/EP suffixes', async () => {
    const hits = (await searchApple(fixtureCtx(), { kind: 'album', title: 'Take Me to Church', artist: 'Hozier' })) as AlbumMeta[];
    expect(hits).toHaveLength(20);
    expect(byId(hits, '752404355')).toEqual({
      kind: 'album',
      id: '752404355',
      url: 'https://music.apple.com/album/752404355',
      title: 'Take Me to Church',
      artists: ['Hozier'],
      artist: 'Hozier',
      trackCount: 4,
      albumType: 'ep',
      explicit: false,
      releaseDate: '2013-09-13',
      art: expect.stringMatching(/\/600x600bb\.jpg$/),
    });
    expect(byId(hits, '1022504726')).toMatchObject({ title: 'Live in America', albumType: 'ep', trackCount: 6 });
    expect(byId(hits, '1729219592')).toMatchObject({ title: 'Take Me to Church', albumType: 'single', trackCount: 1, artist: 'Lars Florence' });
    expect(byId(hits, '923529751')).toMatchObject({ title: 'Hozier', trackCount: 13 });
    expect(byId(hits, '923529751')).not.toHaveProperty('albumType');
    for (const h of hits) expect(h.title).not.toMatch(/ - (Single|EP)$/);
  });

  it('maps album hits from a discography search', async () => {
    const hits = (await searchApple(fixtureCtx(), { kind: 'album', title: '', artist: 'Khaled' })) as AlbumMeta[];
    expect(byId(hits, '1595211129')).toMatchObject({ title: 'Borracho', albumType: 'single', artist: 'Sech & DJ Khaled', releaseDate: '2021-11-26' });
    expect(byId(hits, '1127957437')).toMatchObject({ title: 'Major Key', trackCount: 14, explicit: false });
    expect(await searchApple(fixtureCtx(), { kind: 'album', title: 'Sahra', artist: 'Khaled' })).toEqual([SAHRA_ITUNES]);
  });

  it('only links storefront-less URLs and 600px artwork', async () => {
    const all: ItemMeta[] = [
      ...(await searchApple(fixtureCtx(), { kind: 'track', title: 'Panini', artist: 'Lil Nas X' })),
      ...(await searchApple(fixtureCtx(), { kind: 'track', title: 'Aicha', artist: 'Khaled' })),
      ...(await searchApple(fixtureCtx(), { kind: 'album', title: '', artist: 'Khaled' })),
    ];
    expect(all.length).toBeGreaterThan(50);
    for (const item of all) {
      expect(item.url).toMatch(item.kind === 'track' ? /^https:\/\/music\.apple\.com\/song\/\d+$/ : /^https:\/\/music\.apple\.com\/album\/\d+$/);
      expect(item.art).toMatch(/^https:\/\/is\d-ssl\.mzstatic\.com\/image\/thumb\/.+\/600x600bb\.jpg$/);
      expect(item.releaseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('passes the limit and keeps an empty visitor-storefront result', async () => {
    const calls: string[] = [];
    const url = songSearchUrl('Khaled+Nothing', 'fr', 5);
    const ctx = fixtureCtx({ storefront: 'fr', calls, extra: [fixture(url, { resultCount: 0, results: [] })] });
    expect(await searchApple(ctx, { kind: 'track', title: 'Nothing', artist: 'Khaled' }, 5)).toEqual([]);
    expect(calls).toEqual([url]);
  });

  it('retries a search in the US storefront when the country has no store', async () => {
    const calls: string[] = [];
    const bad = albumSearchUrl('Khaled+Sahra', 'xx');
    const ctx = fixtureCtx({ storefront: 'xx', calls, extra: [fixture(bad, ITUNES_BAD_COUNTRY, 400)] });
    expect(await searchApple(ctx, { kind: 'album', title: 'Sahra', artist: 'Khaled' })).toEqual([SAHRA_ITUNES]);
    expect(calls).toEqual([bad, albumSearchUrl('Khaled+Sahra')]);
  });

  it('form-encodes the search term', async () => {
    const calls: string[] = [];
    const ctx = fixtureCtx({ calls, missing: '404' });
    await searchApple(ctx, { kind: 'track', title: 'Rock & Roll #1', artist: 'AC/DC' }).catch(() => {});
    expect(calls).toEqual([songSearchUrl('AC%2FDC+Rock+%26+Roll+%231')]);
  });

  it('does not call upstream for an empty query', async () => {
    const calls: string[] = [];
    expect(await searchApple(fixtureCtx({ calls }), { kind: 'track', title: ' ', artist: '' })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it.each([403, 429])('surfaces iTunes rate limiting (HTTP %i) as UpstreamError', async (status) => {
    const url = songSearchUrl('Khaled+Ouelli+El+Darek');
    const ctx = fixtureCtx({ extra: [fixture(url, '', status)] });
    const err = await searchApple(ctx, { kind: 'track', title: 'Ouelli El Darek', artist: 'Khaled' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).status).toBe(status);
    expect(ctx.apple).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// MusicKit mode (hand-written responses)

const OUELLI_MK: TrackMeta = {
  ...OUELLI_ITUNES,
  isrc: 'FRZ019601820',
  albumType: 'album',
};

const SAHRA_MK: AlbumMeta = { ...SAHRA_ITUNES, upc: '00731453398924', albumType: 'album' };

describe('MusicKit mode: getAppleItem', () => {
  it('fetches a song with its album and artists, authorized by the developer token', async () => {
    const ctx = mkCtx([fixture(mkSongUrl('1444130134'), { data: [OUELLI] })]);
    const seen = authLog(ctx);
    expect(await getAppleItem(ctx, 'track', '1444130134')).toEqual(OUELLI_MK);
    expect(seen).toEqual([`Bearer test ${mkSongUrl('1444130134')}`]);
    expect(ctx.apple).toEqual({ token: 'test' });
  });

  it('fetches an album with its artists', async () => {
    const album = {
      ...SAHRA,
      relationships: {
        artists: { href: '/v1/catalog/us/albums/1444129774/artists', data: [KHALED] },
        tracks: { href: '/v1/catalog/us/albums/1444129774/tracks', data: [searchHit(OUELLI)] },
      },
    };
    const ctx = mkCtx([fixture(mkAlbumUrl('1444129774'), { data: [album] })]);
    expect(await getAppleItem(ctx, 'album', '1444129774')).toEqual(SAHRA_MK);
  });

  it('keeps separate artist names from the included artists', async () => {
    const lilNasX = { id: '1400730578', type: 'artists', href: '/v1/catalog/us/artists/1400730578', attributes: { name: 'Lil Nas X' } };
    const dababy = { id: '1235910768', type: 'artists', href: '/v1/catalog/us/artists/1235910768', attributes: { name: 'DaBaby' } };
    const single = {
      id: '1479239193',
      type: 'albums',
      href: '/v1/catalog/us/albums/1479239193',
      attributes: { ...SAHRA_ATTRS, name: 'Panini (DaBaby Remix) - Single', artistName: 'Lil Nas X & DaBaby', isSingle: true, trackCount: 1 },
    };
    const song = mkSong(
      '1479239196',
      { ...OUELLI_ATTRS, name: 'Panini (DaBaby Remix)', artistName: 'Lil Nas X & DaBaby', albumName: 'Panini (DaBaby Remix) - Single', contentRating: 'explicit' },
      single,
      [lilNasX, dababy],
    );
    const ctx = mkCtx([fixture(mkSongUrl('1479239196'), { data: [song] })]);
    expect(await getAppleItem(ctx, 'track', '1479239196')).toMatchObject({
      title: 'Panini (DaBaby Remix)',
      artists: ['Lil Nas X', 'DaBaby'],
      artist: 'Lil Nas X & DaBaby',
      album: 'Panini (DaBaby Remix)',
      albumType: 'single',
      explicit: true,
    });
  });

  it.each<[string, Record<string, unknown>, Partial<AlbumMeta>]>([
    ['a single', { name: 'Borracho - Single', isSingle: true, trackCount: 1 }, { title: 'Borracho', albumType: 'single' }],
    ['an EP', { name: 'Take Me to Church - EP', trackCount: 4 }, { title: 'Take Me to Church', albumType: 'ep' }],
    ['a compilation', { name: 'Raï Superstars', artistName: 'Various Artists', isCompilation: true }, { title: 'Raï Superstars', albumType: 'compilation', artists: ['Khaled'] }],
    ['an album', {}, { title: 'Sahra', albumType: 'album' }],
    ['explicit', { contentRating: 'explicit' }, { explicit: true }],
    ['clean', { contentRating: 'clean' }, { explicit: false }],
    ['unrated', {}, { explicit: false }],
    ['year-only release date', { releaseDate: '1996' }, { releaseDate: '1996' }],
  ])('maps %s', async (_, attrs, expected) => {
    const album = { ...SAHRA, attributes: { ...SAHRA_ATTRS, ...attrs }, relationships: { artists: { href: '', data: [KHALED] } } };
    const ctx = mkCtx([fixture(mkAlbumUrl('1444129774'), { data: [album] })]);
    expect(await getAppleItem(ctx, 'album', '1444129774')).toMatchObject(expected);
  });

  it.each([
    ['a large template', mkArtwork(SAHRA_ART, 3000), `${SAHRA_ART}/600x600bb.jpg`],
    ['a small source image', mkArtwork(SAHRA_ART, 400), `${SAHRA_ART}/400x400bb.jpg`],
    ['crop and format placeholders', { width: 1400, height: 1400, url: `${SAHRA_ART}/{w}x{h}{c}.{f}` }, `${SAHRA_ART}/600x600bb.jpg`],
  ])('sizes artwork from %s', async (_, artwork, art) => {
    const song = mkSong('1444130134', { ...OUELLI_ATTRS, artwork }, SAHRA);
    const ctx = mkCtx([fixture(mkSongUrl('1444130134'), { data: [song] })]);
    expect((await getAppleItem(ctx, 'track', '1444130134')).art).toBe(art);
  });

  it('throws 404 for an unknown id', async () => {
    const calls: string[] = [];
    const ctx = mkCtx([fixture(mkSongUrl('1'), MK_NOT_FOUND, 404)], calls);
    await expect(getAppleItem(ctx, 'track', '1')).rejects.toMatchObject({ name: 'UpstreamError', status: 404 });
    expect(calls).toHaveLength(1);
    expect(ctx.apple).toEqual({ token: 'test' });
  });

  it('retries in the US storefront when the visitor storefront lacks the item', async () => {
    const calls: string[] = [];
    const ctx = mkCtx(
      [fixture(mkSongUrl('1444130134', 'jp'), MK_NOT_FOUND, 404), fixture(mkSongUrl('1444130134'), { data: [OUELLI] })],
      calls,
      'jp',
    );
    expect(await getAppleItem(ctx, 'track', '1444130134')).toEqual(OUELLI_MK);
    expect(calls).toEqual([mkSongUrl('1444130134', 'jp'), mkSongUrl('1444130134')]);
  });

  it('surfaces other MusicKit errors without downgrading', async () => {
    const ctx = mkCtx([fixture(mkSongUrl('1444130134'), '', 500)]);
    await expect(getAppleItem(ctx, 'track', '1444130134')).rejects.toMatchObject({ status: 500 });
    expect(ctx.apple).toEqual({ token: 'test' });
  });
});

describe('MusicKit mode: identifiers and search', () => {
  it('returns every song carrying an ISRC', async () => {
    const compilation = {
      id: '1440000001',
      type: 'albums',
      href: '/v1/catalog/us/albums/1440000001',
      attributes: { ...SAHRA_ATTRS, name: 'Raï Superstars', artistName: 'Various Artists', isCompilation: true, trackCount: 20 },
    };
    const single = {
      id: '1440000002',
      type: 'albums',
      href: '/v1/catalog/us/albums/1440000002',
      attributes: { ...SAHRA_ATTRS, name: 'Ouelli el Darek - Single', isSingle: true, trackCount: 1 },
    };
    const body = {
      data: [
        OUELLI,
        mkSong('1440000011', { ...OUELLI_ATTRS, albumName: 'Raï Superstars', trackNumber: 3 }, compilation),
        mkSong('1440000012', { ...OUELLI_ATTRS, albumName: 'Ouelli el Darek - Single', trackNumber: 1 }, single),
      ],
      meta: { filters: { isrc: { FRZ019601820: [{ id: '1444130134', type: 'songs', href: '/v1/catalog/us/songs/1444130134' }] } } },
    };
    const calls: string[] = [];
    const hits = await appleTracksByIsrc(mkCtx([fixture(mkIsrcUrl('FRZ019601820'), body)], calls), 'FRZ019601820');
    expect(calls).toEqual([mkIsrcUrl('FRZ019601820')]);
    expect(hits.map((h) => [h.id, h.album, h.albumType, h.isrc])).toEqual([
      ['1444130134', 'Sahra', 'album', 'FRZ019601820'],
      ['1440000011', 'Raï Superstars', 'compilation', 'FRZ019601820'],
      ['1440000012', 'Ouelli el Darek', 'single', 'FRZ019601820'],
    ]);
    expect(hits[0]).toEqual(OUELLI_MK);
  });

  it('returns [] when no song has the ISRC', async () => {
    expect(await appleTracksByIsrc(mkCtx([fixture(mkIsrcUrl('XX0000000000'), { data: [] })]), 'XX0000000000')).toEqual([]);
  });

  it('looks albums up by UPC', async () => {
    const bestOf = {
      id: '1400380382',
      type: 'albums',
      href: '/v1/catalog/us/albums/1400380382',
      attributes: {
        ...SAHRA_ATTRS,
        artwork: mkArtwork(BEST_OF_ART),
        name: 'Best Of',
        releaseDate: '2007-01-01',
        trackCount: 15,
        upc: '00602567759461',
        copyright: 'This Compilation ℗ 2007 Capitol Music France',
        playParams: { id: '1400380382', kind: 'album' },
      },
      relationships: { artists: { href: '/v1/catalog/us/albums/1400380382/artists', data: [KHALED] } },
    };
    const hits = await appleAlbumsByUpc(mkCtx([fixture(mkUpcUrl('00602567759461'), { data: [bestOf] })]), '00602567759461');
    expect(hits).toEqual([{ ...BEST_OF_ITUNES, upc: '00602567759461', albumType: 'album' }]);
  });

  it('searches songs', async () => {
    const url = mkSearchUrl('Khaled+Ouelli+El+Darek', 'songs');
    const body = {
      results: {
        songs: {
          href: '/v1/catalog/us/search?limit=20&term=Khaled+Ouelli+El+Darek&types=songs',
          next: '/v1/catalog/us/search?offset=20&term=Khaled+Ouelli+El+Darek&types=songs',
          data: [searchHit(OUELLI), searchHit(mkSong('1400382182', { ...OUELLI_ATTRS, name: 'Ouelli El Darek', albumName: 'Best Of', durationInMillis: 189080 }))],
        },
      },
      meta: { results: { order: ['songs'], rawOrder: ['songs'] } },
    };
    const hits = await searchApple(mkCtx([fixture(url, body)]), { kind: 'track', title: 'Ouelli El Darek', artist: 'Khaled' });
    // Search hits have no relationships: the release type is unknown without a suffix.
    const { albumType: _unknown, ...withoutType } = OUELLI_MK;
    expect(hits).toEqual([withoutType, { ...withoutType, id: '1400382182', url: 'https://music.apple.com/song/1400382182', title: 'Ouelli El Darek', album: 'Best Of', durationMs: 189080 }]);
  });

  it('searches albums', async () => {
    const url = mkSearchUrl('Khaled+Sahra', 'albums', 5);
    const body = { results: { albums: { href: '', data: [searchHit(SAHRA)] } }, meta: { results: { order: ['albums'], rawOrder: ['albums'] } } };
    const hits = await searchApple(mkCtx([fixture(url, body)]), { kind: 'album', title: 'Sahra', artist: 'Khaled' }, 5);
    expect(hits).toEqual([{ ...SAHRA_MK, artists: ['Khaled'] }]);
  });

  it('caps the limit at 25 and handles empty results', async () => {
    const calls: string[] = [];
    const url = mkSearchUrl('Nobody+Nothing', 'songs', 25);
    const empty = { results: {}, meta: { results: { order: [], rawOrder: [] } } };
    expect(await searchApple(mkCtx([fixture(url, empty)], calls), { kind: 'track', title: 'Nothing', artist: 'Nobody' }, 100)).toEqual([]);
    expect(calls).toEqual([url]);
  });
});

describe('MusicKit token rejection', () => {
  it.each([401, 403])('downgrades to iTunes and retries getAppleItem after HTTP %i', async (status) => {
    const calls: string[] = [];
    const ctx = mkCtx([fixture(mkSongUrl('1444130134'), '', status)], calls);
    expect(await getAppleItem(ctx, 'track', '1444130134')).toEqual(OUELLI_ITUNES);
    expect(ctx.apple).toBeNull();
    expect(calls).toEqual([mkSongUrl('1444130134'), lookupUrl('1444130134')]);
  });

  it('downgrades a search, and later calls of the request skip MusicKit', async () => {
    const calls: string[] = [];
    const ctx = mkCtx([fixture(mkSearchUrl('Khaled+Sahra', 'albums'), '', 401)], calls);
    expect(await searchApple(ctx, { kind: 'album', title: 'Sahra', artist: 'Khaled' })).toEqual([SAHRA_ITUNES]);
    expect(await appleAlbumsByUpc(ctx, '602567759461')).toEqual([BEST_OF_ITUNES]);
    expect(calls).toEqual([mkSearchUrl('Khaled+Sahra', 'albums'), albumSearchUrl('Khaled+Sahra'), `${ITUNES}/lookup?upc=602567759461&country=us`]);
  });

  it('downgrades an ISRC lookup to no results', async () => {
    const ctx = mkCtx([fixture(mkIsrcUrl('FRZ019601820'), '', 401)]);
    expect(await appleTracksByIsrc(ctx, 'FRZ019601820')).toEqual([]);
    expect(ctx.apple).toBeNull();
  });

  it('downgrades when the visitor-storefront call is rejected', async () => {
    const calls: string[] = [];
    const ctx = mkCtx([fixture(mkSongUrl('1444130134', 'fr'), '', 401), fixture(lookupUrl('1444130134', 'fr'), recordedBody(lookupUrl('1444130134')))], calls, 'fr');
    expect(await getAppleItem(ctx, 'track', '1444130134')).toEqual(OUELLI_ITUNES);
    expect(calls).toEqual([mkSongUrl('1444130134', 'fr'), lookupUrl('1444130134', 'fr')]);
  });

  it('drops the rejected cached token and pauses MusicKit for a cooldown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = appleEnv((await generateKey()).pem);
    const auth = await getAppleAuth(env);
    expect(auth).not.toBeNull();

    const ctx = fixtureCtx({ apple: auth, extra: [fixture(mkSongUrl('1444130134'), '', 401)] });
    expect(await getAppleItem(ctx, 'track', '1444130134')).toEqual(OUELLI_ITUNES);
    expect(ctx.apple).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rejected'));

    expect(await getAppleAuth(env)).toBeNull();
    const now = Math.floor(Date.now() / 1000);
    const renewed = await getAppleAuth(env, now + REJECTED_TOKEN_COOLDOWN_S + 1);
    expect(renewed).not.toBeNull();
    expect(renewed?.token).not.toBe(auth?.token);
  });

  it('a rejected foreign token leaves the cached token alone', async () => {
    const env = appleEnv((await generateKey()).pem);
    const auth = await getAppleAuth(env);
    const ctx = mkCtx([fixture(mkSongUrl('1444130134'), '', 401)]);
    await getAppleItem(ctx, 'track', '1444130134');
    expect((await getAppleAuth(env))?.token).toBe(auth?.token);
  });
});
