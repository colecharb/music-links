import { describe, expect, it } from 'vitest';
import { UpstreamError } from '../src/http';
import {
  decodeHtmlEntities,
  decodeState,
  getSpotifyItem,
  parseAlbumDescription,
  parseSpotifyPage,
  parseTrackDescription,
  spotifySearchUrl,
  spotifyUrl,
} from '../src/sources/spotify';
import type { AlbumMeta, Kind, TrackMeta } from '../src/types';
import { FIXTURES, fixtureCtx } from './helpers/fixtures';

const IMG = 'https://i.scdn.co/image/ab67616d0000b273';

/** Body of a recorded open.spotify.com page. */
function pageBody(kind: Kind, id: string): string {
  const f = FIXTURES.get(spotifyUrl(kind, id));
  if (!f) throw new Error(`missing fixture for ${kind} ${id}`);
  return f.response.body;
}

const STATE_SCRIPT = /<script id="initialState"[^>]*>([\s\S]*?)<\/script>/;

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/** The page with its initialState script removed: only meta tags remain. */
function metaOnly(kind: Kind, id: string): Response {
  return htmlResponse(pageBody(kind, id).replace(STATE_SCRIPT, ''));
}

/** The page with initialState rewritten by `edit`. */
function withState(kind: Kind, id: string, edit: (state: any) => void): Response {
  const body = pageBody(kind, id);
  const m = STATE_SCRIPT.exec(body);
  if (!m?.[1]) throw new Error('fixture has no state');
  const state = decodeState(m[1]) as any;
  edit(state);
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return htmlResponse(body.replace(m[1], btoa(bin)));
}

describe('URL builders', () => {
  it.each([
    ['track', '2qQ3IRCPx3aESBFomT2n2N', 'https://open.spotify.com/track/2qQ3IRCPx3aESBFomT2n2N'],
    ['album', '2Ul6M5sIJdZjKVxwgDG7dC', 'https://open.spotify.com/album/2Ul6M5sIJdZjKVxwgDG7dC'],
  ] as const)('spotifyUrl(%s, %s)', (kind, id, url) => {
    expect(spotifyUrl(kind, id)).toBe(url);
  });

  it.each([
    ['Ouelli El Darek', 'Khaled', 'https://open.spotify.com/search/Ouelli%20El%20Darek%20Khaled'],
    ['Rock & Roll', 'Led Zeppelin', 'https://open.spotify.com/search/Rock%20%26%20Roll%20Led%20Zeppelin'],
    ['#1 Crush', 'Garbage', 'https://open.spotify.com/search/%231%20Crush%20Garbage'],
    ['AC/DC Song', 'AC/DC', 'https://open.spotify.com/search/AC%2FDC%20Song%20AC%2FDC'],
    ['اعطوني رايكم', 'Khaled', 'https://open.spotify.com/search/%D8%A7%D8%B9%D8%B7%D9%88%D9%86%D9%8A%20%D8%B1%D8%A7%D9%8A%D9%83%D9%85%20Khaled'],
    [`Don't Stop "Live"`, 'Queen', 'https://open.spotify.com/search/Don\'t%20Stop%20%22Live%22%20Queen'],
    ['100%?', 'X', 'https://open.spotify.com/search/100%25%3F%20X'],
    ['Solo Title', '', 'https://open.spotify.com/search/Solo%20Title'],
  ])('spotifySearchUrl(%j, %j)', (title, artist, url) => {
    expect(spotifySearchUrl({ kind: 'track', title, artist })).toBe(url);
  });
});

describe('getSpotifyItem: tracks', () => {
  it.each<[string, string, TrackMeta]>([
    [
      'single-artist album track',
      '2qQ3IRCPx3aESBFomT2n2N',
      {
        kind: 'track',
        id: '2qQ3IRCPx3aESBFomT2n2N',
        url: 'https://open.spotify.com/track/2qQ3IRCPx3aESBFomT2n2N',
        title: 'Ouelli El Darek',
        artists: ['Khaled'],
        artist: 'Khaled',
        album: 'Sahra',
        durationMs: 189360,
        durationPrecisionMs: 1,
        releaseDate: '1996-01-01',
        explicit: false,
        albumType: 'album',
        trackNumber: 5,
        art: `${IMG}e1b1864f0ac9fc86215c3c85`,
      },
    ],
    [
      'multi-artist track',
      '69kOkLUCkxIZYexIgSG8rq',
      {
        kind: 'track',
        id: '69kOkLUCkxIZYexIgSG8rq',
        url: 'https://open.spotify.com/track/69kOkLUCkxIZYexIgSG8rq',
        title: 'Get Lucky (feat. Pharrell Williams and Nile Rodgers)',
        artists: ['Daft Punk', 'Pharrell Williams', 'Nile Rodgers'],
        artist: 'Daft Punk, Pharrell Williams, Nile Rodgers',
        album: 'Random Access Memories',
        durationMs: 369626,
        durationPrecisionMs: 1,
        releaseDate: '2013-05-20',
        explicit: false,
        albumType: 'album',
        trackNumber: 8,
        art: `${IMG}9b9b36b0e22870b9f542d937`,
      },
    ],
    [
      'explicit track',
      '7KXjTSCq5nL1LoYtL7XAwS',
      {
        kind: 'track',
        id: '7KXjTSCq5nL1LoYtL7XAwS',
        url: 'https://open.spotify.com/track/7KXjTSCq5nL1LoYtL7XAwS',
        title: 'HUMBLE.',
        artists: ['Kendrick Lamar'],
        artist: 'Kendrick Lamar',
        album: 'DAMN.',
        durationMs: 177000,
        durationPrecisionMs: 1,
        releaseDate: '2017-04-14',
        explicit: true,
        albumType: 'album',
        trackNumber: 8,
        art: `${IMG}8b52c6b9bc4e43d873869699`,
      },
    ],
    [
      'non-Latin title on a single',
      '14NmnX6ajbSufKVJiNmWY5',
      {
        kind: 'track',
        id: '14NmnX6ajbSufKVJiNmWY5',
        url: 'https://open.spotify.com/track/14NmnX6ajbSufKVJiNmWY5',
        title: 'اعطوني رايكم',
        artists: ['Khaled'],
        artist: 'Khaled',
        album: 'اعطوني رايكم',
        durationMs: 268669,
        durationPrecisionMs: 1,
        releaseDate: '2023-08-08',
        explicit: false,
        albumType: 'single',
        trackNumber: 1,
        art: `${IMG}7089bc15c305f5df26c3bea1`,
      },
    ],
    [
      'compilation track with HTML entities in meta',
      '54SWk8zDQ02dBXvOAmQdPc',
      {
        kind: 'track',
        id: '54SWk8zDQ02dBXvOAmQdPc',
        url: 'https://open.spotify.com/track/54SWk8zDQ02dBXvOAmQdPc',
        title: "Rollin' & Scratchin'",
        artists: ['Daft Punk'],
        artist: 'Daft Punk',
        album: 'Musique, Vol. 1',
        durationMs: 448626,
        durationPrecisionMs: 1,
        releaseDate: '2006-03-29',
        explicit: false,
        albumType: 'compilation',
        trackNumber: 6,
        art: `${IMG}54a277d652eba4cd35a2e78a`,
      },
    ],
  ])('%s (%s)', async (_label, id, expected) => {
    const calls: string[] = [];
    const item = await getSpotifyItem(fixtureCtx({ calls }), 'track', id);
    expect(item).toEqual(expected);
    expect(calls).toEqual([`https://open.spotify.com/track/${id}`]);
  });
});

describe('getSpotifyItem: albums', () => {
  it.each<[string, string, AlbumMeta]>([
    [
      'album',
      '2Ul6M5sIJdZjKVxwgDG7dC',
      {
        kind: 'album',
        id: '2Ul6M5sIJdZjKVxwgDG7dC',
        url: 'https://open.spotify.com/album/2Ul6M5sIJdZjKVxwgDG7dC',
        title: 'Sahra',
        artists: ['Khaled'],
        artist: 'Khaled',
        releaseDate: '1996-01-01',
        trackCount: 15,
        albumType: 'album',
        explicit: false,
        art: `${IMG}e1b1864f0ac9fc86215c3c85`,
      },
    ],
    [
      'album with featured artists on tracks',
      '4m2880jivSbbyEGAKfITCa',
      {
        kind: 'album',
        id: '4m2880jivSbbyEGAKfITCa',
        url: 'https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa',
        title: 'Random Access Memories',
        artists: ['Daft Punk'],
        artist: 'Daft Punk',
        releaseDate: '2013-05-20',
        trackCount: 13,
        albumType: 'album',
        explicit: false,
        art: `${IMG}9b9b36b0e22870b9f542d937`,
      },
    ],
    [
      'explicit album',
      '4eLPsYPBmXABThSJ821sqY',
      {
        kind: 'album',
        id: '4eLPsYPBmXABThSJ821sqY',
        url: 'https://open.spotify.com/album/4eLPsYPBmXABThSJ821sqY',
        title: 'DAMN.',
        artists: ['Kendrick Lamar'],
        artist: 'Kendrick Lamar',
        releaseDate: '2017-04-14',
        trackCount: 14,
        albumType: 'album',
        explicit: true,
        art: `${IMG}8b52c6b9bc4e43d873869699`,
      },
    ],
    [
      'single with a non-Latin title',
      '2agNGZOxxpiNqwtEiTPYzr',
      {
        kind: 'album',
        id: '2agNGZOxxpiNqwtEiTPYzr',
        url: 'https://open.spotify.com/album/2agNGZOxxpiNqwtEiTPYzr',
        title: 'اعطوني رايكم',
        artists: ['Khaled'],
        artist: 'Khaled',
        releaseDate: '2023-08-08',
        trackCount: 1,
        albumType: 'single',
        explicit: false,
        art: `${IMG}7089bc15c305f5df26c3bea1`,
      },
    ],
    [
      'compilation',
      '4a0p1M12f7VaZWdoNSdEK4',
      {
        kind: 'album',
        id: '4a0p1M12f7VaZWdoNSdEK4',
        url: 'https://open.spotify.com/album/4a0p1M12f7VaZWdoNSdEK4',
        title: 'Musique, Vol. 1',
        artists: ['Daft Punk'],
        artist: 'Daft Punk',
        releaseDate: '2006-03-29',
        trackCount: 15,
        albumType: 'compilation',
        explicit: false,
        art: `${IMG}54a277d652eba4cd35a2e78a`,
      },
    ],
  ])('%s (%s)', async (_label, id, expected) => {
    expect(await getSpotifyItem(fixtureCtx(), 'album', id)).toEqual(expected);
  });
});

describe('parseSpotifyPage: meta tags only (no initialState)', () => {
  it('track: whole-second duration, artist from meta, no state-only fields', async () => {
    expect(await parseSpotifyPage(metaOnly('track', '2qQ3IRCPx3aESBFomT2n2N'), 'track', '2qQ3IRCPx3aESBFomT2n2N')).toEqual({
      kind: 'track',
      id: '2qQ3IRCPx3aESBFomT2n2N',
      url: 'https://open.spotify.com/track/2qQ3IRCPx3aESBFomT2n2N',
      title: 'Ouelli El Darek',
      artists: ['Khaled'],
      artist: 'Khaled',
      album: 'Sahra',
      durationMs: 189000,
      durationPrecisionMs: 1000,
      releaseDate: '1996-01-01',
      trackNumber: 5,
      art: `${IMG}e1b1864f0ac9fc86215c3c85`,
    });
  });

  it('track: splits musician_description when it matches the music:musician count', async () => {
    const item = (await parseSpotifyPage(metaOnly('track', '69kOkLUCkxIZYexIgSG8rq'), 'track', '69kOkLUCkxIZYexIgSG8rq')) as TrackMeta;
    expect(item.artists).toEqual(['Daft Punk', 'Pharrell Williams', 'Nile Rodgers']);
    expect(item.artist).toBe('Daft Punk, Pharrell Williams, Nile Rodgers');
    expect(item.album).toBe('Random Access Memories');
    expect(item.durationMs).toBe(370000);
    expect(item.durationPrecisionMs).toBe(1000);
    expect(item.explicit).toBeUndefined();
    expect(item.albumType).toBeUndefined();
  });

  it('track: keeps a comma-containing artist whole when the musician count does not match', async () => {
    const body = pageBody('track', '2qQ3IRCPx3aESBFomT2n2N')
      .replace(STATE_SCRIPT, '')
      .replace('name="music:musician_description" content="Khaled"', 'name="music:musician_description" content="Tyler, The Creator"');
    const item = await parseSpotifyPage(htmlResponse(body), 'track', '2qQ3IRCPx3aESBFomT2n2N');
    expect(item.artists).toEqual(['Tyler, The Creator']);
    expect(item.artist).toBe('Tyler, The Creator');
  });

  it('track: decodes HTML entities in meta content', async () => {
    const item = await parseSpotifyPage(metaOnly('track', '54SWk8zDQ02dBXvOAmQdPc'), 'track', '54SWk8zDQ02dBXvOAmQdPc');
    expect(item.title).toBe("Rollin' & Scratchin'");
  });

  it.each<[string, Partial<AlbumMeta>]>([
    ['2Ul6M5sIJdZjKVxwgDG7dC', { title: 'Sahra', artists: ['Khaled'], artist: 'Khaled', trackCount: 15, albumType: 'album', releaseDate: '1996-01-01' }],
    ['4a0p1M12f7VaZWdoNSdEK4', { title: 'Musique, Vol. 1', artists: ['Daft Punk'], trackCount: 15, albumType: 'compilation' }],
    ['2agNGZOxxpiNqwtEiTPYzr', { title: 'اعطوني رايكم', artists: ['Khaled'], trackCount: 1, albumType: 'single' }],
  ])('album %s: title from og:title, type and count from og:description', async (id, expected) => {
    const item = await parseSpotifyPage(metaOnly('album', id), 'album', id);
    expect(item).toMatchObject(expected);
    expect(item.explicit).toBeUndefined();
  });

  it('album: falls back to music:song tags for the track count', async () => {
    const body = pageBody('album', '2Ul6M5sIJdZjKVxwgDG7dC')
      .replace(STATE_SCRIPT, '')
      .replaceAll('15 songs', 'many songs');
    const item = (await parseSpotifyPage(htmlResponse(body), 'album', '2Ul6M5sIJdZjKVxwgDG7dC')) as AlbumMeta;
    expect(item.trackCount).toBe(15);
  });
});

describe('parseSpotifyPage: state edge cases', () => {
  it('ignores a corrupt initialState and still returns meta-tag metadata', async () => {
    const body = pageBody('track', '2qQ3IRCPx3aESBFomT2n2N').replace(STATE_SCRIPT, '<script id="initialState" type="text/plain">%%not base64%%</script>');
    const item = (await parseSpotifyPage(htmlResponse(body), 'track', '2qQ3IRCPx3aESBFomT2n2N')) as TrackMeta;
    expect(item.title).toBe('Ouelli El Darek');
    expect(item.durationPrecisionMs).toBe(1000);
  });

  it('ignores state for a different entity id', async () => {
    const res = withState('track', '2qQ3IRCPx3aESBFomT2n2N', (s) => {
      const items = s.entities.items;
      items['spotify:track:other'] = items['spotify:track:2qQ3IRCPx3aESBFomT2n2N'];
      delete items['spotify:track:2qQ3IRCPx3aESBFomT2n2N'];
    });
    const item = (await parseSpotifyPage(res, 'track', '2qQ3IRCPx3aESBFomT2n2N')) as TrackMeta;
    expect(item.durationMs).toBe(189000);
    expect(item.explicit).toBeUndefined();
  });

  it('album with a partial track list: explicit unknown unless a listed track is explicit', async () => {
    const partial = (explicitFirst: boolean) =>
      withState('album', '2Ul6M5sIJdZjKVxwgDG7dC', (s) => {
        const tracks = s.entities.items['spotify:album:2Ul6M5sIJdZjKVxwgDG7dC'].tracksV2;
        tracks.items = tracks.items.slice(0, 5);
        if (explicitFirst) tracks.items[0].track.contentRating.label = 'EXPLICIT';
      });
    const clean = (await parseSpotifyPage(partial(false), 'album', '2Ul6M5sIJdZjKVxwgDG7dC')) as AlbumMeta;
    expect(clean.trackCount).toBe(15);
    expect(clean.explicit).toBeUndefined();
    const dirty = (await parseSpotifyPage(partial(true), 'album', '2Ul6M5sIJdZjKVxwgDG7dC')) as AlbumMeta;
    expect(dirty.explicit).toBe(true);
  });

  it('album without totalCount uses the og:description count, not the partial list length', async () => {
    const res = withState('album', '2Ul6M5sIJdZjKVxwgDG7dC', (s) => {
      const tracks = s.entities.items['spotify:album:2Ul6M5sIJdZjKVxwgDG7dC'].tracksV2;
      delete tracks.totalCount;
      tracks.items = tracks.items.slice(0, 3);
    });
    const item = (await parseSpotifyPage(res, 'album', '2Ul6M5sIJdZjKVxwgDG7dC')) as AlbumMeta;
    expect(item.trackCount).toBe(15);
    expect(item.explicit).toBeUndefined();
  });

  it('maps EP album type and multiple album artists from state', async () => {
    const res = withState('album', '2Ul6M5sIJdZjKVxwgDG7dC', (s) => {
      const album = s.entities.items['spotify:album:2Ul6M5sIJdZjKVxwgDG7dC'];
      album.type = 'EP';
      album.artists.items.push({ profile: { name: 'Cheb Mami' } });
    });
    const item = (await parseSpotifyPage(res, 'album', '2Ul6M5sIJdZjKVxwgDG7dC')) as AlbumMeta;
    expect(item.albumType).toBe('ep');
    expect(item.artists).toEqual(['Khaled', 'Cheb Mami']);
    expect(item.artist).toBe('Khaled, Cheb Mami');
  });
});

describe('errors', () => {
  it('nonexistent id: UpstreamError 404', async () => {
    const err = await getSpotifyItem(fixtureCtx(), 'track', '0000000000000000000000').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).status).toBe(404);
  });

  it('track id requested as an album: UpstreamError 404', async () => {
    const err = await getSpotifyItem(fixtureCtx(), 'album', '2qQ3IRCPx3aESBFomT2n2N').catch((e: unknown) => e);
    expect((err as UpstreamError).status).toBe(404);
  });

  it.each([
    ['track page parsed as album', 'track', '2qQ3IRCPx3aESBFomT2n2N', 'album'],
    ['album page parsed as track', 'album', '2Ul6M5sIJdZjKVxwgDG7dC', 'track'],
  ] as const)('200 page of the wrong kind (%s): 404', async (_label, kind, id, asKind) => {
    const err = await parseSpotifyPage(htmlResponse(pageBody(kind, id)), asKind, id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).status).toBe(404);
  });

  it('200 page without meta tags: 404', async () => {
    const err = await parseSpotifyPage(htmlResponse('<html><head><title>Spotify</title></head></html>'), 'track', 'x').catch((e: unknown) => e);
    expect((err as UpstreamError).status).toBe(404);
  });

  it('upstream 5xx: UpstreamError with that status', async () => {
    const url = 'https://open.spotify.com/track/2qQ3IRCPx3aESBFomT2n2N';
    const ctx = fixtureCtx({ extra: [{ request: { url }, response: { status: 503, body: 'unavailable' } }] });
    const err = await getSpotifyItem(ctx, 'track', '2qQ3IRCPx3aESBFomT2n2N').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).status).toBe(503);
  });

  // An errored body stream (timeout mid-download) takes the same path, but also makes workerd log the
  // rewriter's internal pipe rejection, so this uses an unreadable (already consumed) body instead.
  it('unreadable body: UpstreamError without status', async () => {
    const res = htmlResponse(pageBody('track', '2qQ3IRCPx3aESBFomT2n2N'));
    await res.arrayBuffer();
    const err = await parseSpotifyPage(res, 'track', '2qQ3IRCPx3aESBFomT2n2N').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).status).toBeUndefined();
  });

  it('network failure: UpstreamError without status', async () => {
    const ctx = fixtureCtx({ fetch: async () => Promise.reject(new TypeError('connection reset')) });
    const err = await getSpotifyItem(ctx, 'track', '2qQ3IRCPx3aESBFomT2n2N').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).status).toBeUndefined();
  });
});

describe('helpers', () => {
  it.each([
    ['Rollin&#x27; &amp; Scratchin&#x27;', "Rollin' & Scratchin'"],
    ['&quot;Q&quot; &lt;b&gt; &#39;x&#39; &apos;y&apos;', `"Q" <b> 'x' 'y'`],
    ['&#x1F600; &#128512;', '\u{1F600} \u{1F600}'],
    ['AT&T &unknown; & plain', 'AT&T &unknown; & plain'],
    ['&#0; &#x110000;', '&#0; &#x110000;'],
  ])('decodeHtmlEntities(%j)', (input, out) => {
    expect(decodeHtmlEntities(input)).toBe(out);
  });

  it.each([
    ['', undefined],
    ['%%%', undefined],
    [btoa('{"a":1}'), { a: 1 }],
    [btoa('not json'), undefined],
    // UTF-8 bytes of {"n":"é"}: atob alone would yield mojibake.
    [btoa('{"n":"Ã©"}'), { n: 'é' }],
  ])('decodeState(%j)', (input, out) => {
    expect(decodeState(input)).toEqual(out);
  });

  it.each([
    ['Khaled · Sahra · Song · 1996', { artist: 'Khaled', album: 'Sahra', year: '1996' }],
    ['A, B · X · Y · Song · 2013', { artist: 'A, B', album: 'X · Y', year: '2013' }],
    ['Khaled · Sahra · Song', undefined],
    [undefined, undefined],
  ])('parseTrackDescription(%j)', (input, out) => {
    expect(parseTrackDescription(input)).toEqual(out);
  });

  it.each([
    ['Khaled · album · 1996 · 15 songs', { artist: 'Khaled', type: 'album', year: '1996', trackCount: 15 }],
    ['Khaled · single · 2023 · 1 songs', { artist: 'Khaled', type: 'single', year: '2023', trackCount: 1 }],
    ['A · B · compilation · 2006 · 1 song', { artist: 'A · B', type: 'compilation', year: '2006', trackCount: 1 }],
    ['Khaled · album · 1996', undefined],
  ])('parseAlbumDescription(%j)', (input, out) => {
    expect(parseAlbumDescription(input)).toEqual(out);
  });
});
