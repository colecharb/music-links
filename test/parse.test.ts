import { describe, expect, it } from 'vitest';
import { fixtureCtx } from './helpers/fixtures';
import type { HttpFixture } from './helpers/fixtures';
import type { FetchFn } from '../src/http';
import {
  MAX_SHORT_LINK_HOPS,
  PARSE_ERRORS,
  cacheKey,
  canonicalPath,
  extractUrlFromPath,
  invalidIdError,
  notItemError,
  parseInput,
  parseMusicUrl,
  refFromParams,
  resolveShortLink,
} from '../src/parse';
import { PLATFORMS } from '../src/types';
import type { Kind, Platform, SourceRef } from '../src/types';

const SP_T = '4uLU6hMCjMI75M1A2tKUQC';
const SP_A = '4m2880jivSbbyEGAKfITCa';
const AM_A = '617154241';
const AM_T = '617154366';
const DZ_T = '3135556';
const DZ_A = '302127';
const YT = 'dQw4w9WgXcQ';
const YT_PUNCT = 'Ab-_cd12345';

const ref = (platform: Platform, kind: Kind, id: string): SourceRef => ({ platform, kind, id });

describe('parseMusicUrl: supported links', () => {
  it.each<[string, SourceRef]>([
    // Spotify
    [`https://open.spotify.com/track/${SP_T}`, ref('sp', 'track', SP_T)],
    [`https://open.spotify.com/track/${SP_T}?si=a1b2c3d4e5f6`, ref('sp', 'track', SP_T)],
    [`https://open.spotify.com/track/${SP_T}?si=1&context=spotify%3Aalbum%3A${SP_A}`, ref('sp', 'track', SP_T)],
    [`https://open.spotify.com/album/${SP_A}?nd=1`, ref('sp', 'album', SP_A)],
    [`https://open.spotify.com/intl-fr/track/${SP_T}?si=x`, ref('sp', 'track', SP_T)],
    [`https://open.spotify.com/intl-pt/album/${SP_A}`, ref('sp', 'album', SP_A)],
    [`https://open.spotify.com/intl-de/track/${SP_T}/`, ref('sp', 'track', SP_T)],
    [`https://open.spotify.com/embed/track/${SP_T}?utm_source=generator`, ref('sp', 'track', SP_T)],
    [`https://open.spotify.com/intl-es/embed/album/${SP_A}`, ref('sp', 'album', SP_A)],
    [`https://open.spotify.com/track/${SP_T}#anchor`, ref('sp', 'track', SP_T)],
    [`https://open.spotify.com/TRACK/${SP_T}`, ref('sp', 'track', SP_T)],
    [`http://open.spotify.com/track/${SP_T}`, ref('sp', 'track', SP_T)],
    [`HTTPS://OPEN.SPOTIFY.COM/track/${SP_T}`, ref('sp', 'track', SP_T)],
    [`https://play.spotify.com/track/${SP_T}`, ref('sp', 'track', SP_T)],
    [`spotify:track:${SP_T}`, ref('sp', 'track', SP_T)],
    [`spotify:album:${SP_A}`, ref('sp', 'album', SP_A)],
    // Normalization
    [`open.spotify.com/track/${SP_T}`, ref('sp', 'track', SP_T)],
    [`www.open.spotify.com/track/${SP_T}`, ref('sp', 'track', SP_T)],
    [`https:/open.spotify.com/track/${SP_T}`, ref('sp', 'track', SP_T)],
    [`https:///open.spotify.com/track/${SP_T}`, ref('sp', 'track', SP_T)],
    [`https%3A%2F%2Fopen.spotify.com%2Ftrack%2F${SP_T}%3Fsi%3Dabc`, ref('sp', 'track', SP_T)],
    [`open.spotify.com%2Ftrack%2F${SP_T}`, ref('sp', 'track', SP_T)],
    [`spotify%3Atrack%3A${SP_T}`, ref('sp', 'track', SP_T)],
    [`  <https://open.spotify.com/track/${SP_T}>  `, ref('sp', 'track', SP_T)],
    [`"https://open.spotify.com/track/${SP_T}"`, ref('sp', 'track', SP_T)],
    [`'https://open.spotify.com/album/${SP_A}'`, ref('sp', 'album', SP_A)],
    [`“https://open.spotify.com/album/${SP_A}”`, ref('sp', 'album', SP_A)],
    [`check this https://open.spotify.com/track/${SP_T} !!`, ref('sp', 'track', SP_T)],
    [`so good (https://open.spotify.com/track/${SP_T}?si=1), right?`, ref('sp', 'track', SP_T)],
    [`Listen on Spotify: https://open.spotify.com/track/${SP_T}`, ref('sp', 'track', SP_T)],
    [`listen: open.spotify.com/album/${SP_A}.`, ref('sp', 'album', SP_A)],
    [`see example.com/x or open.spotify.com/album/${SP_A}`, ref('sp', 'album', SP_A)],
    [`via https://t.co/AbC123 https://open.spotify.com/track/${SP_T}`, ref('sp', 'track', SP_T)],
    [`https://example.com/x then open.spotify.com/album/${SP_A}`, ref('sp', 'album', SP_A)],
    [`two: https://open.spotify.com/track/${SP_T} https://open.spotify.com/album/${SP_A}`, ref('sp', 'track', SP_T)],
    [`line one\nhttps://open.spotify.com/track/${SP_T}\nline three`, ref('sp', 'track', SP_T)],
    // Apple Music
    [`https://music.apple.com/us/album/random-access-memories/${AM_A}`, ref('am', 'album', AM_A)],
    [`https://music.apple.com/us/album/get-lucky/${AM_A}?i=${AM_T}`, ref('am', 'track', AM_T)],
    [`https://music.apple.com/fr/album/${AM_A}?l=en`, ref('am', 'album', AM_A)],
    [`https://music.apple.com/us/album/random-access-memories/${AM_A}?i=`, ref('am', 'album', AM_A)],
    [`https://music.apple.com/gb/song/get-lucky/${AM_T}`, ref('am', 'track', AM_T)],
    [`https://music.apple.com/us/song/${AM_T}`, ref('am', 'track', AM_T)],
    [`https://music.apple.com/song/${AM_T}`, ref('am', 'track', AM_T)],
    [`https://music.apple.com/album/${AM_A}`, ref('am', 'album', AM_A)],
    [`https://music.apple.com/jp/album/%E3%83%A9%E3%83%B3%E3%83%80%E3%83%A0/${AM_A}`, ref('am', 'album', AM_A)],
    [`https://geo.music.apple.com/us/album/_/${AM_A}?i=${AM_T}&mt=1&app=music`, ref('am', 'track', AM_T)],
    [`https://embed.music.apple.com/us/album/random-access-memories/${AM_A}`, ref('am', 'album', AM_A)],
    [`https://itunes.apple.com/us/album/random-access-memories/id${AM_A}?i=${AM_T}&uo=4`, ref('am', 'track', AM_T)],
    [`https://itunes.apple.com/us/album/random-access-memories/id${AM_A}`, ref('am', 'album', AM_A)],
    [`https://itunes.apple.com/album/id${AM_A}`, ref('am', 'album', AM_A)],
    [`music.apple.com/us/album/x/${AM_A}?i=${AM_T}`, ref('am', 'track', AM_T)],
    // Deezer
    [`https://www.deezer.com/en/track/${DZ_T}`, ref('dz', 'track', DZ_T)],
    [`https://www.deezer.com/fr/album/${DZ_A}`, ref('dz', 'album', DZ_A)],
    [`https://deezer.com/track/${DZ_T}`, ref('dz', 'track', DZ_T)],
    [`https://www.deezer.com/album/${DZ_A}?utm_source=deezer&deferredFl=1`, ref('dz', 'album', DZ_A)],
    [`deezer.com/us/track/${DZ_T}`, ref('dz', 'track', DZ_T)],
    // YouTube
    [`https://www.youtube.com/watch?v=${YT}`, ref('yt', 'track', YT)],
    [`https://youtube.com/watch?v=${YT}&list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG&index=2`, ref('yt', 'track', YT)],
    [`https://www.youtube.com/watch?v=${YT}&t=42s`, ref('yt', 'track', YT)],
    [`https://www.youtube.com/watch?feature=share&v=${YT}`, ref('yt', 'track', YT)],
    [`https://m.youtube.com/watch?v=${YT}&si=abc`, ref('yt', 'track', YT)],
    [`https://music.youtube.com/watch?v=${YT}&si=abc`, ref('yt', 'track', YT)],
    [`https://music.youtube.com/watch?v=${YT}&list=RDAMVM${YT}`, ref('yt', 'track', YT)],
    [`https://youtu.be/${YT}`, ref('yt', 'track', YT)],
    [`https://youtu.be/${YT}?si=Xyz123abc`, ref('yt', 'track', YT)],
    [`https://youtu.be/${YT}&feature=shared`, ref('yt', 'track', YT)],
    [`youtu.be/${YT_PUNCT}`, ref('yt', 'track', YT_PUNCT)],
    [`https://www.youtube.com/embed/${YT}?start=10`, ref('yt', 'track', YT)],
    [`https://www.youtube-nocookie.com/embed/${YT}`, ref('yt', 'track', YT)],
    [`https://www.youtube.com/v/${YT}`, ref('yt', 'track', YT)],
  ])('%s', (input, expected) => {
    expect(parseMusicUrl(input)).toEqual({ type: 'ref', ref: expected });
  });
});

describe('parseMusicUrl: short links', () => {
  it.each([
    ['https://spotify.link/AbCdEf12345', 'https://spotify.link/AbCdEf12345'],
    ['spotify.link/AbCdEf12345', 'https://spotify.link/AbCdEf12345'],
    ['http://spotify.link/AbCdEf12345', 'https://spotify.link/AbCdEf12345'],
    ['https://spotify.app.link/AbCdEf12345?_p=c1', 'https://spotify.app.link/AbCdEf12345?_p=c1'],
    ['https://deezer.page.link/AbCdEf12345', 'https://deezer.page.link/AbCdEf12345'],
    ['https://link.deezer.com/s/30AbCdEfGh', 'https://link.deezer.com/s/30AbCdEfGh'],
    ['Listen on Deezer! https://link.deezer.com/s/30AbCdEfGh', 'https://link.deezer.com/s/30AbCdEfGh'],
  ])('%s', (input, url) => {
    expect(parseMusicUrl(input)).toEqual({ type: 'short', url });
  });
});

describe('parseMusicUrl: errors', () => {
  it.each<[string, string]>([
    // Not a link
    ['', PARSE_ERRORS.notALink],
    ['   ', PARSE_ERRORS.notALink],
    ['hello', PARSE_ERRORS.notALink],
    ['just some words.', PARSE_ERRORS.notALink],
    ['hello.world', PARSE_ERRORS.notALink],
    ['!!!', PARSE_ERRORS.notALink],
    ['https://', PARSE_ERRORS.notALink],
    ['https://localhost/track/1', PARSE_ERRORS.notALink],
    // Unknown hosts
    ['https://example.com/track/123', PARSE_ERRORS.unsupportedHost],
    ['https://tidal.com/browse/track/123', PARSE_ERRORS.unsupportedHost],
    ['example.com/foo', PARSE_ERRORS.unsupportedHost],
    ['look at this: https://example.com/a and https://example.org/b', PARSE_ERRORS.unsupportedHost],
    ['https://music.amazon.com/albums/B00C1OJ8OO', PARSE_ERRORS.unsupportedHost],
    // Spotify
    ['https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', PARSE_ERRORS.playlist],
    ['https://open.spotify.com/intl-fr/playlist/37i9dQZF1DXcBWIGoYBM5M?si=1', PARSE_ERRORS.playlist],
    ['https://open.spotify.com/user/spotify/playlist/37i9dQZF1DXcBWIGoYBM5M', PARSE_ERRORS.playlist],
    ['spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', PARSE_ERRORS.playlist],
    ['spotify:user:spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', PARSE_ERRORS.playlist],
    ['https://open.spotify.com/artist/4tZwfgrHOc3mvqYlEYSvVi', PARSE_ERRORS.artist],
    ['spotify:artist:4tZwfgrHOc3mvqYlEYSvVi', PARSE_ERRORS.artist],
    ['https://open.spotify.com/episode/512ojhOuo1ktJprKbVcKyQ', PARSE_ERRORS.podcast],
    ['https://open.spotify.com/show/4rOoJ6Egrf8K2IrywzwOMk', PARSE_ERRORS.podcast],
    ['https://open.spotify.com/embed-podcast/episode/512ojhOuo1ktJprKbVcKyQ', PARSE_ERRORS.podcast],
    ['https://open.spotify.com/audiobook/7iHfbu1YPACw6oZPAFJtqe', PARSE_ERRORS.audiobook],
    ['https://open.spotify.com/', notItemError('sp')],
    ['https://open.spotify.com/search/daft%20punk', notItemError('sp')],
    ['https://open.spotify.com/user/spotify', notItemError('sp')],
    ['https://open.spotify.com/track/', notItemError('sp')],
    ['https://spotify.link/', notItemError('sp')],
    // Apple
    ['https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb', PARSE_ERRORS.playlist],
    ['https://music.apple.com/us/artist/daft-punk/5468295', PARSE_ERRORS.artist],
    ['https://music.apple.com/us/music-video/get-lucky/1440776367', PARSE_ERRORS.musicVideo],
    ['https://podcasts.apple.com/us/podcast/the-daily/id1200361736', PARSE_ERRORS.podcast],
    ['https://itunes.apple.com/us/podcast/the-daily/id1200361736', PARSE_ERRORS.podcast],
    ['https://music.apple.com/us/station/daft-punk-radio/ra.123', notItemError('am')],
    ['https://music.apple.com/us/browse', notItemError('am')],
    ['https://music.apple.com/', notItemError('am')],
    // Deezer
    ['https://www.deezer.com/en/playlist/908622995', PARSE_ERRORS.playlist],
    ['https://www.deezer.com/en/artist/27', PARSE_ERRORS.artist],
    ['https://www.deezer.com/en/show/1234', PARSE_ERRORS.podcast],
    ['https://www.deezer.com/en/episode/5678', PARSE_ERRORS.podcast],
    ['https://www.deezer.com/en/', notItemError('dz')],
    ['https://www.deezer.com/deezer-links-404', notItemError('dz')],
    ['https://link.deezer.com/', notItemError('dz')],
    // YouTube
    ['https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG', PARSE_ERRORS.playlist],
    ['https://www.youtube.com/embed/videoseries?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG', PARSE_ERRORS.playlist],
    ['https://www.youtube.com/playlist?list=OLAK5uy_kM2EJZVyLOFJ0ASdC5fIVoHz6h1C2AP_k', PARSE_ERRORS.ytMusicCollection],
    ['https://music.youtube.com/playlist?list=OLAK5uy_kM2EJZVyLOFJ0ASdC5fIVoHz6h1C2AP_k', PARSE_ERRORS.ytMusicCollection],
    ['https://music.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG', PARSE_ERRORS.ytMusicCollection],
    ['https://music.youtube.com/browse/MPREb_BQZvl3BFGay', PARSE_ERRORS.ytMusicCollection],
    ['https://music.youtube.com/channel/UC_kRDKYrUlrbtrSiyu5Tflg', PARSE_ERRORS.artist],
    ['https://www.youtube.com/@daftpunk', PARSE_ERRORS.artist],
    ['https://www.youtube.com/channel/UC_kRDKYrUlrbtrSiyu5Tflg', PARSE_ERRORS.artist],
    ['https://www.youtube.com/', notItemError('yt')],
    ['https://www.youtube.com/watch', notItemError('yt')],
    ['https://youtu.be/', notItemError('yt')],
  ])('%s', (input, error) => {
    expect(parseMusicUrl(input)).toEqual({ type: 'error', error });
  });

  it.each<[string, Platform]>([
    ['https://open.spotify.com/track/tooShort', 'sp'],
    [`https://open.spotify.com/track/${SP_T}1`, 'sp'],
    [`https://open.spotify.com/track/${SP_T.slice(0, 21)}-`, 'sp'],
    ['spotify:track:abc', 'sp'],
    ['https://music.apple.com/us/album/slug/abc', 'am'],
    [`https://music.apple.com/us/album/slug/${AM_A}?i=abc`, 'am'],
    ['https://music.apple.com/us/song/get-lucky', 'am'],
    ['https://music.apple.com/us/album/slug/0123', 'am'],
    ['https://www.deezer.com/en/track/abc', 'dz'],
    ['https://www.deezer.com/en/track/0123', 'dz'],
    ['https://www.deezer.com/album/12345678901234567890123', 'dz'],
    ['https://www.youtube.com/watch?v=short', 'yt'],
    [`https://youtu.be/${YT}X`, 'yt'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXc!', 'yt'],
  ])('invalid id: %s', (input, platform) => {
    expect(parseMusicUrl(input)).toEqual({ type: 'error', error: invalidIdError(platform) });
  });

  it('keeps every message short, plain ASCII', () => {
    const messages = [
      ...Object.values(PARSE_ERRORS),
      ...PLATFORMS.flatMap((p) => [notItemError(p), invalidIdError(p)]),
    ];
    for (const m of messages) {
      expect(m).toMatch(/^[\x20-\x7e]+$/);
      expect(m.length).toBeLessThanOrEqual(90);
    }
  });

  it('only looks at the start of a huge paste', () => {
    expect(parseMusicUrl(`${'a '.repeat(5000)}https://open.spotify.com/track/${SP_T}`)).toEqual({
      type: 'error',
      error: PARSE_ERRORS.notALink,
    });
  });
});

describe('canonicalPath / cacheKey / refFromParams', () => {
  const refs: SourceRef[] = [
    ref('sp', 'track', SP_T),
    ref('sp', 'album', SP_A),
    ref('am', 'track', AM_T),
    ref('am', 'album', AM_A),
    ref('dz', 'track', DZ_T),
    ref('dz', 'album', DZ_A),
    ref('yt', 'track', YT_PUNCT),
  ];

  it('formats paths and keys', () => {
    expect(canonicalPath(ref('sp', 'track', SP_T))).toBe(`/sp/t/${SP_T}`);
    expect(canonicalPath(ref('am', 'album', AM_A))).toBe(`/am/a/${AM_A}`);
    expect(cacheKey(ref('sp', 'track', SP_T))).toBe(`sp:t:${SP_T}`);
    expect(cacheKey(ref('dz', 'album', DZ_A))).toBe(`dz:a:${DZ_A}`);
  });

  it.each(refs)('round trips $platform $kind $id', (r) => {
    const [, p = '', k = '', id = ''] = canonicalPath(r).split('/');
    expect(refFromParams(p, k, id)).toEqual(r);
    expect(cacheKey(r)).toBe(`${p}:${k}:${id}`);
  });

  it('round trips parsed links', () => {
    const parsed = parseMusicUrl(`https://music.apple.com/us/album/x/${AM_A}?i=${AM_T}`);
    expect(parsed.type).toBe('ref');
    if (parsed.type !== 'ref') return;
    expect(canonicalPath(parsed.ref)).toBe(`/am/t/${AM_T}`);
    expect(cacheKey(parsed.ref)).toBe(`am:t:${AM_T}`);
  });

  it.each([
    ['yt', 'a', YT],
    ['xx', 't', SP_T],
    ['SP', 't', SP_T],
    ['sp', 'x', SP_T],
    ['sp', 'T', SP_T],
    ['sp', 't', 'short'],
    ['sp', 't', ''],
    ['sp', 't', `${SP_T}x`],
    ['am', 't', 'abc'],
    ['am', 't', '0123'],
    ['dz', 'a', '12a'],
    ['dz', 'a', SP_A],
    ['yt', 't', YT.slice(0, 10)],
    ['yt', 't', `${YT.slice(0, 10)}.`],
    ['constructor', 't', SP_T],
    ['sp', 'toString', SP_T],
    ['sp', '__proto__', SP_T],
  ])('rejects %s/%s/%s', (p, k, id) => {
    expect(refFromParams(p, k, id)).toBeNull();
  });
});

describe('extractUrlFromPath', () => {
  it.each<[string, string]>([
    [`https://open.spotify.com/track/${SP_T}?si=1`, `https://open.spotify.com/track/${SP_T}?si=1`],
    [`https:/open.spotify.com/track/${SP_T}`, `https://open.spotify.com/track/${SP_T}`],
    [`http:/open.spotify.com/track/${SP_T}`, `http://open.spotify.com/track/${SP_T}`],
    [`open.spotify.com/track/${SP_T}`, `https://open.spotify.com/track/${SP_T}`],
    [`https%3A%2F%2Fopen.spotify.com%2Ftrack%2F${SP_T}`, `https://open.spotify.com/track/${SP_T}`],
    [`music.apple.com/us/album/x/${AM_A}?i=${AM_T}`, `https://music.apple.com/us/album/x/${AM_A}?i=${AM_T}`],
    [`www.youtube.com/watch?v=${YT}`, `https://www.youtube.com/watch?v=${YT}`],
    [`youtu.be/${YT}`, `https://youtu.be/${YT}`],
    [`spotify:track:${SP_T}`, `spotify:track:${SP_T}`],
    ['spotify.link/AbCdEf12345', 'https://spotify.link/AbCdEf12345'],
    ['example.com/whatever', 'https://example.com/whatever'],
  ])('%s', (path, expected) => {
    expect(extractUrlFromPath(path)).toBe(expected);
  });

  it.each(['', 'favicon.ico', 'robots.txt', 'apple-touch-icon.png', 'assets/app.css', `sp/t/${SP_T}`, 'about', 'spotify'])(
    'not a URL: %j',
    (path) => {
      expect(extractUrlFromPath(path)).toBeNull();
    },
  );

  it.each<[string, SourceRef]>([
    [`https:/open.spotify.com/intl-fr/track/${SP_T}?si=1`, ref('sp', 'track', SP_T)],
    [`music.apple.com/us/album/x/${AM_A}?i=${AM_T}`, ref('am', 'track', AM_T)],
    [`www.deezer.com/en/album/${DZ_A}`, ref('dz', 'album', DZ_A)],
    [`www.youtube.com/watch?v=${YT}&list=PL123`, ref('yt', 'track', YT)],
  ])('feeds parseMusicUrl: %s', (path, expected) => {
    const url = extractUrlFromPath(path);
    expect(url).not.toBeNull();
    expect(parseMusicUrl(url ?? '')).toEqual({ type: 'ref', ref: expected });
  });
});

// Hand-written fixtures modeled on real chains: spotify.link answers 307 to spotify.app.link (Branch),
// which answers 307 to open.spotify.com/...?si=...; link.deezer.com/s/<code> answers 302 to www.deezer.com.
function redirect(from: string, location: string, status = 307): HttpFixture {
  return { request: { url: from }, response: { status, headers: { location }, body: '' } };
}

function page(url: string, body: string, status = 200): HttpFixture {
  return { request: { url }, response: { status, headers: { 'content-type': 'text/html; charset=utf-8' }, body } };
}

const SPOTIFY_LONG = `https://open.spotify.com/track/${SP_T}?si=0a1b2c3d4e5f4a6b&utm_source=copy-link&utm_medium=copy-link&_branch_match_id=1234567890123456789`;
const DEEZER_LONG = `https://www.deezer.com/en/track/${DZ_T}?host=0&utm_campaign=clipboard-generic&utm_source=user_sharing&utm_content=track-${DZ_T}&deferredFl=1`;

describe('resolveShortLink', () => {
  it('follows spotify.link -> spotify.app.link -> open.spotify.com and stops there', async () => {
    const calls: string[] = [];
    const ctx = fixtureCtx({
      calls,
      extra: [
        redirect('https://spotify.link/Fq3JxY9ZbCb', 'https://spotify.app.link/Fq3JxY9ZbCb?_p=c11a33d7c8a82da6c0a0'),
        redirect('https://spotify.app.link/Fq3JxY9ZbCb?_p=c11a33d7c8a82da6c0a0', SPOTIFY_LONG),
      ],
    });
    expect(await resolveShortLink(ctx, 'https://spotify.link/Fq3JxY9ZbCb')).toBe(SPOTIFY_LONG);
    expect(calls).toEqual(['https://spotify.link/Fq3JxY9ZbCb', 'https://spotify.app.link/Fq3JxY9ZbCb?_p=c11a33d7c8a82da6c0a0']);
  });

  it('follows link.deezer.com 302 to the long Deezer URL', async () => {
    const ctx = fixtureCtx({ extra: [redirect('https://link.deezer.com/s/30Ab1Cd2Ef3Gh', DEEZER_LONG, 302)] });
    expect(await resolveShortLink(ctx, 'https://link.deezer.com/s/30Ab1Cd2Ef3Gh')).toBe(DEEZER_LONG);
  });

  it('asks for manual redirects', async () => {
    const inits: (RequestInit | undefined)[] = [];
    const inner = fixtureCtx({ extra: [redirect('https://spotify.link/Abc', SPOTIFY_LONG)] });
    const fetch: FetchFn = (input, init) => {
      inits.push(init);
      return inner.fetch(input, init);
    };
    await resolveShortLink({ ...inner, fetch }, 'https://spotify.link/Abc');
    expect(inits[0]?.redirect).toBe('manual');
  });

  it('resolves relative and protocol-relative Location headers', async () => {
    const ctx = fixtureCtx({
      extra: [
        redirect('https://spotify.app.link/Rel1', '/Rel2?_p=1', 302),
        redirect('https://spotify.app.link/Rel2?_p=1', `//open.spotify.com/album/${SP_A}?si=z`),
      ],
    });
    expect(await resolveShortLink(ctx, 'https://spotify.app.link/Rel1')).toBe(`https://open.spotify.com/album/${SP_A}?si=z`);
  });

  it('passes through unknown intermediate hosts', async () => {
    const ctx = fixtureCtx({
      extra: [
        redirect('https://deezer.page.link/Xy12', 'https://dzr.example-tracker.net/c?id=9', 302),
        redirect('https://dzr.example-tracker.net/c?id=9', `https://www.deezer.com/album/${DZ_A}`, 301),
      ],
    });
    expect(await resolveShortLink(ctx, 'https://deezer.page.link/Xy12')).toBe(`https://www.deezer.com/album/${DZ_A}`);
  });

  it('reads the target from a 200 interstitial page (og:url)', async () => {
    const html = `<!doctype html><html><head><meta property="og:url" content="https://open.spotify.com/album/${SP_A}?si=q"><title>Spotify</title></head><body></body></html>`;
    const ctx = fixtureCtx({ extra: [page('https://spotify.app.link/Html1', html)] });
    expect(await resolveShortLink(ctx, 'https://spotify.app.link/Html1')).toBe(`https://open.spotify.com/album/${SP_A}?si=q`);
  });

  it('reads JS-escaped URLs and skips generic links before them', async () => {
    const html = `<html><head><link rel="icon" href="https://open.spotify.com/favicon.ico"><a href="https://open.spotify.com/">home</a></head><body><script>window.top.location = validate("https:\\/\\/open.spotify.com\\/track\\/${SP_T}?si=1&amp;x=2");</script></body></html>`;
    const ctx = fixtureCtx({ extra: [page('https://spotify.app.link/Html2', html)] });
    expect(await resolveShortLink(ctx, 'https://spotify.app.link/Html2')).toBe(`https://open.spotify.com/track/${SP_T}?si=1&x=2`);
  });

  it('reads a Deezer URL from a meta refresh', async () => {
    const html = `<html><head><meta http-equiv="refresh" content="0; url=https://www.deezer.com/fr/track/${DZ_T}"></head></html>`;
    const ctx = fixtureCtx({ extra: [page('https://deezer.page.link/Html3', html)] });
    expect(await resolveShortLink(ctx, 'https://deezer.page.link/Html3')).toBe(`https://www.deezer.com/fr/track/${DZ_T}`);
  });

  it('returns null for a page with no usable URL', async () => {
    const ctx = fixtureCtx({ extra: [page('https://spotify.app.link/Html4', '<html><body>Redirecting...</body></html>')] });
    expect(await resolveShortLink(ctx, 'https://spotify.app.link/Html4')).toBeNull();
  });

  it('detects redirect loops', async () => {
    const calls: string[] = [];
    const ctx = fixtureCtx({
      calls,
      extra: [
        redirect('https://spotify.link/LoopA', 'https://spotify.app.link/LoopB'),
        redirect('https://spotify.app.link/LoopB', 'https://spotify.link/LoopA'),
      ],
    });
    expect(await resolveShortLink(ctx, 'https://spotify.link/LoopA')).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it(`gives up after ${MAX_SHORT_LINK_HOPS} hops`, async () => {
    const hop = (i: number) => `https://spotify.app.link/Hop${i}`;
    const extra = Array.from({ length: MAX_SHORT_LINK_HOPS + 1 }, (_, i) => redirect(hop(i), hop(i + 1)));
    extra.push(redirect(hop(MAX_SHORT_LINK_HOPS + 1), SPOTIFY_LONG));
    const calls: string[] = [];
    const ctx = fixtureCtx({ calls, extra });
    expect(await resolveShortLink(ctx, hop(0))).toBeNull();
    expect(calls).toHaveLength(MAX_SHORT_LINK_HOPS);
  });

  it.each([
    ['a 3xx without Location', [{ request: { url: 'https://spotify.link/NoLoc' }, response: { status: 302, body: '' } }]],
    ['a 5xx', [page('https://spotify.link/NoLoc', 'error', 503)]],
    ['a redirect to a non-http scheme', [redirect('https://spotify.link/NoLoc', 'intent://open?x=1#Intent;end')]],
  ])('returns null for %s', async (_name, extra: HttpFixture[]) => {
    expect(await resolveShortLink(fixtureCtx({ extra }), 'https://spotify.link/NoLoc')).toBeNull();
  });

  it('returns null on a network error', async () => {
    const fetch: FetchFn = () => Promise.reject(new TypeError('Network connection lost.'));
    expect(await resolveShortLink(fixtureCtx({ fetch }), 'https://spotify.link/Abc')).toBeNull();
  });

  it('returns null on timeout', async () => {
    const fetch: FetchFn = (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    expect(await resolveShortLink(fixtureCtx({ fetch, timeoutMs: 10 }), 'https://spotify.link/Abc')).toBeNull();
  });

  // Recorded: what the real services answer for codes that don't exist.
  it('stops at the Spotify home page for an unknown spotify.link code (recorded)', async () => {
    expect(await resolveShortLink(fixtureCtx(), 'https://spotify.link/Zz0NotReal1')).toBe('https://open.spotify.com/');
  });

  it('stops at the Deezer 404 page for an unknown link.deezer.com code (recorded)', async () => {
    expect(await resolveShortLink(fixtureCtx(), 'https://link.deezer.com/s/30zzNotARealCode0')).toBe(
      'https://www.deezer.com/deezer-links-404',
    );
  });

  it('returns null for a dead deezer.page.link (recorded 404)', async () => {
    expect(await resolveShortLink(fixtureCtx(), 'https://deezer.page.link/Zz0NotReal1')).toBeNull();
  });
});

describe('parseInput', () => {
  it.each<[string, SourceRef]>([
    [`https://open.spotify.com/track/${SP_T}`, ref('sp', 'track', SP_T)],
    [`https://music.apple.com/us/album/x/${AM_A}?i=${AM_T}`, ref('am', 'track', AM_T)],
    [`https://youtu.be/${YT}`, ref('yt', 'track', YT)],
  ])('parses long links without network: %s', async (input, expected) => {
    const calls: string[] = [];
    expect(await parseInput(fixtureCtx({ calls }), input)).toEqual({ ok: true, ref: expected });
    expect(calls).toEqual([]);
  });

  it('returns parse errors as is', async () => {
    expect(await parseInput(fixtureCtx(), 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')).toEqual({
      ok: false,
      error: PARSE_ERRORS.playlist,
    });
    expect(await parseInput(fixtureCtx(), 'nope')).toEqual({ ok: false, error: PARSE_ERRORS.notALink });
  });

  it('resolves Spotify short links', async () => {
    const ctx = fixtureCtx({
      extra: [
        redirect('https://spotify.link/Fq3JxY9ZbCb', 'https://spotify.app.link/Fq3JxY9ZbCb?_p=c11a'),
        redirect('https://spotify.app.link/Fq3JxY9ZbCb?_p=c11a', SPOTIFY_LONG),
      ],
    });
    expect(await parseInput(ctx, 'check this out https://spotify.link/Fq3JxY9ZbCb')).toEqual({
      ok: true,
      ref: ref('sp', 'track', SP_T),
    });
  });

  it('resolves Deezer short links', async () => {
    const ctx = fixtureCtx({ extra: [redirect('https://link.deezer.com/s/30Ab1Cd2Ef3Gh', DEEZER_LONG, 302)] });
    expect(await parseInput(ctx, 'https://link.deezer.com/s/30Ab1Cd2Ef3Gh')).toEqual({
      ok: true,
      ref: ref('dz', 'track', DZ_T),
    });
  });

  it('keeps the specific message when a short link points to a playlist', async () => {
    const ctx = fixtureCtx({
      extra: [redirect('https://spotify.link/Pl1', 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=1')],
    });
    expect(await parseInput(ctx, 'https://spotify.link/Pl1')).toEqual({ ok: false, error: PARSE_ERRORS.playlist });
  });

  it('keeps the playlist message from an interstitial page even if it lists tracks', async () => {
    const html = `<head><meta property="og:url" content="https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"></head><body><a href="https://open.spotify.com/track/${SP_T}">1</a></body>`;
    const ctx = fixtureCtx({ extra: [page('https://spotify.app.link/Pl2', html)] });
    expect(await parseInput(ctx, 'https://spotify.app.link/Pl2')).toEqual({ ok: false, error: PARSE_ERRORS.playlist });
  });

  it.each([
    ['https://spotify.link/Zz0NotReal1', 'dead code -> Spotify home (recorded)'],
    ['https://link.deezer.com/s/30zzNotARealCode0', 'dead code -> Deezer 404 page (recorded)'],
    ['https://deezer.page.link/Zz0NotReal1', 'dead code -> 404 (recorded)'],
  ])('reports a short-link error for %s (%s)', async (input) => {
    expect(await parseInput(fixtureCtx(), input)).toEqual({ ok: false, error: PARSE_ERRORS.shortLink });
  });

  it('reports a short-link error on network failure', async () => {
    const fetch: FetchFn = () => Promise.reject(new TypeError('Network connection lost.'));
    expect(await parseInput(fixtureCtx({ fetch }), 'https://spotify.link/Abc')).toEqual({
      ok: false,
      error: "Couldn't open that short link. Try the full link instead.",
    });
  });
});
