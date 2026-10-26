// Scores candidate tracks/albums from another platform against a source item.
// A wrong direct link is much worse than a search link, so every doubt rejects.
import type { AlbumMeta, AlbumType, ItemMeta, TrackMeta } from './types';
import {
  artistPieces,
  bigramDice,
  fold,
  parseAlbumTitle,
  parseTitle,
  qualifierConflicts,
  sameQualifiedVersion,
  skeleton,
  splitArtists,
  stripHonorifics,
  titleSimilarity,
  transliterate,
  VARIANT_PREFIX,
  type HardTag,
  type ParsedAlbumTitle,
  type ParsedTitle,
} from './normalize';

export const DURATION_TOLERANCE_MS = 3000;
/** Added per side whose duration is whole seconds (durationPrecisionMs >= 1000). */
export const DURATION_PRECISION_SLACK_MS = 500;
/** Durations closer than this score as identical. */
export const DURATION_EXACT_MS = 1000;
export const TITLE_MIN = 0.8;
/** When either duration is unknown, a weak title is too risky. */
export const TITLE_MIN_NO_DURATION = 0.9;
export const ALBUM_TITLE_MIN = 0.8;
export const TRACK_COUNT_TOLERANCE = 1;
export const RELEASE_YEAR_TOLERANCE = 1;
export const ACCEPT_TRACK = 0.7;
export const ACCEPT_ALBUM = 0.7;
export const TIE_EPSILON = 0.02;
/** Artist names this similar (character bigrams) are the same name. */
export const ARTIST_NAME_MIN_DICE = 0.9;
/** Across scripts ("Виктор Цой" / "Viktor Tsoi"): transliterations this similar with equal consonant skeletons. */
export const ARTIST_TRANSLIT_MIN_DICE = 0.8;
/** Identifier lookups (non-strict) reject only when the artist AND the title are this far off. */
export const ID_TITLE_MIN = 0.5;
/** Variant labels this similar may be one label in two languages ("mixte" / "mixed"). */
export const VARIANT_COGNATE_MIN_DICE = 0.5;

export const TRACK_WEIGHTS = { title: 0.45, artist: 0.25, duration: 0.2, album: 0.1 } as const;
export const ALBUM_WEIGHTS = { title: 0.45, artist: 0.25, trackCount: 0.15, year: 0.15 } as const;

export const ARTIST_SCORE = { full: 1, primary: 0.9, secondary: 0.8 } as const;
/** Duration score at the tolerance edge, and when either duration is unknown. */
export const DURATION_SCORE_AT_TOLERANCE = 0.5;
export const DURATION_SCORE_UNKNOWN = 0.6;
/** Album similarity when either album title is unknown. */
export const ALBUM_SIM_UNKNOWN = 0.5;
export const TRACK_COUNT_SCORE = { equal: 1, offByOne: 0.7, unknown: 0.5 } as const;
export const YEAR_SCORE = { close: 1, unknown: 0.5, far: 0.3 } as const;

export const PENALTY = {
  /** Per soft-tag mismatch (remaster, mono, variant, ...), capped at softMax. */
  soft: 0.03,
  softMax: 0.09,
  /** Albums: deluxe/edition mismatch. */
  deluxe: 0.05,
  /** Source explicit, candidate clean. */
  explicitLost: 0.06,
  /** Source clean, candidate explicit. */
  explicitGained: 0.03,
  compilation: 0.04,
  featuredDisjoint: 0.03,
  /**
   * A featured artist in one title that the other side credits nowhere ("Alors On Danse (Featuring Erik
   * Hassle)" vs Stromae alone): usually a different version. Large enough that it is accepted alone only
   * when everything else agrees.
   */
  featuredUncredited: 0.15,
  /** Edit vs extended vs original labels whose durations (albums: track counts) agree. */
  editExtended: 0.05,
  /** Albums: single/EP vs album. */
  albumType: 0.1,
} as const;

/** Edit/extended labels are applied inconsistently across platforms; a matching duration settles it. */
const DURATION_PROVABLE_TAGS: ReadonlySet<HardTag> = new Set(['edit', 'extended']);

const VARIOUS_ARTISTS: ReadonlySet<string> = new Set([
  'various artists',
  'various',
  'va',
  'verschiedene interpreten',
  'verschiedene kunstler',
  'artistes divers',
  'artistes varies',
  'varios artistas',
  'artistas varios',
  'artisti vari',
  'various performers',
]);

const COMPILATION_RE =
  /(?:^| )(?:best of|greatest hits|the very best|hits|collection|anthology|essentials?|gold|now thats what i call|various)(?= |$)/u;

export type Details = Record<string, number | string>;

export interface ScoreResult {
  score: number;
  reject?: string;
  details: Details;
}

export interface RankedCandidate<T> {
  item: T;
  score: number;
  reject?: string;
  details: Details;
}

export interface PickResult<T> {
  accepted: { item: T; score: number; details: Details } | null;
  /** Best first; rejected candidates last, with their reasons (for the misses log). */
  ranked: Array<RankedCandidate<T>>;
}

export interface VerifyOptions {
  /** false: the identifier came from the source platform itself. true: it was derived from a fuzzy match. */
  strict: boolean;
}

// ---------------------------------------------------------------------------------------------
// Artists

interface ArtistSide {
  artists: string[];
  artist: string;
}

export interface ArtistMatch {
  match: boolean;
  score: number;
  note?: string;
}

interface ArtistInfo {
  primaries: string[];
  names: string[];
  pieces: string[];
  various: boolean;
}

function unique(xs: string[]): string[] {
  return [...new Set(xs.filter((x) => x.length > 0))];
}

function artistInfo(side: ArtistSide): ArtistInfo {
  const entries = [...side.artists, side.artist].filter((s) => s && s.trim());
  const primaryEntry = entries[0] ?? '';
  return {
    primaries: unique([fold(primaryEntry), artistPieces(primaryEntry)[0] ?? ''].map(stripHonorifics)),
    names: unique(splitArtists(entries).map(stripHonorifics)),
    pieces: unique(entries.flatMap(artistPieces).map(stripHonorifics)),
    various: VARIOUS_ARTISTS.has(fold(primaryEntry)),
  };
}

function sameSpelling(a: string, b: string): boolean {
  return a === b || a.replace(/ /g, '') === b.replace(/ /g, '') || bigramDice(a, b) >= ARTIST_NAME_MIN_DICE;
}

/**
 * Same artist name (folded input): equal, equal ignoring spaces ("jay z"/"jayz"), nearly identical
 * spelling, or the same name in Cyrillic/Greek and Latin ("Кино"/"Kino"). No containment.
 */
export function sameArtistName(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (sameSpelling(a, b)) return true;
  const ta = transliterate(a);
  const tb = transliterate(b);
  if (ta === a && tb === b) return false;
  return sameSpelling(ta, tb) || (bigramDice(ta, tb) >= ARTIST_TRANSLIT_MIN_DICE && skeleton(ta) === skeleton(tb));
}

function anyEq(as: string[], bs: string[]): boolean {
  return as.some((a) => bs.some((b) => sameArtistName(a, b)));
}

/** Whether the candidate credits the source's artist (or vice versa), and how completely. */
export function artistMatch(src: ArtistSide, cand: ArtistSide): ArtistMatch {
  const s = artistInfo(src);
  const c = artistInfo(cand);
  if (!s.primaries.length || !c.primaries.length) return { match: false, score: 0, note: 'artist unknown' };
  if (s.various || c.various) {
    return s.various && c.various
      ? { match: true, score: ARTIST_SCORE.primary, note: 'various artists' }
      : { match: false, score: 0, note: 'various artists' };
  }
  if (!anyEq(s.primaries, c.names) && !anyEq(c.primaries, s.names)) return { match: false, score: 0 };
  if (!anyEq(s.primaries, c.primaries)) return { match: true, score: ARTIST_SCORE.secondary, note: 'via secondary artist' };
  const full = s.pieces.every((p) => anyEq([p], c.names)) && c.pieces.every((p) => anyEq([p], s.names));
  return { match: true, score: full ? ARTIST_SCORE.full : ARTIST_SCORE.primary };
}

// ---------------------------------------------------------------------------------------------
// Shared helpers

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function symmetricDiff<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): T[] {
  return [...[...a].filter((x) => !b.has(x)), ...[...b].filter((x) => !a.has(x))];
}

function tagLabel(tags: ReadonlySet<string>): string {
  return tags.size ? [...tags].sort().join('+') : 'studio';
}

function explicitPenalty(src: { explicit?: boolean }, cand: { explicit?: boolean }): number {
  if (src.explicit === true && cand.explicit === false) return PENALTY.explicitLost;
  if (src.explicit === false && cand.explicit === true) return PENALTY.explicitGained;
  return 0;
}

function softPenalty(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  return Math.min(PENALTY.softMax, symmetricDiff(a, b).length * PENALTY.soft);
}

function yearOf(date: string | undefined): number | undefined {
  const y = date ? Number.parseInt(date.slice(0, 4), 10) : Number.NaN;
  return Number.isFinite(y) ? y : undefined;
}

function isCompilationTitle(parsed: ParsedAlbumTitle | undefined): boolean {
  return !!parsed && COMPILATION_RE.test(parsed.base);
}

// ---------------------------------------------------------------------------------------------
// Tracks

interface DurationCheck {
  known: boolean;
  diffMs?: number;
  slackMs: number;
  within: boolean;
  score: number;
}

function precisionOf(t: TrackMeta): number {
  // Unspecified precision on a whole-second value is treated as whole seconds.
  return t.durationPrecisionMs ?? ((t.durationMs ?? 0) % 1000 === 0 ? 1000 : 1);
}

function compareDurations(src: TrackMeta, cand: TrackMeta): DurationCheck {
  const slackMs =
    (precisionOf(src) >= 1000 ? DURATION_PRECISION_SLACK_MS : 0) + (precisionOf(cand) >= 1000 ? DURATION_PRECISION_SLACK_MS : 0);
  if (!src.durationMs || !cand.durationMs) return { known: false, slackMs, within: true, score: DURATION_SCORE_UNKNOWN };
  const diffMs = cand.durationMs - src.durationMs;
  const effective = Math.max(0, Math.abs(diffMs) - slackMs);
  const within = effective <= DURATION_TOLERANCE_MS;
  const score =
    effective <= DURATION_EXACT_MS
      ? 1
      : within
        ? 1 - ((1 - DURATION_SCORE_AT_TOLERANCE) * (effective - DURATION_EXACT_MS)) / (DURATION_TOLERANCE_MS - DURATION_EXACT_MS)
        : 0;
  return { known: true, diffMs, slackMs, within, score };
}

/** Truncated, so a value just under a threshold never prints as the threshold itself. */
function formatScore(x: number): string {
  return (Math.floor(x * 100) / 100).toFixed(2);
}

function formatSeconds(ms: number): string {
  return `${ms >= 0 ? '+' : '-'}${(Math.abs(ms) / 1000).toFixed(1)}s`;
}

/**
 * Title tags, plus 'live' when the containing album is a live album ("Hafla (Live)", "Live at Wembley"),
 * and 'acoustic' too for an unplugged album (every track on it is both).
 */
function trackTags(title: ParsedTitle, album: ParsedAlbumTitle | undefined): Set<HardTag> {
  const tags = new Set(title.versions);
  // A single named after its track ("Live in the Moment") is only live through its own descriptors.
  const albumTags = album && album.base === title.base ? parseTitle(album.raw).versions : album?.versions;
  if (albumTags?.has('live')) {
    tags.add('live');
    if (albumTags.has('acoustic')) tags.add('acoustic');
  }
  return tags;
}

/**
 * Hard tags on both sides whose qualifiers disagree ("Tiësto Remix" vs "David Guetta Remix"). Never
 * excused by a duration: two named remixes or edits are two recordings, not one inconsistently labelled.
 */
function conflictLabels(a: ParsedTitle, b: ParsedTitle): string[] {
  return qualifierConflicts(a, b).map((c) => c.label);
}

function variants(soft: ReadonlySet<string>): string[] {
  return [...soft].filter((t) => t.startsWith(VARIANT_PREFIX));
}

/**
 * Variant labels on both sides that may be one label in two languages ("Version Mixte" / "Mixed Version"):
 * every label has a look-alike on the other side. "Japanese Ver." / "English Ver." do not.
 */
function cognateVariants(a: string[], b: string[]): boolean {
  const close = (x: string, ys: string[]) => ys.some((y) => bigramDice(x.slice(VARIANT_PREFIX.length), y.slice(VARIANT_PREFIX.length)) >= VARIANT_COGNATE_MIN_DICE);
  return a.every((x) => close(x, b)) && b.every((y) => close(y, a));
}

/** Featured artists from the title count as credits (Apple puts them in the title, Spotify in the artist list). */
function withFeatured(t: TrackMeta, parsed: ParsedTitle): ArtistSide {
  const credited = t.artists.length ? t.artists : [t.artist];
  return { artists: [...credited, ...parsed.featured], artist: t.artist };
}

/** Lenient credit check: equal names, or one name's words contained in the other's ("Pharrell" / "Pharrell Williams"). */
function credited(name: string, names: string[]): boolean {
  const words = new Set(name.split(' '));
  return names.some((n) => {
    if (sameArtistName(name, n)) return true;
    const other = n.split(' ');
    return other.every((w) => words.has(w)) || [...words].every((w) => other.includes(w));
  });
}

function hasUncredited(featured: string[], other: ArtistSide): boolean {
  if (!featured.length) return false;
  const names = splitArtists([...other.artists, other.artist]).map(stripHonorifics);
  return splitArtists(featured).some((f) => !credited(stripHonorifics(f), names));
}

function isCompilationTrack(t: TrackMeta, album: ParsedAlbumTitle | undefined): boolean {
  return t.albumType === 'compilation' || isCompilationTitle(album);
}

interface TrackEval {
  artist: ArtistMatch;
  title: number;
  titleMin: number;
  duration: DurationCheck;
  versionReject?: string;
  /**
   * Inferences from labels and releases (one-sided variant label, live recordings on different releases).
   * They decide search hits; an ISRC from the source platform identifies the recording better.
   */
  searchReject?: string;
  score: number;
  details: Details;
}

function evaluateTrack(src: TrackMeta, cand: TrackMeta): TrackEval {
  const st = parseTitle(src.title);
  const ct = parseTitle(cand.title);
  const sa = src.album ? parseAlbumTitle(src.album) : undefined;
  const ca = cand.album ? parseAlbumTitle(cand.album) : undefined;

  const artist = artistMatch(withFeatured(src, st), withFeatured(cand, ct));
  const duration = compareDurations(src, cand);
  // Without a duration, near-miss spellings ("Animals" / "Animal") are not evidence of the same song.
  const title = titleSimilarity(st, ct, { fuzzyChars: duration.known });
  const titleMin = duration.known ? TITLE_MIN : TITLE_MIN_NO_DURATION;
  const albumSim = sa && ca ? titleSimilarity(sa, ca) : ALBUM_SIM_UNKNOWN;

  const srcTags = trackTags(st, sa);
  const candTags = trackTags(ct, ca);
  const tagDiff = symmetricDiff(srcTags, candTags);
  const durationAgrees = duration.known && duration.within;
  const provenByDuration = tagDiff.length > 0 && tagDiff.every((t) => DURATION_PROVABLE_TAGS.has(t)) && durationAgrees;
  const conflicts = conflictLabels(st, ct);
  const srcCompilation = isCompilationTrack(src, sa);
  const candCompilation = isCompilationTrack(cand, ca);
  // Two live recordings on different original releases are different concerts, however close their
  // durations ("Bohemian Rhapsody (Live)" on "Queen Rock Montreal" vs on "Hungarian Rhapsody": 1.4s
  // apart), unless both titles name the same concert. Compilations and singles named after the track
  // reuse recordings, so they are excused.
  const otherConcert =
    srcTags.has('live') &&
    candTags.has('live') &&
    sa !== undefined &&
    ca !== undefined &&
    !srcCompilation &&
    !candCompilation &&
    sa.base !== st.base &&
    ca.base !== ct.base &&
    albumSim < ALBUM_TITLE_MIN &&
    !sameQualifiedVersion(st, ct, 'live');
  const versionReasons = [
    ...(tagDiff.length > 0 && !provenByDuration ? [`${tagLabel(srcTags)} vs ${tagLabel(candTags)}`] : []),
    ...conflicts,
  ];
  const versionReject = versionReasons.length ? `version: ${versionReasons.join(', ')}` : undefined;
  // An unclassified "<words> version" on one side only (Piano, Spanish, 10 Minute) is another recording
  // even at a near-identical duration ("Faded" vs "Faded (Piano Version)": 2.5s apart). Look-alike labels
  // on both sides ("Mixed Version" / "Version Mixte") may be one version labelled in two languages, which
  // only a matching duration can show.
  const sv = variants(st.soft);
  const cv = variants(ct.soft);
  const variantMismatch =
    symmetricDiff(new Set(sv), new Set(cv)).length > 0 && !(sv.length && cv.length && cognateVariants(sv, cv) && durationAgrees);
  const searchReasons = [
    ...(variantMismatch ? [`${tagLabel(new Set(sv))} vs ${tagLabel(new Set(cv))}`] : []),
    ...(otherConcert ? [`live on ${src.album} vs ${cand.album}`] : []),
  ];
  const searchReject = searchReasons.length ? `version: ${searchReasons.join(', ')}` : undefined;

  const featuredDisjoint =
    st.featured.length > 0 && ct.featured.length > 0 && !anyEq(splitArtists(st.featured), splitArtists(ct.featured));
  const featuredUncredited = hasUncredited(st.featured, withFeatured(cand, ct)) || hasUncredited(ct.featured, withFeatured(src, st));
  const penalty =
    softPenalty(st.soft, ct.soft) +
    explicitPenalty(src, cand) +
    (candCompilation && !srcCompilation ? PENALTY.compilation : 0) +
    (featuredDisjoint ? PENALTY.featuredDisjoint : 0) +
    (featuredUncredited ? PENALTY.featuredUncredited : 0) +
    (provenByDuration ? PENALTY.editExtended : 0);
  const weighted =
    TRACK_WEIGHTS.title * title +
    TRACK_WEIGHTS.artist * artist.score +
    TRACK_WEIGHTS.duration * duration.score +
    TRACK_WEIGHTS.album * albumSim;
  const score = clamp01(weighted - penalty);

  const details: Details = {
    title: round(title),
    artist: round(artist.score),
    duration: round(duration.score),
    album: round(albumSim),
    penalty: round(penalty),
    raw: round(score),
  };
  if (duration.diffMs !== undefined) details.durationDiffMs = duration.diffMs;
  if (artist.note) details.artistNote = artist.note;
  if (srcTags.size || candTags.size) details.tags = `${tagLabel(srcTags)} vs ${tagLabel(candTags)}`;
  return { artist, title, titleMin, duration, versionReject, searchReject, score, details };
}

function artistReason(src: ArtistSide, cand: ArtistSide): string {
  return `artist: ${src.artist || src.artists.join(', ')} vs ${cand.artist || cand.artists.join(', ')}`;
}

function result(score: number, reasons: string[], details: Details): ScoreResult {
  return reasons.length ? { score: 0, reject: reasons.join('; '), details } : { score: round(score), details };
}

/** Full fuzzy-match scoring of a search hit against the source track. */
export function scoreTrack(src: TrackMeta, cand: TrackMeta): ScoreResult {
  const e = evaluateTrack(src, cand);
  const reasons: string[] = [];
  if (!e.artist.match) reasons.push(artistReason(src, cand));
  if (e.title < e.titleMin) reasons.push(`title: ${formatScore(e.title)} < ${e.titleMin}`);
  if (e.duration.known && !e.duration.within) reasons.push(`duration ${formatSeconds(e.duration.diffMs ?? 0)}`);
  if (e.versionReject) reasons.push(e.versionReject);
  if (e.searchReject) reasons.push(e.searchReject);
  return result(e.score, reasons, e.details);
}

/**
 * Verify a track found by ISRC. Non-strict (ISRC from the source platform itself): reject only on
 * duration, version tags, or when both artist and title disagree (titles can be translated).
 * Strict (ISRC derived from a fuzzy match): full scoreTrack rules and the acceptance threshold.
 */
export function verifyTrackById(src: TrackMeta, cand: TrackMeta, opts: VerifyOptions): ScoreResult {
  if (opts.strict) return withThreshold(scoreTrack(src, cand), ACCEPT_TRACK);
  const e = evaluateTrack(src, cand);
  const reasons: string[] = [];
  if (e.duration.known && !e.duration.within) reasons.push(`duration ${formatSeconds(e.duration.diffMs ?? 0)}`);
  if (e.versionReject) reasons.push(e.versionReject);
  if (!e.artist.match && e.title < ID_TITLE_MIN) reasons.push(`${artistReason(src, cand)}; title: ${formatScore(e.title)}`);
  return result(e.score, reasons, e.details);
}

function withThreshold(r: ScoreResult, min: number): ScoreResult {
  if (r.reject || r.score >= min) return r;
  return { score: 0, reject: `score ${formatScore(r.score)} < ${min}`, details: r.details };
}

// ---------------------------------------------------------------------------------------------
// Albums

type LengthClass = 'short' | 'long';

function lengthClass(type: AlbumType | undefined, hint: 'single' | 'ep' | undefined): LengthClass | undefined {
  if (hint || type === 'single' || type === 'ep') return 'short';
  return type === 'album' ? 'long' : undefined;
}

function isCompilationAlbum(a: AlbumMeta, parsed: ParsedAlbumTitle): boolean {
  return a.albumType === 'compilation' || isCompilationTitle(parsed);
}

interface AlbumEval {
  artist: ArtistMatch;
  title: number;
  trackDiff?: number;
  versionReject?: string;
  score: number;
  details: Details;
}

function evaluateAlbum(src: AlbumMeta, cand: AlbumMeta): AlbumEval {
  const st = parseAlbumTitle(src.title);
  const ct = parseAlbumTitle(cand.title);
  const artist = artistMatch(src, cand);
  const title = titleSimilarity(st, ct);

  const trackDiff =
    src.trackCount !== undefined && cand.trackCount !== undefined ? Math.abs(src.trackCount - cand.trackCount) : undefined;
  const trackCountScore =
    trackDiff === undefined ? TRACK_COUNT_SCORE.unknown : trackDiff === 0 ? TRACK_COUNT_SCORE.equal : TRACK_COUNT_SCORE.offByOne;
  const sy = yearOf(src.releaseDate);
  const cy = yearOf(cand.releaseDate);
  const yearScore =
    sy === undefined || cy === undefined
      ? YEAR_SCORE.unknown
      : Math.abs(sy - cy) <= RELEASE_YEAR_TOLERANCE
        ? YEAR_SCORE.close
        : YEAR_SCORE.far;

  const tagDiff = symmetricDiff(st.versions, ct.versions);
  // Same rule as tracks, with equal track counts standing in for equal durations.
  const provenByTrackCount = tagDiff.length > 0 && tagDiff.every((t) => DURATION_PROVABLE_TAGS.has(t)) && trackDiff === 0;
  const versionReasons = [
    ...(tagDiff.length > 0 && !provenByTrackCount ? [`${tagLabel(st.versions)} vs ${tagLabel(ct.versions)}`] : []),
    ...conflictLabels(st, ct),
  ];
  const versionReject = versionReasons.length ? `version: ${versionReasons.join(', ')}` : undefined;

  const deluxeMismatch = st.soft.has('deluxe') !== ct.soft.has('deluxe');
  const otherSoft = (s: Set<string>) => new Set([...s].filter((t) => t !== 'deluxe'));
  const sl = lengthClass(src.albumType, st.albumHint);
  const cl = lengthClass(cand.albumType, ct.albumHint);
  const penalty =
    (deluxeMismatch ? PENALTY.deluxe : 0) +
    softPenalty(otherSoft(st.soft), otherSoft(ct.soft)) +
    explicitPenalty(src, cand) +
    (sl && cl && sl !== cl ? PENALTY.albumType : 0) +
    (isCompilationAlbum(src, st) !== isCompilationAlbum(cand, ct) ? PENALTY.compilation : 0) +
    (provenByTrackCount ? PENALTY.editExtended : 0);
  const weighted =
    ALBUM_WEIGHTS.title * title +
    ALBUM_WEIGHTS.artist * artist.score +
    ALBUM_WEIGHTS.trackCount * trackCountScore +
    ALBUM_WEIGHTS.year * yearScore;
  const score = clamp01(weighted - penalty);

  const details: Details = {
    title: round(title),
    artist: round(artist.score),
    trackCount: trackCountScore,
    year: yearScore,
    penalty: round(penalty),
    raw: round(score),
  };
  if (trackDiff !== undefined) details.trackDiff = trackDiff;
  if (artist.note) details.artistNote = artist.note;
  if (st.versions.size || ct.versions.size) details.tags = `${tagLabel(st.versions)} vs ${tagLabel(ct.versions)}`;
  return { artist, title, trackDiff, versionReject, score, details };
}

function trackCountReason(src: AlbumMeta, cand: AlbumMeta): string {
  return `tracks: ${src.trackCount} vs ${cand.trackCount}`;
}

/** Full fuzzy-match scoring of a search hit against the source album. */
export function scoreAlbum(src: AlbumMeta, cand: AlbumMeta): ScoreResult {
  const e = evaluateAlbum(src, cand);
  const reasons: string[] = [];
  if (!e.artist.match) reasons.push(artistReason(src, cand));
  if (e.title < ALBUM_TITLE_MIN) reasons.push(`title: ${formatScore(e.title)} < ${ALBUM_TITLE_MIN}`);
  if (e.trackDiff !== undefined && e.trackDiff > TRACK_COUNT_TOLERANCE) reasons.push(trackCountReason(src, cand));
  if (e.versionReject) reasons.push(e.versionReject);
  return result(e.score, reasons, e.details);
}

/** Verify an album found by UPC; see verifyTrackById for strict vs non-strict. */
export function verifyAlbumById(src: AlbumMeta, cand: AlbumMeta, opts: VerifyOptions): ScoreResult {
  if (opts.strict) return withThreshold(scoreAlbum(src, cand), ACCEPT_ALBUM);
  const e = evaluateAlbum(src, cand);
  const reasons: string[] = [];
  if (e.trackDiff !== undefined && e.trackDiff > TRACK_COUNT_TOLERANCE) reasons.push(trackCountReason(src, cand));
  if (!e.artist.match && e.title < ID_TITLE_MIN) reasons.push(`${artistReason(src, cand)}; title: ${formatScore(e.title)}`);
  return result(e.score, reasons, e.details);
}

// ---------------------------------------------------------------------------------------------
// Ranking

interface Entry<T> extends ScoreResult {
  item: T;
  index: number;
  /** Tie-break keys, lower first. */
  keys: Array<number | string>;
}

function compareKeys(a: Array<number | string>, b: Array<number | string>): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** Sortable release date: earlier first, unknown last. */
function dateKey(date: string | undefined): string {
  return date && /^\d{4}/.test(date) ? date : '9999';
}

function rawScore(e: { details: Details }): number {
  const raw = e.details.raw;
  return typeof raw === 'number' ? raw : 0;
}

/**
 * Highest score first; among candidates within TIE_EPSILON of the best remaining one, the tie-break keys
 * decide. Rejected candidates go last, closest first.
 */
function rank<T>(entries: Array<Entry<T>>): Array<RankedCandidate<T>> {
  const remaining = entries.filter((e) => !e.reject);
  const ordered: Array<Entry<T>> = [];
  while (remaining.length) {
    const top = Math.max(...remaining.map((e) => e.score));
    const tied = remaining.filter((e) => top - e.score <= TIE_EPSILON + 1e-9);
    tied.sort((a, b) => compareKeys(a.keys, b.keys) || b.score - a.score || a.index - b.index);
    const pick = tied[0];
    if (!pick) break;
    ordered.push(pick);
    remaining.splice(remaining.indexOf(pick), 1);
  }
  const rejected = entries.filter((e) => e.reject).sort((a, b) => rawScore(b) - rawScore(a) || a.index - b.index);
  return [...ordered, ...rejected].map(({ item, score, reject, details }) =>
    reject ? { item, score, reject, details } : { item, score, details },
  );
}

function pick<T>(ranked: Array<RankedCandidate<T>>, min: number): PickResult<T> {
  const best = ranked[0];
  const accepted = best && !best.reject && best.score >= min ? { item: best.item, score: best.score, details: best.details } : null;
  return { accepted, ranked };
}

/**
 * 0 for the same album title, 1..2 for the same album with other edition/remaster suffixes (fewer
 * differing suffix tags first), 2 otherwise.
 */
function sameAlbumKey(a: ParsedAlbumTitle | undefined, b: ParsedAlbumTitle | undefined): number {
  if (!a || !b || a.base !== b.base) return 2;
  if (a.full === b.full) return 0;
  const differing = symmetricDiff(a.soft, b.soft).length + symmetricDiff(a.versions, b.versions).length;
  return 1 + Math.min(differing, 9) / 10;
}

function trackKeys(src: TrackMeta, cand: TrackMeta, index: number): Array<number | string> {
  const sa = src.album ? parseAlbumTitle(src.album) : undefined;
  const ca = cand.album ? parseAlbumTitle(cand.album) : undefined;
  return [
    isCompilationTrack(cand, ca) ? 1 : 0,
    src.explicit !== undefined && cand.explicit === src.explicit ? 0 : 1,
    sameAlbumKey(sa, ca),
    dateKey(cand.releaseDate),
    index,
  ];
}

function albumKeys(src: AlbumMeta, cand: AlbumMeta, index: number): Array<number | string> {
  const ct = parseAlbumTitle(cand.title);
  return [
    isCompilationAlbum(cand, ct) ? 1 : 0,
    src.explicit !== undefined && cand.explicit === src.explicit ? 0 : 1,
    sameAlbumKey(parseAlbumTitle(src.title), ct),
    dateKey(cand.releaseDate),
    index,
  ];
}

/** Best search hit for a track; accepted only if not rejected and score >= ACCEPT_TRACK. */
export function pickBestTrack(src: TrackMeta, cands: TrackMeta[]): PickResult<TrackMeta> {
  const entries = cands.map((item, index) => ({ item, index, keys: trackKeys(src, item, index), ...scoreTrack(src, item) }));
  return pick(rank(entries), ACCEPT_TRACK);
}

/** Best search hit for an album; accepted only if not rejected and score >= ACCEPT_ALBUM. */
export function pickBestAlbum(src: AlbumMeta, cands: AlbumMeta[]): PickResult<AlbumMeta> {
  const entries = cands.map((item, index) => ({ item, index, keys: albumKeys(src, item, index), ...scoreAlbum(src, item) }));
  return pick(rank(entries), ACCEPT_ALBUM);
}

/**
 * Several items can share an ISRC/UPC (album version, compilation, single): verify each and choose with
 * the same tie-break ranking. The best non-rejected one is accepted.
 */
export function pickBestById(src: TrackMeta, cands: TrackMeta[], opts: VerifyOptions): PickResult<TrackMeta>;
export function pickBestById(src: AlbumMeta, cands: AlbumMeta[], opts: VerifyOptions): PickResult<AlbumMeta>;
export function pickBestById(src: ItemMeta, cands: ItemMeta[], opts: VerifyOptions): PickResult<ItemMeta> {
  const entries: Array<Entry<ItemMeta>> = cands.map((item, index) => {
    if (src.kind === 'track' && item.kind === 'track') {
      return { item, index, keys: trackKeys(src, item, index), ...verifyTrackById(src, item, opts) };
    }
    if (src.kind === 'album' && item.kind === 'album') {
      return { item, index, keys: albumKeys(src, item, index), ...verifyAlbumById(src, item, opts) };
    }
    return { item, index, keys: [index], score: 0, reject: `kind: ${src.kind} vs ${item.kind}`, details: {} };
  });
  return pick(rank(entries), 0);
}
