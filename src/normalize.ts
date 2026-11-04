// Text folding, title parsing and string similarity for cross-platform matching (see src/match.ts).

/** Version tags that must agree between a source and a candidate: they mark a different recording. */
export type HardTag =
  | 'live'
  | 'remix'
  | 'acoustic'
  | 'instrumental'
  | 'acapella'
  | 'karaoke'
  | 'demo'
  | 'sped_up'
  | 'slowed'
  | 'edit'
  | 'extended'
  | 'rerecorded';

export const HARD_TAGS: readonly HardTag[] = [
  'live',
  'remix',
  'acoustic',
  'instrumental',
  'acapella',
  'karaoke',
  'demo',
  'sped_up',
  'slowed',
  'edit',
  'extended',
  'rerecorded',
];

/** Version tags that only cost a small penalty on mismatch. Unclassified "<words> version" become `variant:<words>`. */
export type SoftTag = 'remaster' | 'mono' | 'stereo' | 'deluxe' | 'explicit' | 'clean';
export const VARIANT_PREFIX = 'variant:';

export interface ParsedTitle {
  raw: string;
  /** Folded title without featured clauses and recognized version suffixes. */
  base: string;
  /** `base` without any trailing bracket group, recognized or not. */
  core: string;
  /**
   * Folded unrecognized trailing descriptors: bracket groups ("Pianoforte", "강남스타일") and a " - " suffix
   * ("Song - Pianoforte"). `core` leaves out the bracket groups but keeps the suffix.
   */
  extras: string[];
  /** Folded raw title minus featured clauses. */
  full: string;
  /** Folded featured-artist names. */
  featured: string[];
  versions: Set<HardTag>;
  /** SoftTag values and `variant:<words>`. */
  soft: Set<string>;
  /** The title itself says it is the original recording ("Original Mix", "Album Version"). */
  original: boolean;
  /**
   * What a version descriptor names besides its kind, per hard tag: the remixer of "Tiësto Remix", the
   * venue and year of "Live at Wembley 1986". Two remixes (or concerts) of one song are different recordings.
   */
  qualifiers: Partial<Record<HardTag, string[]>>;
}

export interface ParsedAlbumTitle extends ParsedTitle {
  albumHint?: 'single' | 'ep';
}

// ---------------------------------------------------------------------------------------------
// Folding

const LETTER_MAP: Record<string, string> = {
  ø: 'o',
  æ: 'ae',
  œ: 'oe',
  ß: 'ss',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  ı: 'i',
  þ: 'th',
  ħ: 'h',
  ς: 'σ',
};
const LETTER_RE = /[øæœßđðłıþħς]/g;
const SINGLE_QUOTES_RE = /[‘’‚‛´`′']/g;
const DOUBLE_QUOTES_RE = /[“”„‟″]/g;
const DASHES_RE = /[‐‑‒–—―−﹣－]/g;
/** Dotted acronyms ("P.Y.T.", "R.E.M.") lose their dots instead of becoming spaced letters. */
const ACRONYM_RE = /(?<![\p{L}\p{N}])(?:\p{L}\.){2,}(?:\p{L}(?![\p{L}\p{N}]))?/gu;
const INHERITED_RE = /\p{Script=Inherited}/u;
/** Japanese (han)dakuten are combining marks but change the syllable, so they are kept. */
const KEPT_MARKS = new Set(['\u3099', '\u309a']);

/**
 * Only script-neutral combining marks (Latin/Greek/Cyrillic diacritics, Arabic harakat) are stripped.
 * Marks that belong to a script (Devanagari vowel signs, Thai, ...) carry letters and are kept.
 */
function stripMark(mark: string): string {
  return KEPT_MARKS.has(mark) || !INHERITED_RE.test(mark) ? mark : '';
}

/** Stylized letters inside names: "Ke$ha" / "Kesha", "A$AP", "P!nk" / "Pink". */
const STYLIZED_S_RE = /(?<=\p{L})\$|\$(?=\p{L})/gu;
const STYLIZED_I_RE = /(?<=\p{L})!(?=\p{L})/gu;

/** Case, accent, quote and punctuation folding. Letters and digits of every script survive. */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, stripMark)
    .replace(LETTER_RE, (m) => LETTER_MAP[m] ?? m)
    .replace(STYLIZED_S_RE, 's')
    .replace(STYLIZED_I_RE, 'i')
    .replace(ACRONYM_RE, (m) => m.replace(/\./g, ''))
    .replace(SINGLE_QUOTES_RE, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFC');
}

/** Light normalization for structural parsing: keeps brackets and separators, unifies quotes and dashes. */
function prenorm(s: string): string {
  return s
    .normalize('NFKC')
    .replace(SINGLE_QUOTES_RE, "'")
    .replace(DOUBLE_QUOTES_RE, '"')
    .replace(DASHES_RE, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

// Latin transliteration of Cyrillic and Greek (applied to folded text, so diacritics are already gone:
// "й" arrives as "и", "ё" as "е").
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', є: 'ye', ґ: 'g', ђ: 'dj', ј: 'j', љ: 'lj',
  њ: 'nj', ћ: 'c', џ: 'dz', ѕ: 'dz',
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm', ν: 'n',
  ξ: 'x', ο: 'o', π: 'p', ρ: 'r', σ: 's', τ: 't', υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o',
};
const TRANSLIT_RE = /[\u0370-\u03ff\u0400-\u04ff]/gu;

/** fold, then Cyrillic and Greek letters to Latin ("Кино" -> "kino", "Виктор Цой" -> "viktor tsoi"). */
export function transliterate(s: string): string {
  return fold(s).replace(TRANSLIT_RE, (c) => TRANSLIT[c] ?? c);
}

// ---------------------------------------------------------------------------------------------
// Version descriptor vocabulary (matched against folded suffix text, whole words)

function words(alternatives: string): RegExp {
  return new RegExp(`(?:^| )(?:${alternatives})(?= |$)`, 'u');
}

/** "Off Vocal" is the usual J-pop/anime label for an instrumental. */
const EN_INSTRUMENTAL = 'off vocal|without vocals?|no vocals?|vocal less|vocalless';
/** Japanese labels are written without spaces ("オフボーカルver."), so they match anywhere in a descriptor. */
const JA_INSTRUMENTAL = 'オフ ?ボーカル|インストゥルメンタル|インスト|伴奏';
const JA_KARAOKE = 'カラオケ';
/** Labels stripped as a whole before reading qualifiers, so "Vocal" still names the "Vocal Mix" remix. */
const LABEL_PHRASE_RE = new RegExp(`${words(EN_INSTRUMENTAL).source}|${JA_INSTRUMENTAL}|${JA_KARAOKE}`, 'gu');

interface Rule {
  re: RegExp;
  hard?: readonly HardTag[];
  soft?: SoftTag;
}

const RULES: readonly Rule[] = [
  {
    re: words(
      'live|en vivo|ao vivo|en directo|en direct|en concierto|en concert|en public|dal vivo|in diretta|in concerto|in concert|concert|live version|концерт' +
        // Separate performances recorded for a broadcaster or a platform ("BBC Session", "Recorded at Spotify Studios").
        '|session|sessions|recorded at|recorded live|recorded in',
    ),
    hard: ['live'],
  },
  { re: words('unplugged'), hard: ['live', 'acoustic'] },
  { re: words('acoustic|acustico|acustica|acoustique|akustik|stripped'), hard: ['acoustic'] },
  { re: words('remix|remixes|remixed|rmx|rework|reworked|bootleg|flip|dub|vip|ремикс'), hard: ['remix'] },
  { re: words(`instrumental|instrumentals|inst|инструментал|${EN_INSTRUMENTAL}`), hard: ['instrumental'] },
  { re: new RegExp(JA_INSTRUMENTAL, 'u'), hard: ['instrumental'] },
  { re: words('a cappella|acapella|a capella|acappella'), hard: ['acapella'] },
  { re: words('karaoke|originally performed by|in the style of|backing tracks?'), hard: ['karaoke'] },
  { re: new RegExp(JA_KARAOKE, 'u'), hard: ['karaoke'] },
  { re: words('demo|demos'), hard: ['demo'] },
  { re: words('sped up|speed up|spedup|nightcore'), hard: ['sped_up'] },
  { re: words('slowed|slowed and reverb|slowed reverb|chopped and screwed|chopped not slopped'), hard: ['slowed'] },
  {
    re: words(
      'edit|radio edit|single edit|short edit|radio version|single version|short version|radio mix|single mix|7 inch|7 version|7 mix' +
        // Anime/game openings cut to broadcast length.
        '|tv size|tv edit|tv version|tv ver|short ver|game size',
    ),
    hard: ['edit'],
  },
  {
    // "Extended Edition" (more tracks) and "Extended Play" (an EP) are not extended mixes.
    re: words(
      'extended(?! (?:\\S+ )?edition| play)|extended mix|extended version|long version|12 inch|12 version|12 mix|club mix|full length version',
    ),
    hard: ['extended'],
  },
  { re: words('taylors version|re recorded|rerecorded|re record|re recording'), hard: ['rerecorded'] },
  { re: words('remaster\\p{L}*|digitally remastered'), soft: 'remaster' },
  { re: words('(?:19|20)\\d\\d mix'), soft: 'remaster' },
  { re: words('mono'), soft: 'mono' },
  { re: words('stereo'), soft: 'stereo' },
  {
    re: words('deluxe|super deluxe|expanded|anniversary|bonus track version|special edition|edition|edicion|edizione'),
    soft: 'deluxe',
  },
  { re: words('explicit|dirty'), soft: 'explicit' },
  { re: words('clean|censored|edited'), soft: 'clean' },
];

/** Editions a bonus track is exclusive to ("Japan Bonus Track", "iTunes Bonus Track"). */
const BONUS_EDITIONS = 'japan|japanese|uk|us|eu|european|international|itunes|amazon|spotify|digital|vinyl|cd|hidden|exclusive|limited';
/**
 * Descriptor words that carry no version information ("Official Audio", "Bonus Track", "Album Version").
 * They are stripped before deciding what a descriptor is: "Original Piano Version" is still a variant.
 */
const IGNORABLE_RE = new RegExp(
  words(
    // "LP Version" and "Studio Version" name the album recording, like "Album Version".
    'album version|lp version|studio version|original mix|original version|official version|main version|album mix|main mix|original|single|ep|extended play' +
      `|(?:(?:${BONUS_EDITIONS}) )*bonus tracks?|bonus` +
      '|soundtrack|ost|bso|motion picture|official|officiel|oficial|ufficiale|audio|music video|video|videoclip|clip|lyrics?|lyric video' +
      '|visuali[sz]er|hd|hq|4k|mv|letra|paroles|testo|songtext',
  ).source,
  'gu',
);
/** Soundtrack and cast-album labels in any wording ("Original Broadway Cast Recording", "Original Game Score"). */
const SOUNDTRACK_RE = words('soundtrack|ost|bso|score|motion picture|cast recording|cast album');
/** A kind of video ("Official Dance Video", "Video Musical", "Clipe Oficial"): it describes the video, not the recording. */
const VIDEO_NOUNS = 'video|videoclip|videoclipe|clip|clipe';
const VIDEO_KIND_RE = new RegExp(`^(?:${VIDEO_NOUNS})(?= |$)|(?:^| )(?:${VIDEO_NOUNS}|visuali[sz]er|mv|m v)$`, 'u');
/** A whole descriptor that names the original recording ("Original Mix", "Album Version"). */
const ORIGINAL_LABEL_RE = /^(?:original|original mix|original version|album version|album mix|lp version|studio version|main version|main mix)$/u;
/** An attribution and everything after it: "From "Frozen 2"", "Theme from Shaft", "Taken from X", "Prod. by X". */
const ATTRIBUTION_RE =
  /(?:^| )(?:(?:(?:\S+ )?theme|music|songs|soundtrack) )?(?:from|taken from|as featured in|as heard in|inspired by|produced by|prod)(?= |$).*$/u;
/** Words that may surround ignorable ones without making a descriptor meaningful ("Official Video with Lyrics"). */
const FILLER_WORDS: ReadonlySet<string> = new Set(['with', 'and', 'the', 'a', 'an', 'of', 'in', 'by']);

/** First words of "<x> mix" that do not make it a remix (other rules classify them). */
const NOT_REMIX_MIX = new Set([
  'original',
  'album',
  'radio',
  'single',
  'mono',
  'stereo',
  'main',
  'clean',
  'explicit',
  'extended',
  'club',
  '12',
  '7',
  'inch',
  'long',
  'short',
  'instrumental',
  'acoustic',
  'live',
  'edit',
  'demo',
  'karaoke',
  'remix',
  'and',
  'the',
  'a',
]);
const MIX_RE = /(?:^| )(\S+) mix(?= |$)/gu;
const YEAR_RE = /^(?:19|20)\d\d$/;
const VERSION_WORDS = 'version|ver|versao|versione|fassung|версия';
const VERSION_WORD_RE = new RegExp(`(?:^| )(?:${VERSION_WORDS})(?= |$)`, 'u');
const VERSION_WORD_ALL_RE = new RegExp(`(?:^| )(?:${VERSION_WORDS})(?= |$)`, 'gu');

interface Classification {
  hard: HardTag[];
  soft: string[];
  recognized: boolean;
  hint?: 'single' | 'ep';
}

/** Classify one folded suffix (a bracket group's content or the text after " - "). */
export function classifyDescriptor(folded: string): Classification {
  const hard = new Set<HardTag>();
  const soft = new Set<string>();
  let recognized = false;
  for (const rule of RULES) {
    if (!rule.re.test(folded)) continue;
    recognized = true;
    for (const t of rule.hard ?? []) hard.add(t);
    if (rule.soft) soft.add(rule.soft);
  }
  for (const m of folded.matchAll(MIX_RE)) {
    const x = m[1] ?? '';
    if (NOT_REMIX_MIX.has(x) || YEAR_RE.test(x)) continue;
    hard.add('remix');
    recognized = true;
  }
  if (!recognized) {
    const untagged = classifyUntagged(folded);
    recognized = untagged.recognized;
    if (untagged.variant) soft.add(VARIANT_PREFIX + untagged.variant);
  }
  const hint = folded === 'single' ? 'single' : folded === 'ep' || folded === 'extended play' ? 'ep' : undefined;
  return { hard: [...hard], soft: [...soft], recognized, hint };
}

function stripIgnorable(folded: string): string {
  return folded.replace(ATTRIBUTION_RE, ' ').replace(IGNORABLE_RE, ' ').replace(/\s+/g, ' ').trim();
}

/** Nothing but filler words and years (or nothing at all). */
function isFiller(s: string): boolean {
  return s.split(' ').every((w) => !w || FILLER_WORDS.has(w) || YEAR_RE.test(w));
}

function withoutVersionWords(s: string): string {
  return s.replace(VERSION_WORD_ALL_RE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * A descriptor without hard or soft tags: ignorable when only ignorable words (and filler) remain,
 * "<words> version" names a variant, anything else is unrecognized ("8D Audio" leaves "8d").
 */
function classifyUntagged(folded: string): { recognized: boolean; variant?: string } {
  const rest = stripIgnorable(folded);
  if (isFiller(rest)) return { recognized: true };
  // A video kind naming another take or arrangement ("Piano Video", "Cover Video") is not just a video.
  const videoKind = VIDEO_KIND_RE.test(folded) && !DISTINCT_PART_RE.test(rest);
  if (!VERSION_WORD_RE.test(rest)) return { recognized: SOUNDTRACK_RE.test(folded) || videoKind };
  // "Soundtrack Version" / "Video Version": the only modifier was an ignorable word, which then names the variant.
  const variant = withoutVersionWords(rest) || withoutVersionWords(folded.replace(ATTRIBUTION_RE, ' '));
  return variant ? { recognized: true, variant } : { recognized: true };
}

/** Descriptor words that say what kind of version it is, not whose or where; the rest is the qualifier. */
const QUALIFIER_STOPWORDS: ReadonlySet<string> = new Set(
  (
    'live en vivo ao directo concierto concert public dal in concerto version ver versao versione fassung ' +
    'unplugged acoustic acustico acustica acoustique akustik stripped remix remixes remixed rmx rework reworked ' +
    'bootleg flip dub vip mix mixed instrumental instrumentals inst a cappella acapella capella acappella karaoke ' +
    'originally performed by style of backing track tracks demo demos sped speed up spedup nightcore slowed reverb ' +
    'chopped screwed not slopped edit edited radio single short inch extended long club full length taylors re ' +
    'recorded rerecorded record recording digitally mono stereo explicit clean session sessions studio studios ' +
    'tv size game official original at from on the and with for to de del la le el em na no do da au aus im ' +
    'january february march april may june july august september october november december'
  ).split(' '),
);
/** Descriptor parts: "Live at Wembley / Remastered 2011", "Tiësto Remix - Radio Edit". */
const DESCRIPTOR_PART_RE = /\s*[/,;]\s*|\s+-\s+/;
const REMASTER_WORD_RE = /^remaster/;

const YEARS_ONLY_RE = /^(?:(?:19|20)\d\d ?)+$/;

/**
 * Adds the qualifier words of each hard-tagged part of a raw descriptor to `out`. Plain parts that follow
 * continue it ("Live, European Tour / 1979", "Live At Wembley Stadium / July 1986"); a part with its own
 * tag or a known descriptor ("Remastered 2011", "Bonus Track") ends it.
 */
function addQualifiers(content: string, out: Partial<Record<HardTag, string[]>>): void {
  let current: HardTag[] = [];
  for (const part of prenorm(content).split(DESCRIPTOR_PART_RE)) {
    const folded = fold(part);
    const c = classifyDescriptor(folded);
    if (c.hard.length) current = c.hard;
    else if (c.recognized && !YEARS_ONLY_RE.test(folded)) current = [];
    // The year of "Live 1986 (2011 Remaster)" in one part belongs to the remaster, not the performance.
    const remastered = c.soft.includes('remaster');
    const words = folded
      .replace(LABEL_PHRASE_RE, ' ')
      .split(' ')
      .filter((w) => w && !QUALIFIER_STOPWORDS.has(w) && !REMASTER_WORD_RE.test(w) && !(remastered && YEAR_RE.test(w)));
    for (const t of current) out[t] = [...(out[t] ?? []), ...words];
  }
}

/** The words that identify which `tag` version a title names ("wembley", "1986"; "tiesto"), if any. */
export function qualifierWords(t: ParsedTitle, tag: HardTag): string[] {
  return (t.qualifiers[tag] ?? []).filter(significant);
}

/** Whether both titles name the same `tag` version specifically ("Live at Wembley 1986" on both sides). */
export function sameQualifiedVersion(a: ParsedTitle, b: ParsedTitle, tag: HardTag): boolean {
  return qualifiersConfirm(qualifierWords(a, tag), qualifierWords(b, tag));
}

/** Remixers/venues this similar (character bigrams of the joined words) are the same. */
export const QUALIFIER_MIN_DICE = 0.8;

/** Words that identify something: numbers, and names of three or more characters ("dj", "86" don't). */
function significant(w: string): boolean {
  return /^\p{N}+$/u.test(w) ? w.length !== 2 : Array.from(w).length >= 3;
}

/**
 * Whether two qualifiers of the same version kind can name the same recording. An empty side (plain
 * "Remix", "Live") is compatible with anything; different years, or names sharing nothing, are not.
 */
export function qualifiersCompatible(a: readonly string[], b: readonly string[]): boolean {
  const sa = a.filter(significant);
  const sb = b.filter(significant);
  if (!sa.length || !sb.length) return true;
  const ya = sa.filter((w) => YEAR_RE.test(w));
  const yb = sb.filter((w) => YEAR_RE.test(w));
  if (ya.length && yb.length && !ya.some((y) => yb.includes(y))) return false;
  const wa = sa.filter((w) => !YEAR_RE.test(w));
  const wb = sb.filter((w) => !YEAR_RE.test(w));
  if (!wa.length || !wb.length) return true;
  if (wa.some((w) => wb.includes(w))) return true;
  const ja = wa.join('');
  const jb = wb.join('');
  return ja.includes(jb) || jb.includes(ja) || bigramDice(ja, jb) >= QUALIFIER_MIN_DICE;
}

/**
 * Whether two qualifiers positively name the same version: compatible names on both sides, or a shared year
 * when neither names anything. Unlike qualifiersCompatible, what can't be compared doesn't pass: "1981" vs
 * "Aid", or "1986" vs "Wembley 1986" (Queen also played Budapest in 1986).
 */
export function qualifiersConfirm(a: readonly string[], b: readonly string[]): boolean {
  const sa = a.filter(significant);
  const sb = b.filter(significant);
  if (!sa.length || !sb.length || !qualifiersCompatible(sa, sb)) return false;
  const named = (ws: string[]) => ws.some((w) => !YEAR_RE.test(w));
  return named(sa) === named(sb);
}

/** Hard tags both titles carry but with incompatible qualifiers, e.g. "remix (tiesto vs david guetta)". */
export function qualifierConflicts(a: ParsedTitle, b: ParsedTitle): Array<{ tag: HardTag; label: string }> {
  const out: Array<{ tag: HardTag; label: string }> = [];
  for (const tag of HARD_TAGS) {
    if (!a.versions.has(tag) || !b.versions.has(tag)) continue;
    const qa = a.qualifiers[tag] ?? [];
    const qb = b.qualifiers[tag] ?? [];
    if (!qualifiersCompatible(qa, qb)) out.push({ tag, label: `${tag} (${qa.join(' ')} vs ${qb.join(' ')})` });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Title parsing

const CLOSE_TO_OPEN: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
const OPEN_TO_CLOSE: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

interface Group {
  start: number;
  end: number; // exclusive
  content: string;
}

/** Top-level bracket groups of s, left to right. Unbalanced brackets are ignored. */
function bracketGroups(s: string): Group[] {
  const groups: Group[] = [];
  for (let i = 0; i < s.length; i++) {
    const close = OPEN_TO_CLOSE[s[i] ?? ''];
    if (!close) continue;
    const open = s[i];
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === open) depth++;
      else if (s[j] === close && --depth === 0) {
        groups.push({ start: i, end: j + 1, content: s.slice(i + 1, j).trim() });
        i = j;
        break;
      }
    }
  }
  return groups;
}

function trailingGroup(s: string): { head: string; content: string } | null {
  const close = s[s.length - 1] ?? '';
  const open = CLOSE_TO_OPEN[close];
  if (!open) return null;
  let depth = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === close) depth++;
    else if (s[i] === open && --depth === 0) {
      return { head: s.slice(0, i).trim(), content: s.slice(i + 1, -1).trim() };
    }
  }
  return null;
}

function balanced(s: string): boolean {
  let depth = 0;
  for (const c of s) {
    if (c in OPEN_TO_CLOSE) depth++;
    else if (c in CLOSE_TO_OPEN && --depth < 0) return false;
  }
  return depth === 0;
}

function trailingDash(s: string): { head: string; content: string } | null {
  const i = s.lastIndexOf(' - ');
  if (i <= 0) return null;
  const head = s.slice(0, i).trim();
  const content = s.slice(i + 3).trim();
  if (!head || !content || !balanced(content) || !balanced(head)) return null;
  return { head, content };
}

const FEAT_LEAD_RE = /^((?:feat|ft)\.\s*|(?:feat|ft|featuring|with)\s+|w\/\s*)(.+)$/i;
const WITH_LEAD_RE = /^(?:with\s+|w\/)/i;
/** What "with" introduces when it is not an artist: "(with Lyrics)", "(with Strings)", "(with Full Orchestra)". */
const NOT_ARTIST_WORDS: ReadonlySet<string> = new Set(
  (
    'lyrics lyric letra paroles subtitles commentary intro outro strings string orchestra orchestral choir chorus ' +
    'piano guitar vocals vocal quartet the a an full and'
  ).split(' '),
);
const FEAT_INNER_RE = /^(.*?)(?:\s*[-,;]\s*|\s+)(?:(?:feat|ft)\.\s*|(?:feat|ft|featuring)\s+)(.+)$/i;
const FEAT_BARE_RE = /\s+(?:(?:feat|ft)\.\s*|(?:feat|ft|featuring)\s+)(.+?)(?=\s*[([{]|\s+-\s+|$)/i;
const FEAT_SPLIT_RE = /\s*[,;&]\s*|\s+(?:and|x|×|\+)\s+/i;

function isGenericWith(lead: string, rest: string): boolean {
  return WITH_LEAD_RE.test(lead) && fold(rest).split(' ').every((w) => NOT_ARTIST_WORDS.has(w));
}

function featuredNames(s: string): string[] {
  return s
    .split(FEAT_SPLIT_RE)
    .map(fold)
    .filter((n) => n.length > 0);
}

/** Removes featured-artist clauses from s, appending their names to `out`. */
function extractFeatured(s: string, out: string[]): string {
  let t = s;
  const groups = bracketGroups(t);
  for (let k = groups.length - 1; k >= 0; k--) {
    const g = groups[k];
    if (!g) continue;
    const lead = FEAT_LEAD_RE.exec(g.content);
    if (lead && !isGenericWith(lead[1] ?? '', lead[2] ?? '')) {
      out.unshift(...featuredNames(lead[2] ?? ''));
      t = t.slice(0, g.start) + ' ' + t.slice(g.end);
      continue;
    }
    const inner = FEAT_INNER_RE.exec(g.content);
    if (inner) {
      out.unshift(...featuredNames(inner[2] ?? ''));
      const rest = (inner[1] ?? '').replace(/[\s,;-]+$/, '').trim();
      const open = t[g.start] ?? '(';
      t = t.slice(0, g.start) + (rest ? `${open}${rest}${OPEN_TO_CLOSE[open] ?? ')'}` : ' ') + t.slice(g.end);
    }
  }
  const bare = FEAT_BARE_RE.exec(t);
  if (bare) {
    out.push(...featuredNames(bare[1] ?? ''));
    t = t.slice(0, bare.index) + ' ' + t.slice(bare.index + bare[0].length);
  }
  return t
    .replace(/\s+/g, ' ')
    .replace(/(?:\s+-)+\s*$/, '')
    .replace(/\s+-\s+(?=[([{])/g, ' ')
    .trim();
}

const ALBUM_EP_RE = /\s+E\.?P\.?$/i;
const LIVE_ALBUM_RE =
  /^live$|^live (?:at|in|from|on|aus|au|en) \S|^live \d| live (?:at|in|from) \S|(?:^| )(?:unplugged|in concert|en concierto|en vivo|ao vivo|en directo|dal vivo)(?= |$)/u;
const REMIX_ALBUM_RE = /(?:^| )(?:remixes|remixed|remix album)(?= |$)|^the remix$/u;
const INSTRUMENTAL_ALBUM_RE = /(?:^| )instrumentals?(?= |$)/u;

function parse(raw: string, album: boolean): ParsedAlbumTitle {
  const featured: string[] = [];
  let s = extractFeatured(prenorm(raw), featured);
  const full = fold(s);
  const versions = new Set<HardTag>();
  const soft = new Set<string>();
  let albumHint: 'single' | 'ep' | undefined;
  const kept: string[] = [];
  const qualifiers: Partial<Record<HardTag, string[]>> = {};
  let original = false;

  const apply = (c: Classification, content: string) => {
    for (const t of c.hard) versions.add(t);
    for (const t of c.soft) soft.add(t);
    if (album && c.hint) albumHint ??= c.hint;
    if (c.hard.length) addQualifiers(content, qualifiers);
    if (ORIGINAL_LABEL_RE.test(fold(content))) original = true;
  };

  for (;;) {
    const g = trailingGroup(s);
    if (g && g.head) {
      const c = classifyDescriptor(fold(g.content));
      if (c.recognized) apply(c, g.content);
      else kept.unshift(g.content);
      s = g.head;
      continue;
    }
    const d = trailingDash(s);
    if (d) {
      const c = classifyDescriptor(fold(d.content));
      if (c.recognized) {
        apply(c, d.content);
        s = d.head;
        continue;
      }
    }
    if (album && ALBUM_EP_RE.test(s) && s.replace(ALBUM_EP_RE, '').trim()) {
      albumHint ??= 'ep';
      s = s.replace(ALBUM_EP_RE, '').trim();
      continue;
    }
    break;
  }

  const core = fold(s) || full;
  const base = fold([s, ...kept].join(' ')) || full;
  if (album) {
    if (LIVE_ALBUM_RE.test(base)) {
      // "Live at Wembley Stadium" names its concert in the title itself.
      if (!versions.has('live')) addQualifiers([s, ...kept].join(' '), qualifiers);
      versions.add('live');
    }
    if (/(?:^| )unplugged(?= |$)/u.test(base)) versions.add('acoustic');
    if (REMIX_ALBUM_RE.test(base)) versions.add('remix');
    if (INSTRUMENTAL_ALBUM_RE.test(base)) versions.add('instrumental');
  }
  // The loop stops at a " - " suffix only when it is unrecognized.
  const suffix = trailingDash(s)?.content;
  const extras = [...(suffix ? [suffix] : []), ...kept].map(fold).filter(Boolean);
  return { raw, base, core, full, extras, featured: [...new Set(featured)], versions, soft, original, qualifiers, albumHint };
}

/** Parse a track title into its comparable parts, featured artists and version tags. */
export function parseTitle(raw: string): ParsedTitle {
  const { albumHint: _ignored, ...parsed } = parse(raw, false);
  return parsed;
}

/** parseTitle plus album conventions (" - Single", " - EP", "Live at ...", "Remixes"). */
export function parseAlbumTitle(raw: string): ParsedAlbumTitle {
  return parse(raw, true);
}

// ---------------------------------------------------------------------------------------------
// Artists

const ARTIST_SPLIT_RE = /\s*[,;&]\s*|\s+(?:\+|\/|and|feat\.?|ft\.?|featuring|with|vs\.?|et|y)\s+/i;
/** "x" joins names only between pieces the other separators left, so "Lil Nas X & Billy Ray Cyrus" keeps its X. */
const ARTIST_X_SPLIT_RE = /\s+[x×]\s+/i;

/** Folded individual names of one artist credit, without the unsplit alias. */
export function artistPieces(name: string): string[] {
  return prenorm(name)
    .split(ARTIST_SPLIT_RE)
    .flatMap((p) => p.split(ARTIST_X_SPLIT_RE))
    .map(fold)
    .filter((n) => n.length > 0);
}

/**
 * Folded individual artist names from credits like "Daft Punk & Pharrell Williams", plus each unsplit
 * credit as an alias so names containing separators ("Earth, Wind & Fire") still match whole.
 */
export function splitArtists(names: string[]): string[] {
  const out = new Set<string>();
  for (const name of names) {
    const whole = fold(name);
    if (whole) out.add(whole);
    for (const p of artistPieces(name)) out.add(p);
  }
  return [...out];
}

/** Raï honorifics and "The". Not "DJ"/"MC": "DJ Khaled" and "Khaled" are two artists. */
export const HONORIFICS: ReadonlySet<string> = new Set(['cheb', 'cheba', 'chaba', 'cheikh', 'cheikha', 'the']);

/** "Cheb Khaled" -> "khaled", "The Beatles" -> "beatles". Never returns an empty name. */
export function stripHonorifics(name: string): string {
  const tokens = fold(name).split(' ');
  while (tokens.length > 1 && HONORIFICS.has(tokens[0] ?? '')) tokens.shift();
  return tokens.join(' ');
}

// ---------------------------------------------------------------------------------------------
// Similarity

function multisetDice<T>(a: readonly T[], b: readonly T[]): number {
  if (!a.length || !b.length) return a.length === b.length ? 1 : 0;
  const counts = new Map<T, number>();
  for (const x of a) counts.set(x, (counts.get(x) ?? 0) + 1);
  let common = 0;
  for (const x of b) {
    const c = counts.get(x) ?? 0;
    if (c > 0) {
      common++;
      counts.set(x, c - 1);
    }
  }
  return (2 * common) / (a.length + b.length);
}

/** Dice coefficient over word multisets. */
export function tokenDice(a: string, b: string): number {
  const ta = fold(a).split(' ').filter(Boolean);
  const tb = fold(b).split(' ').filter(Boolean);
  return multisetDice(ta, tb);
}

function bigrams(s: string): string[] {
  const chars = Array.from(s);
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i++) out.push(`${chars[i]}${chars[i + 1]}`);
  return out;
}

/** Dice coefficient over character bigrams of the folded, space-free strings. */
export function bigramDice(a: string, b: string): number {
  const sa = fold(a).replace(/ /g, '');
  const sb = fold(b).replace(/ /g, '');
  if (Array.from(sa).length < 2 || Array.from(sb).length < 2) return sa === sb ? 1 : 0;
  return multisetDice(bigrams(sa), bigrams(sb));
}

const DIGRAPHS: Record<string, string> = {
  ou: 'w',
  oo: 'u',
  ee: 'i',
  ch: 'sh',
  dj: 'j',
  kh: 'h',
  gh: 'g',
  ph: 'f',
  ck: 'k',
  q: 'k',
};
const DIGRAPH_RE = /ou|oo|ee|ch|dj|kh|gh|ph|ck|q/g;
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);

/** Transliteration key: consonant skeleton, so "Ouelli El Darek" and "Weli L Darek" collide. */
export function skeleton(s: string): string {
  const t = fold(s)
    .replace(/[\s']/g, '')
    .replace(DIGRAPH_RE, (m) => DIGRAPHS[m] ?? m);
  const [first = '', ...rest] = Array.from(t);
  return (first + rest.filter((c) => !VOWELS.has(c)).join('')).replace(/(.)\1+/gu, '$1');
}

/** Penalty for comparing titles with their unrecognized trailing groups removed. */
export const CORE_PENALTY = 0.05;
/**
 * Similarity cap for an unexplained bracket group: on one side only, or different on each side ("(Pianoforte)",
 * "(Orchestra)" vs "(Pianoforte)"). Below every title threshold, because a matching duration doesn't explain
 * it: re-recordings are made to the original's length.
 */
export const UNEXPLAINED_GROUP_CAP = 0.75;
/** Transliteration matches never count as more than this. */
export const SKELETON_CAP = 0.85;
/** Shorter skeletons collide too easily ("Lose" / "Loose" / "Lies"). */
export const SKELETON_MIN_LENGTH = 4;
/** Penalty for titles that only match after transliteration ("Группа крови" / "Gruppa krovi"). */
export const TRANSLIT_PENALTY = 0.05;
/** Titles whose numbers differ ("Part 1" / "Part 2", "Song" / "Song 2") are different works. */
export const NUMBER_MISMATCH_CAP = 0.5;
/** A distinct-part word on one side only ("Song (Interlude)" / "Song") marks a different track. */
export const DISTINCT_PART_CAP = 0.6;

const TOKEN_ALIASES: Record<string, string> = { pt: 'part', pts: 'parts', vol: 'volume', nr: 'number', n: 'and' };
/** Words after which a roman numeral is a number ("Part II", "Vol. IV"). */
const NUMBERED_WORDS = new Set(['part', 'parts', 'volume', 'chapter', 'act', 'book', 'episode']);
const ROMAN: Record<string, string> = {
  i: '1',
  ii: '2',
  iii: '3',
  iv: '4',
  v: '5',
  vi: '6',
  vii: '7',
  viii: '8',
  ix: '9',
  x: '10',
  xi: '11',
  xii: '12',
};
const NUMBER_WORDS: Record<string, string> = {
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
};
const NUMBER_RE = /^\p{N}+$/u;

/**
 * Canonical form for comparison: "pt 2" -> "part 2", "no 5" -> "number 5", "part ii" / "part two" ->
 * "part 2", "greatest hits ii" -> "greatest hits 2". Single-letter numerals (i, v, x) and number words
 * only count after a numbering word, since they are ordinary words elsewhere.
 */
function comparable(folded: string): string {
  const tokens = folded.split(' ').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    let t = tokens[i] ?? '';
    const next = tokens[i + 1] ?? '';
    if (t === 'no' && NUMBER_RE.test(next)) t = 'number';
    t = TOKEN_ALIASES[t] ?? t;
    const prev = out[out.length - 1];
    const numbered = prev !== undefined && NUMBERED_WORDS.has(prev);
    if (t in ROMAN && (numbered || t.length > 1)) t = ROMAN[t] ?? t;
    else if (numbered && t in NUMBER_WORDS) t = NUMBER_WORDS[t] ?? t;
    out.push(t);
  }
  return out.join(' ');
}

function numbersOf(s: string): string {
  return s
    .split(' ')
    .filter((t) => NUMBER_RE.test(t))
    .map((t) => (Number.isNaN(Number(t)) ? t : String(Number(t))))
    .sort()
    .join(',');
}

/** Words in an unrecognized trailing group that make it a different track, not a subtitle. */
const DISTINCT_PART_RE = words(
  'reprise|interlude|intro|outro|skit|prelude|coda|part|parts|chapter|act|movement|medley|mashup|megamix|cover|tribute|theme|suite|overture|segue|continued|dialogue|interview|commentary|spoken' +
    // Other takes and arrangements of the same song ("Song (Alternate Take)", "Song (Piano)").
    '|take|takes|outtake|outtakes|alternate|alt|rehearsal|sketch|early|rough|jam|voice memo|work tape|piano|orchestral|symphonic|strings|choir|duet|solo|lofi|lo fi',
);

/** Words present in one string but not the other (multiset difference, both directions). */
function differingWords(a: string, b: string): string[] {
  const count = new Map<string, number>();
  for (const t of a.split(' ')) if (t) count.set(t, (count.get(t) ?? 0) + 1);
  for (const t of b.split(' ')) if (t) count.set(t, (count.get(t) ?? 0) - 1);
  return [...count].filter(([, n]) => n !== 0).map(([t]) => t);
}

/** Each folded group as many times as it is in `a` and not in `b` (spaces ignored: "Piano Forte" = "Pianoforte"). */
function groupsOnlyIn(a: readonly string[], b: readonly string[]): string[] {
  const left = b.map((g) => g.replace(/ /g, ''));
  return a.filter((g) => {
    const i = left.indexOf(g.replace(/ /g, ''));
    if (i < 0) return true;
    left.splice(i, 1);
    return false;
  });
}

/** Writing systems whose letters a string uses. Japanese kana and Han count as one; script-neutral letters don't count. */
const SCRIPTS: ReadonlyArray<readonly [string, RegExp]> = [
  ['latin', /\p{Script=Latin}/u],
  ['cjk', /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ['hangul', /\p{Script=Hangul}/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['greek', /\p{Script=Greek}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['hebrew', /\p{Script=Hebrew}/u],
  ['thai', /\p{Script=Thai}/u],
  ['devanagari', /\p{Script=Devanagari}/u],
];
const SCRIPTED_LETTER_RE = /(?![\p{Script=Common}\p{Script=Inherited}])\p{L}/u;

function scriptsOf(s: string): Set<string> {
  const out = new Set<string>();
  for (const c of s) {
    if (!SCRIPTED_LETTER_RE.test(c)) continue;
    out.add(SCRIPTS.find(([, re]) => re.test(c))?.[0] ?? 'other');
  }
  return out;
}

/** A group in another script than the rest of its title is the title translated or romanized ("Gangnam Style (강남스타일)"). */
function isTranslation(group: string, title: ParsedTitle): boolean {
  const g = scriptsOf(group);
  const t = scriptsOf(withoutWords(title.base, group));
  return g.size > 0 && t.size > 0 && [...g].every((x) => !t.has(x));
}

/** `text` minus one occurrence of each word of `remove`. */
function withoutWords(text: string, remove: string): string {
  const left = text.split(' ');
  for (const w of remove.split(' ')) {
    const i = left.indexOf(w);
    if (i >= 0) left.splice(i, 1);
  }
  return left.join(' ');
}

/** Whether the group only names credited artists ("Oran Marseille (Khaled - I Am)"). */
function namesCredits(group: string, credits: readonly string[]): boolean {
  const names = credits.filter(Boolean).map((c) => c.split(' '));
  const words = group.split(' ');
  let named = false;
  for (let i = 0; i < words.length; ) {
    if (FILLER_WORDS.has(words[i] ?? '')) {
      i++;
      continue;
    }
    const at = i;
    const longest = Math.max(0, ...names.filter((n) => n.every((w, k) => words[at + k] === w)).map((n) => n.length));
    if (!longest) return false;
    named = true;
    i += longest;
  }
  return named;
}

interface GroupComparison {
  /** Groups on one side only that neither translate the title nor name its artists. */
  unexplained: string[];
  /** [translated group, other title's core] pairs worth comparing. */
  translations: Array<[string, string]>;
}

function compareGroups(a: ParsedTitle, b: ParsedTitle, credits: readonly string[]): GroupComparison {
  const unexplained: string[] = [];
  const translations: Array<[string, string]> = [];
  for (const [own, other] of [
    [a, b],
    [b, a],
  ] as const) {
    for (const g of groupsOnlyIn(own.extras, other.extras)) {
      if (isTranslation(g, own)) translations.push([g, other.core]);
      else if (!namesCredits(g, credits)) unexplained.push(g);
    }
  }
  return { unexplained, translations };
}

function pairSimilarity(a: string, b: string, fuzzyChars: boolean): number {
  const chars = fuzzyChars ? bigramDice(a, b) : a.replace(/ /g, '') === b.replace(/ /g, '') ? 1 : 0;
  return Math.max(tokenDice(a, b), chars);
}

export interface TitleSimilarityOptions {
  /**
   * Default true. false: character-level similarity only counts for identical space-free strings
   * ("Fireworks" / "Fire Works"), not near-misses ("Animals" / "Animal"). Use it when no duration can
   * confirm the match.
   */
  fuzzyChars?: boolean;
  /**
   * Default false. true: consonant skeletons of Latin titles count, for transliterations ("Ouelli El Darek" /
   * "Weli L Darek"). Unrelated words share skeletons too ("Stronger" / "Strange"), so pass true only with
   * corroborating evidence such as the same album. Cyrillic/Greek transliterations always count.
   */
  skeleton?: boolean;
  /** Folded artist names of both sides: a bracket group that only names them explains itself. */
  credits?: readonly string[];
}

/** Similarity of two parsed titles in 0..1. Version tags are not considered here. */
export function titleSimilarity(a: ParsedTitle, b: ParsedTitle, opts: TitleSimilarityOptions = {}): number {
  const fuzzyChars = opts.fuzzyChars ?? true;
  const ab = comparable(a.base);
  const bb = comparable(b.base);
  const baseSim = pairSimilarity(ab, bb, fuzzyChars);
  let best = baseSim;
  const groups = compareGroups(a, b, opts.credits ?? []);
  const corePairs = groups.unexplained.length ? groups.translations : [[a.core, b.core] as [string, string], ...groups.translations];
  for (const [x, y] of corePairs) {
    best = Math.max(best, pairSimilarity(comparable(x), comparable(y), fuzzyChars) - CORE_PENALTY);
  }
  const ta = transliterate(ab);
  const tb = transliterate(bb);
  const transliterated = ta !== ab || tb !== bb;
  if (transliterated) best = Math.max(best, pairSimilarity(ta, tb, fuzzyChars) - TRANSLIT_PENALTY);
  const sa = skeleton(ta);
  const sb = skeleton(tb);
  if ((opts.skeleton || transliterated) && Array.from(sa).length >= SKELETON_MIN_LENGTH && Array.from(sb).length >= SKELETON_MIN_LENGTH) {
    best = Math.max(best, Math.min(SKELETON_CAP, bigramDice(sa, sb)));
  }
  if (numbersOf(ab) !== numbersOf(bb)) best = Math.min(best, NUMBER_MISMATCH_CAP);
  if (DISTINCT_PART_RE.test(differingWords(ab, bb).join(' '))) best = Math.min(best, DISTINCT_PART_CAP);
  // The same words bracketed differently ("Sunshine (The Light)" / "Sunshine The Light") are not unexplained.
  if (groups.unexplained.length && baseSim < 1) best = Math.min(best, UNEXPLAINED_GROUP_CAP);
  return Math.max(0, Math.min(1, best));
}
