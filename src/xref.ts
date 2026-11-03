// Spotify cross-reference: direct Spotify links without the Spotify API, learned from Spotify-sourced
// resolutions. When a Spotify link resolves, the ISRC/UPC of its Deezer/Apple matches is mapped to the
// Spotify item (with a metadata snapshot; a few Spotify copies per identifier); a later non-Spotify link
// carrying the same identifier gets those Spotify items as candidates, chosen with the normal fuzzy rules.
// Entries cached before their mapping existed are remembered as "waiting" and patched when it is learned.
//
// All D1 access lives here. Storage problems are logged, never thrown into a response: lookup errors
// are rethrown for resolve.ts to turn into a search link (with a note), everything else is swallowed.
import { pickBestAlbum, pickBestTrack } from './match';
import { normalizeIsrc, UPC_RE } from './sources/deezer';
import { spotifyUrl } from './sources/spotify';
import { readEntryState, TTL_COMPLETE_SECONDS, writeEntry } from './store';
import type { AlbumMeta, AlbumType, ItemMeta, Kind, ResolvedEntry, TrackMeta } from './types';

/** Identifiers per lookup or write; a result has a handful at most (source, Deezer, Apple, entry). */
export const XREF_MAX_IDENTIFIERS = 10;
/** Waiting entries re-checked per learned mapping. */
export const XREF_MAX_WAITING = 50;
/**
 * Spotify items kept per identifier (the most recently learned). Several copies share an ISRC/UPC (album
 * version, single, compilation, clean/explicit packaging); keeping them all lets the tie-breaks choose.
 */
export const XREF_MAX_PER_IDENTIFIER = 5;
/**
 * A waiting entry missing from KV is only taken as gone this long after it was resolved: KV writes can
 * take up to 60 s to be visible in other locations.
 */
export const XREF_ABSENT_GRACE_MS = 5 * 60 * 1000;
/** Waiting rows older than the longest KV TTL point at expired entries. */
export const XREF_WAITING_MAX_AGE_SECONDS = TTL_COMPLETE_SECONDS;

const ALBUM_TYPES: readonly string[] = ['album', 'single', 'ep', 'compilation'];
const NOW_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

/** A learned Spotify item, found by one of the identifiers asked for. */
export interface XrefHit {
  identifier: string;
  item: ItemMeta;
}

/** A cached entry whose Spotify link is a search, by one of its identifiers. */
export interface WaitingRow {
  identifier: string;
  cacheKey: string;
  /** resolvedAt of the entry that waited: a different one under the same key is not patched. */
  resolvedAt: string;
}

/** Read side, used during resolution. */
export interface XrefReader {
  /** Spotify items learned for these normalized identifiers, in one round trip. Throws on storage errors. */
  lookup(kind: Kind, identifiers: string[]): Promise<XrefHit[]>;
}

/** Write side, used in the background after a resolution. Never throws. */
export interface XrefStore extends XrefReader {
  /**
   * Map the identifiers to this Spotify item too (keeping the XREF_MAX_PER_IDENTIFIER most recent per
   * identifier). Returns the entries waiting for any of them, and every Spotify item now mapped to them.
   */
  learn(item: ItemMeta, identifiers: string[]): Promise<{ waiting: WaitingRow[]; hits: XrefHit[] }>;
  /**
   * Remember that the entry under cacheKey (resolved at resolvedAt) has a Spotify search link; prunes rows
   * past the max age. Returns the Spotify items already mapped to the identifiers: a mapping learned after
   * the resolve-time lookup found no waiting row to back-fill.
   */
  wait(kind: Kind, identifiers: string[], cacheKey: string, resolvedAt: string): Promise<XrefHit[]>;
  /** Forget every waiting row of these cache keys. */
  unwait(cacheKeys: string[]): Promise<void>;
}

/** The Spotify item's metadata, enough to verify a match without fetching Spotify again. */
export interface SpotifySnapshot {
  kind: Kind;
  id: string;
  title: string;
  artists: string[];
  artist: string;
  album?: string;
  durationMs?: number;
  durationPrecisionMs?: number;
  explicit?: boolean;
  albumType?: AlbumType;
  trackCount?: number;
  releaseDate?: string;
  art?: string;
}

// ---------------------------------------------------------------------------------------------
// Identifiers

/**
 * Canonical form for lookups: ISRC uppercase without spaces/hyphens; UPC digits without leading zeros
 * (Deezer and Apple disagree on 12/13/14-digit forms of the same GTIN). null when malformed.
 */
export function normalizeIdentifier(kind: Kind, raw: string): string | null {
  if (kind === 'track') return normalizeIsrc(raw);
  const digits = raw.replace(/[\s-]+/g, '');
  if (!UPC_RE.test(digits)) return null;
  return digits.replace(/^0+/, '') || null;
}

/** Normalized, deduplicated, malformed ones dropped, at most XREF_MAX_IDENTIFIERS. */
export function normalizeIdentifiers(kind: Kind, raw: ReadonlyArray<string | undefined>): string[] {
  const out = new Set<string>();
  for (const r of raw) {
    const id = r ? normalizeIdentifier(kind, r) : null;
    if (id) out.add(id);
  }
  return [...out].slice(0, XREF_MAX_IDENTIFIERS);
}

// ---------------------------------------------------------------------------------------------
// Snapshots

export function toSnapshot(item: ItemMeta): SpotifySnapshot {
  const common = {
    kind: item.kind,
    id: item.id,
    title: item.title,
    artists: item.artists,
    artist: item.artist,
    explicit: item.explicit,
    albumType: item.albumType,
    releaseDate: item.releaseDate,
    art: item.art,
  };
  return compact<SpotifySnapshot>(
    item.kind === 'track'
      ? { ...common, album: item.album, durationMs: item.durationMs, durationPrecisionMs: item.durationPrecisionMs }
      : { ...common, trackCount: item.trackCount },
  );
}

/** Snapshot (parsed JSON) -> Spotify ItemMeta; null for anything malformed or of another kind. */
export function fromSnapshot(v: unknown, kind?: Kind): ItemMeta | null {
  if (!isRecord(v) || (v.kind !== 'track' && v.kind !== 'album') || (kind && v.kind !== kind)) return null;
  if (!isNonEmptyString(v.id) || typeof v.title !== 'string' || typeof v.artist !== 'string') return null;
  if (!Array.isArray(v.artists) || !v.artists.every((a) => typeof a === 'string')) return null;
  for (const [field, type] of SNAPSHOT_OPTIONAL) if (v[field] !== undefined && typeof v[field] !== type) return null;
  if (v.albumType !== undefined && !ALBUM_TYPES.includes(v.albumType as string)) return null;
  const common = {
    id: v.id,
    url: spotifyUrl(v.kind, v.id),
    title: v.title,
    artists: v.artists as string[],
    artist: v.artist,
    explicit: v.explicit as boolean | undefined,
    albumType: v.albumType as AlbumType | undefined,
    releaseDate: v.releaseDate as string | undefined,
    art: v.art as string | undefined,
  };
  if (v.kind === 'track') {
    return compact<TrackMeta>({
      kind: 'track',
      ...common,
      album: v.album as string | undefined,
      durationMs: v.durationMs as number | undefined,
      durationPrecisionMs: v.durationPrecisionMs as number | undefined,
    });
  }
  return compact<AlbumMeta>({ kind: 'album', ...common, trackCount: v.trackCount as number | undefined });
}

const SNAPSHOT_OPTIONAL: ReadonlyArray<[keyof SpotifySnapshot, 'string' | 'number' | 'boolean']> = [
  ['album', 'string'],
  ['durationMs', 'number'],
  ['durationPrecisionMs', 'number'],
  ['explicit', 'boolean'],
  ['albumType', 'string'],
  ['trackCount', 'number'],
  ['releaseDate', 'string'],
  ['art', 'string'],
];

/** A cached entry's own metadata as an item, to verify a learned Spotify item against it. */
export function entryAsItem(entry: ResolvedEntry): ItemMeta {
  const common = {
    id: '',
    url: '',
    title: entry.title,
    artists: entry.artist ? [entry.artist] : [],
    artist: entry.artist,
    explicit: entry.explicit,
    releaseDate: entry.releaseYear !== undefined ? String(entry.releaseYear) : undefined,
  };
  return entry.kind === 'track'
    ? compact<TrackMeta>({ kind: 'track', ...common, album: entry.album, durationMs: entry.durationMs })
    : compact<AlbumMeta>({ kind: 'album', ...common, trackCount: entry.trackCount });
}

// ---------------------------------------------------------------------------------------------
// After a resolution (background)

/** What recordXref needs from a resolution. */
export interface XrefResolution {
  /** Cache key of the resolved entry. */
  key: string;
  source: ItemMeta;
  /** The entry as written to KV. */
  entry: ResolvedEntry;
  /** The Spotify outcome: via 'source' for Spotify links. */
  spotify: { via: string; match: string };
  /** Normalized identifiers of the result (resolve.ts xrefIdentifiers). */
  identifiers: string[];
}

type OnPatched = (key: string, entry: ResolvedEntry) => void;

/**
 * Spotify source: learn identifier -> Spotify item, then back-fill the entries waiting for it.
 * Other sources still on a Spotify search link: wait for a mapping, and use one learned meanwhile right
 * away. Never throws.
 */
export async function recordXref(store: XrefStore, kv: KVNamespace, r: XrefResolution, onPatched?: OnPatched): Promise<void> {
  try {
    if (!r.identifiers.length) return;
    if (r.spotify.via === 'source') {
      const { waiting, hits } = await store.learn(r.source, r.identifiers);
      if (waiting.length) await backfill(store, kv, r.source.kind, waiting, hits, onPatched);
    } else if (r.spotify.match === 'search') {
      const hits = await store.wait(r.source.kind, r.identifiers, r.key, r.entry.resolvedAt);
      // Verified against the full source item, exactly as at resolve time: the hits that lookup saw are
      // rejected again, only a mapping learned since can be accepted.
      const item = hits.length ? chooseSpotify(r.source, hits.map((h) => h.item)) : null;
      if (!item) return;
      const patched = withSpotify(r.entry, item);
      if (!(await writeEntry(kv, r.key, patched))) return;
      onPatched?.(r.key, patched);
      await store.unwait([r.key]);
    }
  } catch (err) {
    console.error('spotify xref update failed', r.key, err);
  }
}

/**
 * Re-check each waiting entry against the Spotify items mapped to its identifiers (the newly learned one
 * among them) with the normal fuzzy rules, and patch its Spotify link when one is accepted.
 * Done (forgotten): patched, no longer a search link, or gone (absent well after it was resolved).
 * Kept: rejected (a later mapping may fit), a failed KV read or write, an entry not yet visible here, or
 * another resolution than the one that waited (a stale read, or a newer one that waits for itself).
 */
export async function backfill(
  store: XrefStore,
  kv: KVNamespace,
  kind: Kind,
  waiting: WaitingRow[],
  hits: XrefHit[],
  onPatched?: OnPatched,
): Promise<void> {
  const byKey = new Map<string, WaitingRow[]>();
  for (const w of waiting) byKey.set(w.cacheKey, [...(byKey.get(w.cacheKey) ?? []), w]);
  const done = await Promise.all(
    [...byKey].map(async ([key, rows]): Promise<string | null> => {
      const entry = await readEntryState(kv, key);
      if (entry === 'unreadable') return null;
      if (entry === 'absent') return rows.every(resolvedLongAgo) ? key : null;
      if (entry.kind !== kind) return key;
      if (!rows.some((w) => w.resolvedAt === entry.resolvedAt)) return null;
      if (entry.links.spotify.match !== 'search') return key;
      const ids = new Set(rows.map((w) => w.identifier));
      const item = chooseSpotify(
        entryAsItem(entry),
        hits.filter((h) => ids.has(h.identifier)).map((h) => h.item),
      );
      if (!item) return null;
      const patched = withSpotify(entry, item);
      if (!(await writeEntry(kv, key, patched))) return null;
      onPatched?.(key, patched);
      return key;
    }),
  );
  await store.unwait(done.filter((k): k is string => k !== null));
}

/** The Spotify item the normal fuzzy rules accept for this item (pickBest*, threshold, hard rejects), if any. */
export function chooseSpotify(own: ItemMeta, candidates: ItemMeta[]): ItemMeta | null {
  // The first of each id: lookups list the most recently learned first.
  const unique = candidates.filter((c, i) => candidates.findIndex((o) => o.id === c.id) === i);
  if (own.kind === 'track') return pickBestTrack(own, unique.filter(isTrack)).accepted?.item ?? null;
  return pickBestAlbum(own, unique.filter(isAlbum)).accepted?.item ?? null;
}

/** Long enough ago that an entry missing from KV is gone, not just not visible here yet. */
function resolvedLongAgo(w: WaitingRow): boolean {
  const at = Date.parse(w.resolvedAt);
  return !Number.isFinite(at) || Date.now() - at >= XREF_ABSENT_GRACE_MS;
}

function withSpotify(entry: ResolvedEntry, item: ItemMeta): ResolvedEntry {
  return { ...entry, links: { ...entry.links, spotify: { url: item.url, match: 'fuzzy' } } };
}

function isTrack(item: ItemMeta): item is TrackMeta {
  return item.kind === 'track';
}

function isAlbum(item: ItemMeta): item is AlbumMeta {
  return item.kind === 'album';
}

// ---------------------------------------------------------------------------------------------
// D1

/** Most recently learned first: the last tie-break among equally good copies (API order) is recency. */
export const XREF_LOOKUP_SQL = (n: number) =>
  `SELECT identifier, snapshot FROM spotify_xref WHERE kind = ? AND identifier IN (${marks(n)}) ` +
  `ORDER BY updated_at DESC, rowid DESC`;
export const XREF_UPSERT_SQL =
  `INSERT INTO spotify_xref (kind, identifier, spotify_id, snapshot) VALUES (?, ?, ?, ?) ` +
  `ON CONFLICT (kind, identifier, spotify_id) DO UPDATE SET snapshot = excluded.snapshot, updated_at = ${NOW_SQL}`;
/** Keeps the XREF_MAX_PER_IDENTIFIER most recently learned items of one identifier. */
export const XREF_TRIM_SQL =
  `DELETE FROM spotify_xref WHERE kind = ? AND identifier = ? AND rowid NOT IN ` +
  `(SELECT rowid FROM spotify_xref WHERE kind = ? AND identifier = ? ORDER BY updated_at DESC, rowid DESC LIMIT ${XREF_MAX_PER_IDENTIFIER})`;
export const XREF_WAITING_SQL = (n: number) =>
  `SELECT identifier, cache_key, resolved_at FROM spotify_xref_waiting WHERE kind = ? AND identifier IN (${marks(n)}) ` +
  `ORDER BY updated_at DESC LIMIT ${XREF_MAX_WAITING}`;
export const XREF_WAIT_SQL =
  `INSERT INTO spotify_xref_waiting (kind, identifier, cache_key, resolved_at) VALUES (?, ?, ?, ?) ` +
  `ON CONFLICT (kind, identifier, cache_key) DO UPDATE SET resolved_at = excluded.resolved_at, updated_at = ${NOW_SQL}`;
/** Uses the updated_at index; normally deletes nothing. */
export const XREF_PRUNE_SQL = `DELETE FROM spotify_xref_waiting WHERE updated_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)`;
export const XREF_UNWAIT_SQL = (n: number) => `DELETE FROM spotify_xref_waiting WHERE cache_key IN (${marks(n)})`;

type SnapshotRow = { identifier: string; snapshot: string };

export function d1Xref(db: D1Database): XrefStore {
  const lookupStmt = (kind: Kind, ids: string[]) => db.prepare(XREF_LOOKUP_SQL(ids.length)).bind(kind, ...ids);
  const toHits = (kind: Kind, rows: SnapshotRow[]): XrefHit[] =>
    rows.flatMap((row) => {
      const item = fromSnapshot(parseJson(row.snapshot), kind);
      return item ? [{ identifier: row.identifier, item }] : [];
    });

  return {
    async lookup(kind, identifiers) {
      const ids = identifiers.slice(0, XREF_MAX_IDENTIFIERS);
      if (!ids.length) return [];
      try {
        const { results } = await lookupStmt(kind, ids).all<SnapshotRow>();
        return toHits(kind, results);
      } catch (err) {
        console.error('spotify xref lookup failed', err);
        throw err;
      }
    },

    async learn(item, identifiers) {
      const ids = identifiers.slice(0, XREF_MAX_IDENTIFIERS);
      if (!ids.length) return { waiting: [], hits: [] };
      try {
        const snapshot = JSON.stringify(toSnapshot(item));
        const upsert = db.prepare(XREF_UPSERT_SQL);
        const trim = db.prepare(XREF_TRIM_SQL);
        // One round trip (one transaction): the upserts and trims, then the waiting rows and every item
        // now mapped to the same identifiers.
        const results = await db.batch([
          ...ids.map((id) => upsert.bind(item.kind, id, item.id, snapshot)),
          ...ids.map((id) => trim.bind(item.kind, id, item.kind, id)),
          db.prepare(XREF_WAITING_SQL(ids.length)).bind(item.kind, ...ids),
          lookupStmt(item.kind, ids),
        ]);
        const rows = (results.at(-2)?.results ?? []) as Array<{ identifier: string; cache_key: string; resolved_at: string }>;
        return {
          waiting: rows.map((r) => ({ identifier: r.identifier, cacheKey: r.cache_key, resolvedAt: r.resolved_at })),
          hits: toHits(item.kind, (results.at(-1)?.results ?? []) as SnapshotRow[]),
        };
      } catch (err) {
        console.error('spotify xref learn failed', err);
        return { waiting: [], hits: [] };
      }
    },

    async wait(kind, identifiers, cacheKey, resolvedAt) {
      const ids = identifiers.slice(0, XREF_MAX_IDENTIFIERS);
      if (!ids.length) return [];
      try {
        const insert = db.prepare(XREF_WAIT_SQL);
        // One transaction with learn's: either learn sees these rows, or this sees its mapping.
        const results = await db.batch([
          ...ids.map((id) => insert.bind(kind, id, cacheKey, resolvedAt)),
          db.prepare(XREF_PRUNE_SQL).bind(`-${XREF_WAITING_MAX_AGE_SECONDS} seconds`),
          lookupStmt(kind, ids),
        ]);
        return toHits(kind, (results.at(-1)?.results ?? []) as SnapshotRow[]);
      } catch (err) {
        console.error('spotify xref wait failed', cacheKey, err);
        return [];
      }
    },

    async unwait(cacheKeys) {
      const keys = [...new Set(cacheKeys)];
      if (!keys.length) return;
      try {
        await db.prepare(XREF_UNWAIT_SQL(keys.length)).bind(...keys).run();
      } catch (err) {
        console.error('spotify xref unwait failed', err);
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Helpers

function marks(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** Drop undefined fields so stored JSON stays clean. */
function compact<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}
