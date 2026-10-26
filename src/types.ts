// Shared contracts between parsing, sources, matching, resolution, storage and rendering.

/** Platform a share link originates from (path segment `p`). */
export type Platform = 'sp' | 'am' | 'dz' | 'yt';
export const PLATFORMS: readonly Platform[] = ['sp', 'am', 'dz', 'yt'];

/** Path segment `k`. */
export type KindCode = 't' | 'a';
export type Kind = 'track' | 'album';

export const KIND_BY_CODE: Record<KindCode, Kind> = { t: 'track', a: 'album' };
export const CODE_BY_KIND: Record<Kind, KindCode> = { track: 't', album: 'a' };

/** A parsed, canonical reference to one item on one platform. */
export interface SourceRef {
  platform: Platform;
  kind: Kind;
  id: string;
}

/** Services shown on the share page, in display order. */
export const SERVICES = ['spotify', 'apple', 'deezer', 'youtubeMusic', 'amazon'] as const;
export type Service = (typeof SERVICES)[number];

export const SERVICE_NAMES: Record<Service, string> = {
  spotify: 'Spotify',
  apple: 'Apple Music',
  deezer: 'Deezer',
  youtubeMusic: 'YouTube Music',
  amazon: 'Amazon Music',
};

/** The service that owns links from each source platform. */
export const SERVICE_BY_PLATFORM: Record<Platform, Service> = {
  sp: 'spotify',
  am: 'apple',
  dz: 'deezer',
  yt: 'youtubeMusic',
};

/**
 * exact:  identified by a shared identifier (ISRC/UPC) or the source item itself, re-verified.
 * fuzzy:  metadata search result that cleared the confidence threshold.
 * search: a search URL on that service; never a guess presented as a direct link.
 */
export type MatchType = 'exact' | 'fuzzy' | 'search';

export interface ServiceLink {
  url: string;
  match: MatchType;
}

/** A link that opens the item itself (as opposed to a search). */
export function isDirect(link: ServiceLink): boolean {
  return link.match === 'exact' || link.match === 'fuzzy';
}

export type AlbumType = 'album' | 'single' | 'ep' | 'compilation';

/** Metadata common to tracks and albums, normalized from any platform. */
interface ItemBase {
  /** Platform-specific id. */
  id: string;
  /** Canonical, region-independent URL on its own platform. */
  url: string;
  /** Title exactly as the platform shows it (no normalization). */
  title: string;
  /** Individual artist names, primary first. At least one entry when known. */
  artists: string[];
  /** Display string as the platform shows it, e.g. "Daft Punk & Pharrell Williams". */
  artist: string;
  /** ISO date prefix: "yyyy", "yyyy-mm" or "yyyy-mm-dd". */
  releaseDate?: string;
  explicit?: boolean;
  /** Absolute artwork URL, ideally >= 600px. */
  art?: string;
}

export interface TrackMeta extends ItemBase {
  kind: 'track';
  /** Title of the album/release the track appears on. */
  album?: string;
  durationMs?: number;
  /** Precision of durationMs: 1 for millisecond sources, 1000 when the platform reports whole seconds. */
  durationPrecisionMs?: number;
  isrc?: string;
  /** Type of the containing release, if known. */
  albumType?: AlbumType;
  trackNumber?: number;
}

export interface AlbumMeta extends ItemBase {
  kind: 'album';
  trackCount?: number;
  upc?: string;
  albumType?: AlbumType;
}

export type ItemMeta = TrackMeta | AlbumMeta;

/** Text query for a platform search API. */
export interface SearchQuery {
  kind: Kind;
  title: string;
  artist: string;
  /** Album title, tracks only. */
  album?: string;
  /** Other credited artists (secondary and featured), in credit order. */
  credits?: string[];
}

/** Resolved-links cache value (KV), keyed by `sp:t:<id>` etc. */
export interface ResolvedEntry {
  kind: Kind;
  title: string;
  artist: string;
  /** Album title, tracks only. */
  album?: string;
  durationMs?: number;
  releaseYear?: number;
  isrc?: string;
  upc?: string;
  art?: string;
  explicit?: boolean;
  /** ISO timestamp. */
  resolvedAt: string;
  /** How Apple was queried: the MusicKit API, or the degraded public iTunes API. */
  appleMode: 'musickit' | 'itunes';
  links: Record<Service, ServiceLink>;
}

/** One row of the D1 `misses` table (id and created_at are filled by D1). */
export interface MissRow {
  source_key: string;
  service: Service;
  outcome: 'fuzzy' | 'search' | 'error';
  source_title: string | null;
  source_artist: string | null;
  source_duration_ms: number | null;
  candidate_title: string | null;
  candidate_artist: string | null;
  candidate_duration_ms: number | null;
  score: number | null;
  note: string | null;
}

/** Secrets and bindings. Apple secrets are optional: without them Apple uses the iTunes API. */
export type AppEnv = Env & {
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  APPLE_PRIVATE_KEY?: string;
};
