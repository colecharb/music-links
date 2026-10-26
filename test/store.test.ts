import { env, applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  INSERT_MISS_SQL,
  TTL_COMPLETE_SECONDS,
  TTL_PARTIAL_SECONDS,
  logMisses,
  readEntry,
  ttlFor,
  writeEntry,
} from '../src/store';
import type { MatchType, MissRow, ResolvedEntry, Service } from '../src/types';

function entry(m: Partial<Record<Service, MatchType>> = {}, patch: Partial<ResolvedEntry> = {}): ResolvedEntry {
  const match = (s: Service): MatchType => m[s] ?? 'exact';
  const link = (s: Service) => ({ url: `https://example.com/${s}/1`, match: match(s) });
  return {
    kind: 'track',
    title: 'Get Lucky',
    artist: 'Daft Punk & Pharrell Williams',
    album: 'Random Access Memories',
    durationMs: 369_626,
    releaseYear: 2013,
    isrc: 'USQX91300108',
    art: 'https://i.scdn.co/image/ab67616d0000b2739b9b36b0e22870b9f542d937',
    explicit: false,
    resolvedAt: '2026-10-26T00:00:00.000Z',
    appleMode: 'itunes',
    links: {
      spotify: link('spotify'),
      apple: link('apple'),
      deezer: link('deezer'),
      youtubeMusic: link('youtubeMusic'),
      amazon: link('amazon'),
    },
    ...patch,
  };
}

let keySeq = 0;
const freshKey = () => `sp:t:test${Date.now()}${keySeq++}`;

beforeAll(async () => {
  await applyD1Migrations(env.DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ttlFor', () => {
  it.each<[MatchType, MatchType, number]>([
    ['exact', 'exact', TTL_COMPLETE_SECONDS],
    ['exact', 'fuzzy', TTL_COMPLETE_SECONDS],
    ['fuzzy', 'exact', TTL_COMPLETE_SECONDS],
    ['fuzzy', 'fuzzy', TTL_COMPLETE_SECONDS],
    ['search', 'exact', TTL_PARTIAL_SECONDS],
    ['exact', 'search', TTL_PARTIAL_SECONDS],
    ['fuzzy', 'search', TTL_PARTIAL_SECONDS],
    ['search', 'search', TTL_PARTIAL_SECONDS],
  ])('apple %s + deezer %s -> %i s', (apple, deezer, ttl) => {
    expect(ttlFor(entry({ apple, deezer }))).toBe(ttl);
  });

  it('ignores the other services', () => {
    expect(ttlFor(entry({ spotify: 'search', youtubeMusic: 'search', amazon: 'search' }))).toBe(TTL_COMPLETE_SECONDS);
  });

  it('uses 30 days and 6 hours', () => {
    expect(TTL_COMPLETE_SECONDS).toBe(2_592_000);
    expect(TTL_PARTIAL_SECONDS).toBe(21_600);
  });
});

describe('readEntry / writeEntry', () => {
  it.each<[string, ResolvedEntry, number]>([
    ['complete', entry(), TTL_COMPLETE_SECONDS],
    ['partial', entry({ deezer: 'search' }), TTL_PARTIAL_SECONDS],
    [
      'minimal album',
      {
        kind: 'album',
        title: 'Homework',
        artist: 'Daft Punk',
        resolvedAt: '2026-10-26T00:00:00.000Z',
        appleMode: 'musickit',
        links: entry({ apple: 'fuzzy' }).links,
      },
      TTL_COMPLETE_SECONDS,
    ],
  ])('round-trips a %s entry with its TTL', async (_, value, ttl) => {
    const key = freshKey();
    const before = Math.floor(Date.now() / 1000);
    await writeEntry(env.LINKS, key, value);
    expect(await readEntry(env.LINKS, key)).toEqual(value);
    const { keys } = await env.LINKS.list({ prefix: key });
    expect(keys).toHaveLength(1);
    const expiration = keys[0]?.expiration ?? 0;
    expect(expiration).toBeGreaterThanOrEqual(before + ttl - 5);
    expect(expiration).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000) + ttl + 5);
  });

  it('returns null for a missing key', async () => {
    expect(await readEntry(env.LINKS, freshKey())).toBeNull();
  });

  const valid = entry();
  const { links: _links, ...noLinks } = valid;
  const { amazon: _amazon, ...fourLinks } = valid.links;
  it.each<[string, string]>([
    ['corrupt JSON', '{"kind":"track","title":'],
    ['empty value', ''],
    ['a JSON string', '"hello"'],
    ['JSON null', 'null'],
    ['an array', '[]'],
    ['an empty object', '{}'],
    ['no links', JSON.stringify(noLinks)],
    ['a missing service', JSON.stringify({ ...valid, links: fourLinks })],
    ['an unknown match type', JSON.stringify({ ...valid, links: { ...valid.links, apple: { url: 'https://x', match: 'maybe' } } })],
    ['a link without url', JSON.stringify({ ...valid, links: { ...valid.links, deezer: { match: 'exact' } } })],
    ['an unknown kind', JSON.stringify({ ...valid, kind: 'playlist' })],
    ['an unknown apple mode', JSON.stringify({ ...valid, appleMode: 'scrape' })],
    ['a non-string title', JSON.stringify({ ...valid, title: 42 })],
    ['a mistyped optional field', JSON.stringify({ ...valid, durationMs: '369626' })],
  ])('reads %s as null', async (_, raw) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const key = freshKey();
    await env.LINKS.put(key, raw);
    expect(await readEntry(env.LINKS, key)).toBeNull();
  });

  it('returns null instead of throwing when KV fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = {
      get: async () => {
        throw new Error('KV GET failed: 503');
      },
    } as unknown as KVNamespace;
    expect(await readEntry(broken, 'sp:t:x')).toBeNull();
    expect(log).toHaveBeenCalled();
  });

  it('does not throw when a KV write fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = {
      put: async () => {
        throw new Error('KV PUT failed: 429');
      },
    } as unknown as KVNamespace;
    await expect(writeEntry(broken, 'sp:t:x', entry())).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
  });
});

describe('logMisses', () => {
  const FULL: MissRow = {
    source_key: 'sp:t:full',
    service: 'apple',
    outcome: 'fuzzy',
    source_title: 'Get Lucky',
    source_artist: 'Daft Punk',
    source_duration_ms: 369_626,
    candidate_title: 'Get Lucky (Radio Edit)',
    candidate_artist: 'Daft Punk & Pharrell Williams',
    candidate_duration_ms: 248_000,
    score: 0.87,
    note: 'via search',
  };
  const NULLS: MissRow = {
    source_key: 'sp:t:nulls',
    service: 'amazon',
    outcome: 'error',
    source_title: null,
    source_artist: null,
    source_duration_ms: null,
    candidate_title: null,
    candidate_artist: null,
    candidate_duration_ms: null,
    score: null,
    note: null,
  };

  function countingDb(): { db: D1Database; batches: number[] } {
    const batches: number[] = [];
    const db = {
      prepare: (q: string) => env.DB.prepare(q),
      batch: (stmts: D1PreparedStatement[]) => {
        batches.push(stmts.length);
        return env.DB.batch(stmts);
      },
    } as unknown as D1Database;
    return { db, batches };
  }

  async function rowsFor(...keys: string[]) {
    const { results } = await env.DB.prepare(
      `SELECT * FROM misses WHERE source_key IN (${keys.map(() => '?').join(',')}) ORDER BY id`,
    )
      .bind(...keys)
      .all<Record<string, unknown>>();
    return results;
  }

  it('inserts every column, including nulls, in one batch', async () => {
    const { db, batches } = countingDb();
    await logMisses(db, [FULL, NULLS]);
    expect(batches).toEqual([2]);
    const rows = await rowsFor(FULL.source_key, NULLS.source_key);
    expect(rows).toHaveLength(2);
    for (const [row, expected] of [
      [rows[0], FULL],
      [rows[1], NULLS],
    ] as const) {
      const { id, created_at, ...rest } = row ?? {};
      expect(rest).toEqual(expected);
      expect(typeof id).toBe('number');
      expect(created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it('stores undefined and non-finite numbers as NULL', async () => {
    const row = { ...FULL, source_key: 'sp:t:nonfinite', score: Number.NaN, candidate_duration_ms: undefined };
    await logMisses(env.DB, [row as unknown as MissRow]);
    const [stored] = await rowsFor('sp:t:nonfinite');
    expect(stored?.score).toBeNull();
    expect(stored?.candidate_duration_ms).toBeNull();
    expect(stored?.candidate_title).toBe(FULL.candidate_title);
  });

  it('does nothing for no rows', async () => {
    const db = {
      prepare: () => {
        throw new Error('should not prepare');
      },
      batch: () => {
        throw new Error('should not batch');
      },
    } as unknown as D1Database;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await logMisses(db, []);
    expect(log).not.toHaveBeenCalled();
  });

  it.each<[string, D1Database]>([
    [
      'batch rejects',
      {
        prepare: (q: string) => env.DB.prepare(q),
        batch: async () => {
          throw new Error('D1_ERROR: database is locked');
        },
      } as unknown as D1Database,
    ],
    [
      'prepare throws synchronously',
      {
        prepare: () => {
          throw new Error('no such table');
        },
      } as unknown as D1Database,
    ],
  ])('never throws when %s', async (_, db) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(logMisses(db, [FULL])).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('never throws when the real database rejects the batch (constraint violation)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = { ...FULL, source_key: 'sp:t:badoutcome', outcome: 'bogus' } as unknown as MissRow;
    await expect(logMisses(env.DB, [bad])).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(await rowsFor('sp:t:badoutcome')).toHaveLength(0);
  });

  it('inserts into every MissRow column', () => {
    expect(INSERT_MISS_SQL).toBe(
      'INSERT INTO misses (source_key, service, outcome, source_title, source_artist, source_duration_ms, candidate_title, candidate_artist, candidate_duration_ms, score, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
  });
});
