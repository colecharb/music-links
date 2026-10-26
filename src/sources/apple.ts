// Apple Music. Two modes, chosen per request by ctx.apple:
//   MusicKit (developer token): the catalog API, with ISRC/UPC filters and separate artist names.
//   iTunes (no token): the public Search/Lookup API. No ISRC filter and only a display artist string,
//   so matching is degraded; the resolver records appleMode 'itunes'.
// Links never carry a storefront (music.apple.com/song/<id>): Apple redirects each visitor to their own.

import { importPKCS8, SignJWT } from 'jose';
import type { AppleAuth, UpstreamCtx } from '../http';
import { getJson, UpstreamError } from '../http';
import type { AlbumMeta, AlbumType, AppEnv, ItemMeta, Kind, SearchQuery, TrackMeta } from '../types';

export const APPLE_MUSIC_WEB = 'https://music.apple.com';
export const MUSICKIT_CATALOG = 'https://api.music.apple.com/v1/catalog';
export const ITUNES_API = 'https://itunes.apple.com';

/** Storefront retried once when the visitor's storefront is unknown to Apple or lacks the item. */
export const FALLBACK_STOREFRONT = 'us';
const STOREFRONT = /^[a-z]{2}$/;

/** Edge of the artwork we link, in px (Apple's image server renders any size from its template). */
export const ART_SIZE = 600;

export const DEFAULT_SEARCH_LIMIT = 20;
export const MUSICKIT_MAX_SEARCH_LIMIT = 25;
export const ITUNES_MAX_LIMIT = 200;

/** Both APIs report milliseconds. */
export const DURATION_PRECISION_MS = 1;

/** Developer token lifetime, and how long before expiry a cached token is replaced. */
export const TOKEN_TTL_S = 12 * 3600;
export const TOKEN_REFRESH_MARGIN_S = 3600;
/** After Apple rejects our token, skip MusicKit for this long instead of failing once per request. */
export const REJECTED_TOKEN_COOLDOWN_S = 300;

export const SECRETS_WARNING = 'Apple MusicKit secrets missing/invalid; using iTunes Search API (degraded matching)';

/** Apple appends these to release names ("Borracho - Single", "Take Me to Church - EP"). */
const RELEASE_SUFFIX = /\s+-\s+(Single|EP)$/;
const VARIOUS_ARTISTS = /^various artists$/i;
const DATE_PREFIX = /^\d{4}(?:-\d{2}(?:-\d{2})?)?/;
/** Size segment of an mzstatic artwork URL, e.g. ".../100x100bb.jpg". */
const ART_SIZE_SEGMENT = /\/\d+x\d+bb(\.\w+)$/;

const MUSICKIT_TYPE: Record<Kind, 'songs' | 'albums'> = { track: 'songs', album: 'albums' };
/** Songs: album attributes give the release type, artists give separate names. */
const MUSICKIT_INCLUDE: Record<Kind, string> = { track: 'albums,artists', album: 'artists' };
const ITUNES_ENTITY: Record<Kind, 'song' | 'album'> = { track: 'song', album: 'album' };

export function appleUrl(kind: Kind, id: string): string {
  return `${APPLE_MUSIC_WEB}/${kind === 'track' ? 'song' : 'album'}/${encodeURIComponent(id)}`;
}

// ---------------------------------------------------------------------------------------------
// Public operations

export async function getAppleItem(ctx: UpstreamCtx, kind: Kind, id: string): Promise<ItemMeta> {
  return withAppleMode(
    ctx,
    (token) =>
      inStorefront(ctx, async (sf) => {
        const body = await musicKit(ctx, token, `${sf}/${MUSICKIT_TYPE[kind]}/${encodeURIComponent(id)}?include=${MUSICKIT_INCLUDE[kind]}`);
        const items = musicKitItems(kind, body);
        const item = items.find((i) => i.id === id) ?? items[0];
        if (!item) throw notFound(kind, id);
        return item;
      }),
    () =>
      // An album id returns the collection followed by its songs.
      inStorefront(ctx, async (sf) => {
        const body = await itunes(ctx, `lookup?id=${encodeURIComponent(id)}&country=${sf}&entity=song`);
        const item = itunesItems(kind, body).find((i) => i.id === id);
        if (!item) throw notFound(kind, id);
        return item;
      }),
  );
}

/** Every Apple song with this ISRC (album version, compilations, single...). [] in iTunes mode, which can't filter by ISRC. */
export async function appleTracksByIsrc(ctx: UpstreamCtx, isrc: string): Promise<TrackMeta[]> {
  return withAppleMode(
    ctx,
    (token) =>
      inStorefront(ctx, async (sf) => {
        const body = await musicKit(ctx, token, `${sf}/songs?filter[isrc]=${encodeURIComponent(isrc)}&include=${MUSICKIT_INCLUDE.track}`);
        return musicKitItems('track', body);
      }),
    async () => [],
  );
}

export async function appleAlbumsByUpc(ctx: UpstreamCtx, upc: string): Promise<AlbumMeta[]> {
  return withAppleMode(
    ctx,
    (token) =>
      inStorefront(ctx, async (sf) => {
        const body = await musicKit(ctx, token, `${sf}/albums?filter[upc]=${encodeURIComponent(upc)}&include=${MUSICKIT_INCLUDE.album}`);
        return musicKitItems('album', body);
      }),
    () =>
      inStorefront(ctx, async (sf) => {
        const body = await itunes(ctx, `lookup?upc=${encodeURIComponent(upc)}&country=${sf}`);
        return itunesItems('album', body);
      }),
  );
}

export async function searchApple(ctx: UpstreamCtx, q: SearchQuery, limit = DEFAULT_SEARCH_LIMIT): Promise<ItemMeta[]> {
  const term = formEncode(searchText(q));
  if (!term) return [];
  return withAppleMode(
    ctx,
    (token) =>
      inStorefront(ctx, async (sf) => {
        const n = clamp(limit, 1, MUSICKIT_MAX_SEARCH_LIMIT);
        const type = MUSICKIT_TYPE[q.kind];
        const body = await musicKit(ctx, token, `${sf}/search?term=${term}&types=${type}&limit=${n}`);
        return musicKitItems(q.kind, at(body, 'results', type));
      }),
    () =>
      inStorefront(ctx, async (sf) => {
        const n = clamp(limit, 1, ITUNES_MAX_LIMIT);
        const body = await itunes(ctx, `search?term=${term}&country=${sf}&media=music&entity=${ITUNES_ENTITY[q.kind]}&limit=${n}`);
        return itunesItems(q.kind, body);
      }),
  );
}

// ---------------------------------------------------------------------------------------------
// Mode and storefront handling

/**
 * Run the MusicKit variant of an operation when the request has a developer token, else the iTunes one.
 *
 * HTTP 401/403 from MusicKit means Apple rejected the token (revoked key, wrong team or key id). The
 * request then downgrades itself: ctx.apple is set to null (UpstreamCtx is per-request, and the
 * resolver reads ctx.apple afterwards to record appleMode 'itunes'), the cached token is dropped so
 * later requests don't reuse it, and the same operation is retried in iTunes mode.
 */
async function withAppleMode<T>(
  ctx: UpstreamCtx,
  viaMusicKit: (token: string) => Promise<T>,
  viaItunes: () => Promise<T>,
): Promise<T> {
  const auth = ctx.apple;
  if (!auth) return viaItunes();
  try {
    return await viaMusicKit(auth.token);
  } catch (err) {
    if (!(err instanceof UpstreamError && (err.status === 401 || err.status === 403))) throw err;
    ctx.apple = null;
    rejectToken(auth.token);
    return viaItunes();
  }
}

/**
 * Run `op` in the visitor's storefront, then once in FALLBACK_STOREFRONT when Apple doesn't know that
 * storefront (400) or the item isn't sold there (404): catalog items are region-limited.
 */
async function inStorefront<T>(ctx: UpstreamCtx, op: (storefront: string) => Promise<T>): Promise<T> {
  const sf = ctx.storefront.toLowerCase();
  if (!STOREFRONT.test(sf) || sf === FALLBACK_STOREFRONT) return op(FALLBACK_STOREFRONT);
  try {
    return await op(sf);
  } catch (err) {
    if (err instanceof UpstreamError && (err.status === 400 || err.status === 404)) return op(FALLBACK_STOREFRONT);
    throw err;
  }
}

function musicKit(ctx: UpstreamCtx, token: string, pathAndQuery: string): Promise<unknown> {
  return getJson<unknown>(ctx, `${MUSICKIT_CATALOG}/${pathAndQuery}`, { headers: { authorization: `Bearer ${token}` } });
}

/** iTunes answers 403/429 when rate limited (~20 requests/minute per IP); getJson surfaces those as UpstreamError. */
function itunes(ctx: UpstreamCtx, pathAndQuery: string): Promise<unknown> {
  return getJson<unknown>(ctx, `${ITUNES_API}/${pathAndQuery}`);
}

function notFound(kind: Kind, id: string): UpstreamError {
  return new UpstreamError(`music.apple.com: no ${kind} ${id}`, 404);
}

// ---------------------------------------------------------------------------------------------
// Developer token

interface SignedToken {
  /** The secrets the token was signed with, so changed secrets are never served a stale token. */
  secrets: string;
  token: string;
  expiresAt: number;
}

let signed: SignedToken | undefined;
/** Secrets that failed to import or sign. */
let invalidSecrets: string | undefined;
let rejected: { secrets: string; at: number } | undefined;
let warned = false;

/**
 * MusicKit developer token (ES256 JWT) from APPLE_TEAM_ID, APPLE_KEY_ID and APPLE_PRIVATE_KEY, cached
 * per isolate until TOKEN_REFRESH_MARGIN_S before expiry. Null when the secrets are missing or invalid,
 * or Apple recently rejected the token: Apple then works through the iTunes API.
 */
export async function getAppleAuth(env: AppEnv, nowSeconds = epochSeconds()): Promise<AppleAuth | null> {
  const teamId = env.APPLE_TEAM_ID?.trim();
  const keyId = env.APPLE_KEY_ID?.trim();
  const privateKey = env.APPLE_PRIVATE_KEY?.trim();
  if (!teamId || !keyId || !privateKey) return disabled();

  const secrets = `${teamId}\n${keyId}\n${privateKey}`;
  if (signed?.secrets === secrets && nowSeconds < signed.expiresAt - TOKEN_REFRESH_MARGIN_S) return { token: signed.token };
  if (invalidSecrets === secrets) return null;
  if (rejected?.secrets === secrets && nowSeconds < rejected.at + REJECTED_TOKEN_COOLDOWN_S) return null;

  try {
    const key = await importPKCS8(toPkcs8Pem(privateKey), 'ES256');
    const expiresAt = nowSeconds + TOKEN_TTL_S;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: keyId })
      .setIssuer(teamId)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(expiresAt)
      .sign(key);
    signed = { secrets, token, expiresAt };
    return { token };
  } catch {
    invalidSecrets = secrets;
    return disabled();
  }
}

/**
 * Normalize a .p8 key as it tends to arrive in env vars: literal "\n" escapes, real newlines, CRLF,
 * wrapping quotes, with or without the BEGIN/END lines.
 */
export function toPkcs8Pem(raw: string): string {
  const base64 = raw
    .replace(/\\[nr]/g, '\n')
    .replace(/-----(?:BEGIN|END)[A-Z ]*-----/g, '')
    .replace(/[^A-Za-z0-9+/=]/g, '');
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

function rejectToken(token: string): void {
  // Only our cached token says anything about the configured secrets.
  if (signed?.token !== token) return;
  rejected = { secrets: signed.secrets, at: epochSeconds() };
  signed = undefined;
  console.warn(`Apple MusicKit rejected the developer token; using iTunes Search API for ${REJECTED_TOKEN_COOLDOWN_S}s`);
}

function disabled(): null {
  if (!warned) {
    warned = true;
    console.warn(SECRETS_WARNING);
  }
  return null;
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------------------------
// MusicKit mapping ({ data: [ { id, type, href, attributes, relationships } ] })

function musicKitItems(kind: 'track', container: unknown): TrackMeta[];
function musicKitItems(kind: 'album', container: unknown): AlbumMeta[];
function musicKitItems(kind: Kind, container: unknown): ItemMeta[];
function musicKitItems(kind: Kind, container: unknown): ItemMeta[] {
  const toItem: (r: unknown) => ItemMeta | undefined = kind === 'track' ? musicKitTrack : musicKitAlbum;
  return list(at(container, 'data'))
    .map(toItem)
    .filter((i): i is ItemMeta => i !== undefined);
}

function musicKitTrack(r: unknown): TrackMeta | undefined {
  const id = idOf(at(r, 'id'));
  const a = at(r, 'attributes');
  const title = str(at(a, 'name'));
  if (at(r, 'type') !== 'songs' || !id || !title) return undefined;
  const artist = str(at(a, 'artistName')) ?? '';
  const album = splitReleaseSuffix(str(at(a, 'albumName')));
  const albumAttrs = at(list(at(r, 'relationships', 'albums', 'data'))[0], 'attributes');
  const durationMs = int(at(a, 'durationInMillis'));
  return compact<TrackMeta>({
    kind: 'track',
    id,
    url: appleUrl('track', id),
    title,
    artists: musicKitArtists(r, artist),
    artist,
    album: album?.title,
    durationMs,
    durationPrecisionMs: durationMs !== undefined ? DURATION_PRECISION_MS : undefined,
    isrc: str(at(a, 'isrc')),
    explicit: musicKitExplicit(at(a, 'contentRating')),
    releaseDate: datePrefix(at(a, 'releaseDate')),
    trackNumber: int(at(a, 'trackNumber')),
    albumType: albumTypeOf({
      suffix: album?.suffix,
      isSingle: bool(at(albumAttrs, 'isSingle')),
      isCompilation: bool(at(albumAttrs, 'isCompilation')),
    }),
    art: musicKitArt(at(a, 'artwork')),
  });
}

function musicKitAlbum(r: unknown): AlbumMeta | undefined {
  const id = idOf(at(r, 'id'));
  const a = at(r, 'attributes');
  const name = splitReleaseSuffix(str(at(a, 'name')));
  if (at(r, 'type') !== 'albums' || !id || !name) return undefined;
  const artist = str(at(a, 'artistName')) ?? '';
  return compact<AlbumMeta>({
    kind: 'album',
    id,
    url: appleUrl('album', id),
    title: name.title,
    artists: musicKitArtists(r, artist),
    artist,
    trackCount: int(at(a, 'trackCount')),
    upc: str(at(a, 'upc')),
    albumType: albumTypeOf({
      suffix: name.suffix,
      isSingle: bool(at(a, 'isSingle')),
      isCompilation: bool(at(a, 'isCompilation')),
    }),
    explicit: musicKitExplicit(at(a, 'contentRating')),
    releaseDate: datePrefix(at(a, 'releaseDate')),
    art: musicKitArt(at(a, 'artwork')),
  });
}

/** Included artist resources give separate names; otherwise the display string is the only credit. */
function musicKitArtists(r: unknown, artist: string): string[] {
  const names = list(at(r, 'relationships', 'artists', 'data'))
    .map((x) => str(at(x, 'attributes', 'name')))
    .filter((n): n is string => n !== undefined);
  return names.length ? names : artist ? [artist] : [];
}

/** Apple only rates explicit and cleaned content; no contentRating means not explicit. */
function musicKitExplicit(rating: unknown): boolean | undefined {
  if (rating === undefined || rating === 'clean') return false;
  return rating === 'explicit' ? true : undefined;
}

/** Artwork template "https://.../{w}x{h}bb.jpg" (some templates also carry {c} crop and {f} format). */
function musicKitArt(artwork: unknown): string | undefined {
  const template = str(at(artwork, 'url'));
  if (!template) return undefined;
  const size = Math.min(ART_SIZE, positive(at(artwork, 'width')) ?? ART_SIZE, positive(at(artwork, 'height')) ?? ART_SIZE);
  return template
    .replace('{w}', String(size))
    .replace('{h}', String(size))
    .replace('{c}', 'bb')
    .replace('{f}', 'jpg');
}

// ---------------------------------------------------------------------------------------------
// iTunes mapping ({ resultCount, results: [ { wrapperType, kind, ... } ] })

function itunesItems(kind: 'track', body: unknown): TrackMeta[];
function itunesItems(kind: 'album', body: unknown): AlbumMeta[];
function itunesItems(kind: Kind, body: unknown): ItemMeta[];
function itunesItems(kind: Kind, body: unknown): ItemMeta[] {
  const toItem: (r: unknown) => ItemMeta | undefined = kind === 'track' ? itunesTrack : itunesAlbum;
  return list(at(body, 'results'))
    .map(toItem)
    .filter((i): i is ItemMeta => i !== undefined);
}

function itunesTrack(r: unknown): TrackMeta | undefined {
  if (at(r, 'wrapperType') !== 'track' || at(r, 'kind') !== 'song') return undefined;
  const id = idOf(at(r, 'trackId'));
  const title = str(at(r, 'trackName'));
  if (!id || !title) return undefined;
  const artist = str(at(r, 'artistName')) ?? '';
  const album = splitReleaseSuffix(str(at(r, 'collectionName')));
  const durationMs = int(at(r, 'trackTimeMillis'));
  return compact<TrackMeta>({
    kind: 'track',
    id,
    url: appleUrl('track', id),
    title,
    artists: artist ? [artist] : [],
    artist,
    album: album?.title,
    durationMs,
    durationPrecisionMs: durationMs !== undefined ? DURATION_PRECISION_MS : undefined,
    explicit: itunesExplicit(at(r, 'trackExplicitness')),
    releaseDate: datePrefix(at(r, 'releaseDate')),
    trackNumber: int(at(r, 'trackNumber')),
    albumType: albumTypeOf({ suffix: album?.suffix, variousArtists: VARIOUS_ARTISTS.test(str(at(r, 'collectionArtistName')) ?? '') }),
    art: itunesArt(at(r, 'artworkUrl100')),
  });
}

function itunesAlbum(r: unknown): AlbumMeta | undefined {
  if (at(r, 'wrapperType') !== 'collection') return undefined;
  const id = idOf(at(r, 'collectionId'));
  const name = splitReleaseSuffix(str(at(r, 'collectionName')));
  if (!id || !name) return undefined;
  const artist = str(at(r, 'artistName')) ?? '';
  return compact<AlbumMeta>({
    kind: 'album',
    id,
    url: appleUrl('album', id),
    title: name.title,
    artists: artist ? [artist] : [],
    artist,
    trackCount: int(at(r, 'trackCount')),
    albumType: albumTypeOf({
      suffix: name.suffix,
      variousArtists: VARIOUS_ARTISTS.test(artist) || at(r, 'collectionType') === 'Compilation',
    }),
    explicit: itunesExplicit(at(r, 'collectionExplicitness')),
    releaseDate: datePrefix(at(r, 'releaseDate')),
    art: itunesArt(at(r, 'artworkUrl100')),
  });
}

/** 'explicit' | 'notExplicit' | 'cleaned' (the edited version of explicit content). */
function itunesExplicit(v: unknown): boolean | undefined {
  if (v === 'explicit') return true;
  return v === 'notExplicit' || v === 'cleaned' ? false : undefined;
}

/** ".../100x100bb.jpg" -> ".../600x600bb.jpg". */
function itunesArt(url: unknown): string | undefined {
  const s = str(url);
  return s?.replace(ART_SIZE_SEGMENT, `/${ART_SIZE}x${ART_SIZE}bb$1`);
}

// ---------------------------------------------------------------------------------------------
// Shared mapping

export interface ReleaseName {
  title: string;
  suffix?: 'Single' | 'EP';
}

/** "Borracho - Single" -> { title: "Borracho", suffix: "Single" }. */
export function splitReleaseSuffix(name: string | undefined): ReleaseName | undefined {
  if (!name) return undefined;
  const m = RELEASE_SUFFIX.exec(name);
  if (!m) return { title: name };
  const title = name.slice(0, m.index).trim();
  return title ? { title, suffix: m[1] as 'Single' | 'EP' } : { title: name };
}

interface ReleaseMarkers {
  suffix?: 'Single' | 'EP';
  isSingle?: boolean;
  isCompilation?: boolean;
  variousArtists?: boolean;
}

/**
 * 'album' only when MusicKit's isSingle flag says it isn't a single: Apple doesn't suffix every EP
 * (Lil Nas X's "7" has none), so a missing suffix alone proves nothing.
 */
export function albumTypeOf(m: ReleaseMarkers): AlbumType | undefined {
  if (m.isCompilation || m.variousArtists) return 'compilation';
  if (m.isSingle || m.suffix === 'Single') return 'single';
  if (m.suffix === 'EP') return 'ep';
  return m.isSingle === false ? 'album' : undefined;
}

function datePrefix(v: unknown): string | undefined {
  return str(v)?.match(DATE_PREFIX)?.[0];
}

/** "Artist Title": both APIs match every word against artist, title and album fields. */
function searchText(q: SearchQuery): string {
  return [q.artist, q.title]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ');
}

/** Query value with "+" for spaces, as both APIs document. */
function formEncode(s: string): string {
  return encodeURIComponent(s).replace(/%20/g, '+');
}

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : max;
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

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function int(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
}

function positive(v: unknown): number | undefined {
  const n = int(v);
  return n ? n : undefined;
}

/** Apple ids: strings in MusicKit, numbers in iTunes. */
function idOf(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return String(v);
  return typeof v === 'string' && /^\d+$/.test(v) ? v : undefined;
}

/** Drop undefined fields so cached JSON and test expectations stay clean. */
function compact<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}
