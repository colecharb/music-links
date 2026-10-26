import { describe, expect, it } from 'vitest';
import {
  bigramDice,
  classifyDescriptor,
  UNEXPLAINED_GROUP_CAP,
  fold,
  parseAlbumTitle,
  parseTitle,
  skeleton,
  splitArtists,
  stripHonorifics,
  titleSimilarity,
  tokenDice,
  transliterate,
  type HardTag,
} from '../src/normalize';

describe('fold', () => {
  it.each([
    ['Beyoncé', 'beyonce'],
    ['Aïcha', 'aicha'],
    ['Sigur Rós', 'sigur ros'],
    ['Mötley Crüe', 'motley crue'],
    ['Ørjan Nilsen', 'orjan nilsen'],
    ['Æon Flux', 'aeon flux'],
    ['Œuvre', 'oeuvre'],
    ['Straße', 'strasse'],
    ['Đorđe Balašević', 'dorde balasevic'],
    ['Łódź', 'lodz'],
    ['Þór', 'thor'],
    ['Fıstık', 'fistik'],
    ['İstanbul', 'istanbul'],
    ['Ἀθῆναι', 'αθηναι'],
    ['Don’t Stop Me Now', 'dont stop me now'],
    ["Don't Stop Me Now", 'dont stop me now'],
    ['Rock ‘n’ Roll', 'rock n roll'],
    ['“Heroes”', 'heroes'],
    ['Jay‐Z', 'jay z'],
    ['A—B–C', 'a b c'],
    ['Simon & Garfunkel', 'simon and garfunkel'],
    ['P.Y.T.', 'pyt'],
    ['R.E.M.', 'rem'],
    ['Mr. Brightside', 'mr brightside'],
    ['  Hello,   World!  ', 'hello world'],
    ['ＡＢＣ１２３', 'abc123'],
    ['日本語', '日本語'],
    ['Кино', 'кино'],
    ['Группа крови', 'группа крови'],
    ['عمرو دياب', 'عمرو دياب'],
    ['아이유', '아이유'],
    ['ガガガSP', 'ガガガsp'],
    ['हिन्दी', 'हिन्दी'],
  ])('fold(%j) = %j', (input, expected) => {
    expect(fold(input)).toBe(expected);
  });

  it('is idempotent', () => {
    for (const s of ['Beyoncé & Jay‐Z', '아이유', 'ガガガSP', 'عمرو دياب', 'P.Y.T.']) expect(fold(fold(s))).toBe(fold(s));
  });
});

describe('transliterate', () => {
  it.each([
    ['Кино', 'kino'],
    ['Виктор Цой', 'viktor tsoi'],
    ['Группа крови', 'gruppa krovi'],
    ['Земфира', 'zemfira'],
    ['Щедрик', 'shchedrik'],
    ['Μίκης Θεοδωράκης', 'mikis theodorakis'],
    ['Beyoncé', 'beyonce'],
    ['아이유', '아이유'],
  ])('%j -> %j', (input, expected) => {
    expect(transliterate(input)).toBe(expected);
  });
});

describe('parseTitle: version tags in suffixes', () => {
  const cases: Array<[string, HardTag[], string[]]> = [
    // live
    ['Song (Live)', ['live'], []],
    ['Song - Live', ['live'], []],
    ['Song - Live at Wembley / 1986', ['live'], []],
    ['Song (Live At Wembley Stadium / July 1986)', ['live'], []],
    ['Song (Live Aid)', ['live'], []],
    ['Song (En Vivo)', ['live'], []],
    ['Song - Ao Vivo', ['live'], []],
    ['Song (En Directo)', ['live'], []],
    ['Song (En concert)', ['live'], []],
    ['Song (En public)', ['live'], []],
    ['Song (Dal Vivo)', ['live'], []],
    ['Song (Live Version)', ['live'], []],
    ['Song (Concert)', ['live'], []],
    ['Song (MTV Unplugged)', ['acoustic', 'live'], []],
    // remix
    ['Song (Remix)', ['remix'], []],
    ['Song - Kygo Remix', ['remix'], []],
    ['Song (RMX)', ['remix'], []],
    ['Song (Remixed)', ['remix'], []],
    ['Song (Rework)', ['remix'], []],
    ['Song (Bootleg)', ['remix'], []],
    ['Song (Flip)', ['remix'], []],
    ['Song (Dub)', ['remix'], []],
    ['Song (VIP)', ['remix'], []],
    ['Song (Oran Mix)', ['remix'], []],
    ['Oran Marseille - Oran Mix', ['remix'], []],
    ['Song (Dance Mix)', ['remix'], []],
    // acoustic
    ['Song (Acoustic)', ['acoustic'], []],
    ['Song - Acústico', ['acoustic'], []],
    ['Song (Version acoustique)', ['acoustic'], []],
    ['Song (Stripped)', ['acoustic'], []],
    // instrumental, acapella, karaoke, demo
    ['Song (Instrumental)', ['instrumental'], []],
    ['Song (Inst.)', ['instrumental'], []],
    ['Song (A Cappella)', ['acapella'], []],
    ['Song - Acapella', ['acapella'], []],
    ['Song (A Capella)', ['acapella'], []],
    ['Song (Karaoke Version)', ['karaoke'], []],
    ['Get Lucky (Originally Performed by Daft Punk)', ['karaoke'], []],
    ['Song (Demo)', ['demo'], []],
    ['Song - 1979 Demo', ['demo'], []],
    // sped up / slowed
    ['Song (Sped Up)', ['sped_up'], []],
    ['Song - Speed Up', ['sped_up'], []],
    ['Song (Nightcore)', ['sped_up'], []],
    ['Song (Slowed)', ['slowed'], []],
    ['Song (Slowed + Reverb)', ['slowed'], []],
    ['Song - Slowed & Reverb', ['slowed'], []],
    ['Song (Chopped & Screwed)', ['slowed'], []],
    // edit
    ['Song (Radio Edit)', ['edit'], []],
    ['Song - Single Edit', ['edit'], []],
    ['Song (Edit)', ['edit'], []],
    ['Song - Radio Version', ['edit'], []],
    ['Song (Single Version)', ['edit'], []],
    ['Song (Short Version)', ['edit'], []],
    ['Song (Radio Mix)', ['edit'], []],
    // extended
    ['Song (Extended)', ['extended'], []],
    ['Song - Extended Mix', ['extended'], []],
    ['Song (Extended Version)', ['extended'], []],
    ['Song (Long Version)', ['extended'], []],
    ['Song (12" Version)', ['extended'], []],
    ['Song (12 Inch Mix)', ['extended'], []],
    ['Song (Club Mix)', ['extended'], []],
    // re-recordings
    ['Love Story (Taylor’s Version)', ['rerecorded'], []],
    ['Song - Re-Recorded', ['rerecorded'], []],
    ['Song (Rerecorded)', ['rerecorded'], []],
    // soft
    ['Song - Remastered 2011', [], ['remaster']],
    ['Song (2011 Remaster)', [], ['remaster']],
    ['Song (Remasterizado)', [], ['remaster']],
    ['Song (Remasterisé)', [], ['remaster']],
    ['Song (Remasterizzato)', [], ['remaster']],
    ['Song - Digitally Remastered', [], ['remaster']],
    ['Song - 2009 Mix', [], ['remaster']],
    ['Song (Mono)', [], ['mono']],
    ['Song - Mono Version', [], ['mono']],
    ['Song - Stereo Mix', [], ['stereo']],
    ['Song (Deluxe Edition)', [], ['deluxe']],
    ['Song (Explicit)', [], ['explicit']],
    ['Song (Clean)', [], ['clean']],
    ['Song [Edited Version]', [], ['clean']],
    ['Song (Spanish Version)', [], ['variant:spanish']],
    ['Aïcha - Version Mixte', [], ['variant:mixte']],
    ['Aicha (Mixed Version)', [], ['variant:mixed']],
    ['Группа крови (Английская версия)', [], ['variant:англииская']], // folded: й loses its breve
    ['Группа крови (Ремикс)', ['remix'], []],
    // several tags in one suffix, and several suffixes
    ['Song - Live / Remastered', ['live'], ['remaster']],
    ['Song (Live) [Remastered 2011]', ['live'], ['remaster']],
    ['Song (Live) - Remastered 2011', ['live'], ['remaster']],
    ['Song (Acoustic) [Live]', ['acoustic', 'live'], []],
  ];

  it.each(cases)('%j -> hard %j, soft %j', (raw, hard, soft) => {
    const p = parseTitle(raw);
    expect([...p.versions].sort()).toEqual([...hard].sort());
    expect([...p.soft].sort()).toEqual([...soft].sort());
  });

  it.each(cases)('%j has a stripped base', (raw) => {
    const p = parseTitle(raw);
    expect(['song', 'love story', 'oran marseille', 'aicha', 'get lucky', 'группа крови']).toContain(p.base);
    expect(p.core).toBe(p.base);
  });
});

describe('parseTitle: ignorable descriptors are stripped without tags', () => {
  it.each([
    'Song (Album Version)',
    'Song - Original Mix',
    'Song (Original Version)',
    'Song (Main Version)',
    'Song - Single',
    'Song (From "The Movie" Soundtrack)',
    'Song - From "The Movie" Soundtrack',
    'Song - From the Motion Picture "The Movie"',
    'Song (Bonus Track)',
    'Song (1996)',
    'Song [Official Video]',
    'Song (Official Audio)',
  ])('%j', (raw) => {
    const p = parseTitle(raw);
    expect(p.base).toBe('song');
    expect(p.versions.size).toBe(0);
    expect(p.soft.size).toBe(0);
  });
});

describe('parseTitle: traps', () => {
  it.each([
    ['Live Forever', 'live forever'],
    ['Live and Let Die', 'live and let die'],
    ['Remix to Ignition', 'remix to ignition'],
    ['Edit the World', 'edit the world'],
    ['Credit Card', 'credit card'],
    ['Mix Tape', 'mix tape'],
    ['Dancing With Myself', 'dancing with myself'],
    ['Soft Rock', 'soft rock'],
    ['Song - The Beginning', 'song the beginning'],
    ['Part 1 - The Beginning', 'part 1 the beginning'],
    ['Get Lucky - Tribute to Daft Punk', 'get lucky tribute to daft punk'],
  ])('%j keeps base %j with no tags or featured artists', (raw, base) => {
    const p = parseTitle(raw);
    expect(p.base).toBe(base);
    expect(p.versions.size).toBe(0);
    expect(p.soft.size).toBe(0);
    expect(p.featured).toEqual([]);
  });

  it('a tag word inside the title is not a tag, the suffix still is', () => {
    const p = parseTitle('Live Forever (Remastered)');
    expect(p.base).toBe('live forever');
    expect([...p.versions]).toEqual([]);
    expect([...p.soft]).toEqual(['remaster']);
    expect([...parseTitle('Meredith - Edit').versions]).toEqual(['edit']);
    expect([...parseTitle('Meredith').versions]).toEqual([]);
    expect([...parseTitle('Alive (Live)').versions]).toEqual(['live']);
  });
});

describe('parseTitle: base, core and full', () => {
  it.each([
    ['Song (Interlude)', 'song interlude', 'song', 'song interlude'],
    ['Song (Interlude) [Live]', 'song interlude', 'song', 'song interlude live'],
    ['Oran Marseille (Khaled - I Am)', 'oran marseille khaled i am', 'oran marseille', 'oran marseille khaled i am'],
    ['Song (feat. Drake) [Live]', 'song', 'song', 'song live'],
    ['P.Y.T. (Pretty Young Thing)', 'pyt pretty young thing', 'pyt', 'pyt pretty young thing'],
    ["(I Can't Get No) Satisfaction - Mono Version", 'i cant get no satisfaction', 'i cant get no satisfaction', 'i cant get no satisfaction mono version'],
    ['Let It Go - From "Frozen"/Soundtrack Version', 'let it go', 'let it go', 'let it go from frozen soundtrack version'],
  ])('%j -> base %j, core %j, full %j', (raw, base, core, full) => {
    const p = parseTitle(raw);
    expect(p.raw).toBe(raw);
    expect(p.base).toBe(base);
    expect(p.core).toBe(core);
    expect(p.full).toBe(full);
  });
});

describe('parseTitle: featured artists', () => {
  it.each([
    ['Song (feat. Drake)', ['drake'], 'song'],
    ['Song (ft. Drake & Rihanna)', ['drake', 'rihanna'], 'song'],
    ['Song (featuring Drake)', ['drake'], 'song'],
    ['Song [feat. Drake]', ['drake'], 'song'],
    ['Song feat. Drake', ['drake'], 'song'],
    ['Song ft. Drake', ['drake'], 'song'],
    ['Song featuring Drake, Future x Metro Boomin', ['drake', 'future', 'metro boomin'], 'song'],
    ['Song (with Drake)', ['drake'], 'song'],
    ['Song [with Drake]', ['drake'], 'song'],
    ['Song feat. Drake (Remix)', ['drake'], 'song'],
    ['Song (feat. Malcolm X)', ['malcolm x'], 'song'],
    ['Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers)', ['pharrell williams', 'nile rodgers'], 'get lucky'],
    ['Get Lucky (feat. Pharrell Williams & Nile Rodgers) [Daft Punk Remix]', ['pharrell williams', 'nile rodgers'], 'get lucky'],
    ['Dancing With Myself', [], 'dancing with myself'],
  ])('%j -> %j', (raw, featured, base) => {
    const p = parseTitle(raw);
    expect(p.featured).toEqual(featured);
    expect(p.base).toBe(base);
  });

  it('keeps the version tag of a combined Deezer suffix', () => {
    expect([...parseTitle('Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers)').versions]).toEqual(['edit']);
    expect([...parseTitle('Song feat. Drake (Remix)').versions]).toEqual(['remix']);
  });
});

describe('parseAlbumTitle', () => {
  it.each([
    ['Sahra', 'sahra', undefined, [], []],
    ['Album - Single', 'album', 'single', [], []],
    ['Album - EP', 'album', 'ep', [], []],
    ['Album EP', 'album', 'ep', [], []],
    ['Get Lucky (feat. Pharrell Williams & Nile Rodgers) - Single', 'get lucky', 'single', [], []],
    ['Album (Deluxe Edition)', 'album', undefined, [], ['deluxe']],
    ['Album (Deluxe Version)', 'album', undefined, [], ['deluxe']],
    ['Album (Expanded Edition)', 'album', undefined, [], ['deluxe']],
    ['Album (Remastered)', 'album', undefined, [], ['remaster']],
    ['Random Access Memories (10th Anniversary Edition)', 'random access memories', undefined, [], ['deluxe']],
    ['Album (Bonus Track Version)', 'album', undefined, [], ['deluxe']],
    ['Hafla (Live)', 'hafla', undefined, ['live'], []],
    ['Live at Wembley', 'live at wembley', undefined, ['live'], []],
    ['On Fire: Live At The Bowl', 'on fire live at the bowl', undefined, ['live'], []],
    ['Live in Paris 2003', 'live in paris 2003', undefined, ['live'], []],
    ['Album - Live at the BBC', 'album', undefined, ['live'], []],
    ['MTV Unplugged', 'mtv unplugged', undefined, ['acoustic', 'live'], []],
    ['Live Forever', 'live forever', undefined, [], []],
    ['Live Through This', 'live through this', undefined, [], []],
    ['Live On', 'live on', undefined, [], []],
    ['Live a Little', 'live a little', undefined, [], []],
    ['Live on Letterman', 'live on letterman', undefined, ['live'], []],
    ['Kygo Remixes', 'kygo remixes', undefined, ['remix'], []],
    ['Album (The Remixes)', 'album', undefined, ['remix'], []],
    ['Remixed', 'remixed', undefined, ['remix'], []],
    ['Blonde (Instrumentals)', 'blonde', undefined, ['instrumental'], []],
  ])('%j -> base %j, hint %j, hard %j, soft %j', (raw, base, hint, hard, soft) => {
    const p = parseAlbumTitle(raw);
    expect(p.base).toBe(base);
    expect(p.albumHint).toBe(hint);
    expect([...p.versions].sort()).toEqual(hard);
    expect([...p.soft]).toEqual(soft);
  });

  it('parseTitle never reports an album hint', () => {
    expect('albumHint' in parseTitle('Album - Single')).toBe(false);
  });
});

describe('classifyDescriptor', () => {
  it.each([
    ['khaled i am', false],
    ['interlude', false],
    ['pt 2', false],
    ['live', true],
    ['1996', true],
    ['spanish version', true],
  ])('%j recognized: %j', (folded, recognized) => {
    expect(classifyDescriptor(folded).recognized).toBe(recognized);
  });
});

describe('splitArtists', () => {
  it.each([
    [['Daft Punk & Pharrell Williams'], ['daft punk', 'pharrell williams', 'daft punk and pharrell williams']],
    [['Daft Punk', 'Pharrell Williams'], ['daft punk', 'pharrell williams']],
    [['Earth, Wind & Fire'], ['earth wind and fire', 'earth', 'wind', 'fire']],
    [['Simon & Garfunkel'], ['simon and garfunkel', 'simon', 'garfunkel']],
    [['Crosby, Stills, Nash & Young'], ['crosby stills nash and young', 'crosby', 'stills', 'nash', 'young']],
    [['Khaled And I AM, I Am & Khaled'], ['khaled and i am i am and khaled', 'khaled', 'i am']],
    [['A x B'], ['a x b', 'a', 'b']],
    [['A + B'], ['a b', 'a', 'b']],
    [['A / B'], ['a b', 'a', 'b']],
    [['A; B'], ['a b', 'a', 'b']],
    [['A feat. B'], ['a feat b', 'a', 'b']],
    [['A ft. B'], ['a ft b', 'a', 'b']],
    [['A featuring B'], ['a featuring b', 'a', 'b']],
    [['A with B'], ['a with b', 'a', 'b']],
    [['A vs. B'], ['a vs b', 'a', 'b']],
    [['A et B'], ['a et b', 'a', 'b']],
    [['A y B'], ['a y b', 'a', 'b']],
    [['AC/DC'], ['ac dc']],
    [['Malcolm X'], ['malcolm x']],
  ])('%j', (names, expected) => {
    expect(splitArtists(names).sort()).toEqual([...expected].sort());
  });
});

describe('stripHonorifics', () => {
  it.each([
    ['Cheb Khaled', 'khaled'],
    ['Khaled', 'khaled'],
    ['Cheba Zahouania', 'zahouania'],
    ['Chaba Fadela', 'fadela'],
    ['Cheikh Lô', 'lo'],
    ['Cheikha Rimitti', 'rimitti'],
    ['The Beatles', 'beatles'],
    // "DJ Khaled" and "Khaled" are two artists.
    ['DJ Snake', 'dj snake'],
    ['MC Solaar', 'mc solaar'],
    ['The The', 'the'],
    ['DJ', 'dj'],
    ['Theory of a Deadman', 'theory of a deadman'],
  ])('%j -> %j', (name, expected) => {
    expect(stripHonorifics(name)).toBe(expected);
  });
});

describe('similarity helpers', () => {
  it.each([
    ['a b c', 'a b c', 1],
    ['a b c', 'c b a', 1],
    ['a b c', 'a b d', 2 / 3],
    ['the the', 'the', 2 / 3],
    ['', '', 1],
    ['a', '', 0],
  ])('tokenDice(%j, %j) = %d', (a, b, expected) => {
    expect(tokenDice(a, b)).toBeCloseTo(expected, 5);
  });

  it.each([
    ['night', 'night', 1],
    ['night', 'nacht', 0.25],
    ['jay z', 'jayz', 1],
    ['ab', 'ba', 0],
    ['a', 'a', 1],
    ['日本語', '日本語', 1],
  ])('bigramDice(%j, %j) = %d', (a, b, expected) => {
    expect(bigramDice(a, b)).toBeCloseTo(expected, 5);
  });

  it.each([
    ['Ouelli El Darek', 'Weli L Darek'],
    ['Aïcha', 'Aisha'],
    ['Khaled', 'Haled'],
    ['Djamel', 'Jamel'],
    ['Philippe', 'Filipe'],
    ['Mohamed', 'Mohammed'],
    ['Qassim', 'Kassim'],
    ['Zoo', 'Zu'],
    ['Leila', 'Leyla'],
  ])('skeleton(%j) === skeleton(%j)', (a, b) => {
    expect(skeleton(a)).toBe(skeleton(b));
  });

  it('skeleton keeps distinct consonants apart', () => {
    expect(skeleton('Ouelli El Darek')).toBe('wldrk');
    expect(skeleton('Didi')).not.toBe(skeleton('Aicha'));
  });
});

describe('titleSimilarity', () => {
  const sim = (a: string, b: string) => titleSimilarity(parseTitle(a), parseTitle(b));

  it.each([
    ['Ouelli El Darek', 'Ouelli el Darek', 1],
    ['Get Lucky', 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)', 1],
    ['Bohemian Rhapsody - Remastered 2011', 'Bohemian Rhapsody', 1],
    ['Song, Pt. 1', 'Song Part 1', 1],
    ['Symphony No. 5', 'Symphony Number 5', 1],
    ['Song Part II', 'Song Part 2', 1],
    ["Rock 'n' Roll Train", 'Rock and Roll Train', 1],
    // Without credits or corroboration: an unexplained group, an unrelated consonant skeleton.
    ['Oran Marseille (Khaled - I Am)', 'Oran Marseille', 0.7272727],
    ['Ouelli El Darek', 'Weli L Darek', 0.6666667],
    ['Intro', 'Intro', 1],
    ['Interlude (Live)', 'Interlude', 1],
    ['Группа крови', 'Gruppa Krovi', 0.95],
  ])('%j ~ %j = %d', (a, b, expected) => {
    expect(sim(a, b)).toBeCloseTo(expected, 5);
  });

  it.each([
    ['Song, Pt. 1', 'Song, Pt. 2'],
    ['Song (Part 1)', 'Song (Part 2)'],
    ['Song', 'Song 2'],
    ['Song (Interlude)', 'Song (Reprise)'],
    ['Song (Reprise)', 'Song'],
    ['Hello', 'Hallo'],
    ['Hello', 'Hello Again'],
    ['Ouelli El Darek', 'Oran Marseille (Khaled - I Am)'],
    ['Love Story (Commentary)', 'Love Story'],
    ['Love Story - Commentary', 'Love Story'],
    ['Song Title (Interlude)', 'Song Title'],
    ['Song Title (Cover)', 'Song Title'],
  ])('%j vs %j stays below 0.8', (a, b) => {
    expect(sim(a, b)).toBeLessThan(0.8);
  });

  it('a group that only names the credited artists explains itself', () => {
    const credits = ['khaled', 'i am'];
    expect(titleSimilarity(parseTitle('Oran Marseille (Khaled - I Am)'), parseTitle('Oran Marseille'), { credits })).toBeCloseTo(0.95, 5);
    expect(titleSimilarity(parseTitle('Oran Marseille (Khaled - Remake)'), parseTitle('Oran Marseille'), { credits })).toBeLessThanOrEqual(UNEXPLAINED_GROUP_CAP);
  });

  it('consonant skeletons count only when the caller has corroboration', () => {
    expect(titleSimilarity(parseTitle('Ouelli El Darek'), parseTitle('Weli L Darek'), { skeleton: true })).toBeCloseTo(0.85, 5);
    expect(titleSimilarity(parseTitle('Stronger'), parseTitle('Strange'), { skeleton: true })).toBeCloseTo(0.85, 5);
    expect(titleSimilarity(parseTitle('Stronger'), parseTitle('Strange'))).toBeLessThan(0.8);
    // Cyrillic transliteration changes a side, which is evidence enough.
    expect(sim('Группа крови', 'Gruppa Krovi')).toBeCloseTo(0.95, 5);
  });

  it('is symmetric', () => {
    for (const [a, b] of [
      ['Ouelli El Darek', 'Weli L Darek'],
      ['Song (Interlude)', 'Song'],
      ['Song, Pt. 1', 'Song'],
    ] as const) {
      expect(sim(a, b)).toBeCloseTo(sim(b, a), 10);
    }
  });

  it('works for non-Latin titles', () => {
    expect(sim('残酷な天使のテーゼ', '残酷な天使のテーゼ (TV Size)')).toBeGreaterThanOrEqual(0.9);
    expect(sim('Группа крови', 'Группа крови - Remastered')).toBe(1);
    expect(sim('좋은 날', '너의 의미')).toBeLessThan(0.5);
  });
});
