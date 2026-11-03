// Resolution: source metadata -> per-service links, firing upstream calls in parallel wherever the
// dependency graph allows. Each target service is isolated: a failure there yields a search link.
//
// Ladder per API-backed target (Deezer, Apple):
//   1. identifier (ISRC for tracks, UPC for albums) -> 'exact', re-verified against source metadata
//   2. metadata search -> 'fuzzy' only above the confidence threshold (started alongside step 1, and
//      also reached when the identifier lookup fails)
//   3. search URL -> 'search'
// When the source has no identifier (Spotify, YouTube, iTunes-mode Apple), the best Deezer match
// supplies one; identifier lookups based on it are verified with the full (strict) rules.
//
// Spotify (no API) when it isn't the source: the identifiers of the source and of the Deezer/Apple
// matches are looked up in the learned cross-reference (src/xref.ts), and the Spotify items found are
// verified with the full fuzzy rules -> 'fuzzy' via 'xref'; otherwise a search URL.

import type { UpstreamCtx } from './http';
import { UpstreamError } from './http';
import { parseAlbumTitle, parseTitle } from './normalize';
import { pickBestAlbum, pickBestById, pickBestTrack, type PickResult } from './match';
import { cacheKey } from './parse';
import { appleAlbumsByUpc, appleTracksByIsrc, getAppleItem, searchApple } from './sources/apple';
import { amazonSearchUrl } from './sources/amazon';
import { deezerAlbumByUpc, deezerTrackByIsrc, getDeezerItem, searchDeezer } from './sources/deezer';
import { getSpotifyItem, spotifySearchUrl } from './sources/spotify';
import { getYouTubeItem, youtubeMusicSearchUrl } from './sources/youtube';
import type {
  AlbumMeta,
  ItemMeta,
  Kind,
  MatchType,
  MissRow,
  ResolvedEntry,
  SearchQuery,
  Service,
  SourceRef,
  TrackMeta,
} from './types';
import { SERVICE_BY_PLATFORM, SERVICES } from './types';
import { normalizeIdentifiers, type XrefHit, type XrefReader } from './xref';

export type Via = 'source' | 'isrc' | 'upc' | 'search' | 'search-url' | 'xref';

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
  /** The ISRC/UPC an exact (or Spotify 'xref') match was found by. */
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

export interface ResolveOptions {
  /** Clock, injectable for tests. */
  now?: () => number;
  /** Learned ISRC/UPC -> Spotify items. Without it, Spotify is a search link unless it is the source. */
  xref?: XrefReader;
}

/** Services whose matching is attempted through an API (the others are search URLs by design). */
const MATCHED_SERVICES: readonly Service[] = ['apple', 'deezer'];

/** A cross-reference lookup slower than this counts as failed (search link); D1 is normally far faster. */
export const XREF_LOOKUP_TIMEOUT_MS = 1000;

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

/** `options` may also be the clock alone (the former third parameter). */
export async function resolveRef(
  ctx: UpstreamCtx,
  ref: SourceRef,
  options: ResolveOptions | (() => number) = {},
): Promise<ResolveResult> {
  const { now = Date.now, xref } = typeof options === 'function' ? { now: options } : options;
  const started = now();
  const source = await getSourceItem(ctx, ref);
  const sourceService = SERVICE_BY_PLATFORM[ref.platform];
  const query = buildQuery(source);

  // Spotify by cross-reference: the source's own identifier right away, the matches' once they finish.
  const xrefT0 = now();
  const spotifyXref = xref && sourceService !== 'spotify' ? xrefLookups(xref, source.kind) : undefined;
  spotifyXref?.ask([identifierOf(source)]);

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
  // Usually Deezer finishes first (Apple often waits for its identifier): look its identifier up meanwhile.
  void deezerP.then(({ detail }) => spotifyXref?.ask([matchedIdentifier(detail, source.kind)]));

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

  let spotify: ServiceDetail | undefined;
  if (spotifyXref) {
    // At most one more round trip: identifiers only the Apple match carries.
    spotifyXref.ask([matchedIdentifier(deezer, source.kind), matchedIdentifier(apple, source.kind)]);
    spotify = { ...spotifyByXref(source, query, await spotifyXref.results()), ms: now() - xrefT0 };
  }

  const details = {} as Record<Service, ServiceDetail>;
  for (const service of SERVICES) {
    if (service === sourceService) details[service] = sourceDetail(source);
    else if (service === 'deezer') details[service] = deezer;
    else if (service === 'apple') details[service] = apple;
    else if (service === 'spotify' && spotify) details[service] = spotify;
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
  // Start the search right away; it runs during the ISRC lookup and is used only if that finds nothing.
  const searchP = settle(searchDeezer(ctx, buildQuery(source)));
  const isrc = source.isrc;
  const byIsrc = isrc
    ? async () => {
        const hit = await deezerTrackByIsrc(ctx, isrc);
        return hit ? exactMatch('isrc', isrc, pickBestById(source, [hit], { strict: false })) : null;
      }
    : undefined;
  const detail = await ladder('isrc', byIsrc, async () => {
    const results = (await unwrap(searchP)).filter(isTrack);
    const pick = pickBestTrack(source, results);
    if (!pick.accepted) return noMatch('deezer', source, pick.ranked);
    // Apple's identifier lookup needs the ISRC; fetch the full track only when the search hit lacks it.
    let item = pick.accepted.item;
    if (!item.isrc) {
      const full = await getDeezerItem(ctx, 'track', item.id).catch(() => null);
      if (full && full.kind === 'track') item = full;
    }
    return matched('fuzzy', 'search', item, pick.accepted.score);
  });
  return { detail };
}

async function matchDeezerAlbum(ctx: UpstreamCtx, source: AlbumMeta): Promise<{ detail: ServiceDetail }> {
  const searchP = settle(searchDeezer(ctx, buildQuery(source)));
  const upc = source.upc;
  const byUpc = upc
    ? async () => {
        const hit = await deezerAlbumByUpc(ctx, upc);
        return hit ? exactMatch('upc', upc, pickBestById(source, [hit], { strict: false })) : null;
      }
    : undefined;
  const detail = await ladder('upc', byUpc, async () => {
    const results = (await unwrap(searchP)).filter(isAlbum);
    const pick = pickBestAlbum(source, results);
    if (!pick.accepted) return noMatch('deezer', source, pick.ranked);
    // Search results lack the UPC (needed for Apple); fetch the full album.
    const full = await getDeezerItem(ctx, 'album', pick.accepted.item.id).catch(() => null);
    const item = full && full.kind === 'album' ? full : pick.accepted.item;
    return matched('fuzzy', 'search', item, pick.accepted.score);
  });
  return { detail };
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
  const isrc = source.isrc ?? (await derivedIsrc);
  const byIsrc = isrc
    ? async () => exactMatch('isrc', isrc, pickBestById(source, await appleTracksByIsrc(ctx, isrc), { strict: !source.isrc }))
    : undefined;
  return ladder('isrc', byIsrc, async () => {
    const results = await searchWithRetry(
      unwrap(searchP),
      () => searchApple(ctx, altQuery(buildQuery(source))),
      isTrack,
      (c) => pickBestTrack(source, c),
    );
    const pick = pickBestTrack(source, results);
    if (!pick.accepted) return noMatch('apple', source, pick.ranked);
    return matched('fuzzy', 'search', pick.accepted.item, pick.accepted.score);
  });
}

async function matchAppleAlbum(
  ctx: UpstreamCtx,
  source: AlbumMeta,
  derivedUpc: Promise<string | undefined>,
): Promise<ServiceDetail> {
  const searchP = settle(searchApple(ctx, buildQuery(source)));
  const upc = source.upc ?? (await derivedUpc);
  const byUpc = upc
    ? async () => exactMatch('upc', upc, pickBestById(source, await appleAlbumsByUpc(ctx, upc), { strict: !source.upc }))
    : undefined;
  return ladder('upc', byUpc, async () => {
    const results = await searchWithRetry(
      unwrap(searchP),
      () => searchApple(ctx, altQuery(buildQuery(source))),
      isAlbum,
      (c) => pickBestAlbum(source, c),
    );
    const pick = pickBestAlbum(source, results);
    if (!pick.accepted) return noMatch('apple', source, pick.ranked);
    return matched('fuzzy', 'search', pick.accepted.item, pick.accepted.score);
  });
}

// ---------------------------------------------------------------------------------------------
// Spotify (cross-reference)

interface XrefLookups {
  /** Look up the identifiers not asked for yet (one call for all of them). */
  ask(raw: ReadonlyArray<string | undefined>): void;
  /** Every hit so far, and the first lookup error. */
  results(): Promise<{ hits: XrefHit[]; error?: string }>;
}

function xrefLookups(xref: XrefReader, kind: Kind): XrefLookups {
  const asked = new Set<string>();
  const pending: Array<Promise<Settled<XrefHit[]>>> = [];
  return {
    ask(raw) {
      const ids = normalizeIdentifiers(kind, raw).filter((id) => !asked.has(id));
      if (!ids.length) return;
      for (const id of ids) asked.add(id);
      let lookup: Promise<XrefHit[]>;
      try {
        lookup = xref.lookup(kind, ids);
      } catch (err) {
        lookup = Promise.reject(err);
      }
      pending.push(settle(withTimeout(lookup, XREF_LOOKUP_TIMEOUT_MS)));
    },
    async results() {
      const settled = await Promise.all(pending);
      const failed = settled.find((s) => !s.ok);
      return {
        hits: settled.flatMap((s) => (s.ok ? s.value : [])),
        error: failed && !failed.ok ? (failed.error instanceof Error ? failed.error.message : String(failed.error)) : undefined,
      };
    },
  };
}

/**
 * The learned Spotify items, chosen like search hits (pickBest*, threshold, every hard reject). Never
 * 'exact': the identifier -> Spotify link was itself learned from a fuzzy match.
 */
function spotifyByXref(source: ItemMeta, query: SearchQuery, found: { hits: XrefHit[]; error?: string }): ServiceDetail {
  const byId = new Map<string, XrefHit>();
  for (const hit of found.hits) if (hit.item.kind === source.kind && !byId.has(hit.item.id)) byId.set(hit.item.id, hit);
  const hits = [...byId.values()];
  const note = found.error ? `xref lookup failed: ${found.error}` : undefined;
  if (!hits.length) return withNote(searchDetail('spotify', query), note);
  const pick =
    source.kind === 'track'
      ? pickBestTrack(source, hits.map((h) => h.item).filter(isTrack))
      : pickBestAlbum(source, hits.map((h) => h.item).filter(isAlbum));
  if (!pick.accepted) return withNote(noMatch('spotify', source, pick.ranked), note);
  const item = pick.accepted.item;
  return { ...matched('fuzzy', 'xref', item, pick.accepted.score), identifier: byId.get(item.id)?.identifier };
}

/**
 * Normalized ISRCs (tracks) or UPCs (albums) of a result for the Spotify cross-reference: the source's
 * own, those of the exact/fuzzy Deezer and Apple matches, and the entry's. For a Spotify source (the
 * identifiers it is learned under), none carried by a match of the other edition (explicit vs clean):
 * that identifier names another recording, and a later source of that edition would get this one.
 */
export function xrefIdentifiers(r: Pick<ResolveResult, 'source' | 'entry' | 'details'>): string[] {
  const kind = r.source.kind;
  const ids = normalizeIdentifiers(kind, [
    identifierOf(r.source),
    ...MATCHED_SERVICES.map((s) => matchedIdentifier(r.details[s], kind)),
    kind === 'track' ? r.entry.isrc : r.entry.upc,
  ]);
  if (r.details.spotify.via !== 'source') return ids;
  const otherEdition = normalizeIdentifiers(
    kind,
    MATCHED_SERVICES.flatMap((s) => {
      const d = r.details[s];
      const id = matchedIdentifier(d, kind);
      return id !== undefined && explicitDiffers(r.source, d.item) ? [id, d.identifier] : [];
    }),
  );
  return ids.filter((id) => !otherEdition.includes(id));
}

function explicitDiffers(a: ItemMeta, b: ItemMeta | undefined): boolean {
  return a.explicit !== undefined && b?.explicit !== undefined && a.explicit !== b.explicit;
}

function identifierOf(item: ItemMeta): string | undefined {
  return item.kind === 'track' ? item.isrc : item.upc;
}

/** The ISRC/UPC of an exact or fuzzy match (Deezer items carry it; Apple items in MusicKit mode). */
function matchedIdentifier(d: ServiceDetail, kind: Kind): string | undefined {
  if ((d.outcome !== 'exact' && d.outcome !== 'fuzzy') || !d.item || d.item.kind !== kind) return undefined;
  return identifierOf(d.item);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

// ---------------------------------------------------------------------------------------------
// Ladder

/**
 * Identifier step, then the metadata search. A failed lookup (timeout, 5xx, quota) counts as no hit:
 * the search still decides, and the lookup's error is kept in the note for the misses log. Only a
 * failing search makes the whole service an 'error'.
 */
async function ladder(
  via: 'isrc' | 'upc',
  lookup: (() => Promise<ServiceDetail | null>) | undefined,
  search: () => Promise<ServiceDetail>,
): Promise<ServiceDetail> {
  let lookupNote: string | undefined;
  if (lookup) {
    try {
      const hit = await lookup();
      if (hit) return hit;
    } catch (err) {
      lookupNote = `${via} lookup failed: ${errorText(err)}`;
    }
  }
  try {
    return withNote(await search(), lookupNote);
  } catch (err) {
    if (lookupNote && err instanceof UpstreamError) throw new UpstreamError(`${lookupNote}; ${err.message}`, err.status);
    throw err;
  }
}

function exactMatch(via: 'isrc' | 'upc', identifier: string, pick: PickResult<ItemMeta>): ServiceDetail | null {
  return pick.accepted ? { ...matched('exact', via, pick.accepted.item, pick.accepted.score), identifier } : null;
}

function withNote(detail: ServiceDetail, note: string | undefined): ServiceDetail {
  if (!note) return detail;
  return { ...detail, note: detail.note ? `${note}; ${detail.note}` : note };
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
    return { detail: { ...searchDetail(service, query), outcome: 'error', note: errorText(err) } };
  }
}

function errorText(err: unknown): string {
  return err instanceof UpstreamError ? err.message : `unexpected: ${String(err)}`;
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
    trackCount: source.kind === 'album' ? source.trackCount : undefined,
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
