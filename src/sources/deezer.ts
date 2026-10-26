// Deezer: public JSON API, no auth. Lookups by id, ISRC and UPC, plus text search.
// Errors arrive as HTTP 200 with {"error": {"type", "message", "code"}}; code 800 means "no data".

import type { UpstreamCtx } from '../http';
import { getJson, UpstreamError } from '../http';
import type { AlbumMeta, AlbumType, ItemMeta, Kind, SearchQuery, TrackMeta } from '../types';

export const DEEZER_API = 'https://api.deezer.com';
export const DEEZER_WEB = 'https://www.deezer.com';

/** Results requested per search query (searchDeezer runs two queries). */
export const DEEZER_SEARCH_LIMIT = 15;
export const DEEZER_MAX_SEARCH_LIMIT = 100;

/** https://developers.deezer.com/api/errors */
export const DEEZER_ERROR_QUOTA = 4;
export const DEEZER_ERROR_NO_DATA = 800;

/** Deezer reports durations in whole seconds. */
export const DEEZER_DURATION_PRECISION_MS = 1000;

export const DEEZER_ID = /^\d{1,20}$/;
/** ISRC: country (2 letters), registrant (3 alphanumerics), year (2 digits), designation (5 digits). */
export const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;
/** EAN-8, UPC-A (12), EAN-13 or GTIN-14. */
export const UPC_RE = /^\d{8,14}$/;

export const RECORD_TYPES: Readonly<Record<string, AlbumType>> = {
  album: 'album',
  single: 'single',
  ep: 'ep',
  compile: 'compilation',
};

/** Contributor roles in credit order; unknown roles sort last. */
export const ROLE_ORDER: Readonly<Record<string, number>> = { Main: 0, Featured: 1 };
const OTHER_ROLE_RANK = 2;

type Json = Record<string, unknown>;

export function deezerUrl(kind: Kind, id: string): string {
  return `${DEEZER_WEB}/${kind}/${encodeURIComponent(id)}`;
}

export function deezerSearchUrl(kind: Kind, text: string, limit: number = DEEZER_SEARCH_LIMIT): string {
  return `${DEEZER_API}/search/${kind}?q=${encodeURIComponent(text)}&limit=${clampLimit(limit)}`;
}

// ---------------------------------------------------------------------------------------------
// Lookups

export async function getDeezerItem(ctx: UpstreamCtx, kind: Kind, id: string): Promise<ItemMeta> {
  if (!DEEZER_ID.test(id)) throw new UpstreamError(`api.deezer.com: invalid ${kind} id ${id}`, 404);
  const body = await getDeezer(ctx, `${DEEZER_API}/${kind}/${id}`);
  if (!body) throw new UpstreamError(`api.deezer.com: no ${kind} ${id}`, 404);
  const item = kind === 'track' ? mapDeezerTrack(body) : mapDeezerAlbum(body);
  if (!item) throw new UpstreamError(`api.deezer.com: unexpected ${kind} response for ${id}`);
  return item;
}

export async function deezerTrackByIsrc(ctx: UpstreamCtx, isrc: string): Promise<TrackMeta | null> {
  const code = normalizeIsrc(isrc);
  if (!code) return null;
  const body = await getDeezer(ctx, `${DEEZER_API}/track/isrc:${code}`);
  const track = body && !isWithdrawn(body) ? mapDeezerTrack(body) : null;
  // The lookup is meant to be exact; never pass off a different recording as an identifier match.
  if (track?.isrc && track.isrc.toUpperCase() !== code) return null;
  return track;
}

export async function deezerAlbumByUpc(ctx: UpstreamCtx, upc: string): Promise<AlbumMeta | null> {
  const digits = upc.trim();
  if (!UPC_RE.test(digits)) return null;
  // Deezer misses EAN-13s written with a leading zero ("0602567759461") but finds the 12-digit
  // UPC-A ("602567759461"), the same GTIN. Ask for both at once and prefer the form we were given.
  const settled = await Promise.allSettled(upcVariants(digits).map((v) => getDeezer(ctx, `${DEEZER_API}/album/upc:${v}`)));
  let failure: unknown;
  for (const s of settled) {
    if (s.status === 'rejected') {
      failure ??= s.reason;
      continue;
    }
    const album = s.value ? mapDeezerAlbum(s.value) : null;
    if (album && (!album.upc || sameGtin(album.upc, digits))) return album;
  }
  // A miss is only a miss when every lookup answered.
  if (failure !== undefined) throw failure;
  return null;
}

/**
 * A track taken down everywhere: available_countries is empty (not merely absent). Deezer still serves
 * such duplicates by ISRC (readable false, web page 404) next to the playable copy with the same ISRC.
 * readable alone isn't the signal: it reflects the requesting (worker's) country, not the visitor's.
 */
export function isWithdrawn(raw: unknown): boolean {
  const countries = asObject(raw)?.available_countries;
  return Array.isArray(countries) && countries.length === 0;
}

/** Uppercase, without separators; null when it isn't a well-formed ISRC. */
export function normalizeIsrc(isrc: string): string | null {
  const code = isrc.replace(/[\s-]+/g, '').toUpperCase();
  return ISRC_RE.test(code) ? code : null;
}

/** The UPC as given, then its 12-digit form when it carries extra leading zeros. */
export function upcVariants(upc: string): string[] {
  const short = upc.replace(/^0+(?=\d{12}$)/, '');
  return short === upc ? [upc] : [upc, short];
}

function sameGtin(a: string, b: string): boolean {
  return a.replace(/^0+/, '') === b.replace(/^0+/, '');
}

/** GET a Deezer API URL. Returns null for "no data"; throws UpstreamError for any other error body. */
async function getDeezer(ctx: UpstreamCtx, url: string): Promise<Json | null> {
  const body = asObject(await getJson<unknown>(ctx, url));
  if (!body) throw new UpstreamError('api.deezer.com: unexpected response');
  const err = asObject(body.error);
  if (!err) return body;
  const code = Number(err.code);
  if (code === DEEZER_ERROR_NO_DATA) return null;
  const detail = `${text(err.type) ?? 'Error'}: ${text(err.message) ?? 'unknown'} (code ${String(err.code)})`;
  throw new UpstreamError(`api.deezer.com: ${detail}`, code === DEEZER_ERROR_QUOTA ? 429 : undefined);
}

// ---------------------------------------------------------------------------------------------
// Search

/**
 * Searches with two plain queries in parallel and merges the results (first query first, deduplicated
 * by id; `limit` applies per query). One failed query doesn't hide the other's results.
 * The advanced syntax (artist:"…" track:"…") is not used: as of 2026-10 it returns nothing even for the
 * documented examples. Recall of plain search is fickle, so the second query takes another angle.
 */
export async function searchDeezer(ctx: UpstreamCtx, q: SearchQuery, limit: number = DEEZER_SEARCH_LIMIT): Promise<ItemMeta[]> {
  const queries = deezerSearchQueries(q);
  if (!queries.length) return [];
  const settled = await Promise.allSettled(queries.map((text) => searchOnce(ctx, q.kind, text, limit)));
  const lists: ItemMeta[][] = [];
  for (const s of settled) if (s.status === 'fulfilled') lists.push(s.value);
  if (!lists.length) throw (settled[0] as PromiseRejectedResult).reason;
  return mergeById(lists);
}

/**
 * ["<artist> <title>", second]. The second query is "<title> <last other credit>" when there are other
 * credits (featured artists come last; "despacito remix justin bieber" finds the remix that
 * "luis fonsi despacito remix" misses), else the title alone (popular versions first, and immune to
 * artist spellings that differ between catalogs).
 */
export function deezerSearchQueries(q: SearchQuery): string[] {
  const title = q.title.trim();
  const artist = q.artist.trim();
  const credit = q.credits?.map((c) => c.trim()).filter(Boolean).at(-1);
  const queries = [[artist, title], [title, credit]].map((parts) => parts.filter(Boolean).join(' '));
  return [...new Set(queries.filter(Boolean))];
}

async function searchOnce(ctx: UpstreamCtx, kind: Kind, query: string, limit: number): Promise<ItemMeta[]> {
  const body = await getDeezer(ctx, deezerSearchUrl(kind, query, limit));
  const data = body && Array.isArray(body.data) ? body.data : [];
  const items: ItemMeta[] = [];
  for (const raw of data) {
    if (isWithdrawn(raw)) continue;
    const item = kind === 'track' ? mapDeezerTrack(raw) : mapDeezerAlbum(raw);
    if (item) items.push(item);
  }
  return items;
}

export function mergeById(lists: readonly ItemMeta[][]): ItemMeta[] {
  const seen = new Set<string>();
  const out: ItemMeta[] = [];
  for (const list of lists) {
    for (const item of list) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
  }
  return out;
}

function clampLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.min(DEEZER_MAX_SEARCH_LIMIT, Math.max(1, Math.floor(limit))) : DEEZER_SEARCH_LIMIT;
}

// ---------------------------------------------------------------------------------------------
// Mapping (track/album detail, ISRC/UPC lookups and search results share one shape, minus fields)

export function mapDeezerTrack(raw: unknown): TrackMeta | null {
  const o = asObject(raw);
  const id = o && idOf(o.id);
  const title = o && fullTitle(o);
  if (!o || !id || !title) return null;
  const album = asObject(o.album);
  const duration = positiveInt(o.duration);
  return compact<TrackMeta>({
    kind: 'track',
    id,
    url: deezerUrl('track', id),
    title,
    ...credits(o),
    album: text(album?.title),
    durationMs: duration && duration * 1000,
    durationPrecisionMs: duration && DEEZER_DURATION_PRECISION_MS,
    isrc: text(o.isrc),
    explicit: bool(o.explicit_lyrics),
    // The album's date: a track's own release_date can be a later re-delivery (2018 for a 2007 album).
    releaseDate: isoDate(album?.release_date) ?? isoDate(o.release_date),
    albumType: recordType(album?.record_type),
    trackNumber: positiveInt(o.track_position),
    art: cover(album),
  });
}

export function mapDeezerAlbum(raw: unknown): AlbumMeta | null {
  const o = asObject(raw);
  const id = o && idOf(o.id);
  const title = o && text(o.title);
  if (!o || !id || !title) return null;
  return compact<AlbumMeta>({
    kind: 'album',
    id,
    url: deezerUrl('album', id),
    title,
    ...credits(o),
    trackCount: positiveInt(o.nb_tracks),
    upc: text(o.upc),
    albumType: recordType(o.record_type),
    releaseDate: isoDate(o.release_date),
    explicit: bool(o.explicit_lyrics),
    art: cover(o),
  });
}

/** "title" normally includes the version already ("Ouelli El Darek (Live)"); append it if not. */
function fullTitle(o: Json): string | undefined {
  const title = text(o.title);
  const version = text(o.title_version);
  if (!title || !version || title.toLowerCase().includes(version.toLowerCase())) return title;
  return `${title} ${version}`;
}

/** artists from contributors (Main, then Featured, then others), else the single artist. */
function credits(o: Json): { artists: string[]; artist: string } {
  const main = text(asObject(o.artist)?.name);
  const contributors = Array.isArray(o.contributors) ? o.contributors : [];
  const ranked = contributors
    .map((c, i) => {
      const obj = asObject(c);
      const role = text(obj?.role);
      return { name: text(obj?.name), rank: (role !== undefined && Object.hasOwn(ROLE_ORDER, role) ? ROLE_ORDER[role] : undefined) ?? OTHER_ROLE_RANK, i };
    })
    .filter((c): c is { name: string; rank: number; i: number } => c.name !== undefined)
    .sort((a, b) => a.rank - b.rank || a.i - b.i);
  const seen = new Set<string>();
  const artists: string[] = [];
  for (const { name } of ranked) {
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    artists.push(name);
  }
  if (!artists.length && main) artists.push(main);
  return { artists, artist: main ?? artists.join(', ') };
}

export function recordType(v: unknown): AlbumType | undefined {
  return typeof v === 'string' && Object.hasOwn(RECORD_TYPES, v) ? RECORD_TYPES[v] : undefined;
}

/** Largest cover. Covers without artwork have an empty hash ("…/images/cover//1000x1000-…"). */
function cover(o: Json | undefined): string | undefined {
  const url = text(o?.cover_xl) ?? text(o?.cover_big);
  return url && !url.includes('/cover//') ? url : undefined;
}

/** "yyyy-mm-dd" with unknown parts ("-00") dropped; Deezer uses "0000-00-00" for no date. */
export function isoDate(v: unknown): string | undefined {
  if (typeof v !== 'string' || !/^\d{4}(?:-\d{2}){0,2}$/.test(v) || v.startsWith('0000')) return undefined;
  return v.replace(/(?:-00)+$/, '');
}

function idOf(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return String(v);
  if (typeof v === 'string' && DEEZER_ID.test(v) && !/^0+$/.test(v)) return v;
  return undefined;
}

function asObject(v: unknown): Json | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

/** Drop undefined fields so results compare cleanly and serialize compactly. */
function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}
