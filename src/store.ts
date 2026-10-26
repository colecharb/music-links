// Resolved-links cache (KV) and the misses log (D1). Storage problems are logged, never thrown:
// a cache or log failure must not break a page.
import { isDirect, SERVICES } from './types';
import type { MissRow, ResolvedEntry, ServiceLink } from './types';

export const TTL_COMPLETE_SECONDS = 30 * 24 * 3600;
/** Short so releases that Apple/Deezer index late get their direct links on a later visit. */
export const TTL_PARTIAL_SECONDS = 6 * 3600;

/** Column order of the INSERT; covers every MissRow field. */
export const MISS_COLUMNS = [
  'source_key',
  'service',
  'outcome',
  'source_title',
  'source_artist',
  'source_duration_ms',
  'candidate_title',
  'candidate_artist',
  'candidate_duration_ms',
  'score',
  'note',
] as const satisfies readonly (keyof MissRow)[];

export const INSERT_MISS_SQL = `INSERT INTO misses (${MISS_COLUMNS.join(', ')}) VALUES (${MISS_COLUMNS.map(() => '?').join(', ')})`;

const MATCH_TYPES: readonly string[] = ['exact', 'fuzzy', 'search'];
const APPLE_MODES: readonly string[] = ['musickit', 'itunes'];

/** Long TTL only once both services that commonly lag on new releases have a direct link. */
export function ttlFor(entry: ResolvedEntry): number {
  return isDirect(entry.links.apple) && isDirect(entry.links.deezer) ? TTL_COMPLETE_SECONDS : TTL_PARTIAL_SECONDS;
}

export async function readEntry(kv: KVNamespace, key: string): Promise<ResolvedEntry | null> {
  let text: string | null;
  try {
    text = await kv.get(key, 'text');
  } catch (err) {
    console.error('kv read failed', key, err);
    return null;
  }
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (isResolvedEntry(value)) return value;
  } catch {
    // fall through
  }
  console.error('kv entry has an unknown shape, ignoring', key);
  return null;
}

export async function writeEntry(kv: KVNamespace, key: string, entry: ResolvedEntry): Promise<void> {
  try {
    await kv.put(key, JSON.stringify(entry), { expirationTtl: ttlFor(entry) });
  } catch (err) {
    console.error('kv write failed', key, err);
  }
}

export async function logMisses(db: D1Database, rows: MissRow[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    const stmt = db.prepare(INSERT_MISS_SQL);
    await db.batch(rows.map((row) => stmt.bind(...MISS_COLUMNS.map((col) => bindable(row[col])))));
  } catch (err) {
    console.error('logging misses failed', err);
  }
}

/** D1 rejects undefined and stores NaN/Infinity badly; both become NULL. */
function bindable(v: string | number | null | undefined): string | number | null {
  if (v === undefined) return null;
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  return v;
}

/**
 * Structural check of a cached value. Anything else (older layouts, a service added since the
 * entry was written, manual edits) reads as a miss and gets re-resolved.
 */
export function isResolvedEntry(v: unknown): v is ResolvedEntry {
  if (!isRecord(v)) return false;
  if (v.kind !== 'track' && v.kind !== 'album') return false;
  // Empty strings are tolerated: rejecting them would re-resolve the same item on every visit.
  if (typeof v.title !== 'string' || typeof v.artist !== 'string') return false;
  if (typeof v.resolvedAt !== 'string' || typeof v.appleMode !== 'string' || !APPLE_MODES.includes(v.appleMode)) {
    return false;
  }
  if (!optional(v.album, 'string') || !optional(v.isrc, 'string') || !optional(v.upc, 'string')) return false;
  if (!optional(v.art, 'string') || !optional(v.explicit, 'boolean')) return false;
  if (!optional(v.durationMs, 'number') || !optional(v.releaseYear, 'number')) return false;
  const links = v.links;
  if (!isRecord(links)) return false;
  return SERVICES.every((s) => isServiceLink(links[s]));
}

function isServiceLink(v: unknown): v is ServiceLink {
  return isRecord(v) && isNonEmptyString(v.url) && typeof v.match === 'string' && MATCH_TYPES.includes(v.match);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function optional(v: unknown, type: 'string' | 'number' | 'boolean'): boolean {
  return v === undefined || typeof v === type;
}
