// YouTube: video metadata from oEmbed (no API key). oEmbed gives only the video title and channel name,
// so artist and title are inferred from upload conventions ("Artist - Title (Official Video)", "- Topic"
// auto-generated channels, VEVO channels). No duration is available.

import type { UpstreamCtx } from '../http';
import { getJson, UpstreamError } from '../http';
import type { SearchQuery, TrackMeta } from '../types';

export const YOUTUBE_OEMBED = 'https://www.youtube.com/oembed';
export const YOUTUBE_MUSIC = 'https://music.youtube.com';

interface OEmbed {
  title?: unknown;
  author_name?: unknown;
  thumbnail_url?: unknown;
}

export function youtubeMusicUrl(id: string): string {
  return `${YOUTUBE_MUSIC}/watch?v=${encodeURIComponent(id)}`;
}

export function youtubeMusicSearchUrl(q: SearchQuery): string {
  return `${YOUTUBE_MUSIC}/search?q=${encodeURIComponent(searchText(q))}`;
}

export function youtubeOEmbedUrl(id: string): string {
  const video = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
  return `${YOUTUBE_OEMBED}?url=${encodeURIComponent(video)}&format=json`;
}

export async function getYouTubeItem(ctx: UpstreamCtx, id: string): Promise<TrackMeta> {
  const data = await getJson<OEmbed>(ctx, youtubeOEmbedUrl(id)).catch((err: unknown) => {
    // oEmbed answers 400 for ids that don't exist, 404 for removed videos and 401/403 for private or
    // non-embeddable ones. All are permanent: report them as not found rather than as an outage.
    if (err instanceof UpstreamError && (err.status === 400 || err.status === 401 || err.status === 403)) {
      throw new UpstreamError(`www.youtube.com: video ${id} unavailable (HTTP ${err.status})`, 404);
    }
    throw err;
  });
  const rawTitle = typeof data?.title === 'string' ? data.title.trim() : '';
  if (!rawTitle) throw new UpstreamError(`www.youtube.com: oEmbed without title for ${id}`);
  const author = typeof data.author_name === 'string' ? data.author_name : '';
  const { title, artist, artists } = parseYouTubeTitle(rawTitle, author);
  const art = typeof data.thumbnail_url === 'string' && data.thumbnail_url ? data.thumbnail_url : undefined;
  return { kind: 'track', id, url: youtubeMusicUrl(id), title, artists, artist, ...(art ? { art } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Title parsing

/** Auto-generated "art track" channels: the title is the official track title. */
export const TOPIC_SUFFIX = /\s+-\s+Topic$/i;

/** "Artist - Title" separators; the first one in the title wins. */
export const TITLE_SEPARATOR = /\s+[-–—|]\s+/;

/**
 * Channel-name suffixes that aren't part of the artist name ("TaylorSwiftVEVO", "Rick Astley Official",
 * "ImagineDragonsOfficial"). An attached "Official" must start a new word, so "...Unofficial" is kept.
 */
export const CHANNEL_SUFFIX = /\s*(?:VEVO|Vevo|vevo)$|\s+(?:Official|OFFICIAL|official)$|(?<=[\p{Ll}\d])(?:Official|OFFICIAL)$/u;

/** Joiners between several artists in an "Artist" string. Only lowercase " x " (uppercase X ends names like "Lil Nas X"). */
export const ARTIST_JOINERS = /\s*,\s+|\s+&\s+|\s+[x×]\s+|\s+(?:[Ff]eat|FEAT|[Ff]t|FT|[Ff]eaturing|FEATURING)\.?\s+/;

const VIDEO_KIND = String.raw`music\s+video|lyrics?\s+video|video\s*clip|video|audio|visuali[sz]er|(?:with\s+)?lyrics?|m\/?v`;
const QUALITY = String.raw`hd|hq|4k|8k`;

/**
 * Video-only annotations, matched against a whole bracket group or title tail:
 * "Official Video", "Official 4K Video", "Lyric Video", "Lyrics", "Audio", "HD", "4K Remaster", "Remastered in 4K", "M/V".
 * Version markers (Live, Remix, Acoustic, feat., Radio Edit, ...) never match.
 */
export const VIDEO_NOISE = new RegExp(
  String.raw`^(?:(?:official\s+)?(?:(?:${QUALITY})\s+)?(?:${VIDEO_KIND})(?:\s+(?:${QUALITY}))?` +
    String.raw`|(?:${QUALITY})(?:\s+(?:remaster(?:ed)?|version|upgrade))?` +
    String.raw`|remastered\s+in\s+(?:${QUALITY})|official)$`,
  'i',
);

/** Noise words that are also plausible real title endings, so only stripped inside brackets. */
const WEAK_NOISE = /^(?:video|audio|lyrics?|official)$/i;

/** K-pop convention: "BTS (방탄소년단) 'Dynamite' Official MV", "BLACKPINK - '뚜두뚜두' M/V". */
const MV_MARKER = /\bM\/?V\b/i;
const QUOTED_TAIL = /^(.+?)\s+(?:'([^']+)'|‘([^’]+)’|"([^"]+)"|“([^”]+)”)$/;
const QUOTED_WHOLE = /^(?:'([^']+)'|‘([^’]+)’|"([^"]+)"|“([^”]+)”)$/;

export function parseYouTubeTitle(title: string, author: string): { title: string; artist: string; artists: string[] } {
  const channel = author.trim();
  if (TOPIC_SUFFIX.test(channel)) {
    // A Topic channel is a single artist entity, even when its name contains "&" or ",".
    const artist = channel.replace(TOPIC_SUFFIX, '');
    return { title: title.trim(), artist, artists: artist ? [artist] : [] };
  }

  const cleaned = stripVideoNoise(title) || collapse(title);
  const kpop = MV_MARKER.test(title);
  let artist: string;
  let song: string;

  const sep = TITLE_SEPARATOR.exec(cleaned);
  const left = sep ? cleaned.slice(0, sep.index).trim() : '';
  const right = sep ? cleaned.slice(sep.index + sep[0].length).trim() : '';
  const channelArtist = cleanChannelName(channel);
  if (left && right) {
    // "Title - Artist" uploads: trust the channel when it names the right-hand side only.
    const swapped = same(channelArtist, right) && !same(channelArtist, left);
    [artist, song] = swapped ? [right, left] : [left, right];
  } else {
    const quoted = kpop ? QUOTED_TAIL.exec(cleaned) : null;
    if (quoted) {
      artist = quoted[1] ?? '';
      song = firstGroup(quoted, 2) ?? cleaned;
    } else {
      artist = channelArtist;
      song = cleaned;
    }
  }

  if (kpop) {
    const whole = QUOTED_WHOLE.exec(song);
    if (whole) song = firstGroup(whole, 1) ?? song;
  }
  return { title: song, artist, artists: splitArtists(artist) };
}

/** Remove video-only annotations in brackets and at the end of the title. */
export function stripVideoNoise(title: string): string {
  let t = collapse(title.replace(/\(([^()]*)\)|\[([^[\]]*)\]/g, (m, a?: string, b?: string) => (VIDEO_NOISE.test((a ?? b ?? '').trim()) ? ' ' : m)));
  for (let prev = ''; prev !== t; ) {
    prev = t;
    t = dropNoiseTail(t);
  }
  return t.replace(/\s+[-–—|]$/, '').trim();
}

/** Cut the longest trailing segment ("| Official Video", "- Official Audio", " Official MV", " HD") that is noise. */
function dropNoiseTail(t: string): string {
  for (const m of t.matchAll(/\s*[-–—|]\s+|\s+/g)) {
    const tail = t.slice(m.index + m[0].length).trim();
    if (m.index > 0 && VIDEO_NOISE.test(tail) && !WEAK_NOISE.test(tail)) return t.slice(0, m.index).trim();
  }
  return t;
}

/** "TaylorSwiftVEVO" -> "Taylor Swift", "Rick Astley Official" -> "Rick Astley"; other names unchanged. */
export function cleanChannelName(author: string): string {
  const name = author.trim().replace(TOPIC_SUFFIX, '');
  const stripped = name.replace(CHANNEL_SUFFIX, '');
  if (!stripped || stripped === name) return name;
  // Suffixed channel names are usually written without spaces.
  return /\s/.test(stripped) ? stripped : stripped.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2');
}

/** "A x B", "A & B", "A, B", "A feat. B" -> individual names (the caller keeps the full string too). */
export function splitArtists(artist: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of artist.split(ARTIST_JOINERS)) {
    const name = piece.trim();
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.push(name);
    }
  }
  return out;
}

function firstGroup(m: RegExpExecArray, from: number): string | undefined {
  for (let i = from; i < m.length; i++) if (m[i]) return m[i];
  return undefined;
}

function same(a: string, b: string): boolean {
  return !!a && a.localeCompare(b, undefined, { sensitivity: 'base' }) === 0;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function searchText(q: SearchQuery): string {
  return [q.title, q.artist].map((s) => s.trim()).filter(Boolean).join(' ');
}
