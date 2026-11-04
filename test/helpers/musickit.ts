// MusicKit fixtures built from recorded iTunes results (MusicKit calls need a developer token, so they
// can't be recorded), plus small helpers for hand-written fixtures.
import type { FetchFn } from '../../src/http';
import type { HttpFixture } from './fixtures';
import { fixtureCtx, FIXTURES } from './fixtures';

export const MK = 'https://api.music.apple.com/v1/catalog/us';
export const ITUNES = 'https://itunes.apple.com';
export const DEEZER = 'https://api.deezer.com';

export type ItunesResult = Record<string, unknown> & {
  trackId?: number;
  collectionId: number;
  artistId: number;
  artistName: string;
  collectionName: string;
  artworkUrl100: string;
  releaseDate: string;
};

export function recordedJson(url: string): unknown {
  const f = FIXTURES.get(new URL(url).toString());
  if (!f) throw new Error(`missing fixture ${url}`);
  return JSON.parse(f.response.body);
}

export function itunesRecord(url: string, id: number): ItunesResult {
  const { results } = recordedJson(url) as { results: ItunesResult[] };
  const r = results.find((x) => (x.trackId ?? x.collectionId) === id);
  if (!r) throw new Error(`no iTunes result ${id} in ${url}`);
  return r;
}

export function fixture(url: string, body: unknown, status = 200): HttpFixture {
  return { request: { url }, response: { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } };
}

// MusicKit resources, built from recorded iTunes results for the same catalog ids (MusicKit calls
// need a developer token, so they can't be recorded). ISRC/UPC values are the real ones.

const mkArtwork = (r: ItunesResult) => ({ width: 3000, height: 3000, url: r.artworkUrl100.replace(/\/100x100bb\.jpg$/, '/{w}x{h}bb.jpg') });

const mkArtist = (r: ItunesResult) => ({
  id: String(r.artistId),
  type: 'artists',
  href: `/v1/catalog/us/artists/${r.artistId}`,
  attributes: { name: r.artistName },
});

export function mkAlbum(r: ItunesResult, upc: string) {
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

export function mkSong(r: ItunesResult, isrc: string) {
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

export const songFixture = (r: ItunesResult, isrc: string) => fixture(`${MK}/songs/${r.trackId}?include=albums,artists`, { data: [mkSong(r, isrc)] });
export const albumFixture = (r: ItunesResult, upc: string) => fixture(`${MK}/albums/${r.collectionId}?include=artists`, { data: [mkAlbum(r, upc)] });

export const musicKit = (extra: HttpFixture[], fetch?: FetchFn) =>
  fixtureCtx({ apple: { token: 'test' }, extra, ...(fetch ? { fetch } : {}) });
