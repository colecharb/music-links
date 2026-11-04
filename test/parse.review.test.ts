// Adversarial review of src/parse.ts: odd but real inputs (share sheets in other languages, embed codes,
// links copied out of email/social redirectors, markdown) and short-link chains that must never yield a
// wrong item.
import { describe, expect, it } from 'vitest';
import { fixtureCtx } from './helpers/fixtures';
import type { HttpFixture } from './helpers/fixtures';
import {
  PARSE_ERRORS,
  extractUrlFromPath,
  invalidIdError,
  notItemError,
  parseInput,
  parseMusicUrl,
  resolveShortLink,
} from '../src/parse';
import type { Kind, Platform, SourceRef } from '../src/types';

const SP_T = '4uLU6hMCjMI75M1A2tKUQC';
const SP_A = '4m2880jivSbbyEGAKfITCa';
const AM_A = '617154241';
const AM_T = '617154366';
const DZ_T = '3135556';
const DZ_A = '302127';
const YT = 'dQw4w9WgXcQ';
const YT_DASH = 'Ab-_cd1234-';

const ref = (platform: Platform, kind: Kind, id: string): SourceRef => ({ platform, kind, id });

describe('review: share text in other scripts, emoji and invisible characters', () => {
  it.each<[string, string, SourceRef]>([
    ['zero-width space glued after the link', `https://open.spotify.com/track/${SP_T}\u200b`, ref('sp', 'track', SP_T)],
    ['zero-width space between link and words', `https://open.spotify.com/track/${SP_T}\u200bcheck it`, ref('sp', 'track', SP_T)],
    ['RTL mark after the link (Arabic/Hebrew text)', `استمع https://open.spotify.com/track/${SP_T}\u200f`, ref('sp', 'track', SP_T)],
    ['word joiner after a youtu.be link', `https://youtu.be/${YT}\u2060`, ref('yt', 'track', YT)],
    ['Japanese corner brackets', `「https://open.spotify.com/track/${SP_T}」`, ref('sp', 'track', SP_T)],
    ['Japanese full stop', `この曲 https://open.spotify.com/track/${SP_T}。`, ref('sp', 'track', SP_T)],
    ['Japanese text glued after the link', `https://open.spotify.com/track/${SP_T}いい曲`, ref('sp', 'track', SP_T)],
    ['fullwidth exclamation', `最高 https://www.deezer.com/fr/track/${DZ_T}！`, ref('dz', 'track', DZ_T)],
    ['French guillemets', `«https://open.spotify.com/album/${SP_A}»`, ref('sp', 'album', SP_A)],
    ['emoji glued after the link', `https://open.spotify.com/track/${SP_T}🔥🔥`, ref('sp', 'track', SP_T)],
    ['emoji glued after a youtu.be link', `https://youtu.be/${YT}🎶`, ref('yt', 'track', YT)],
    ['emoji glued before the link', `👉https://open.spotify.com/track/${SP_T}`, ref('sp', 'track', SP_T)],
    ['emoji glued before a scheme-less link', `👉open.spotify.com/track/${SP_T}`, ref('sp', 'track', SP_T)],
    ['CJK text glued before a scheme-less link', `聴いてopen.spotify.com/album/${SP_A}`, ref('sp', 'album', SP_A)],
    [
      'raw unicode Apple slug (as the Apple Music share sheet produces)',
      'https://music.apple.com/jp/album/夜に駆ける/1488408555?i=1488408563',
      ref('am', 'track', '1488408563'),
    ],
    [
      'raw unicode Apple slug, closing bracket glued',
      '「https://music.apple.com/jp/album/夜に駆ける/1488408555?i=1488408563」',
      ref('am', 'track', '1488408563'),
    ],
    ['Apple ?i= with Japanese glued on', `https://music.apple.com/jp/album/x/${AM_A}?i=${AM_T}です`, ref('am', 'track', AM_T)],
    ['ellipsis after an intact link', `https://open.spotify.com/track/${SP_T}?si=0a1b…`, ref('sp', 'track', SP_T)],
    ['NBSP before the link', `écoute\u00a0https://open.spotify.com/track/${SP_T}`, ref('sp', 'track', SP_T)],
  ])('%s', (_name, input, expected) => {
    expect(parseMusicUrl(input)).toEqual({ type: 'ref', ref: expected });
  });

  it('a youtu.be id ending in "-" or "_" keeps its last character', () => {
    expect(parseMusicUrl(`https://youtu.be/${YT_DASH}`)).toEqual({ type: 'ref', ref: ref('yt', 'track', YT_DASH) });
    expect(parseMusicUrl(`look https://youtu.be/${YT_DASH}!`)).toEqual({ type: 'ref', ref: ref('yt', 'track', YT_DASH) });
  });
});

describe('review: markdown and HTML around the link', () => {
  it.each<[string, string, SourceRef]>([
    [
      'markdown link with the URL as its text',
      `[https://open.spotify.com/track/${SP_T}](https://open.spotify.com/track/${SP_T})`,
      ref('sp', 'track', SP_T),
    ],
    [
      'markdown link with a query in the text part',
      `[https://music.apple.com/us/album/x/${AM_A}?i=${AM_T}](https://music.apple.com/us/album/x/${AM_A}?i=${AM_T})`,
      ref('am', 'track', AM_T),
    ],
    ['markdown link with a title', `[Get Lucky](https://open.spotify.com/track/${SP_T}?si=1)`, ref('sp', 'track', SP_T)],
    ['markdown bold', `**https://open.spotify.com/track/${SP_T}**`, ref('sp', 'track', SP_T)],
    ['HTML-escaped ampersand before ?i=', `https://music.apple.com/us/album/x/${AM_A}?l=en&amp;i=${AM_T}`, ref('am', 'track', AM_T)],
    ['HTML-escaped ampersand before v=', `https://www.youtube.com/watch?feature=share&amp;v=${YT}`, ref('yt', 'track', YT)],
    [
      'Spotify embed code',
      `<iframe style="border-radius:12px" src="https://open.spotify.com/embed/track/${SP_T}?utm_source=generator" width="100%" height="352" frameBorder="0" allowfullscreen="" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>`,
      ref('sp', 'track', SP_T),
    ],
    [
      'Apple Music embed code',
      `<iframe allow="autoplay *; encrypted-media *; fullscreen *; clipboard-write" frameborder="0" height="175" style="width:100%;max-width:660px;overflow:hidden;border-radius:10px;" sandbox="allow-forms allow-popups allow-same-origin allow-scripts allow-storage-access-by-user-activation allow-top-navigation-by-user-activation" src="https://embed.music.apple.com/us/album/get-lucky/${AM_A}?i=${AM_T}"></iframe>`,
      ref('am', 'track', AM_T),
    ],
    [
      'YouTube embed code with a start time',
      `<iframe width="560" height="315" src="https://www.youtube.com/embed/${YT}?si=Xy12ab&amp;start=30" title="YouTube video player" frameborder="0" allowfullscreen></iframe>`,
      ref('yt', 'track', YT),
    ],
    [
      'Deezer embed code',
      `<iframe title="deezer-widget" src="https://widget.deezer.com/widget/dark/track/${DZ_T}" width="100%" height="300" frameborder="0" allowtransparency="true" allow="encrypted-media; clipboard-write"></iframe>`,
      ref('dz', 'track', DZ_T),
    ],
    ['Deezer widget URL (album)', `https://widget.deezer.com/widget/auto/album/${DZ_A}?tracklist=false`, ref('dz', 'album', DZ_A)],
  ])('%s', (_name, input, expected) => {
    expect(parseMusicUrl(input)).toEqual({ type: 'ref', ref: expected });
  });

  it.each<[string, string]>([
    ['https://widget.deezer.com/widget/dark/playlist/908622995', PARSE_ERRORS.playlist],
    ['https://widget.deezer.com/widget/light/artist/27', PARSE_ERRORS.artist],
    ['https://widget.deezer.com/', notItemError('dz')],
    [`https://widget.deezer.com/widget/dark/track/0${DZ_T}`, invalidIdError('dz')],
  ])('Deezer widget: %s', (input, error) => {
    expect(parseMusicUrl(input)).toEqual({ type: 'error', error });
  });
});

describe('review: links copied through redirectors (email safe links, social, YouTube descriptions)', () => {
  const enc = encodeURIComponent;
  it.each<[string, string, SourceRef]>([
    [
      'Outlook Safe Links',
      `https://nam12.safelinks.protection.outlook.com/?url=${enc(`https://open.spotify.com/track/${SP_T}?si=abc`)}&data=05%7C02%7Cx%7C&sdata=abc%3D&reserved=0`,
      ref('sp', 'track', SP_T),
    ],
    [
      'Facebook outbound link',
      `https://l.facebook.com/l.php?u=${enc(`https://music.apple.com/us/album/get-lucky/${AM_A}?i=${AM_T}&fbclid=IwAR0x`)}&h=AT0abc`,
      ref('am', 'track', AM_T),
    ],
    [
      'Google result link',
      `https://www.google.com/url?sa=t&source=web&rct=j&url=${enc(`https://www.deezer.com/en/album/${DZ_A}`)}&ved=2ahUKEw`,
      ref('dz', 'album', DZ_A),
    ],
    [
      'YouTube description link (youtube.com/redirect)',
      `https://www.youtube.com/redirect?event=video_description&redir_token=QUFFLUhqbX&q=${enc(`https://open.spotify.com/album/${SP_A}`)}&v=${YT}`,
      ref('sp', 'album', SP_A),
    ],
    [
      'redirector inside share text',
      `listen: https://l.facebook.com/l.php?u=${enc(`https://youtu.be/${YT}`)}&h=AT0 !!`,
      ref('yt', 'track', YT),
    ],
  ])('%s', (_name, input, expected) => {
    expect(parseMusicUrl(input)).toEqual({ type: 'ref', ref: expected });
  });

  it('keeps the specific message for a wrapped playlist', () => {
    const input = `https://l.facebook.com/l.php?u=${enc('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')}`;
    expect(parseMusicUrl(input)).toEqual({ type: 'error', error: PARSE_ERRORS.playlist });
  });

  it('treats a wrapped short link as a short link', () => {
    const input = `https://nam12.safelinks.protection.outlook.com/?url=${enc('https://spotify.link/Fq3JxY9ZbCb')}&data=05`;
    expect(parseMusicUrl(input)).toEqual({ type: 'short', url: 'https://spotify.link/Fq3JxY9ZbCb' });
  });

  it.each<[string, string]>([
    ['a redirector to a non-music site', `https://l.facebook.com/l.php?u=${enc('https://example.com/a')}`],
    ['a non-music link whose query mentions a non-URL', 'https://example.com/?q=open%20spotify'],
  ])('still says unsupported for %s', (_name, input) => {
    expect(parseMusicUrl(input)).toEqual({ type: 'error', error: PARSE_ERRORS.unsupportedHost });
  });

  it('does not unwrap the query of a real item link', () => {
    // A track link whose tracking params carry another music URL is still that track.
    const input = `https://open.spotify.com/track/${SP_T}?ref=${enc(`https://open.spotify.com/album/${SP_A}`)}`;
    expect(parseMusicUrl(input)).toEqual({ type: 'ref', ref: ref('sp', 'track', SP_T) });
  });
});

describe('review: several links in one paste', () => {
  it.each<[string, string, ParsedOk]>([
    [
      'artist link before the release link (artist promo post)',
      `Follow https://open.spotify.com/artist/4tZwfgrHOc3mvqYlEYSvVi - new single https://open.spotify.com/track/${SP_T}`,
      { type: 'ref', ref: ref('sp', 'track', SP_T) },
    ],
    [
      'playlist link before an album link',
      `on my playlist https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M, album: https://music.apple.com/us/album/x/${AM_A}`,
      { type: 'ref', ref: ref('am', 'album', AM_A) },
    ],
    [
      'broken link, then the corrected one',
      `https://open.spotify.com/track/4uLU6hMCjMI75M1A2 oops https://open.spotify.com/track/${SP_T}`,
      { type: 'ref', ref: ref('sp', 'track', SP_T) },
    ],
    [
      'artist link before a short link',
      'https://open.spotify.com/artist/4tZwfgrHOc3mvqYlEYSvVi out now: https://spotify.link/Fq3JxY9ZbCb',
      { type: 'short', url: 'https://spotify.link/Fq3JxY9ZbCb' },
    ],
    [
      'tracker link before a wrapped song link',
      `https://t.co/AbC123 https://l.facebook.com/l.php?u=${encodeURIComponent(`https://youtu.be/${YT}`)}`,
      { type: 'ref', ref: ref('yt', 'track', YT) },
    ],
    [
      'fully encoded Apple song link',
      encodeURIComponent(`https://music.apple.com/us/album/get-lucky/${AM_A}?i=${AM_T}`),
      { type: 'ref', ref: ref('am', 'track', AM_T) },
    ],
  ])('%s', (_name, input, expected) => {
    expect(parseMusicUrl(input)).toEqual(expected);
  });

  it.each<[string, string]>([
    ['only an artist and a playlist: the first explains', `https://open.spotify.com/artist/4tZwfgrHOc3mvqYlEYSvVi https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M`],
    ['a non-music link, then a wrapped artist', `https://example.com/a https://l.facebook.com/l.php?u=${encodeURIComponent('https://open.spotify.com/artist/4tZwfgrHOc3mvqYlEYSvVi')}`],
  ])('%s', (_name, input) => {
    expect(parseMusicUrl(input)).toEqual({ type: 'error', error: PARSE_ERRORS.artist });
  });
});

type ParsedOk = { type: 'ref'; ref: SourceRef } | { type: 'short'; url: string };

describe('review: other official short-link domains', () => {
  it.each([
    ['https://apple.co/3AbCdEf', 'https://apple.co/3AbCdEf'],
    ['apple.co/3AbCdEf', 'https://apple.co/3AbCdEf'],
    ['Listen on Apple Music: https://apple.co/3AbCdEf', 'https://apple.co/3AbCdEf'],
    ['https://spoti.fi/3AbCdEf', 'https://spoti.fi/3AbCdEf'],
    ['out now spoti.fi/3AbCdEf', 'https://spoti.fi/3AbCdEf'],
  ])('%s', (input, url) => {
    expect(parseMusicUrl(input)).toEqual({ type: 'short', url });
  });

  it.each([
    ['https://apple.co/', 'am'],
    ['https://spoti.fi/', 'sp'],
  ] as const)('bare short-link host %s', (input, platform) => {
    expect(parseMusicUrl(input)).toEqual({ type: 'error', error: notItemError(platform) });
  });
});

describe('review: more real share URLs that must keep working', () => {
  it.each<[string, SourceRef]>([
    [`Https://Open.Spotify.com/track/${SP_T}`, ref('sp', 'track', SP_T)], // phone keyboard auto-capitalization
    [`Open.spotify.com/track/${SP_T}`, ref('sp', 'track', SP_T)],
    [`https://open.spotify.com/intl-ja/track/${SP_T}?si=x`, ref('sp', 'track', SP_T)],
    [`https://open.spotify.com/intl-zh-hant/album/${SP_A}`, ref('sp', 'album', SP_A)],
    [`https://open.spotify.com/track/${SP_T}?si=1&context=spotify%3Aplaylist%3A37i9dQZF1DXcBWIGoYBM5M`, ref('sp', 'track', SP_T)],
    [`https://open.spotify.com/track/${SP_T}?si=1&context=spotify:album:${SP_A}`, ref('sp', 'track', SP_T)],
    [`https://open.spotify.com/track/${SP_T}?si=1&nd=1&dlsi=2a3b`, ref('sp', 'track', SP_T)],
    [`Spotify:Track:${SP_T}`, ref('sp', 'track', SP_T)],
    ['https://music.apple.com/us/album/21/1544491232', ref('am', 'album', '1544491232')], // numeric slug
    ['https://music.apple.com/us/album/1989-taylors-version/1713845538?i=1713845545', ref('am', 'track', '1713845545')],
    [`HTTPS://MUSIC.APPLE.COM/US/ALBUM/X/${AM_A}?i=${AM_T}`, ref('am', 'track', AM_T)],
    [`https://music.apple.com/us/album/x/${AM_A}/`, ref('am', 'album', AM_A)],
    [`https://music.apple.com/us/album/x/${AM_A}?i=${AM_T}&l=es-MX`, ref('am', 'track', AM_T)],
    [`https://geo.music.apple.com/us/album/_/${AM_A}?i=${AM_T}&mt=1&app=music&ls=1&at=1000lHKX`, ref('am', 'track', AM_T)],
    [`https://itunes.apple.com/gb/album/x/${AM_A}?i=${AM_T}&uo=4`, ref('am', 'track', AM_T)], // no "id" prefix
    [`https://www.deezer.com/en/track/${DZ_T}/`, ref('dz', 'track', DZ_T)],
    [`https://m.deezer.com/track/${DZ_T}`, ref('dz', 'track', DZ_T)],
    [`https://www.deezer.com/track/${DZ_T}?utm_source=deezer&utm_content=track-${DZ_T}&utm_medium=web`, ref('dz', 'track', DZ_T)],
    [`https://youtube.com/watch?v=${YT}&feature=shared`, ref('yt', 'track', YT)],
    [`https://www.youtube.com/watch?app=desktop&v=${YT}`, ref('yt', 'track', YT)],
    [`https://music.youtube.com/watch?v=${YT}&list=OLAK5uy_kM2EJZVyLOFJ0ASdC5fIVoHz6h1C2AP_k`, ref('yt', 'track', YT)],
    [`https://youtu.be/${YT}/`, ref('yt', 'track', YT)],
    [`https://www.youtube.com/watch?v=${YT}#t=30`, ref('yt', 'track', YT)],
  ])('%s', (input, expected) => {
    expect(parseMusicUrl(input)).toEqual({ type: 'ref', ref: expected });
  });
});

describe('review: extractUrlFromPath does not claim ordinary asset or probe paths', () => {
  it.each([
    'index.html?utm_source=x',
    'robots.txt?v=2',
    'favicon.ico?v=3',
    'wp-login.php?redirect_to=x',
    'xmlrpc.php?rsd',
    '.well-known/security.txt',
  ])('%j -> null', (path) => {
    expect(extractUrlFromPath(path)).toBeNull();
  });

  it.each<[string, string]>([
    [`widget.deezer.com/widget/dark/track/${DZ_T}`, `https://widget.deezer.com/widget/dark/track/${DZ_T}`],
    ['apple.co/3AbCdEf', 'https://apple.co/3AbCdEf'],
    [`https:/music.apple.com/us/album/x/${AM_A}?i=${AM_T}`, `https://music.apple.com/us/album/x/${AM_A}?i=${AM_T}`],
  ])('%s', (path, expected) => {
    expect(extractUrlFromPath(path)).toBe(expected);
  });
});

function redirect(from: string, location: string, status = 307): HttpFixture {
  return { request: { url: from }, response: { status, headers: { location }, body: '' } };
}

function page(url: string, body: string, status = 200): HttpFixture {
  return { request: { url }, response: { status, headers: { 'content-type': 'text/html; charset=utf-8' }, body } };
}

describe('review: short-link resolution never invents an item', () => {
  it('does not take a track/album off an ordinary page a short link lands on', async () => {
    // A short link whose destination is a landing page (download, premium, ...) is not an interstitial;
    // the first album linked from that page is not what the user shared.
    const landing = `<html><head><title>Download Spotify</title></head><body><a href="https://open.spotify.com/album/${SP_A}">Featured</a></body></html>`;
    const ctx = fixtureCtx({
      extra: [
        redirect('https://spotify.link/Land1', 'https://www.spotify.com/us/download/'),
        page('https://www.spotify.com/us/download/', landing),
      ],
    });
    expect(await resolveShortLink(ctx, 'https://spotify.link/Land1')).toBeNull();
    expect(await parseInput(ctx, 'https://spotify.link/Land1')).toEqual({ ok: false, error: PARSE_ERRORS.shortLink });
  });

  it('still reads an interstitial served by the short-link host after an unknown hop', async () => {
    const html = `<html><head><meta property="og:url" content="https://open.spotify.com/track/${SP_T}?si=q"></head></html>`;
    const ctx = fixtureCtx({
      extra: [
        redirect('https://spotify.link/Inter1', 'https://tracker.example.net/c?id=1', 302),
        redirect('https://tracker.example.net/c?id=1', 'https://spotify.app.link/Inter1?_p=1', 302),
        page('https://spotify.app.link/Inter1?_p=1', html),
      ],
    });
    expect(await resolveShortLink(ctx, 'https://spotify.link/Inter1')).toBe(`https://open.spotify.com/track/${SP_T}?si=q`);
  });

  it("reads an interstitial served from Branch's alternate domain", async () => {
    const html = `<html><head><meta property="og:url" content="https://open.spotify.com/album/${SP_A}?si=a"></head></html>`;
    const ctx = fixtureCtx({
      extra: [
        redirect('https://spotify.link/Alt1', 'https://spotify-alternate.app.link/Alt1?__branch_flow_type=viewapp'),
        page('https://spotify-alternate.app.link/Alt1?__branch_flow_type=viewapp', html),
      ],
    });
    expect(await parseInput(ctx, 'https://spotify.link/Alt1')).toEqual({ ok: true, ref: ref('sp', 'album', SP_A) });
  });

  it('scans an interstitial with a long punctuation run in linear time', async () => {
    // A /[...]+$/ trim regex is quadratic here (seconds for 60K chars, about a minute at the 256K scan cap).
    const html = `<script>var a="https://open.spotify.com/x${'.'.repeat(60_000)}x";</script><meta property="og:url" content="https://open.spotify.com/track/${SP_T}">`;
    const ctx = fixtureCtx({ extra: [page('https://spotify.app.link/Slow1', html)] });
    const start = performance.now();
    expect(await resolveShortLink(ctx, 'https://spotify.app.link/Slow1')).toBe(`https://open.spotify.com/track/${SP_T}`);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('reads a target URL from HTML-escaped JSON in an interstitial', async () => {
    const html = `<div data-props="{&quot;url&quot;:&quot;https://open.spotify.com/album/${SP_A}&quot;}"></div>`;
    const ctx = fixtureCtx({ extra: [page('https://spotify.app.link/Json1', html)] });
    expect(await resolveShortLink(ctx, 'https://spotify.app.link/Json1')).toBe(`https://open.spotify.com/album/${SP_A}`);
  });

  // Hand-written: the sandbox proxy blocks apple.co and spoti.fi. Both answer a 301 to the long URL
  // (apple.co adds affiliate params; spoti.fi is a Bitly branded domain).
  it('resolves apple.co to an Apple Music song', async () => {
    const long = `https://music.apple.com/us/album/get-lucky/${AM_A}?i=${AM_T}&app=music&at=1000lHKX&ct=social&itscg=30200`;
    const ctx = fixtureCtx({ extra: [redirect('https://apple.co/3AbCdEf', long, 301)] });
    expect(await parseInput(ctx, 'https://apple.co/3AbCdEf')).toEqual({ ok: true, ref: ref('am', 'track', AM_T) });
  });

  it('resolves spoti.fi to a Spotify album', async () => {
    const ctx = fixtureCtx({ extra: [redirect('https://spoti.fi/3AbCdEf', `https://open.spotify.com/album/${SP_A}`, 301)] });
    expect(await parseInput(ctx, 'out now spoti.fi/3AbCdEf')).toEqual({ ok: true, ref: ref('sp', 'album', SP_A) });
  });

  it('reports a short-link error when apple.co leads outside Apple Music', async () => {
    const ctx = fixtureCtx({
      extra: [
        redirect('https://apple.co/3AppStore', 'https://apps.apple.com/us/app/apple-music/id1108187390', 301),
        page('https://apps.apple.com/us/app/apple-music/id1108187390', `<a href="https://open.spotify.com/track/${SP_T}">x</a>`),
      ],
    });
    expect(await parseInput(ctx, 'https://apple.co/3AppStore')).toEqual({ ok: false, error: PARSE_ERRORS.shortLink });
  });

  it('resolves a short link copied through Outlook Safe Links', async () => {
    const ctx = fixtureCtx({
      extra: [redirect('https://link.deezer.com/s/30Ab1Cd2Ef3Gh', `https://www.deezer.com/en/album/${DZ_A}?host=0`, 302)],
    });
    const input = `https://nam12.safelinks.protection.outlook.com/?url=${encodeURIComponent('https://link.deezer.com/s/30Ab1Cd2Ef3Gh')}&data=05`;
    expect(await parseInput(ctx, input)).toEqual({ ok: true, ref: ref('dz', 'album', DZ_A) });
  });
});
