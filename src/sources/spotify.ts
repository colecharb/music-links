// Spotify: metadata from the public web page (no Web API). Meta tags are always read; the embedded
// base64 `initialState` JSON, when present and parseable, refines them (separate artist names, exact
// duration, explicit flag, album type, track count).

import type { UpstreamCtx } from '../http';
import { fetchWithTimeout, UpstreamError } from '../http';
import type { AlbumMeta, AlbumType, ItemMeta, Kind, SearchQuery, TrackMeta } from '../types';

export const SPOTIFY_WEB = 'https://open.spotify.com';
const HOST = 'open.spotify.com';

/** og:type a page must carry to be the requested kind. */
export const OG_TYPE_BY_KIND: Record<Kind, string> = { track: 'music.song', album: 'music.album' };

/** music:duration is whole seconds; the embedded state has milliseconds. */
export const META_DURATION_PRECISION_MS = 1000;
export const STATE_DURATION_PRECISION_MS = 1;

/** Separator in og:description, e.g. "Khaled · Sahra · Song · 1996" or "Khaled · album · 1996 · 15 songs". */
export const DESCRIPTION_SEPARATOR = ' · ';

/** Spotify's joiner for several artists in music:musician_description and og:description. */
export const ARTIST_SEPARATOR = ', ';

const ALBUM_TYPES: Record<string, AlbumType> = {
  album: 'album',
  single: 'single',
  ep: 'ep',
  compilation: 'compilation',
};

/** Album og:title, e.g. "Listen to Sahra - Album by Khaled | Spotify" (greedy title: the last " - X by " wins). */
const ALBUM_OG_TITLE = /^Listen to (.+) - \p{L}+ by (.+) \| Spotify$/u;
const TRACK_COUNT = /^(\d+) songs?$/i;
const YEAR = /^\d{4}$/;
const ISO_DATE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;

export function spotifyUrl(kind: Kind, id: string): string {
  return `${SPOTIFY_WEB}/${kind}/${encodeURIComponent(id)}`;
}

export function spotifySearchUrl(q: SearchQuery): string {
  return `${SPOTIFY_WEB}/search/${encodeURIComponent(searchText(q))}`;
}

export async function getSpotifyItem(ctx: UpstreamCtx, kind: Kind, id: string): Promise<ItemMeta> {
  const res = await fetchWithTimeout(ctx, spotifyUrl(kind, id));
  if (!res.ok) {
    await res.body?.cancel();
    throw new UpstreamError(`${HOST}: HTTP ${res.status}`, res.status);
  }
  return parseSpotifyPage(res, kind, id);
}

/** Parse a fetched open.spotify.com page. Throws UpstreamError 404 when it is not a `kind` page. */
export async function parseSpotifyPage(res: Response, kind: Kind, id: string): Promise<ItemMeta> {
  // The fetch timeout also covers streaming the body, so a stalled page fails here.
  const page = await scrapePage(res).catch((err: unknown) => {
    throw new UpstreamError(`${HOST}: page read failed (${err instanceof Error ? err.name : String(err)})`);
  });
  const title = firstMeta(page.meta, 'og:title');
  if (!title || firstMeta(page.meta, 'og:type') !== OG_TYPE_BY_KIND[kind]) {
    throw new UpstreamError(`${HOST}: no ${kind} ${id}`, 404);
  }
  const entity = at(decodeState(page.state), 'entities', 'items', `spotify:${kind}:${id}`);
  return kind === 'track' ? toTrack(id, page.meta, entity) : toAlbum(id, page.meta, entity);
}

// ---------------------------------------------------------------------------------------------
// Page scraping

type MetaTags = Map<string, string[]>;

interface ScrapedPage {
  meta: MetaTags;
  /** Raw text of <script id="initialState">, or '' when absent. */
  state: string;
}

async function scrapePage(res: Response): Promise<ScrapedPage> {
  const meta: MetaTags = new Map();
  let state = '';
  const rewriter = new HTMLRewriter()
    .on('meta', {
      element(el) {
        const key = el.getAttribute('property') ?? el.getAttribute('name');
        const content = el.getAttribute('content');
        if (!key || content === null) return;
        const values = meta.get(key) ?? [];
        values.push(decodeHtmlEntities(content));
        meta.set(key, values);
      },
    })
    .on('script#initialState', {
      // Text arrives in chunks; script contents are raw text (no entities).
      text(chunk) {
        state += chunk.text;
      },
    });
  await rewriter.transform(res).arrayBuffer();
  return { meta, state };
}

function firstMeta(meta: MetaTags, key: string): string | undefined {
  const v = meta.get(key)?.[0]?.trim();
  return v ? v : undefined;
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** HTMLRewriter returns attribute values undecoded ("Rollin&#x27; &amp; Scratchin&#x27;"). */
export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

/** base64 -> UTF-8 -> JSON. Returns undefined on any failure: the state is optional enrichment. */
export function decodeState(base64: string): unknown {
  const clean = base64.replace(/\s+/g, '');
  if (!clean) return undefined;
  try {
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Mapping

function toTrack(id: string, meta: MetaTags, e: unknown): TrackMeta {
  const desc = parseTrackDescription(firstMeta(meta, 'og:description') ?? firstMeta(meta, 'twitter:description'));
  const stateArtists = artistNames([...list(at(e, 'firstArtist', 'items')), ...list(at(e, 'otherArtists', 'items'))]);
  const metaArtist = firstMeta(meta, 'music:musician_description') ?? desc?.artist;
  const stateMs = int(at(e, 'duration', 'totalMilliseconds'));
  const metaSeconds = int(Number(firstMeta(meta, 'music:duration')));
  const album = at(e, 'albumOfTrack');
  const rating = str(at(e, 'contentRating', 'label'));

  return compact<TrackMeta>({
    kind: 'track',
    id,
    url: spotifyUrl('track', id),
    title: str(at(e, 'name')) ?? firstMeta(meta, 'og:title') ?? '',
    ...artistFields(stateArtists, metaArtist, meta),
    album: str(at(album, 'name')) ?? desc?.album,
    durationMs: stateMs ?? (metaSeconds !== undefined ? metaSeconds * 1000 : undefined),
    durationPrecisionMs:
      stateMs !== undefined ? STATE_DURATION_PRECISION_MS : metaSeconds !== undefined ? META_DURATION_PRECISION_MS : undefined,
    releaseDate: releaseDate(meta, at(album, 'date'), desc?.year),
    explicit: rating ? rating === 'EXPLICIT' : undefined,
    albumType: albumType(at(album, 'type')),
    trackNumber: int(at(e, 'trackNumber')) ?? int(Number(firstMeta(meta, 'music:album:track'))),
    art: firstMeta(meta, 'og:image') ?? largestImage(at(album, 'coverArt', 'sources')),
  });
}

function toAlbum(id: string, meta: MetaTags, e: unknown): AlbumMeta {
  const desc = parseAlbumDescription(firstMeta(meta, 'og:description') ?? firstMeta(meta, 'twitter:description'));
  const ogTitle = firstMeta(meta, 'og:title') ?? '';
  const titleMatch = ALBUM_OG_TITLE.exec(ogTitle);
  const stateArtists = artistNames(list(at(e, 'artists', 'items')));
  const tracks = list(at(e, 'tracksV2', 'items'));
  const songTags = meta.get('music:song')?.length ?? 0;
  const trackCount = int(at(e, 'tracksV2', 'totalCount')) ?? desc?.trackCount ?? (songTags || undefined);

  return compact<AlbumMeta>({
    kind: 'album',
    id,
    url: spotifyUrl('album', id),
    title: str(at(e, 'name')) ?? titleMatch?.[1] ?? ogTitle,
    ...artistFields(stateArtists, desc?.artist ?? titleMatch?.[2], meta),
    releaseDate: releaseDate(meta, at(e, 'date'), desc?.year),
    trackCount,
    albumType: albumType(at(e, 'type')) ?? albumType(desc?.type),
    explicit: albumExplicit(tracks, trackCount),
    art: firstMeta(meta, 'og:image') ?? largestImage(at(e, 'coverArt', 'sources')),
  });
}

/** State names win; otherwise split the meta string only when the pieces match the music:musician count. */
function artistFields(stateArtists: string[], metaArtist: string | undefined, meta: MetaTags): { artists: string[]; artist: string } {
  if (stateArtists.length) return { artists: stateArtists, artist: stateArtists.join(ARTIST_SEPARATOR) };
  if (!metaArtist) return { artists: [], artist: '' };
  const pieces = metaArtist.split(ARTIST_SEPARATOR).map((s) => s.trim()).filter(Boolean);
  const musicians = meta.get('music:musician')?.length ?? 0;
  return { artists: pieces.length > 1 && pieces.length === musicians ? pieces : [metaArtist], artist: metaArtist };
}

/** True if any listed track is explicit; false only when the full track list is known and none is. */
function albumExplicit(tracks: unknown[], trackCount: number | undefined): boolean | undefined {
  const labels = tracks.map((t) => str(at(t, 'track', 'contentRating', 'label')));
  if (labels.includes('EXPLICIT')) return true;
  const complete = trackCount !== undefined && labels.length >= trackCount && labels.every((l) => l !== undefined);
  return complete && labels.length > 0 ? false : undefined;
}

function releaseDate(meta: MetaTags, stateDate: unknown, year: string | undefined): string | undefined {
  const tag = firstMeta(meta, 'music:release_date');
  if (tag && ISO_DATE.test(tag)) return tag;
  return formatDate(stateDate) ?? year;
}

/** {year, month?, day?} -> "yyyy", "yyyy-mm" or "yyyy-mm-dd". */
function formatDate(d: unknown): string | undefined {
  const year = int(at(d, 'year'));
  if (year === undefined) return undefined;
  const parts = [String(year).padStart(4, '0')];
  const month = int(at(d, 'month'));
  const day = int(at(d, 'day'));
  if (month !== undefined) {
    parts.push(String(month).padStart(2, '0'));
    if (day !== undefined) parts.push(String(day).padStart(2, '0'));
  }
  return parts.join('-');
}

function albumType(v: unknown): AlbumType | undefined {
  const s = str(v);
  return s ? ALBUM_TYPES[s.toLowerCase()] : undefined;
}

function artistNames(items: unknown[]): string[] {
  return items.map((a) => str(at(a, 'profile', 'name'))).filter((n): n is string => n !== undefined);
}

function largestImage(sources: unknown): string | undefined {
  let best: { url: string; width: number } | undefined;
  for (const s of list(sources)) {
    const url = str(at(s, 'url'));
    const width = int(at(s, 'width')) ?? 0;
    if (url && (!best || width > best.width)) best = { url, width };
  }
  return best?.url;
}

interface TrackDescription {
  artist: string;
  album?: string;
  year?: string;
}

/** "Artist · Album · Song · Year" (the album may itself contain the separator). */
export function parseTrackDescription(desc: string | undefined): TrackDescription | undefined {
  const segs = desc?.split(DESCRIPTION_SEPARATOR).map((s) => s.trim());
  if (!segs || segs.length < 4 || !segs[0]) return undefined;
  const year = segs[segs.length - 1];
  return {
    artist: segs[0],
    album: segs.slice(1, -2).join(DESCRIPTION_SEPARATOR) || undefined,
    year: year && YEAR.test(year) ? year : undefined,
  };
}

interface AlbumDescription {
  artist: string;
  type?: string;
  year?: string;
  trackCount?: number;
}

/** "Artist · album · 1996 · 15 songs", parsed from the end so the artist may contain the separator. */
export function parseAlbumDescription(desc: string | undefined): AlbumDescription | undefined {
  const segs = desc?.split(DESCRIPTION_SEPARATOR).map((s) => s.trim());
  if (!segs || segs.length < 4) return undefined;
  const count = TRACK_COUNT.exec(segs[segs.length - 1] ?? '');
  const year = segs[segs.length - 2];
  const artist = segs.slice(0, -3).join(DESCRIPTION_SEPARATOR);
  if (!artist) return undefined;
  return {
    artist,
    type: segs[segs.length - 3],
    year: year && YEAR.test(year) ? year : undefined,
    trackCount: count ? Number(count[1]) : undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Untyped JSON access

function at(v: unknown, ...keys: string[]): unknown {
  for (const k of keys) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function int(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Drop undefined fields so cached JSON and test expectations stay clean. */
function compact<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function searchText(q: SearchQuery): string {
  return [q.title, q.artist].map((s) => s.trim()).filter(Boolean).join(' ');
}
