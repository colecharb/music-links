// Turns whatever a user pastes (share links, URIs, links wrapped in text, short links) into a
// canonical SourceRef, and maps refs to route paths and cache keys.
import { fetchWithTimeout } from './http';
import type { UpstreamCtx } from './http';
import { CODE_BY_KIND, KIND_BY_CODE, PLATFORMS } from './types';
import type { Kind, KindCode, Platform, SourceRef } from './types';

export type ParsedInput =
  | { type: 'ref'; ref: SourceRef }
  | { type: 'short'; url: string } // short link that needs network resolution
  | { type: 'error'; error: string }; // short, clear, user-facing message

/** User-facing messages: plain ASCII, one line on a phone. */
export const PARSE_ERRORS = {
  notALink: "That doesn't look like a link.",
  unsupportedHost: 'Unsupported link. Paste a Spotify, Apple Music, Deezer or YouTube link to a song or album.',
  playlist: "Playlists aren't supported - paste a song or album link.",
  artist: "Artist pages aren't supported - paste a song or album link.",
  podcast: "Podcasts aren't supported - paste a song or album link.",
  audiobook: "Audiobooks aren't supported - paste a song or album link.",
  musicVideo: "Music videos aren't supported - paste a song or album link.",
  ytMusicCollection: "YouTube Music albums and playlists aren't supported - paste a song link.",
  shortLink: "Couldn't open that short link. Try the full link instead.",
} as const;

export const PLATFORM_NAMES: Record<Platform, string> = {
  sp: 'Spotify',
  am: 'Apple Music',
  dz: 'Deezer',
  yt: 'YouTube',
};

/** Known host, but the page is not a song/album (home page, search, profile, broken short link...). */
export function notItemError(platform: Platform): string {
  return platform === 'yt' ? "That YouTube link isn't a song." : `That ${PLATFORM_NAMES[platform]} link isn't a song or album.`;
}

export function invalidIdError(platform: Platform): string {
  return `That ${PLATFORM_NAMES[platform]} link looks broken - check it and try again.`;
}

/** Spotify ids are base62, always 22 chars. */
export const SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;
/** Apple and Deezer ids are positive integers; no leading zero so each item has exactly one cache key. */
export const NUMERIC_ID_RE = /^[1-9][0-9]{0,19}$/;
export const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

const ID_RE: Record<Platform, RegExp> = { sp: SPOTIFY_ID_RE, am: NUMERIC_ID_RE, dz: NUMERIC_ID_RE, yt: YOUTUBE_ID_RE };

export const MAX_SHORT_LINK_HOPS = 5;
/** Only the first URL matters; bounds regex work on huge pastes. */
export const MAX_INPUT_LENGTH = 4096;
/** Branch interstitial pages put the target URL in <head>; no need to scan megabytes. */
export const MAX_HTML_SCAN_CHARS = 256 * 1024;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// ---------------------------------------------------------------------------------------------
// Internal parse result: errors carry a reason so short-link resolution can tell "a known service
// answered with something that's not a song" from "this isn't a music link at all".

type ErrorReason =
  | 'not-a-link' // empty or garbage
  | 'unknown-host'
  | 'not-item' // known service, but not a song/album page
  | 'unsupported' // playlist, artist, podcast...: a real item we deliberately don't handle
  | 'invalid-id';

type Parsed =
  | { type: 'ref'; ref: SourceRef }
  | { type: 'short'; url: string }
  | { type: 'error'; error: string; reason: ErrorReason };

function fail(reason: ErrorReason, error: string): Parsed {
  return { type: 'error', error, reason };
}

function unsupported(error: string): Parsed {
  return fail('unsupported', error);
}

function notItem(platform: Platform): Parsed {
  return fail('not-item', notItemError(platform));
}

function toRef(platform: Platform, kind: Kind, id: string): Parsed {
  if (!id) return notItem(platform);
  if (!ID_RE[platform].test(id)) return fail('invalid-id', invalidIdError(platform));
  return { type: 'ref', ref: { platform, kind, id } };
}

// ---------------------------------------------------------------------------------------------
// Spotify

const SPOTIFY_PREFIX_SEGMENT_RE = /^(?:intl-[a-z0-9_-]+|embed(?:-podcast)?)$/i;

/** `parts` is ["track", id], ["album", id], ["user", name, "playlist", id], ... (URL path or URI). */
function spotifyItem(parts: string[]): Parsed {
  const [type = '', id = ''] = parts;
  switch (type.toLowerCase()) {
    case 'track':
      return toRef('sp', 'track', id);
    case 'album':
      return toRef('sp', 'album', id);
    case 'playlist':
      return unsupported(PARSE_ERRORS.playlist);
    case 'user':
      return parts.some((p) => p.toLowerCase() === 'playlist') ? unsupported(PARSE_ERRORS.playlist) : notItem('sp');
    case 'artist':
      return unsupported(PARSE_ERRORS.artist);
    case 'episode':
    case 'show':
      return unsupported(PARSE_ERRORS.podcast);
    case 'audiobook':
    case 'chapter':
      return unsupported(PARSE_ERRORS.audiobook);
    default:
      return notItem('sp');
  }
}

function parseSpotifyUrl(_url: URL, segs: string[]): Parsed {
  let i = 0;
  while (i < segs.length && SPOTIFY_PREFIX_SEGMENT_RE.test(segs[i] ?? '')) i++;
  return spotifyItem(segs.slice(i));
}

/** spotify:track:<id>, spotify:user:<name>:playlist:<id> */
function parseSpotifyUri(uri: string): Parsed {
  const body = uri.slice('spotify:'.length).split(/[?#]/)[0] ?? '';
  return spotifyItem(body.split(':'));
}

// ---------------------------------------------------------------------------------------------
// Apple Music (music.apple.com and legacy itunes.apple.com)

const APPLE_STOREFRONT_RE = /^[a-z]{2}$/i;
/** Legacy iTunes links prefix numeric ids with "id". */
const APPLE_ID_SEGMENT_RE = /^id([0-9]+)$/i;

function appleId(segment: string | undefined): string {
  const s = segment ?? '';
  return APPLE_ID_SEGMENT_RE.exec(s)?.[1] ?? s;
}

function parseAppleUrl(url: URL, segs: string[]): Parsed {
  const parts = segs[0] !== undefined && APPLE_STOREFRONT_RE.test(segs[0]) ? segs.slice(1) : segs;
  const [type = '', ...rest] = parts;
  switch (type.toLowerCase()) {
    case 'album': {
      // An album link with ?i= is how Apple shares a song.
      const trackId = url.searchParams.get('i');
      if (trackId) return toRef('am', 'track', trackId);
      return toRef('am', 'album', appleId(rest.at(-1)));
    }
    case 'song':
      return toRef('am', 'track', appleId(rest.at(-1)));
    case 'playlist':
      return unsupported(PARSE_ERRORS.playlist);
    case 'artist':
      return unsupported(PARSE_ERRORS.artist);
    case 'music-video':
      return unsupported(PARSE_ERRORS.musicVideo);
    case 'podcast':
      return unsupported(PARSE_ERRORS.podcast);
    default:
      return notItem('am');
  }
}

// ---------------------------------------------------------------------------------------------
// Deezer

const DEEZER_LANG_RE = /^[a-z]{2}(?:-[a-z]{2})?$/i;

function parseDeezerUrl(_url: URL, segs: string[]): Parsed {
  return deezerItem(segs[0] !== undefined && DEEZER_LANG_RE.test(segs[0]) ? segs.slice(1) : segs);
}

/** Embed player (the iframe "Share > Embed" gives): widget.deezer.com/widget/<theme>/<type>/<id>. */
function parseDeezerWidget(_url: URL, segs: string[]): Parsed {
  if (segs[0]?.toLowerCase() !== 'widget') return notItem('dz');
  return deezerItem(segs.slice(segs.length > 3 ? 2 : 1));
}

/** `parts` is [type, id]. */
function deezerItem(parts: string[]): Parsed {
  const [type = '', id = ''] = parts;
  switch (type.toLowerCase()) {
    case 'track':
      return toRef('dz', 'track', id);
    case 'album':
      return toRef('dz', 'album', id);
    case 'playlist':
      return unsupported(PARSE_ERRORS.playlist);
    case 'artist':
      return unsupported(PARSE_ERRORS.artist);
    case 'show':
    case 'episode':
    case 'podcast':
      return unsupported(PARSE_ERRORS.podcast);
    default:
      return notItem('dz');
  }
}

// ---------------------------------------------------------------------------------------------
// YouTube (videos only: a YouTube Music "album" is a playlist without a stable album identity)

/** Auto-generated YouTube Music album playlists start with this. */
export const YT_ALBUM_LIST_PREFIX = 'OLAK5uy_';

function parseYouTubeUrl(url: URL, segs: string[], host: string): Parsed {
  const isMusic = host === 'music.youtube.com';
  const [first = '', second = ''] = segs;
  switch (first.toLowerCase()) {
    case 'watch':
      return toRef('yt', 'track', url.searchParams.get('v') ?? '');
    case 'embed':
      return second.toLowerCase() === 'videoseries' ? unsupported(PARSE_ERRORS.playlist) : toRef('yt', 'track', second);
    case 'v':
      return toRef('yt', 'track', second);
    case 'playlist': {
      const list = url.searchParams.get('list') ?? '';
      return unsupported(isMusic || list.startsWith(YT_ALBUM_LIST_PREFIX) ? PARSE_ERRORS.ytMusicCollection : PARSE_ERRORS.playlist);
    }
    case 'browse':
      return isMusic ? unsupported(PARSE_ERRORS.ytMusicCollection) : notItem('yt');
    case 'channel':
    case 'c':
    case 'user':
      return unsupported(PARSE_ERRORS.artist);
    default:
      return first.startsWith('@') ? unsupported(PARSE_ERRORS.artist) : notItem('yt');
  }
}

function parseYoutuBe(_url: URL, segs: string[]): Parsed {
  // Some apps append "&feature=share" without a "?".
  return toRef('yt', 'track', (segs[0] ?? '').split('&')[0] ?? '');
}

// ---------------------------------------------------------------------------------------------
// Short links (resolved over the network)

function shortLink(platform: Platform): HostHandler {
  return (url, segs) => {
    if (segs.length === 0) return notItem(platform);
    const u = new URL(url);
    u.protocol = 'https:';
    u.hash = '';
    return { type: 'short', url: u.toString() };
  };
}

// ---------------------------------------------------------------------------------------------
// Host table. Hosts are matched after lowercasing and dropping one "www." or "m." prefix.

type HostHandler = (url: URL, segs: string[], host: string) => Parsed;

/**
 * Official short-link domains: spotify.link and spotify.app.link (Branch, which also serves pages from
 * "<app>-alternate.app.link"), spoti.fi (Spotify's Bitly domain, used in artist posts), apple.co (Apple's
 * shortener), deezer.page.link and link.deezer.com. Only these hosts' own 200 pages are scanned for the target.
 */
const SHORT_LINK_HOSTS: Record<string, Platform> = {
  'spotify.link': 'sp',
  'spotify.app.link': 'sp',
  'spotify-alternate.app.link': 'sp',
  'spoti.fi': 'sp',
  'apple.co': 'am',
  'deezer.page.link': 'dz',
  'link.deezer.com': 'dz',
};

const HOSTS: Record<string, HostHandler> = {
  ...Object.fromEntries(Object.entries(SHORT_LINK_HOSTS).map(([host, platform]) => [host, shortLink(platform)])),
  'open.spotify.com': parseSpotifyUrl,
  'play.spotify.com': parseSpotifyUrl,
  'music.apple.com': parseAppleUrl,
  'geo.music.apple.com': parseAppleUrl,
  'embed.music.apple.com': parseAppleUrl,
  'itunes.apple.com': parseAppleUrl,
  'geo.itunes.apple.com': parseAppleUrl,
  'podcasts.apple.com': () => unsupported(PARSE_ERRORS.podcast),
  'deezer.com': parseDeezerUrl,
  'widget.deezer.com': parseDeezerWidget,
  'youtube.com': parseYouTubeUrl,
  'music.youtube.com': parseYouTubeUrl,
  'youtube-nocookie.com': parseYouTubeUrl,
  'youtu.be': parseYoutuBe,
};

function normalizeHost(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^(?:www|m)\./, '');
}

function isKnownHost(hostname: string): boolean {
  return Object.hasOwn(HOSTS, normalizeHost(hostname));
}

function isShortLinkUrl(url: string): boolean {
  try {
    return Object.hasOwn(SHORT_LINK_HOSTS, normalizeHost(new URL(url).hostname));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Input normalization

const WRAPPERS: readonly (readonly [string, string])[] = [
  ['<', '>'],
  ['"', '"'],
  ["'", "'"],
  ['`', '`'],
  ['“', '”'],
  ['‘', '’'],
  ['(', ')'],
  ['[', ']'],
];

function unwrap(input: string): string {
  let s = input.trim();
  for (let changed = true; changed && s.length >= 2; ) {
    changed = false;
    for (const [open, close] of WRAPPERS) {
      if (s.startsWith(open) && s.endsWith(close)) {
        s = s.slice(open.length, -close.length).trim();
        changed = true;
        break;
      }
    }
  }
  return s;
}

/**
 * Decode once when the URL itself is percent-encoded ("https%3A%2F%2F...", "open.spotify.com%2Ftrack").
 * A normal URL with encoded parts (an Apple slug, a nested query value) has a literal "/" first.
 */
function decodeIfEncoded(s: string): string {
  const encoded = s.search(/%2F|%3A/i);
  if (encoded < 0) return s;
  const slash = s.indexOf('/');
  if (slash >= 0 && slash < encoded) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Invisible format characters (zero-width space/joiners, bidi marks, word joiner, soft hyphen) that chat
 * apps and RTL text put next to links. They are never part of a URL, so they end one.
 */
const FORMAT_CHARS = String.raw`\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff`;
/** "[" and "]" are not allowed outside IPv6 hosts; excluding them splits markdown "[url](url)". */
const URL_CHARS = String.raw`[^\s<>"'\x60\[\]${FORMAT_CHARS}]`;
/** http(s) with any number of slashes (proxies collapse "//"), or a Spotify URI. */
const SCHEME_URL_RE = new RegExp(String.raw`(?:https?:/*|spotify:[a-z]+:)${URL_CHARS}+`, 'gi');
/**
 * Scheme-less "host.tld/path" at the start of the text, after a space/bracket/quote, or right after
 * non-ASCII text (CJK has no spaces; emoji are often glued to links).
 */
const BARE_URL_RE = new RegExp(
  String.raw`(?:^|[\s(<\[{"'\x60]|[^\x00-\x7f])((?:[a-z0-9-]+\.)+[a-z]{2,}\.?(?::[0-9]+)?(?:[/?#]${URL_CHARS}*)?)`,
  'gi',
);
/** ASCII punctuation that ends a sentence (or markdown emphasis) rather than the URL before it. */
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', '>', "'", '"', '`', '*']);
/** HTML-escaped "&" from links copied out of page source or embed codes ("?l=en&amp;i=123"). */
const HTML_AMP_RE = /&amp;/gi;

/**
 * Drops trailing punctuation and any non-ASCII tail: every link we accept ends in an ASCII id, code or
 * query value, so a non-ASCII tail ("。", "」", "»", emoji, glued CJK words) is text written right after
 * the link. A scan from the end, because a /[...]+$/ regex is quadratic on long punctuation runs.
 */
function trimTrailing(s: string): string {
  let end = s.length;
  while (end > 0) {
    const c = s.charAt(end - 1);
    if (c.charCodeAt(0) < 0x80 && !TRAILING_PUNCTUATION.has(c)) break;
    end--;
  }
  return s.slice(0, end);
}

/** "https:/x", "HTTPS:///x" -> "https://x"; bare hosts get https. */
function withHttpScheme(s: string): string {
  const m = /^(https?):\/*/i.exec(s);
  if (m) return `${(m[1] ?? 'https').toLowerCase()}://${s.slice(m[0].length)}`;
  return `https://${s}`;
}

function isMusicCandidate(candidate: string): boolean {
  if (/^spotify:/i.test(candidate)) return true;
  try {
    return isKnownHost(new URL(withHttpScheme(candidate)).hostname);
  } catch {
    return false;
  }
}

/**
 * The URLs in a pasted text, best first: links on a music service (so a tracker link before them doesn't
 * win), then other links with a scheme, then bare "host.tld/path". A bare "word.word" is prose.
 */
function findUrlCandidates(text: string): string[] {
  const schemed = Array.from(text.matchAll(SCHEME_URL_RE), (m) => trimTrailing(m[0]));
  const bare = Array.from(text.matchAll(BARE_URL_RE), (m) => trimTrailing(m[1] ?? ''));
  return [
    ...schemed.filter(isMusicCandidate),
    ...bare.filter(isMusicCandidate),
    ...schemed.filter((c) => !isMusicCandidate(c)),
    ...bare.filter((c) => !isMusicCandidate(c) && /[/?#]/.test(c)),
  ];
}

function parseDetailed(input: string): Parsed {
  const text = decodeIfEncoded(unwrap(input.slice(0, MAX_INPUT_LENGTH))).replace(HTML_AMP_RE, '&');
  const results = findUrlCandidates(text).map((c) => parseCandidate(c, true));
  // A song/album (or short) link wins over an artist, playlist or broken link pasted before it; with no
  // item at all, explain the most specific problem.
  return (
    results.find((r) => r.type !== 'error') ??
    results.find(isSettled) ??
    results[0] ??
    fail('not-a-link', PARSE_ERRORS.notALink)
  );
}

/** One URL or Spotify URI. `unwrapRedirects`: look inside redirector links (one level only). */
function parseCandidate(candidate: string, unwrapRedirects: boolean): Parsed {
  if (/^spotify:/i.test(candidate)) return parseSpotifyUri(candidate);

  let url: URL;
  try {
    url = new URL(withHttpScheme(candidate));
  } catch {
    return fail('not-a-link', PARSE_ERRORS.notALink);
  }
  const host = normalizeHost(url.hostname);
  if (!host.includes('.')) return fail('not-a-link', PARSE_ERRORS.notALink);
  const handler = HOSTS[host];
  const result = handler ? handler(url, url.pathname.split('/').filter(Boolean), host) : fail('unknown-host', PARSE_ERRORS.unsupportedHost);
  if (unwrapRedirects && result.type === 'error' && (result.reason === 'unknown-host' || result.reason === 'not-item')) {
    return embeddedLink(url) ?? result;
  }
  return result;
}

const EMBEDDED_LINK_RE = /^\s*(?:https?:|spotify:)/i;

/**
 * Redirectors carry the real link in a query value: Outlook Safe Links (?url=), l.facebook.com (?u=),
 * google.com/url (?q=/?url=), youtube.com/redirect (?q=). Only consulted when the outer URL is not an
 * item itself, so tracking params on a real song link are never followed.
 */
function embeddedLink(url: URL): Parsed | null {
  for (const value of url.searchParams.values()) {
    if (!EMBEDDED_LINK_RE.test(value)) continue;
    const p = parseCandidate(value.trim(), false);
    if (p.type !== 'error' || isSettled(p)) return p;
  }
  return null;
}

function publicResult(p: Parsed): ParsedInput {
  return p.type === 'error' ? { type: 'error', error: p.error } : p;
}

// ---------------------------------------------------------------------------------------------
// Public API

export function parseMusicUrl(input: string): ParsedInput {
  return publicResult(parseDetailed(input));
}

/** A hop is final once it lands on a music service page (song/album or a page we can explain). */
function isSettled(p: Parsed): boolean {
  return p.type === 'ref' || (p.type === 'error' && p.reason !== 'not-a-link' && p.reason !== 'unknown-host');
}

function resolveLocation(location: string | null, base: string): string | null {
  if (!location) return null;
  try {
    return new URL(location, base).toString();
  } catch {
    return null;
  }
}

/** Long service URLs, also inside JS strings ("https:\/\/open.spotify.com\/track\/..."). */
const HTML_LONG_URL_RE = /https?:\/\/(?:open\.spotify\.com|(?:www\.)?deezer\.com)\/[^\s"'<>\\]+/gi;

/**
 * Interstitial pages (Branch sometimes answers 200 instead of redirecting) carry the target in og:url,
 * a meta refresh or JS. Take the first long URL that is an item; that skips generic links like the
 * home page, while a playlist's og:url still wins over track links further down its page.
 */
function findLongUrlInHtml(html: string): string | null {
  const text = html
    .slice(0, MAX_HTML_SCAN_CHARS)
    .replace(/\\\//g, '/')
    .replace(/\\u002f/gi, '/')
    .replace(/&#x2f;|&#47;/gi, '/')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(HTML_AMP_RE, '&');
  for (const m of text.matchAll(HTML_LONG_URL_RE)) {
    const candidate = trimTrailing(m[0]);
    const p = parseDetailed(candidate);
    if (p.type === 'ref' || (p.type === 'error' && p.reason === 'unsupported')) return candidate;
  }
  return null;
}

/**
 * Follows a short link's redirects by hand (up to MAX_SHORT_LINK_HOPS) and returns the long URL, or null
 * if it can't be resolved (network error, 4xx/5xx, loop, too many hops, nothing usable in the page).
 */
export async function resolveShortLink(ctx: UpstreamCtx, url: string): Promise<string | null> {
  const seen = new Set<string>();
  let current = url;
  try {
    for (let hop = 0; hop < MAX_SHORT_LINK_HOPS; hop++) {
      if (seen.has(current)) return null;
      seen.add(current);
      const res = await fetchWithTimeout(ctx, current, { redirect: 'manual' });
      if (REDIRECT_STATUSES.has(res.status)) {
        await res.body?.cancel();
        const next = resolveLocation(res.headers.get('location'), current);
        if (next === null) return null;
        if (isSettled(parseDetailed(next))) return next;
        if (!/^https?:$/.test(new URL(next).protocol)) return null;
        current = next;
        continue;
      }
      // Only a short-link service's own interstitial names the target. Any other page a chain lands on
      // (download/premium/app store) may link to unrelated tracks, which must never be taken as the answer.
      if (res.ok && isShortLinkUrl(current)) return findLongUrlInHtml(await res.text());
      await res.body?.cancel();
      return null;
    }
  } catch {
    // UpstreamError (network/timeout) or a body read failure: the caller shows a short-link error.
    return null;
  }
  return null;
}

export async function parseInput(
  ctx: UpstreamCtx,
  input: string,
): Promise<{ ok: true; ref: SourceRef } | { ok: false; error: string }> {
  const first = parseDetailed(input);
  if (first.type === 'ref') return { ok: true, ref: first.ref };
  if (first.type === 'error') return { ok: false, error: first.error };

  const long = await resolveShortLink(ctx, first.url);
  const resolved = long === null ? null : parseDetailed(long);
  if (resolved?.type === 'ref') return { ok: true, ref: resolved.ref };
  // Playlists etc. keep their specific message; a redirect to a home or 404 page means a dead code.
  if (resolved?.type === 'error' && (resolved.reason === 'unsupported' || resolved.reason === 'invalid-id')) {
    return { ok: false, error: resolved.error };
  }
  return { ok: false, error: PARSE_ERRORS.shortLink };
}

/** "/sp/t/<id>" */
export function canonicalPath(ref: SourceRef): string {
  return `/${ref.platform}/${CODE_BY_KIND[ref.kind]}/${ref.id}`;
}

/** "sp:t:<id>" */
export function cacheKey(ref: SourceRef): string {
  return `${ref.platform}:${CODE_BY_KIND[ref.kind]}:${ref.id}`;
}

function isPlatform(s: string): s is Platform {
  return (PLATFORMS as readonly string[]).includes(s);
}

function isKindCode(s: string): s is KindCode {
  return Object.hasOwn(KIND_BY_CODE, s);
}

/** Validates /:p/:k/:id route params; null lets the route fall through. */
export function refFromParams(p: string, k: string, id: string): SourceRef | null {
  if (!isPlatform(p) || !isKindCode(k)) return null;
  if (p === 'yt' && k !== 't') return null;
  if (!ID_RE[p].test(id)) return null;
  return { platform: p, kind: KIND_BY_CODE[k], id };
}

/**
 * Scheme-less "host.tld/..." as the first path segment. "favicon.ico", "assets/x.js" and
 * "index.html?v=2" are not URLs: every link we accept has a path after the host.
 */
const BARE_PATH_URL_RE = /^(?:[a-z0-9-]+\.)+[a-z]{2,}\.?(?::[0-9]+)?\//i;

/**
 * Prefix trick: "<our host>/https://open.spotify.com/track/X" works as a link. `pathAndQuery` is the
 * request path + query without the leading "/"; the query belongs to the embedded URL.
 */
export function extractUrlFromPath(pathAndQuery: string): string | null {
  const s = decodeIfEncoded(pathAndQuery.replace(/^\/+/, '').trim());
  if (!s) return null;
  if (/^https?:/i.test(s)) return withHttpScheme(s);
  if (/^spotify:[a-z]+:/i.test(s)) return s;
  if (BARE_PATH_URL_RE.test(s)) return `https://${s}`;
  return null;
}
