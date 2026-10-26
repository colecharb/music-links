// Regressions from the resolver review: identifier lookups that fail or return dead catalog entries,
// and catalog items the service can't play. Recorded fixtures, varied by hand only where noted.
import { describe, expect, it } from 'vitest';
import { TEST_LINKS } from '../scripts/test-links';
import type { FetchFn } from '../src/http';
import { parseMusicUrl } from '../src/parse';
import { resolveRef, type ResolveResult } from '../src/resolve';
import { TTL_COMPLETE_SECONDS, TTL_PARTIAL_SECONDS, ttlFor } from '../src/store';
import type { SourceRef } from '../src/types';
import type { HttpFixture } from './helpers/fixtures';
import { fixtureCtx, fixtureFetch, FIXTURES } from './helpers/fixtures';

const MK = 'https://api.music.apple.com/v1/catalog/us';
const ITUNES = 'https://itunes.apple.com';
const DEEZER = 'https://api.deezer.com';

type ItunesResult = Record<string, unknown> & {
  trackId?: number;
  collectionId: number;
  artistId: number;
  artistName: string;
  collectionName: string;
  artworkUrl100: string;
  releaseDate: string;
};

function recordedJson(url: string): unknown {
  const f = FIXTURES.get(new URL(url).toString());
  if (!f) throw new Error(`missing fixture ${url}`);
  return JSON.parse(f.response.body);
}

function itunesRecord(url: string, id: number): ItunesResult {
  const { results } = recordedJson(url) as { results: ItunesResult[] };
  const r = results.find((x) => (x.trackId ?? x.collectionId) === id);
  if (!r) throw new Error(`no iTunes result ${id} in ${url}`);
  return r;
}

function fixture(url: string, body: unknown, status = 200): HttpFixture {
  return { request: { url }, response: { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } };
}

/** Answers every request matching `match` with `status` (an outage), everything else from fixtures. */
function failing(match: (url: string) => boolean, status = 503, inner: FetchFn = fixtureFetch()): FetchFn {
  return (url, init) => (match(url) ? Promise.resolve(new Response('upstream down', { status })) : inner(url, init));
}

/** Holds requests matching `held` until one matching `opener` has been made, or the request times out. */
function gated(held: (url: string) => boolean, opener: (url: string) => boolean, inner: FetchFn = fixtureFetch()): FetchFn {
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return async (url, init) => {
    if (opener(url)) open();
    if (held(url)) {
      await new Promise<void>((resolve, reject) => {
        void opened.then(resolve);
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }
    return inner(url, init);
  };
}

const outcome = (r: ResolveResult, s: 'apple' | 'deezer') => `${r.details[s].outcome}:${r.details[s].via}:${r.details[s].item?.id ?? ''}`;
const describeDetail = (r: ResolveResult, s: 'apple' | 'deezer') => JSON.stringify({ ...r.details[s], item: r.details[s].item?.title });

// ---------------------------------------------------------------------------------------------
// MusicKit resources, built from recorded iTunes results for the same catalog ids (MusicKit calls
// need a developer token, so they can't be recorded). ISRC/UPC values are the real ones.

const mkArtwork = (r: ItunesResult) => ({ width: 3000, height: 3000, url: r.artworkUrl100.replace(/\/100x100bb\.jpg$/, '/{w}x{h}bb.jpg') });

const mkArtist = (r: ItunesResult) => ({
  id: String(r.artistId),
  type: 'artists',
  href: `/v1/catalog/us/artists/${r.artistId}`,
  attributes: { name: r.artistName },
});

function mkAlbum(r: ItunesResult, upc: string) {
  const id = String(r.collectionId);
  return {
    id,
    type: 'albums',
    href: `/v1/catalog/us/albums/${id}`,
    attributes: {
      artistName: r.artistName,
      artwork: mkArtwork(r),
      isCompilation: false,
      isSingle: false,
      name: r.collectionName,
      playParams: { id, kind: 'album' },
      releaseDate: r.releaseDate.slice(0, 10),
      trackCount: r.trackCount,
      upc,
    },
    relationships: { artists: { href: `/v1/catalog/us/albums/${id}/artists`, data: [mkArtist(r)] } },
  };
}

function mkSong(r: ItunesResult, isrc: string) {
  const id = String(r.trackId);
  const { relationships: _artists, ...album } = mkAlbum(r, '');
  return {
    id,
    type: 'songs',
    href: `/v1/catalog/us/songs/${id}`,
    attributes: {
      albumName: r.collectionName,
      artistName: r.artistName,
      artwork: mkArtwork(r),
      discNumber: r.discNumber,
      durationInMillis: r.trackTimeMillis,
      isrc,
      name: r.trackName,
      playParams: { id, kind: 'song' },
      releaseDate: r.releaseDate.slice(0, 10),
      trackNumber: r.trackNumber,
    },
    relationships: {
      albums: { href: `/v1/catalog/us/songs/${id}/albums`, data: [album] },
      artists: { href: `/v1/catalog/us/songs/${id}/artists`, data: [mkArtist(r)] },
    },
  };
}

const songFixture = (r: ItunesResult, isrc: string) => fixture(`${MK}/songs/${r.trackId}?include=albums,artists`, { data: [mkSong(r, isrc)] });
const albumFixture = (r: ItunesResult, upc: string) => fixture(`${MK}/albums/${r.collectionId}?include=artists`, { data: [mkAlbum(r, upc)] });

// Queen, "Bohemian Rhapsody" on A Night At The Opera (Deluxe Edition), 354320 ms.
const BOHEMIAN = itunesRecord(`${ITUNES}/search?term=Queen+bohemian+rhapsody&country=us&media=music&entity=song&limit=20`, 6781024437);
const BOHEMIAN_ISRC = 'GBUM71029604';
// Khaled, "Ouelli el Darek" on Sahra (1996).
const OUELLI = itunesRecord(`${ITUNES}/lookup?id=1444130134&country=us&entity=song`, 1444130134);
const OUELLI_ISRC = 'FRZ019601820';
// Khaled, Sahra and Best Of.
const SAHRA = itunesRecord(`${ITUNES}/lookup?id=1444129774&country=us&entity=song`, 1444129774);
const SAHRA_UPC = '00731453398924';
const BEST_OF = itunesRecord(`${ITUNES}/lookup?upc=602567759461&country=us`, 1400380382);
const BEST_OF_UPC = '0602567759461';

const musicKit = (extra: HttpFixture[], fetch?: FetchFn) =>
  fixtureCtx({ apple: { token: 'test' }, extra, ...(fetch ? { fetch } : {}) });

const am = (kind: 'track' | 'album', id: number): SourceRef => ({ platform: 'am', kind, id: String(id) });
const dz = (kind: 'track' | 'album', id: string): SourceRef => ({ platform: 'dz', kind, id });

// ---------------------------------------------------------------------------------------------

describe('a failed identifier lookup falls through to the metadata search', () => {
  // Deezer album "dz:a:1002561451" carries UPC 199957766142; iTunes knows no album by it, and the
  // album search finds 6779097512 (resolve.test.ts).
  const DZ_ALBUM = dz('album', '1002561451');
  const UPC_LOOKUP = `${ITUNES}/lookup?upc=199957766142&country=us`;

  it('Apple UPC lookup answering 503: the search match is kept, the error goes to the misses log', async () => {
    const r = await resolveRef(fixtureCtx({ extra: [fixture(UPC_LOOKUP, 'Service Unavailable', 503)] }), DZ_ALBUM);
    expect(outcome(r, 'apple'), describeDetail(r, 'apple')).toBe('fuzzy:search:6779097512');
    expect(r.details.apple.note).toMatch(/upc lookup failed: itunes\.apple\.com: HTTP 503/);
    const miss = r.misses.find((m) => m.service === 'apple');
    expect(miss).toMatchObject({ outcome: 'fuzzy', candidate_title: r.details.apple.item?.title });
    expect(miss?.note).toMatch(/upc lookup failed: itunes\.apple\.com: HTTP 503/);
    expect(ttlFor(r.entry)).toBe(TTL_COMPLETE_SECONDS);
  });

  it('Apple UPC lookup timing out: same', async () => {
    const hang: FetchFn = (url, init) =>
      url.startsWith(`${ITUNES}/lookup?upc=`)
        ? new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
        : fixtureFetch()(url, init);
    const r = await resolveRef({ ...fixtureCtx(), fetch: hang, timeoutMs: 100 }, DZ_ALBUM);
    expect(outcome(r, 'apple'), describeDetail(r, 'apple')).toBe('fuzzy:search:6779097512');
    expect(r.details.apple.note).toMatch(/upc lookup failed: itunes\.apple\.com: timeout/);
  });

  it('outcome "error" only when the search fails too, with both errors in the note', async () => {
    const r = await resolveRef({ ...fixtureCtx(), fetch: failing((u) => u.startsWith(ITUNES)) }, DZ_ALBUM);
    expect(r.details.apple).toMatchObject({ outcome: 'error', match: 'search', via: 'search-url' });
    expect(r.details.apple.note).toMatch(/^upc lookup failed: itunes\.apple\.com: HTTP 503; itunes\.apple\.com: HTTP 503$/);
    expect(r.misses.find((m) => m.service === 'apple')).toMatchObject({ outcome: 'error' });
    expect(ttlFor(r.entry)).toBe(TTL_PARTIAL_SECONDS);
  });

  it('Apple ISRC lookup failing in MusicKit mode (Deezer source)', async () => {
    // "Win rak tergoud ?" by Cheikha Rimitti, ISRC FR43D1500746 (recorded Deezer track).
    const term = 'Cheikha+Rimitti+win+rak+tergoud';
    const itunes = recordedJson(`${ITUNES}/search?term=${term}&country=us&media=music&entity=song&limit=20`) as { results: ItunesResult[] };
    const songs = itunes.results.map((x) => mkSong(x, 'FR43D1500746'));
    const search = { results: { songs: { href: '', data: songs.map(({ relationships: _r, ...hit }) => hit) } } };
    const r = await resolveRef(
      musicKit([
        fixture(`${MK}/songs?filter[isrc]=FR43D1500746&include=albums,artists`, { errors: [{ status: '500' }] }, 500),
        fixture(`${MK}/search?term=${term}&types=songs&limit=20`, search),
      ]),
      dz('track', '96996588'),
    );
    expect(outcome(r, 'apple'), describeDetail(r, 'apple')).toBe('fuzzy:search:975981523');
    expect(r.details.apple.note).toMatch(/isrc lookup failed: api\.music\.apple\.com: HTTP 500/);
    expect(r.entry.appleMode).toBe('musickit');
  });

  it('Deezer ISRC lookup over quota (MusicKit source)', async () => {
    const quota = { error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } };
    const r = await resolveRef(
      musicKit([songFixture(BOHEMIAN, BOHEMIAN_ISRC), fixture(`${DEEZER}/track/isrc:${BOHEMIAN_ISRC}`, quota)]),
      am('track', 6781024437),
    );
    expect(outcome(r, 'deezer'), describeDetail(r, 'deezer')).toBe('fuzzy:search:4091937401');
    expect(r.details.deezer.note).toMatch(/isrc lookup failed: api\.deezer\.com: Exception: Quota limit exceeded \(code 4\)/);
    expect(r.misses.find((m) => m.service === 'deezer')?.note).toBe(r.details.deezer.note);
  });

  it('Deezer UPC lookups answering 503 (MusicKit source)', async () => {
    const fetch = failing((u) => u.startsWith(`${DEEZER}/album/upc:`), 503, fixtureFetch({ extra: [albumFixture(SAHRA, SAHRA_UPC)] }));
    const r = await resolveRef(musicKit([], fetch), am('album', 1444129774));
    expect(outcome(r, 'deezer'), describeDetail(r, 'deezer')).toBe('fuzzy:search:155932012');
    expect(r.details.deezer.note).toMatch(/upc lookup failed: api\.deezer\.com: HTTP 503/);
  });

  // Every recorded resolution again, with every ISRC/UPC lookup down: search outcomes stay as they were,
  // and an identifier match turns into the same item found by search, a search link, or an error only
  // when the recorded search failed too (Nevermind's iTunes album search was recorded as a 403).
  const isLookup = (url: string) => /\/lookup\?upc=|\/track\/isrc:|\/album\/upc:|filter\[(?:isrc|upc)\]/.test(decodeURIComponent(url));
  it.each(TEST_LINKS.map((l) => [l.url] as const))('recorded link, all lookups down: %s', async (url) => {
    const parsed = parseMusicUrl(url);
    if (parsed.type !== 'ref') throw new Error(`not a ref: ${url}`);
    const normal = await resolveRef(fixtureCtx(), parsed.ref);
    const down = await resolveRef({ ...fixtureCtx(), fetch: failing(isLookup) }, parsed.ref);
    for (const s of ['apple', 'deezer'] as const) {
      const [before, after] = [normal.details[s], down.details[s]];
      const why = `${s}: ${outcome(normal, s)} -> ${describeDetail(down, s)}`;
      if (before.outcome !== 'exact' || before.via === 'source') {
        expect(outcome(down, s), why).toBe(outcome(normal, s));
        continue;
      }
      expect(after.note, why).toMatch(new RegExp(`^${before.via} lookup failed: `));
      if (after.outcome === 'fuzzy') expect(after.item?.id, why).toBe(before.item?.id);
      else if (after.outcome === 'error') expect(after.note, why).toMatch(/; itunes\.apple\.com: HTTP 403$/);
      else expect(after.outcome, why).toBe('search');
    }
  });
});

describe('the Deezer search starts alongside the identifier lookup', () => {
  // Each lookup is held until the search has been requested: run one after the other, the lookup
  // would time out instead of producing the exact match.
  it.each([
    ['track', 'isrc', am('track', 1444130134), songFixture(OUELLI, OUELLI_ISRC), `${DEEZER}/track/isrc:`, `${DEEZER}/search/track?`, '920717'],
    ['album', 'upc', am('album', 1400380382), albumFixture(BEST_OF, BEST_OF_UPC), `${DEEZER}/album/upc:`, `${DEEZER}/search/album?`, '66071352'],
  ] as const)('%s by %s', async (_kind, via, ref, source, lookup, search, id) => {
    const calls: string[] = [];
    const inner = fixtureFetch({ extra: [source], calls, missing: '404' });
    const fetch = gated((u) => u.startsWith(lookup), (u) => u.startsWith(search), inner);
    const r = await resolveRef({ ...musicKit([]), fetch, timeoutMs: 300 }, ref);
    expect(outcome(r, 'deezer'), `${describeDetail(r, 'deezer')} calls: ${calls.join(' ')}`).toBe(`exact:${via}:${id}`);
  });
});

describe('dead Deezer duplicates found by ISRC', () => {
  // GET /track/isrc:GBUM71029605 answers 3476766481 "Another One Bites The Dust (Remastered 2011)" on
  // a 2025 compilation: readable false, available_countries [] and a 404 web page. Its duration agrees
  // (217 s), so verification alone would accept it. The playable copy is 4092324041 on The Game.
  const AOBTD = itunesRecord(`${ITUNES}/search?term=Queen+another+one+bites+the+dust&country=us&media=music&entity=song&limit=20`, 6781076397);

  it('fall through to the search, which finds the playable copy', async () => {
    const r = await resolveRef(musicKit([songFixture(AOBTD, 'GBUM71029605')]), am('track', 6781076397));
    expect(outcome(r, 'deezer'), describeDetail(r, 'deezer')).toBe('fuzzy:search:4092324041');
    expect(r.entry.links.deezer).toEqual({ url: 'https://www.deezer.com/track/4092324041', match: 'fuzzy' });
  });
});

describe('Apple songs that are not streamable', () => {
  // Apple searches answering only with the album version of "Get Lucky" as it appears on the "Piece By
  // Piece" soundtrack, recorded with isStreamable false (an album-only purchase Apple Music can't play).
  const piece = itunesRecord(`${ITUNES}/search?term=nile+rodgers+get+lucky&country=us&media=music&entity=song&limit=20`, 1771867453);
  const onlyHit = (hit: ItunesResult): FetchFn => {
    const inner = fixtureFetch();
    const body = JSON.stringify({ resultCount: 1, results: [hit] });
    return (url, init) => (url.startsWith(`${ITUNES}/search?`) ? Promise.resolve(new Response(body, { status: 200 })) : inner(url, init));
  };

  it('never become direct links', async () => {
    expect(piece.isStreamable).toBe(false);
    const r = await resolveRef({ ...fixtureCtx(), fetch: onlyHit(piece) }, dz('track', '67238735'));
    expect(outcome(r, 'apple'), describeDetail(r, 'apple')).toBe('search:search-url:');
  });

  it('control: the same hit, streamable, is a match', async () => {
    const r = await resolveRef({ ...fixtureCtx(), fetch: onlyHit({ ...piece, isStreamable: true }) }, dz('track', '67238735'));
    expect(outcome(r, 'apple'), describeDetail(r, 'apple')).toBe('fuzzy:search:1771867453');
  });
});
