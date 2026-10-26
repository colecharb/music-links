// Adversarial review of src/normalize.ts and src/match.ts. Each case is a catalog title shape that real
// platforms produce; the "real" groups use metadata observed live on the iTunes and Deezer search APIs.
import { describe, expect, it } from 'vitest';
import { ACCEPT_TRACK, artistMatch, pickBestAlbum, pickBestTrack, scoreAlbum, scoreTrack, verifyTrackById } from '../src/match';
import { fold, parseAlbumTitle, parseTitle, qualifiersCompatible, splitArtists, titleSimilarity } from '../src/normalize';
import type { AlbumMeta, TrackMeta } from '../src/types';

function track(p: Partial<TrackMeta> & { title: string }): TrackMeta {
  return {
    kind: 'track',
    id: p.id ?? p.title,
    url: `https://example.com/${encodeURIComponent(p.id ?? p.title)}`,
    artists: ['Artist'],
    artist: 'Artist',
    durationMs: 200_000,
    durationPrecisionMs: 1,
    ...p,
  };
}

function album(p: Partial<AlbumMeta> & { title: string }): AlbumMeta {
  return {
    kind: 'album',
    id: p.id ?? p.title,
    url: `https://example.com/${encodeURIComponent(p.id ?? p.title)}`,
    artists: ['Artist'],
    artist: 'Artist',
    ...p,
  };
}

/** A YouTube source: no duration, no album. */
const youtube = { durationMs: undefined, durationPrecisionMs: undefined } as const;
const sim = (a: string, b: string, fuzzyChars = true) => titleSimilarity(parseTitle(a), parseTitle(b), { fuzzyChars });

describe('review: vocabulary gaps', () => {
  it.each([
    // Separate performances for a broadcaster or platform: live, not the studio recording.
    ['Song - Recorded at Spotify Studios NYC', ['live']],
    ['Song (Recorded at Spotify Studios NYC)', ['live']],
    ['Song (BBC Session)', ['live']],
    ['Song - Spotify Sessions', ['live']],
    ['Song (Recorded Live at Abbey Road)', ['live']],
    ["Song (En direct de l'Olympia)", ['live']],
    ['Song (In diretta)', ['live']],
    // Anime openings cut to broadcast length.
    ['紅蓮華 (TV Size)', ['edit']],
    ['Song (TV Ver.)', ['edit']],
  ])('%j carries %j', (raw, hard) => {
    const p = parseTitle(raw);
    expect([...p.versions].sort()).toEqual(hard);
    expect(p.base).toBe(raw.startsWith('紅') ? '紅蓮華' : 'song');
  });

  it.each(['Song (LP Version)', 'Song (Studio Version)', 'Song (Letra)', 'Song - Paroles'])('%j is the album recording (no tags)', (raw) => {
    const p = parseTitle(raw);
    expect(p.base).toBe('song');
    expect(p.versions.size + p.soft.size).toBe(0);
  });

  it('"Ver." counts as a version word', () => {
    expect([...parseTitle('Dynamite (Acoustic Ver.)').versions]).toEqual(['acoustic']);
    expect([...parseTitle('Song (Japanese Ver.)').soft]).toEqual(['variant:japanese']);
  });
});

describe('review: version qualifiers (remixer, venue, year)', () => {
  it.each([
    ['Song - Tiësto Remix', 'remix', ['tiesto']],
    ['Song (David Guetta Remix)', 'remix', ['david', 'guetta']],
    ['Song (Remixed by Tiësto)', 'remix', ['tiesto']],
    ['Song - Remix', 'remix', []],
    ['Song (Tiësto Remix) [Radio Edit]', 'remix', ['tiesto']],
    ['Song - Tiësto Remix / Radio Edit', 'remix', ['tiesto']],
    ['Song (Live at Wembley Stadium / July 1986)', 'live', ['wembley', 'stadium', '1986']],
    ['Bohemian Rhapsody (Live, European Tour / 1979)', 'live', ['european', 'tour', '1979']],
    ['Song (Live / Remastered 2011)', 'live', []],
    ['Song (Live / Bonus Track)', 'live', []],
    ['Song (2011 Remastered Live Version)', 'live', []],
    ['Song (Ao Vivo Em São Paulo)', 'live', ['sao', 'paulo']],
    ['Song (Demo 2)', 'demo', ['2']],
  ] as const)('%j: %s qualifier %j', (raw, tag, words) => {
    expect(parseTitle(raw).qualifiers[tag] ?? []).toEqual(words);
  });

  it.each([
    [['tiesto'], ['david', 'guetta'], false],
    [['dj', 'snake'], ['dj', 'khaled'], false],
    [['wembley'], ['budokan'], false],
    [['1986'], ['1992'], false],
    [['wembley', '1986'], ['wembley', '1992'], false],
    [['1'], ['2'], false],
    [['tiesto'], ['tiestos', 'big', 'room'], true],
    [['steve', 'aoki'], ['aoki'], true],
    [['major', 'lazer', 'moti'], ['moti'], true],
    [['wembley', 'stadium', '1986'], ['wembley', '86'], true],
    [['1986'], ['wembley'], true],
    [[], ['anything'], true],
    [['mk'], ['tiesto'], true], // too short to tell
  ])('%j vs %j: compatible %s', (a, b, ok) => {
    expect(qualifiersCompatible(a, b)).toBe(ok);
    expect(qualifiersCompatible(b, a)).toBe(ok);
  });
});

describe('review: folding and artist splitting', () => {
  it.each([
    ['P!nk', 'pink'],
    ['Ke$ha', 'kesha'],
    ['A$AP Rocky', 'asap rocky'],
    ['$uicideboy$', 'suicideboys'],
    ['Panic! At The Disco', 'panic at the disco'],
    ['Wham!', 'wham'],
  ])('fold(%j) === %j', (raw, folded) => {
    expect(fold(raw)).toBe(folded);
  });

  it.each([
    ['Lil Nas X & Billy Ray Cyrus', ['lil nas x', 'billy ray cyrus']],
    ['Marshmello x Anne-Marie', ['marshmello', 'anne marie']],
    ['Lil Nas X, Jack Harlow', ['lil nas x', 'jack harlow']],
    ['Malcolm X', ['malcolm x']],
  ])('splitArtists([%j]) has the names %j', (credit, names) => {
    const split = splitArtists([credit]);
    for (const n of names) expect(split).toContain(n);
    expect(split).not.toContain('lil nas');
  });

  it.each([
    ['P!nk', 'Pink'],
    ['Ke$ha', 'Kesha'],
    ['Lil Nas X & Billy Ray Cyrus', 'Lil Nas X'],
  ])('%j matches %j', (a, b) => {
    expect(artistMatch({ artist: a, artists: [a] }, { artist: b, artists: [b] }).match).toBe(true);
  });
});

describe('review: numbers in titles', () => {
  it.each([
    ['Greatest Hits', 'Greatest Hits II'],
    ['Greatest Hits II', 'Greatest Hits III'],
    ['Rocky II', 'Rocky IV'],
    ['Song, Pt. 1', 'Song, Part Two'],
  ])('%j vs %j are different works', (a, b) => {
    expect(sim(a, b)).toBeLessThan(0.8);
    expect(titleSimilarity(parseAlbumTitle(a), parseAlbumTitle(b))).toBeLessThan(0.8);
  });

  it.each([
    ['Another Brick in the Wall, Pt. 2', 'Another Brick In The Wall (Part II)'],
    ['Song, Part Two', 'Song, Pt. 2'],
    ['Greatest Hits II', 'Greatest Hits 2'],
    ['Vol. III', 'Volume 3'],
  ])('%j vs %j are the same title', (a, b) => {
    expect(sim(a, b)).toBeGreaterThanOrEqual(0.95);
  });
});

describe('review: title similarity without a duration', () => {
  it.each([
    ['Animals', 'Animal'],
    ['Diamonds', 'Diamond'],
    ['Lose', 'Loose'],
  ])('%j vs %j: a one-letter difference is not enough without a duration', (a, b) => {
    expect(sim(a, b, false)).toBeLessThan(0.9);
  });

  it.each([
    ['Fireworks', 'Fire Works'],
    ['Hey Ya!', 'Hey Ya'],
    ['Señorita', 'Senorita'],
  ])('%j vs %j: spacing and punctuation still match', (a, b) => {
    expect(sim(a, b, false)).toBe(1);
  });

  it.each([
    ['Song (Alternate Take)'],
    ['Song (Outtake)'],
    ['Song (Rehearsal)'],
    ['Song (Piano)'],
    ['Song (Orchestral)'],
    ['Song (Duet with Someone)'],
    ['Song (Early Take)'],
    ['Song (Voice Memo)'],
  ])('%j is another track than "Song"', (raw) => {
    expect(sim('Song', raw)).toBeLessThan(0.8);
    expect(scoreTrack(track({ title: 'Song' }), track({ title: raw })).reject).toMatch(/^title: /);
  });
});

describe('review: wrong direct links that are now rejected', () => {
  it.each([
    // [label, source, candidate, reject pattern]
    ['different remixers, same duration', track({ title: 'Song - Tiësto Remix' }), track({ title: 'Song (David Guetta Remix)' }), /remix \(tiesto vs david guetta\)/],
    ['different remixers, YouTube source', track({ title: 'Song (Tiësto Remix)', ...youtube }), track({ title: 'Song (David Guetta Remix)' }), /remix \(/],
    ['DJ Snake vs DJ Khaled remix', track({ title: 'Song (DJ Snake Remix)' }), track({ title: 'Song (DJ Khaled Remix)' }), /remix \(dj snake vs dj khaled\)/],
    ['remix years', track({ title: 'Song (2012 Remix)' }), track({ title: 'Song (2020 Remix)' }), /remix \(2012 vs 2020\)/],
    ['numbered demos', track({ title: 'Song (Demo 1)' }), track({ title: 'Song (Demo 2)' }), /demo \(1 vs 2\)/],
    ['different venues, YouTube source', track({ title: 'Song (Live at Wembley)', ...youtube }), track({ title: 'Song (Live at Budokan)' }), /live \(wembley vs budokan\)/],
    ['different live years', track({ title: 'Song (Live 1986)' }), track({ title: 'Song (Live 1992)' }), /live \(1986 vs 1992\)/],
    ['Spotify Studios session vs studio', track({ title: 'Song' }), track({ title: 'Song - Recorded at Spotify Studios NYC' }), /studio vs live/],
    ['bracketed Spotify Studios session vs studio', track({ title: 'Song' }), track({ title: 'Song (Recorded at Spotify Studios NYC)' }), /studio vs live/],
    ['BBC session vs studio', track({ title: 'Song' }), track({ title: 'Song (BBC Session)' }), /studio vs live/],
    ['French live vs studio', track({ title: "Song (En direct de l'Olympia)" }), track({ title: 'Song' }), /live vs studio/],
    ['piano version, YouTube source', track({ title: 'Song', ...youtube }), track({ title: 'Song (Piano Version)' }), /studio vs variant:piano/],
    ['piano without "version", YouTube source', track({ title: 'Song', ...youtube }), track({ title: 'Song (Piano)' }), /^title: /],
    ['Spanish version with the same duration', track({ title: 'Song' }), track({ title: 'Song (Spanish Version)' }), /studio vs variant:spanish/],
    [
      "All Too Well 10 minute version, YouTube source",
      track({ title: "All Too Well (Taylor's Version)", ...youtube }),
      track({ title: "All Too Well (10 Minute Version) (Taylor's Version) (From The Vault)" }),
      /variant:10 minute/,
    ],
    ['anime TV size, YouTube source', track({ title: '紅蓮華', ...youtube }), track({ title: '紅蓮華 (TV Size)' }), /studio vs edit/],
    ['plural title, YouTube source', track({ title: 'Animals', ...youtube }), track({ title: 'Animal' }), /^title: /],
  ])('%s', (_label, src, cand, reason) => {
    const r = scoreTrack(src, cand);
    expect(r.score).toBe(0);
    expect(r.reject).toMatch(reason);
    expect(pickBestTrack(src, [cand]).accepted).toBeNull();
  });
});

describe('review: real catalog data', () => {
  // iTunes search results, observed live (durations in ms).
  const queen = { artists: ['Queen'], artist: 'Queen' };

  it('Queen: two live albums 1.4s apart are different concerts', () => {
    const wembley = track({ ...queen, title: 'Bohemian Rhapsody (Live At Wembley Stadium / July 1986)', album: 'Live at Wembley Stadium', durationMs: 350_613 });
    const killers = track({ ...queen, title: 'Bohemian Rhapsody (Live, European Tour / 1979)', album: 'Live Killers', durationMs: 352_040 });
    const r = scoreTrack(wembley, killers);
    expect(r.reject).toMatch(/live \(wembley stadium 1986 vs european tour 1979\)/);
    expect(pickBestTrack(wembley, [killers]).accepted).toBeNull();
  });

  it('Queen: bare "(Live)" on two different live releases is rejected; the same concert on a compilation is not', () => {
    const montreal = track({ ...queen, title: 'Bohemian Rhapsody (Live)', album: 'Queen Rock Montreal', durationMs: 328_933 });
    const budapest = track({ ...queen, title: 'Bohemian Rhapsody (Live)', album: 'Hungarian Rhapsody (Live In Budapest / 1986)', durationMs: 330_333 });
    expect(scoreTrack(montreal, budapest).reject).toBe('version: live on Queen Rock Montreal vs Hungarian Rhapsody (Live In Budapest / 1986)');
    expect(scoreTrack(budapest, montreal).reject).toMatch(/^version: live on /);
    const onCompilation = track({ ...queen, title: 'Bohemian Rhapsody (Live)', album: 'Greatest Hits Live', durationMs: 329_000, durationPrecisionMs: 1000 });
    expect(scoreTrack(montreal, onCompilation).reject).toBeUndefined();
  });

  it('Queen: the same concert named in both titles matches across album names', () => {
    const spotify = track({ ...queen, title: 'Bohemian Rhapsody - Live At Wembley Stadium / July 1986', album: 'Live At Wembley Stadium', durationMs: 350_613 });
    const deezer = track({ ...queen, title: 'Bohemian Rhapsody (Live At Wembley Stadium / July 1986)', album: "Live At Wembley '86", durationMs: 350_000, durationPrecisionMs: 1000 });
    expect(scoreTrack(spotify, deezer).reject).toBeUndefined();
    expect(scoreTrack(spotify, deezer).score).toBeGreaterThanOrEqual(ACCEPT_TRACK);
  });

  it('Queen: an ISRC hit on another release is not second-guessed by release names', () => {
    const live = track({ ...queen, title: 'Bohemian Rhapsody (Live)', album: 'Queen Rock Montreal', durationMs: 328_933, isrc: 'GBUM71029604' });
    const sameIsrc = track({ ...live, id: 'deluxe', album: 'The Game (Deluxe Edition)' });
    expect(verifyTrackById(live, sameIsrc, { strict: false }).reject).toBeUndefined();
    expect(verifyTrackById(live, sameIsrc, { strict: true }).reject).toMatch(/^version: live on /);
  });

  // Portugal. The Man, "Live in the Moment": Apple (ms) and Deezer (whole seconds).
  const ptm = { artists: ['Portugal. The Man'], artist: 'Portugal. The Man' };

  it('Portugal. The Man: two remixes within the duration tolerance are not the same recording', () => {
    const apple = track({ ...ptm, title: 'Live in the Moment (Superorganism Remix)', album: 'Live in the Moment (Superorganism Remix) - Single', durationMs: 191_548 });
    const tokimonsta = track({ ...ptm, id: '499632712', title: 'Live in the Moment (TOKiMONSTA Remix)', album: 'Live in the Moment (TOKiMONSTA Remix)', durationMs: 195_000, durationPrecisionMs: 1000 });
    const superorganism = track({ ...ptm, id: '805690922', title: 'Live in the Moment (Superorganism Remix)', album: 'Live in the Moment (Remixes)', durationMs: 191_000, durationPrecisionMs: 1000 });
    expect(scoreTrack(apple, tokimonsta).reject).toBe('version: remix (superorganism vs tokimonsta)');
    expect(pickBestTrack(apple, [tokimonsta]).accepted).toBeNull();
    expect(pickBestTrack(apple, [tokimonsta, superorganism]).accepted?.item.id).toBe('805690922');
  });

  it('Portugal. The Man: a single named after its track is not a live album', () => {
    const appleSingle = track({ ...ptm, title: 'Live in the Moment ("Weird Al" Yankovic Remix)', album: 'Live in the Moment ("Weird Al" Yankovic Remix) - Single', durationMs: 201_284 });
    const deezer = track({ ...ptm, id: '2074036417', title: "Live in the Moment ('Weird Al' Yankovic Remix)", album: 'Woodstock (Deluxe Edition)', durationMs: 201_000, durationPrecisionMs: 1000 });
    expect(scoreTrack(appleSingle, deezer).reject).toBeUndefined();
    expect(scoreTrack(deezer, appleSingle).reject).toBeUndefined();
    const original = track({ ...ptm, title: 'Live in the Moment', album: 'Woodstock', durationMs: 246_789 });
    const single = track({ ...ptm, id: 'single', title: 'Live in the Moment', album: 'Live in the Moment - Single', durationMs: 246_000, durationPrecisionMs: 1000 });
    expect(pickBestTrack(original, [single]).accepted?.item.id).toBe('single');
    expect(pickBestTrack(single, [original]).accepted).not.toBeNull();
    // A real live single is still live.
    expect(scoreTrack(original, track({ ...ptm, title: 'Live in the Moment', album: 'Live in the Moment (Live) - Single' })).reject).toMatch(/studio vs live/);
  });

  // Alan Walker, "Faded": iTunes search hits (ms), in API order.
  const aw = { artists: ['Alan Walker'], artist: 'Alan Walker', explicit: false };
  const faded = [
    track({ ...aw, id: '1196294581', title: 'Faded', album: 'Faded - EP', durationMs: 212_627 }),
    track({ ...aw, id: '1634020343', title: 'Faded (Slowed Remix)', album: 'Slowed - EP', durationMs: 236_400 }),
    track({ ...aw, id: '1196294706', title: 'Faded (Restrung)', album: 'Faded - EP', durationMs: 217_053 }),
    track({ ...aw, id: '1196294686', title: 'Faded (Instrumental)', album: 'Faded - EP', durationMs: 214_013 }),
    track({ ...aw, id: '1196295329', title: "Faded (Tiesto's Northern Lights Remix)", album: 'Faded (Remixes)', durationMs: 250_280 }),
    track({ ...aw, id: '1196295333', title: 'Faded (Luke Christopher Remix)', album: 'Faded (Remixes)', durationMs: 206_387 }),
    track({ ...aw, id: '1196295288', title: 'Faded (Dash Berlin Remix)', album: 'Faded (Remixes)', durationMs: 215_413 }),
    track({ ...aw, id: '1445141314', title: 'Faded (Interlude)', album: 'Different World', durationMs: 41_867 }),
    track({ ...aw, id: '1196295091', title: 'Faded (Slushii Remix)', album: 'Faded (Remixes)', durationMs: 211_693 }),
    track({ ...aw, id: '1445141316', title: 'Faded', album: 'Different World', durationMs: 212_107 }),
    track({ ...aw, id: '1196294825', title: 'Faded (Piano Version)', album: 'Faded - EP', durationMs: 215_080 }),
    track({ ...aw, id: '6766787217', title: 'Fade', album: 'Origins - Single', durationMs: 264_048 }),
  ];

  it('Alan Walker: the piano version (2.5s longer) never stands in for the original, or vice versa', () => {
    const piano = faded.find((t) => t.id === '1196294825');
    const deezerOriginal = track({ ...aw, title: 'Faded', album: 'Faded', durationMs: 212_000, durationPrecisionMs: 1000 });
    if (!piano) throw new Error('fixture');
    expect(scoreTrack(deezerOriginal, piano).reject).toBe('version: studio vs variant:piano');
    expect(scoreTrack(piano, deezerOriginal).reject).toBe('version: variant:piano vs studio');
    expect(pickBestTrack(piano, faded.filter((t) => t !== piano)).accepted).toBeNull();
    expect(pickBestTrack(piano, faded).accepted?.item.id).toBe('1196294825');
  });

  it('Alan Walker: a Deezer source and a YouTube source both get the original', () => {
    const deezer = track({ ...aw, title: 'Faded', album: 'Faded', durationMs: 212_000, durationPrecisionMs: 1000 });
    const r = pickBestTrack(deezer, faded);
    expect(r.accepted?.item.id).toBe('1196294581');
    const yt = track({ artists: ['Alan Walker'], artist: 'Alan Walker', title: 'Faded', ...youtube });
    const y = pickBestTrack(yt, faded);
    expect(['1196294581', '1445141316']).toContain(y.accepted?.item.id);
    const acceptable = new Set(['1196294581', '1445141316', '1196294706']); // Restrung is only ranked below
    expect(y.ranked.filter((c) => !c.reject).every((c) => acceptable.has(c.item.id))).toBe(true);
  });

  it('Alan Walker: a YouTube "Faded (Piano Version)" source finds only the piano version', () => {
    const yt = track({ artists: ['Alan Walker'], artist: 'Alan Walker', title: 'Faded (Piano Version)', ...youtube });
    const r = pickBestTrack(yt, faded);
    expect(r.accepted?.item.id).toBe('1196294825');
    expect(r.ranked.filter((c) => !c.reject).map((c) => c.item.id)).toEqual(['1196294825']);
  });

  it('Kino: the English version with an identical duration is rejected on its label alone', () => {
    const apple = track({ title: 'Группа крови', artists: ['Kino'], artist: 'Kino', album: 'Группа крови', durationMs: 284_003 });
    const english = track({ title: 'Группа крови (Английская версия)', artists: ['Кино'], artist: 'Кино', album: 'Группа крови', durationMs: 284_000, durationPrecisionMs: 1000 });
    expect(scoreTrack(apple, english).reject).toBe('version: studio vs variant:англииская');
  });

  // Deezer album search: Queen's three "Greatest Hits" volumes have 17 tracks each.
  it.each([
    ['Greatest Hits', '1007459321'],
    ['Greatest Hits II', '1007454451'],
    ['Greatest Hits III', '1007462751'],
  ])('Queen albums: %j picks only its own volume', (title, id) => {
    const deezer = [
      album({ ...queen, id: '1007459321', title: 'Greatest Hits', trackCount: 17, albumType: 'album' }),
      album({ ...queen, id: '1007454451', title: 'Greatest Hits II', trackCount: 17, albumType: 'album' }),
      album({ ...queen, id: '1007462751', title: 'Greatest Hits III', trackCount: 17, albumType: 'album' }),
      album({ ...queen, id: '1007452191', title: 'Greatest Hits In Japan', trackCount: 12, albumType: 'album' }),
      album({ artists: ['The Bohemian Champions'], artist: 'The Bohemian Champions', id: '5224681', title: 'Queen Greatest Hits', trackCount: 17 }),
    ];
    const src = album({ ...queen, title, trackCount: 17 });
    expect(pickBestAlbum(src, deezer).accepted?.item.id).toBe(id);
    expect(pickBestAlbum(src, deezer.filter((a) => a.id !== id)).accepted).toBeNull();
  });
});

describe('review: legitimate matches stay accepted', () => {
  it.each([
    ['Hey Jude remaster', track({ title: 'Hey Jude' }), track({ title: 'Hey Jude - Remastered 2015' })],
    ['remix with credits on both platforms', track({ title: 'Despacito - Remix', artists: ['Luis Fonsi', 'Daddy Yankee', 'Justin Bieber'] }), track({ title: 'Despacito (feat. Justin Bieber) [Remix]', artists: ['Luis Fonsi & Daddy Yankee'] })],
    ['named remix, both formats', track({ title: 'Titanium (feat. Sia) - Alesso Remix', artists: ['David Guetta', 'Sia'] }), track({ title: 'Titanium (feat. Sia) [Alesso Remix]', artists: ['David Guetta'] })],
    ['remixer spelled two ways', track({ title: "Song (Tiësto's Big Room Remix)" }), track({ title: 'Song - Tiësto Remix' })],
    ['remixer plus radio edit', track({ title: 'Song - Tiësto Remix / Radio Edit' }), track({ title: 'Song (Tiësto Remix) [Radio Edit]' })],
    ['remixer surname only', track({ title: 'Song (Steve Aoki Remix)' }), track({ title: 'Song (Aoki Remix)' })],
    ['plain remix vs named remix', track({ title: 'Song (Remix)' }), track({ title: 'Song (Tiësto Remix)' })],
    ['venue with a comma', track({ title: 'Song - Live From Spotify London' }), track({ title: 'Song (Live from Spotify, London)' })],
    ['venue, year and remaster', track({ title: 'Hotel California - Live On MTV, 1994; 2018 Remaster' }), track({ title: 'Hotel California (Live on MTV)' })],
    ['plain live vs live with venue', track({ title: 'Song - Live/1975' }), track({ title: 'Song (Live at Hammersmith Odeon, London / 1975)' })],
    ['Portuguese and English venue', track({ title: 'Song (Ao Vivo Em São Paulo)' }), track({ title: 'Song (Live in Sao Paulo)' })],
    ['French and English venue', track({ title: "Song (En direct de l'Olympia)" }), track({ title: 'Song (Live at Olympia)' })],
    ['remastered live take', track({ title: 'Song (2011 Remastered Live Version)' }), track({ title: 'Song (Live at Wembley 1986)' })],
    [
      'unplugged, long Spotify descriptor',
      track({ title: 'Layla - Acoustic; Live at MTV Unplugged, Bray Film Studios, Windsor, England, UK, 1/16/1992; 2013 Remaster', album: 'Unplugged (Deluxe Edition) [Remastered]' }),
      track({ title: 'Layla (Acoustic) [Live]', album: 'Unplugged' }),
    ],
    ['LP version', track({ title: 'Song' }), track({ title: 'Song (LP Version)' })],
    ['studio version', track({ title: 'Song' }), track({ title: 'Song (Studio Version)' })],
    ['two variant labels, one recording, same duration', track({ title: 'Aïcha - Version Mixte' }), track({ title: 'Aicha (Mixed Version)' })],
    ['part numbering', track({ title: 'Another Brick in the Wall, Pt. 2' }), track({ title: 'Another Brick In The Wall (Part II)' })],
    ['part in words', track({ title: 'Song, Part Two' }), track({ title: 'Song, Pt. 2' })],
    ['soundtrack suffix', track({ title: 'Let It Go' }), track({ title: 'Let It Go - From "Frozen"/Soundtrack Version' })],
    ['stylized artist', track({ title: 'Song', artists: ['P!nk'] }), track({ title: 'Song', artists: ['Pink'] })],
    ['stylized artist with $', track({ title: 'Song', artists: ['Ke$ha'] }), track({ title: 'Song', artists: ['Kesha'] })],
    ['duet credit ending in X', track({ title: 'Old Town Road (Remix)', artists: ['Lil Nas X & Billy Ray Cyrus'] }), track({ title: 'Old Town Road - Remix', artists: ['Lil Nas X', 'Billy Ray Cyrus'] })],
    ['"x" credit', track({ title: 'Friends', artists: ['Marshmello x Anne-Marie'] }), track({ title: 'FRIENDS', artists: ['Marshmello', 'Anne-Marie'] })],
    ['feat in title vs second artist', track({ title: 'Get Lucky (feat. Pharrell Williams)', artists: ['Daft Punk'] }), track({ title: 'Get Lucky', artists: ['Daft Punk', 'Pharrell Williams'] })],
    ['romanized subtitle', track({ title: '봄날 (Spring Day)', artists: ['BTS'] }), track({ title: 'Spring Day', artists: ['BTS'] })],
    ['YouTube official video', track({ title: 'Blinding Lights (Official Video)', artists: ['The Weeknd'], ...youtube }), track({ title: 'Blinding Lights', artists: ['The Weeknd'] })],
    ['YouTube lyric video in Spanish', track({ title: 'Song (Letra)', ...youtube }), track({ title: 'Song' })],
    ['YouTube title split differently', track({ title: 'Fireworks', ...youtube }), track({ title: 'Fire Works' })],
    ['YouTube Cyrillic vs Latin', track({ title: 'Группа крови', artists: ['Кино'], ...youtube }), track({ title: 'Gruppa krovi', artists: ['Kino'] })],
    ['live album, same concert on another platform', track({ title: 'Ouelli El Darek', artists: ['Khaled'], album: 'Hafla (Live)', durationMs: 279_427 }), track({ title: 'Ouelli El Darek (Live)', artists: ['Khaled'], album: 'Hafla', durationMs: 279_000, durationPrecisionMs: 1000 })],
  ])('%s', (_label, src, cand) => {
    const r = scoreTrack(src, cand);
    expect(r.reject).toBeUndefined();
    expect(r.score).toBeGreaterThanOrEqual(ACCEPT_TRACK);
    expect(scoreTrack(cand, src).reject).toBeUndefined();
  });
});

describe('review: refinements', () => {
  it('a live single named after its track carries the live album recording', () => {
    const single = track({ title: 'Song (Live)', album: 'Song (Live) - Single', durationMs: 240_000 });
    const liveAlbum = track({ title: 'Song (Live)', album: 'Live at the Forum', durationMs: 240_500 });
    expect(scoreTrack(single, liveAlbum).reject).toBeUndefined();
    expect(scoreTrack(liveAlbum, single).reject).toBeUndefined();
  });

  it('named edits are not excused by an equal duration', () => {
    expect(scoreTrack(track({ title: 'Song (Tiësto Edit)' }), track({ title: 'Song (Guetta Edit)' })).reject).toBe('version: edit (tiesto vs guetta)');
    // ...while unnamed edit labels still are
    expect(scoreTrack(track({ title: 'Song (Radio Edit)' }), track({ title: 'Song (Single Edit)' })).reject).toBeUndefined();
  });

  it.each([
    ['Fancy (Japanese Ver.)', 'Fancy (English Ver.)'],
    ['Song (Spanish Version)', 'Song (English Version)'],
    ['Song (Piano Version)', 'Song (Orchestral Version)'],
  ])('%j vs %j with the same duration: different language or arrangement labels are rejected', (a, b) => {
    expect(scoreTrack(track({ title: a }), track({ title: b })).reject).toMatch(/^version: variant:/);
  });

  it('look-alike variant labels need a matching duration', () => {
    const deezer = track({ title: 'Aïcha (Version Mixte)', durationMs: 260_000, durationPrecisionMs: 1000 });
    expect(scoreTrack(deezer, track({ title: 'Aicha (Mixed Version)', durationMs: 259_667 })).reject).toBeUndefined();
    expect(scoreTrack(deezer, track({ title: 'Aicha (Mixed Version)', durationMs: undefined })).reject).toMatch(/variant:mixte vs variant:mixed/);
  });

  it('albums: two remix singles by different remixers are different releases', () => {
    const r = scoreAlbum(album({ title: 'Song (Tiësto Remix) - Single', trackCount: 1 }), album({ title: 'Song (David Guetta Remix) - Single', trackCount: 1 }));
    expect(r.reject).toBe('version: remix (tiesto vs david guetta)');
  });

  it('ISRC lookups (non-strict) trust the identifier over variant labels, not over named remixes', () => {
    const src = track({ title: 'Song', isrc: 'USAAA0000001' });
    expect(verifyTrackById(src, track({ title: 'Song (LP Version)' }), { strict: false }).reject).toBeUndefined();
    expect(verifyTrackById(src, track({ title: 'Song (Japanese Version)' }), { strict: false }).reject).toBeUndefined();
    expect(verifyTrackById(src, track({ title: 'Song (Japanese Version)' }), { strict: true }).reject).toMatch(/variant:japanese/);
    const remix = track({ title: 'Song (Tiësto Remix)' });
    expect(verifyTrackById(remix, track({ title: 'Song (David Guetta Remix)' }), { strict: false }).reject).toMatch(/remix \(tiesto vs david guetta\)/);
  });
});

describe('review: the task brief cases', () => {
  it.each([
    ['Smells Like Teen Spirit vs MTV Unplugged', track({ title: 'Smells Like Teen Spirit', album: 'Nevermind' }), track({ title: 'Smells Like Teen Spirit', album: 'MTV Unplugged In New York' }), /studio vs acoustic\+live/],
    ['Despacito vs remix', track({ title: 'Despacito' }), track({ title: 'Despacito - Remix' }), /studio vs remix/],
    ['Blinding Lights vs sped up', track({ title: 'Blinding Lights' }), track({ title: 'Blinding Lights - Sped Up' }), /studio vs sped_up/],
    ["Taylor's Version", track({ title: 'Love Story' }), track({ title: "Love Story (Taylor's Version)" }), /studio vs rerecorded/],
    ['Song vs Song 2', track({ title: 'Song' }), track({ title: 'Song 2' }), /^title: /],
    ['Pt. 1 vs Pt. 2', track({ title: 'Song, Pt. 1' }), track({ title: 'Song (Part II)' }), /^title: /],
  ])('%s is rejected', (_label, src, cand, reason) => {
    expect(scoreTrack(src, cand).reject).toMatch(reason);
    expect(scoreTrack(cand, src).reject).toBeDefined();
  });

  it('an album: "Greatest Hits" vs "Greatest Hits II" with equal track counts is rejected', () => {
    const r = scoreAlbum(album({ title: 'Greatest Hits', trackCount: 17, releaseDate: '1981-10-26' }), album({ title: 'Greatest Hits II', trackCount: 17, releaseDate: '1991-10-28' }));
    expect(r.reject).toMatch(/^title: /);
  });
});
