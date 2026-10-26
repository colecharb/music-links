// Resolution: source metadata -> per-service links, firing upstream calls in parallel wherever the
// dependency graph allows. Each target service is isolated: a failure there yields a search link.
//
// Ladder per API-backed target (Deezer, Apple):
//   1. identifier (ISRC for tracks, UPC for albums) -> 'exact', re-verified against source metadata
//   2. metadata search -> 'fuzzy' only above the confidence threshold
//   3. search URL -> 'search'
// When the source has no identifier (Spotify, YouTube, iTunes-mode Apple), the best Deezer match
// supplies one; identifier lookups based on it are verified with the full (strict) rules.

import type { UpstreamCtx } from './http';
import { UpstreamError } from './http';
import { parseAlbumTitle, parseTitle } from './normalize';
import { pickBestAlbum, pickBestById, pickBestTrack } from './match';
import { cacheKey } from './parse';
import { appleAlbumsByUpc, appleTracksByIsrc, getAppleItem, searchApple } from './sources/apple';
import { amazonSearchUrl } from './sources/amazon';
import { deezerAlbumByUpc, deezerTrackByIsrc, getDeezerItem, searchDeezer } from './sources/deezer';
import { getSpotifyItem, spotifySearchUrl } from './sources/spotify';
import { getYouTubeItem, youtubeMusicSearchUrl } from './sources/youtube';
import type {
  AlbumMeta,
  ItemMeta,
  MatchType,
  MissRow,
  ResolvedEntry,
  SearchQuery,
  Service,
  SourceRef,
  TrackMeta,
} from './types';
import { SERVICE_BY_PLATFORM, SERVICES } from './types';

export type Via = 'source' | 'isrc' | 'upc' | 'search' | 'search-url';

/** What happened for one service; drives the link, the misses log and the smoke report. */
export interface ServiceDetail {
  match: MatchType;
  outcome: 'exact' | 'fuzzy' | 'search' | 'error';
  via: Via;
  url: string;
  item?: ItemMeta;
  score?: number;
  /** Best candidate that was considered but not accepted. */
  rejected?: { item: ItemMeta; score: number; reason?: string };
  /** The ISRC/UPC an exact match was found by. */
  identifier?: string;
  note?: string;
  ms?: number;
}

export interface ResolveResult {
  key: string;
  source: ItemMeta;
  entry: ResolvedEntry;
  details: Record<Service, ServiceDetail>;
  misses: MissRow[];
  ms: number;
}

/** Services whose matching is attempted through an API (the others are search URLs by design). */
const MATCHED_SERVICES: readonly Service[] = ['apple', 'deezer'];

const SEARCH_URL: Record<Service, (q: SearchQuery) => string> = {
  spotify: spotifySearchUrl,
  youtubeMusic: youtubeMusicSearchUrl,
  amazon: amazonSearchUrl,
  // Used only when matching fails: there is no public deep search for these two, so link to their web search.
  apple: (q) => `https://music.apple.com/search?term=${encodeURIComponent(queryText(q))}`,
  deezer: (q) => `https://www.deezer.com/search/${encodeURIComponent(queryText(q))}`,
};

/** Search words added back for hard version tags, so searches surface live/remix/... versions. */
const VERSION_QUERY_WORDS: Record<string, string> = {
  live: 'live',
  remix: 'remix',
  acoustic: 'acoustic',
  instrumental: 'instrumental',
  acapella: 'acapella',
  karaoke: 'karaoke',
  demo: 'demo',
  sped_up: 'sped up',
  slowed: 'slowed',
};

export async function getSourceItem(ctx: UpstreamCtx, ref: SourceRef): Promise<ItemMeta> {
  switch (ref.platform) {
    case 'sp':
      return getSpotifyItem(ctx, ref.kind, ref.id);
    case 'am':
      return getAppleItem(ctx, ref.kind, ref.id);
    case 'dz':
      return getDeezerItem(ctx, ref.kind, ref.id);
    case 'yt':
      return getYouTubeItem(ctx, ref.id);
  }
}

export async function resolveRef(ctx: UpstreamCtx, ref: SourceRef, now: () => number = Date.now): Promise<ResolveResult> {
  const started = now();
  const source = await getSourceItem(ctx, ref);
  const sourceService = SERVICE_BY_PLATFORM[ref.platform];
  const query = buildQuery(source);

  const timed = async (fn: () => Promise<ServiceDetail>): Promise<ServiceDetail> => {
    const t0 = now();
    const d = await fn();
    return { ...d, ms: now() - t0 };
  };

  let deezerP: Promise<{ detail: ServiceDetail; id?: string }>;
  if (sourceService === 'deezer') {
    deezerP = Promise.resolve({ detail: sourceDetail(source) });
  } else {
    const t0 = now();
    deezerP = isolate('deezer', query, () =>
      source.kind === 'track' ? matchDeezerTrack(ctx, source) : matchDeezerAlbum(ctx, source),
    ).then((r) => ({ ...r, detail: { ...r.detail, ms: now() - t0 } }));
  }

  // Identifier for Apple when the source has none: the one carried by the Deezer match.
  const derivedId = deezerP.then(({ detail }) => {
    if (detail.outcome === 'error' || !detail.item) return undefined;
    return detail.item.kind === 'track' ? detail.item.isrc : detail.item.upc;
  });

  const appleP: Promise<ServiceDetail> =
    sourceService === 'apple'
      ? Promise.resolve(sourceDetail(source))
      : timed(() =>
          isolate('apple', query, async () => ({
            detail:
              source.kind === 'track'
                ? await matchAppleTrack(ctx, source, derivedId)
                : await matchAppleAlbum(ctx, source, derivedId),
          })).then((r) => r.detail),
        );

  const [deezer, apple] = await Promise.all([deezerP.then((r) => r.detail), appleP]);

  const details = {} as Record<Service, ServiceDetail>;
  for (const service of SERVICES) {
    if (service === sourceService) details[service] = sourceDetail(source);
    else if (service === 'deezer') details[service] = deezer;
    else if (service === 'apple') details[service] = apple;
    else details[service] = searchDetail(service, query);
  }

  const key = cacheKey(ref);
  const entry = buildEntry(source, details, ctx, now());
  const misses = buildMisses(key, source, details, sourceService);
  return { key, source, entry, details, misses, ms: now() - started };
}

// ---------------------------------------------------------------------------------------------
// Deezer

async function matchDeezerTrack(ctx: UpstreamCtx, source: TrackMeta): Promise<{ detail: ServiceDetail }> {
  if (source.isrc) {
    const hit = await deezerTrackByIsrc(ctx, source.isrc);
    if (hit) {
      const pick = pickBestById(source, [hit], { strict: false });
      if (pick.accepted) return { detail: matched('exact', 'isrc', pick.accepted.item, pick.accepted.score) };
    }
  }
  const results = (await searchDeezer(ctx, buildQuery(source))).filter(isTrack);
  const pick = pickBestTrack(source, results);
  if (!pick.accepted) return { detail: noMatch('deezer', source, pick.ranked) };
  // Apple's identifier lookup needs the ISRC; fetch the full track only when the search hit lacks it.
  let item = pick.accepted.item;
  if (!item.isrc) {
    const full = await getDeezerItem(ctx, 'track', item.id).catch(() => null);
    if (full && full.kind === 'track') item = full;
  }
  return { detail: matched('fuzzy', 'search', item, pick.accepted.score) };
}

async function matchDeezerAlbum(ctx: UpstreamCtx, source: AlbumMeta): Promise<{ detail: ServiceDetail }> {
  if (source.upc) {
    const hit = await deezerAlbumByUpc(ctx, source.upc);
    if (hit) {
      const pick = pickBestById(source, [hit], { strict: false });
      if (pick.accepted) return { detail: matched('exact', 'upc', pick.accepted.item, pick.accepted.score) };
    }
  }
  const results = (await searchDeezer(ctx, buildQuery(source))).filter(isAlbum);
  const pick = pickBestAlbum(source, results);
  if (!pick.accepted) return { detail: noMatch('deezer', source, pick.ranked) };
  // Search results lack the UPC (needed for Apple); fetch the full album.
  const full = await getDeezerItem(ctx, 'album', pick.accepted.item.id).catch(() => null);
  const item = full && full.kind === 'album' ? full : pick.accepted.item;
  return { detail: matched('fuzzy', 'search', item, pick.accepted.score) };
}

// ---------------------------------------------------------------------------------------------
// Apple

async function matchAppleTrack(
  ctx: UpstreamCtx,
  source: TrackMeta,
  derivedIsrc: Promise<string | undefined>,
): Promise<ServiceDetail> {
  // Start the text search right away; it's the fallback for every identifier path.
  const searchP = settle(searchApple(ctx, buildQuery(source)));

  const byIsrc = async (isrc: string, strict: boolean) => {
    const hits = await appleTracksByIsrc(ctx, isrc);
    const pick = pickBestById(source, hits, { strict });
    return pick.accepted ? { ...matched('exact', 'isrc', pick.accepted.item, pick.accepted.score), identifier: isrc } : null;
  };

  if (source.isrc) {
    const hit = await byIsrc(source.isrc, false);
    if (hit) return hit;
  } else {
    const isrc = await derivedIsrc;
    if (isrc) {
      const hit = await byIsrc(isrc, true).catch(() => null);
      if (hit) return hit;
    }
  }

  const query = buildQuery(source);
  const results = await searchWithRetry(
    unwrap(searchP),
    () => searchApple(ctx, altQuery(query)),
    isTrack,
    (c) => pickBestTrack(source, c),
  );
  const pick = pickBestTrack(source, results);
  if (!pick.accepted) return noMatch('apple', source, pick.ranked);
  return matched('fuzzy', 'search', pick.accepted.item, pick.accepted.score);
}

async function matchAppleAlbum(
  ctx: UpstreamCtx,
  source: AlbumMeta,
  derivedUpc: Promise<string | undefined>,
): Promise<ServiceDetail> {
  const searchP = settle(searchApple(ctx, buildQuery(source)));

  const byUpc = async (upc: string, strict: boolean) => {
    const hits = await appleAlbumsByUpc(ctx, upc);
    const pick = pickBestById(source, hits, { strict });
    return pick.accepted ? { ...matched('exact', 'upc', pick.accepted.item, pick.accepted.score), identifier: upc } : null;
  };

  if (source.upc) {
    const hit = await byUpc(source.upc, false);
    if (hit) return hit;
  } else {
    const upc = await derivedUpc;
    if (upc) {
      const hit = await byUpc(upc, true).catch(() => null);
      if (hit) return hit;
    }
  }

  const query = buildQuery(source);
  const results = await searchWithRetry(
    unwrap(searchP),
    () => searchApple(ctx, altQuery(query)),
    isAlbum,
    (c) => pickBestAlbum(source, c),
  );
  const pick = pickBestAlbum(source, results);
  if (!pick.accepted) return noMatch('apple', source, pick.ranked);
  return matched('fuzzy', 'search', pick.accepted.item, pick.accepted.score);
}

// ---------------------------------------------------------------------------------------------
// Helpers

/** Search text: title without featured artists and non-version suffixes, plus the primary artist. */
export function buildQuery(item: ItemMeta): SearchQuery {
  const parsed = item.kind === 'track' ? parseTitle(item.title) : parseAlbumTitle(item.title);
  // Remixer names are spelled consistently across catalogs and the matcher rejects a different remixer,
  // so they belong in the query. Venue strings ("Live In Del Mar, California/1991") vary too much.
  const words = [...parsed.versions].flatMap((v) => {
    const word = VERSION_QUERY_WORDS[v];
    if (!word) return [];
    return v === 'remix' ? [...(parsed.qualifiers.remix ?? []), word] : [word];
  });
  const core = parsed.core || parsed.base || item.title;
  const artist = item.artists[0] ?? item.artist;
  const credits = [...new Set([...item.artists.slice(1), ...parsed.featured])].filter(
    (c) => c.toLowerCase() !== artist.toLowerCase(),
  );
  return {
    kind: item.kind,
    title: [core, ...words].join(' '),
    artist,
    album: item.kind === 'track' ? item.album : undefined,
    credits: credits.length ? credits : undefined,
  };
}

/** Second-chance Apple search when the first found nothing acceptable: see deezerSearchQueries. */
function altQuery(q: SearchQuery): SearchQuery {
  return { ...q, artist: q.credits?.at(-1) ?? '' };
}

/** Run the first search; if nothing clears the threshold, search once more from another angle. */
async function searchWithRetry<T extends ItemMeta>(
  first: Promise<ItemMeta[]>,
  again: () => Promise<ItemMeta[]>,
  keep: (item: ItemMeta) => item is T,
  pick: (cands: T[]) => { accepted: unknown },
): Promise<T[]> {
  const results = (await first).filter(keep);
  if (pick(results).accepted) return results;
  const more = (await again().catch(() => [] as ItemMeta[])).filter(keep);
  const seen = new Set(results.map((r) => r.id));
  return [...results, ...more.filter((m) => !seen.has(m.id))];
}

function queryText(q: SearchQuery): string {
  return `${q.title} ${q.artist}`.trim();
}

function sourceDetail(source: ItemMeta): ServiceDetail {
  return { match: 'exact', outcome: 'exact', via: 'source', url: source.url, item: source };
}

function searchDetail(service: Service, query: SearchQuery): ServiceDetail {
  return { match: 'search', outcome: 'search', via: 'search-url', url: SEARCH_URL[service](query) };
}

function matched(match: 'exact' | 'fuzzy', via: Via, item: ItemMeta, score: number): ServiceDetail {
  return { match, outcome: match, via, url: item.url, item, score };
}

type Ranked = { item: ItemMeta; score: number; reject?: string }[];

function noMatch(service: Service, source: ItemMeta, ranked: Ranked): ServiceDetail {
  const best = ranked[0];
  return {
    ...searchDetail(service, buildQuery(source)),
    rejected: best ? { item: best.item, score: best.score, reason: best.reject } : undefined,
    note: best ? (best.reject ?? `score ${best.score.toFixed(2)} below threshold`) : 'no candidates',
  };
}

/** Run one service's matching; any failure becomes a search link with outcome 'error'. */
async function isolate<T extends { detail: ServiceDetail }>(
  service: Service,
  query: SearchQuery,
  fn: () => Promise<T>,
): Promise<T | { detail: ServiceDetail }> {
  try {
    return await fn();
  } catch (err) {
    const note = err instanceof UpstreamError ? err.message : `unexpected: ${String(err)}`;
    return { detail: { ...searchDetail(service, query), outcome: 'error', note } };
  }
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Start a promise now without risking an unhandled rejection if nobody ends up awaiting it. */
function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

async function unwrap<T>(p: Promise<Settled<T>>): Promise<T> {
  const r = await p;
  if (r.ok) return r.value;
  throw r.error;
}

function isTrack(item: ItemMeta): item is TrackMeta {
  return item.kind === 'track';
}

function isAlbum(item: ItemMeta): item is AlbumMeta {
  return item.kind === 'album';
}

function buildEntry(
  source: ItemMeta,
  details: Record<Service, ServiceDetail>,
  ctx: UpstreamCtx,
  nowMs: number,
): ResolvedEntry {
  const links = {} as ResolvedEntry['links'];
  for (const service of SERVICES) links[service] = { url: details[service].url, match: details[service].match };

  const matchedItems = MATCHED_SERVICES.map((s) => details[s])
    .filter((d) => d.match !== 'search' && d.item)
    .map((d) => d.item as ItemMeta);
  // YouTube thumbnails are letterboxed 4:3 video frames; prefer square cover art from a match.
  const art =
    source.url.includes('youtube.com') || !source.art ? (matchedItems.find((i) => i.art)?.art ?? source.art) : source.art;

  const year = source.releaseDate ? Number(source.releaseDate.slice(0, 4)) : NaN;
  // The source's own identifier, else one confirmed by an exact identifier match on another service.
  const identifier = (k: 'isrc' | 'upc') =>
    (source as Partial<Record<'isrc' | 'upc', string>>)[k] ??
    MATCHED_SERVICES.map((s) => details[s]).find((d) => d.match === 'exact' && d.via === k)?.identifier;

  return {
    kind: source.kind,
    title: source.title,
    artist: source.artist,
    album: source.kind === 'track' ? source.album : undefined,
    durationMs: source.kind === 'track' ? source.durationMs : undefined,
    releaseYear: Number.isFinite(year) ? year : undefined,
    isrc: source.kind === 'track' ? identifier('isrc') : undefined,
    upc: source.kind === 'album' ? identifier('upc') : undefined,
    art,
    explicit: source.explicit,
    resolvedAt: new Date(nowMs).toISOString(),
    appleMode: ctx.apple ? 'musickit' : 'itunes',
    links,
  };
}

function buildMisses(
  key: string,
  source: ItemMeta,
  details: Record<Service, ServiceDetail>,
  sourceService: Service,
): MissRow[] {
  const rows: MissRow[] = [];
  for (const service of MATCHED_SERVICES) {
    if (service === sourceService) continue;
    const d = details[service];
    if (d.outcome === 'exact') continue;
    const candidate = d.outcome === 'fuzzy' ? d.item : d.rejected?.item;
    rows.push({
      source_key: key,
      service,
      outcome: d.outcome,
      source_title: source.title,
      source_artist: source.artist,
      source_duration_ms: source.kind === 'track' ? (source.durationMs ?? null) : null,
      candidate_title: candidate?.title ?? null,
      candidate_artist: candidate?.artist ?? null,
      candidate_duration_ms: candidate?.kind === 'track' ? (candidate.durationMs ?? null) : null,
      score: d.outcome === 'fuzzy' ? (d.score ?? null) : (d.rejected?.score ?? null),
      note: d.note ?? (d.outcome === 'fuzzy' ? `via ${d.via}` : null),
    });
  }
  return rows;
}
