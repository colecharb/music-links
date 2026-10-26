import { describe, expect, it } from 'vitest';
import {
  ACCEPT_TRACK,
  artistMatch,
  DURATION_TOLERANCE_MS,
  PENALTY,
  pickBestAlbum,
  pickBestById,
  pickBestTrack,
  scoreAlbum,
  scoreTrack,
  TIE_EPSILON,
  verifyAlbumById,
  verifyTrackById,
} from '../src/match';
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

const side = (artist: string, artists: string[] = [artist]) => ({ artist, artists });

describe('artistMatch', () => {
  it.each([
    ['Cheb Khaled vs Khaled', side('Cheb Khaled'), side('Khaled')],
    ['display string vs separate names', side('Daft Punk & Pharrell Williams'), side('Daft Punk, Pharrell Williams', ['Daft Punk', 'Pharrell Williams'])],
    ['Earth, Wind & Fire', side('Earth, Wind & Fire'), side('Earth Wind and Fire')],
    ['Simon & Garfunkel vs Simon and Garfunkel', side('Simon & Garfunkel'), side('Simon and Garfunkel')],
    ['Mumford & Sons', side('Mumford & Sons'), side('Mumford & Sons')],
    ['Crosby, Stills, Nash & Young', side('Crosby, Stills, Nash & Young'), side('Crosby, Stills, Nash & Young')],
    ['JAY-Z vs Jay Z', side('JAY-Z'), side('Jay Z')],
    ['Jay-Z vs JAYZ', side('Jay-Z'), side('JAYZ')],
    ['AC/DC vs ACDC', side('AC/DC'), side('ACDC')],
    ['The Beatles vs Beatles', side('The Beatles'), side('Beatles')],
    ['Beyoncé vs Beyonce', side('Beyoncé'), side('Beyonce')],
    ['Apple duet credit vs Spotify list', side('Khaled And I AM, I Am & Khaled'), side('Khaled, IAM', ['Khaled', 'IAM'])],
    ['secondary artist', side('Pharrell Williams'), side('Daft Punk, Pharrell Williams', ['Daft Punk', 'Pharrell Williams'])],
    ['both Various Artists', side('Various Artists'), side('Verschiedene Interpreten')],
    ['Cyrillic vs Latin', side('Кино'), side('Kino')],
    ['Cyrillic vs Latin transliteration variant', side('Виктор Цой'), side('Viktor Tsoy')],
    ['Cyrillic duet vs Latin', side('Кино'), side('Viktor Tsoi & Kino')],
    ['Greek vs Latin', side('Μίκης Θεοδωράκης'), side('Mikis Theodorakis')],
  ])('%s: match', (_label, a, b) => {
    expect(artistMatch(a, b).match).toBe(true);
    expect(artistMatch(b, a).match).toBe(true);
  });

  it.each([
    ['John vs Elton John', side('John'), side('Elton John')],
    ['Kygo vs Khaled', side('Kygo'), side('Khaled')],
    ['Khaled vs Khalid', side('Khaled'), side('Khalid')],
    ['Prince vs Princess', side('Prince'), side('Princess')],
    ['Кино vs Kina', side('Кино'), side('Kina')],
    ['Cyrillic vs unrelated Latin', side('Земфира'), side('Zemlyane')],
    ['Various Artists vs a real artist', side('Various Artists'), side('Daft Punk')],
    ['Varios Artistas vs a real artist', side('Varios Artistas'), side('Varios')],
    ['Artistes Divers vs a real artist', side('Daft Punk'), side('Artistes Divers', ['Artistes Divers', 'Daft Punk'])],
    ['unknown artist', side('Daft Punk'), side('', [])],
  ])('%s: no match', (_label, a, b) => {
    expect(artistMatch(a, b)).toMatchObject({ match: false, score: 0 });
    expect(artistMatch(b, a).match).toBe(false);
  });

  it.each([
    ['same single artist', side('Khaled'), side('Cheb Khaled'), 1],
    ['same full set', side('Daft Punk & Pharrell Williams'), side('Daft Punk, Pharrell Williams', ['Daft Punk', 'Pharrell Williams']), 1],
    ['Apple duet credit vs Spotify list', side('Khaled And I AM, I Am & Khaled'), side('Khaled, IAM', ['Khaled', 'IAM']), 1],
    ['primary only', side('Daft Punk, Pharrell Williams', ['Daft Punk', 'Pharrell Williams']), side('Daft Punk'), 0.9],
    ['via secondary', side('Pharrell Williams'), side('Daft Punk, Pharrell Williams', ['Daft Punk', 'Pharrell Williams']), 0.8],
  ])('%s: score %d', (_label, a, b, score) => {
    expect(artistMatch(a, b).score).toBe(score);
  });
});

describe('scoreTrack: hard rejections', () => {
  const src = track({ title: 'Song', album: 'Album' });

  it.each([
    'Live',
    'Remix',
    'Acoustic',
    'Instrumental',
    'A Cappella',
    'Karaoke Version',
    'Demo',
    'Sped Up',
    'Slowed + Reverb',
    "Taylor's Version",
    'MTV Unplugged',
  ])('candidate "Song (%s)" with the same duration is rejected', (descriptor) => {
    const r = scoreTrack(src, track({ title: `Song (${descriptor})`, album: 'Album' }));
    expect(r.score).toBe(0);
    expect(r.reject).toMatch(/^version: studio vs /);
    // and the reverse direction
    expect(scoreTrack(track({ title: `Song - ${descriptor}`, album: 'Album' }), src).reject).toMatch(/^version: .* vs studio$/);
  });

  it.each(['Hafla (Live)', 'Live at Wembley', 'MTV Unplugged', 'Hungarian Rhapsody (Live In Budapest / 1986)'])(
    'a candidate on the live album %j is live',
    (liveAlbum) => {
      const r = scoreTrack(src, track({ title: 'Song', album: liveAlbum }));
      expect(r.reject).toMatch(/^version: studio vs (acoustic\+)?live$/);
    },
  );

  it('an unplugged album makes its tracks live and acoustic', () => {
    const unplugged = track({ title: 'Song (Live)', album: 'MTV Unplugged' });
    expect(scoreTrack(track({ title: 'Song (MTV Unplugged)' }), unplugged).reject).toBeUndefined();
    expect(scoreTrack(track({ title: 'Song (Live)' }), unplugged).reject).toBe('version: live vs acoustic+live');
  });

  it('live by album matches live by title', () => {
    const liveSrc = track({ title: 'Song', album: 'Hafla (Live)' });
    expect(scoreTrack(liveSrc, track({ title: 'Song (Live)', album: 'Best Of' })).reject).toBeUndefined();
  });

  it('rejects a different artist with a readable reason', () => {
    const r = scoreTrack(track({ title: 'Song', artist: 'Khaled', artists: ['Khaled'] }), track({ title: 'Song', artist: 'Kygo', artists: ['Kygo'] }));
    expect(r).toMatchObject({ score: 0, reject: 'artist: Khaled vs Kygo' });
  });

  it('rejects a different title', () => {
    expect(scoreTrack(src, track({ title: 'Other Song Entirely' })).reject).toMatch(/^title: 0\.\d\d < 0\.8$/);
  });

  it('collects every reason', () => {
    const r = scoreTrack(src, track({ title: 'Song (Live)', durationMs: 270_000 }));
    expect(r.reject).toBe('duration +70.0s; version: studio vs live');
  });
});

describe('scoreTrack: durations', () => {
  it.each([
    // [src ms, src precision, cand ms, cand precision, accepted]
    [200_000, 1, 202_600, 1, true],
    [200_000, 1, 197_400, 1, true],
    [200_000, 1, 203_000, 1, true],
    [200_000, 1, 203_400, 1, false],
    [200_000, 1, 205_000, 1, false],
    [200_000, 1, 195_000, 1, false],
    // ±3 s is a hard limit on the reported values; whole-second precision doesn't widen it.
    [200_000, 1, 203_000, 1000, true],
    [200_600, 1, 203_600, 1000, true],
    [200_600, 1, 204_000, 1000, false],
    [200_000, 1, 204_000, 1000, false],
    [200_000, 1000, 203_000, 1000, true],
    [200_000, 1000, 204_000, 1000, false],
    [200_000, 1000, 205_000, 1000, false],
  ])('%d (precision %d) vs %d (precision %d): accepted %s', (sms, sp, cms, cp, ok) => {
    const r = scoreTrack(track({ title: 'Song', durationMs: sms, durationPrecisionMs: sp }), track({ title: 'Song', durationMs: cms, durationPrecisionMs: cp }));
    expect(r.reject === undefined).toBe(ok);
    if (!ok) expect(r.reject).toMatch(/^duration [+-]\d+\.\ds$/);
  });

  it('formats the duration reason with a sign', () => {
    expect(scoreTrack(track({ title: 'Song' }), track({ title: 'Song', durationMs: 205_200 })).reject).toBe('duration +5.2s');
    expect(scoreTrack(track({ title: 'Song' }), track({ title: 'Song', durationMs: 190_000 })).reject).toBe('duration -10.0s');
  });

  it('scores closer durations higher and unknown durations in between', () => {
    const src = track({ title: 'Song' });
    const exact = scoreTrack(src, track({ title: 'Song', durationMs: 200_500 })).score;
    const near = scoreTrack(src, track({ title: 'Song', durationMs: 202_000 })).score;
    const edge = scoreTrack(src, track({ title: 'Song', durationMs: 200_000 + DURATION_TOLERANCE_MS })).score;
    const unknown = scoreTrack(src, track({ title: 'Song', durationMs: undefined })).score;
    expect(exact).toBeGreaterThan(near);
    expect(near).toBeGreaterThan(edge);
    expect(unknown).toBeGreaterThan(edge);
    expect(unknown).toBeLessThan(near);
  });

  it('whole-second precision softens the score, not the limit', () => {
    const src = track({ title: 'Song', durationMs: 200_000, durationPrecisionMs: 1000 });
    const ms = scoreTrack(track({ title: 'Song' }), track({ title: 'Song', durationMs: 202_500 })).details.duration;
    const seconds = scoreTrack(src, track({ title: 'Song', durationMs: 202_500, durationPrecisionMs: 1000 })).details.duration;
    expect(seconds).toBeGreaterThan(ms as number);
    expect(scoreTrack(src, track({ title: 'Song', durationMs: 203_001, durationPrecisionMs: 1000 })).reject).toBe('duration +3.0s');
  });

  it('needs a stronger title when a duration is unknown', () => {
    // The transliteration (consonant skeleton) only counts because the album agrees.
    const src = track({ title: 'Ouelli El Darek', artists: ['Khaled'], artist: 'Khaled', album: 'Sahra' });
    const cand = track({ title: 'Weli L Darek', artists: ['Khaled'], artist: 'Khaled', album: 'Sahra' });
    expect(scoreTrack(src, cand).reject).toBeUndefined();
    expect(scoreTrack(src, { ...cand, durationMs: undefined }).reject).toBe('title: 0.85 < 0.9');
  });
});

describe('scoreTrack: edit and extended labels', () => {
  const src = track({ title: 'Song', album: 'Song' });
  const plain = scoreTrack(src, track({ title: 'Song', album: 'Song' }));

  it.each(['Song (Radio Edit)', 'Song - Single Version', 'Song (Extended Mix)'])('%j with the same duration is accepted with a penalty', (title) => {
    const r = scoreTrack(src, track({ title, album: 'Song' }));
    expect(r.reject).toBeUndefined();
    expect(r.score).toBeCloseTo(plain.score - PENALTY.editExtended, 5);
  });

  it('radio edit vs extended mix with the same duration is accepted', () => {
    expect(scoreTrack(track({ title: 'Song (Radio Edit)' }), track({ title: 'Song (Extended Mix)' })).reject).toBeUndefined();
  });

  it('radio edit with a different duration is rejected', () => {
    expect(scoreTrack(src, track({ title: 'Song (Radio Edit)', durationMs: 170_000 })).reject).toBe('duration -30.0s; version: studio vs edit');
  });

  it('radio edit with an unknown duration is rejected', () => {
    expect(scoreTrack(src, track({ title: 'Song (Radio Edit)', durationMs: undefined })).reject).toBe('version: studio vs edit');
  });

  it('edit vs live is never excused', () => {
    expect(scoreTrack(track({ title: 'Song (Radio Edit)' }), track({ title: 'Song (Live)' })).reject).toBe('version: edit vs live');
  });
});

describe('scoreTrack: adjustments', () => {
  const src = track({ title: 'Song', album: 'Album', explicit: false });
  const base = scoreTrack(src, track({ title: 'Song', album: 'Album', explicit: false })).score;

  it('identical metadata scores 1', () => {
    expect(base).toBe(1);
  });

  it.each([
    ['soft remaster tag', { title: 'Song - Remastered 2011' }, PENALTY.soft],
    ['two soft tags', { title: 'Song (Mono) [Remastered]' }, 2 * PENALTY.soft],
    ['candidate explicit, source clean', { explicit: true }, PENALTY.explicitGained],
    ['compilation album title', { album: 'Greatest Hits' }, PENALTY.compilation + 0.1 * (1 - 0)],
    ['compilation album type', { albumType: 'compilation' as const }, PENALTY.compilation],
  ])('%s', (_label, patch, penalty) => {
    const r = scoreTrack(src, track({ title: 'Song', album: 'Album', explicit: false, ...patch }));
    expect(r.reject).toBeUndefined();
    expect(r.score).toBeCloseTo(base - penalty, 2);
  });

  it('source explicit, candidate clean costs more than the reverse', () => {
    const lost = scoreTrack(track({ title: 'Song', explicit: true }), track({ title: 'Song', explicit: false }));
    const gained = scoreTrack(track({ title: 'Song', explicit: false }), track({ title: 'Song', explicit: true }));
    expect(lost.score).toBeCloseTo(1 - 0.1 * 0.5 - PENALTY.explicitLost, 5);
    expect(gained.score).toBeCloseTo(1 - 0.1 * 0.5 - PENALTY.explicitGained, 5);
  });

  it('no compilation penalty when the source is a compilation too', () => {
    const r = scoreTrack(track({ title: 'Song', album: 'Greatest Hits' }), track({ title: 'Song', album: 'Greatest Hits' }));
    expect(r.score).toBe(1);
  });

  it('disjoint featured artists cost a little', () => {
    const r = scoreTrack(track({ title: 'Song (feat. Drake)' }), track({ title: 'Song (feat. Future)' }));
    const same = scoreTrack(track({ title: 'Song (feat. Drake)' }), track({ title: 'Song [feat. Drake]' }));
    expect(r.reject).toBeUndefined();
    expect(same.score - r.score).toBeCloseTo(PENALTY.featuredDisjoint + PENALTY.featuredUncredited + 0.25 * 0.1, 5);
  });

  it('a featured artist the other side never credits costs a lot', () => {
    const plain = track({ title: 'Song', artists: ['Stromae'], artist: 'Stromae' });
    const featuring = track({ title: 'Song (Featuring Erik Hassle)', artists: ['Stromae'], artist: 'Stromae' });
    expect(scoreTrack(plain, featuring).details.penalty).toBeCloseTo(PENALTY.featuredUncredited, 5);
    expect(scoreTrack(featuring, plain).details.penalty).toBeCloseTo(PENALTY.featuredUncredited, 5);
    expect(scoreTrack(plain, featuring).reject).toBeUndefined();
  });

  it.each([
    ['listed artist', ['Daft Punk', 'Pharrell Williams'], 'Get Lucky (feat. Pharrell Williams)'],
    ['short form of a listed artist', ['Daft Punk', 'Pharrell Williams'], 'Get Lucky (feat. Pharrell)'],
    ['display-string credit', ['Daft Punk, Pharrell Williams & Nile Rodgers'], 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)'],
    ['spelling variant', ['Daft Punk', 'JAY-Z'], 'Get Lucky (feat. Jay Z)'],
  ])('a featured %s is credited', (_label, artists, title) => {
    const src = track({ title: 'Get Lucky', artists, artist: artists.join(', ') });
    expect(scoreTrack(src, track({ title, artists: ['Daft Punk'], artist: 'Daft Punk' })).details.penalty).toBe(0);
  });

  it('featured artists do not displace the primary artist when the artist list is empty', () => {
    const src = track({ title: 'Get Lucky (feat. Pharrell Williams)', artists: [], artist: 'Daft Punk' });
    expect(scoreTrack(src, track({ title: 'Get Lucky', artists: ['Daft Punk'], artist: 'Daft Punk' })).details.artist).toBe(0.9);
  });

  it('featured artists in the title count as credits', () => {
    const spotify = track({ title: 'Get Lucky', artists: ['Daft Punk', 'Pharrell Williams', 'Nile Rodgers'], artist: 'Daft Punk, Pharrell Williams, Nile Rodgers' });
    const apple = track({ title: 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)', artists: ['Daft Punk'], artist: 'Daft Punk' });
    expect(scoreTrack(spotify, apple).details.artist).toBe(1);
  });

  it('scores stay within 0..1', () => {
    const r = scoreTrack(
      track({ title: 'Song (feat. A)', explicit: true, durationMs: undefined }),
      track({ title: 'Song (feat. B) [Mono] (Remastered) (Spanish Version)', explicit: false, albumType: 'compilation', durationMs: undefined }),
    );
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
  });
});

describe('Khaled "Ouelli El Darek" end to end', () => {
  // Real metadata (Spotify source; Deezer and iTunes search results), verified live.
  const src = track({
    id: 'spotify',
    title: 'Ouelli El Darek',
    artists: ['Khaled'],
    artist: 'Khaled',
    album: 'Sahra',
    albumType: 'album',
    releaseDate: '1996',
    durationMs: 189_360,
    durationPrecisionMs: 1,
    explicit: false,
  });
  const khaled = { artists: ['Khaled'], artist: 'Khaled', durationPrecisionMs: 1000, explicit: false };
  const deezer = [
    track({ ...khaled, id: '515038112', title: 'Ouelli El Darek', album: 'Best Of', durationMs: 192_000, isrc: 'FRZ019601820' }),
    track({ ...khaled, id: '2298124', title: 'Ouelli El Darek (Live)', album: 'Hafla', durationMs: 270_000 }),
    track({ ...khaled, id: '2797929262', title: 'Weli L Darek (Live)', album: 'Best Of Cheb Khaled', durationMs: 369_000 }),
  ];
  const itunes = { artists: ['Khaled'], artist: 'Khaled', durationPrecisionMs: 1, explicit: false };
  const apple = [
    track({ ...itunes, id: '1444130134', title: 'Ouelli el Darek', album: 'Sahra', durationMs: 191_093 }),
    track({ ...itunes, id: '1444050118', title: 'Ouelli el Darek', album: 'Hafla (Live)', durationMs: 279_427 }),
    track({ ...itunes, id: '1400382182', title: 'Ouelli El Darek', album: 'Best Of', durationMs: 189_080 }),
    track({
      ...itunes,
      id: '1444130029',
      title: 'Oran Marseille (Khaled - I Am)',
      artists: ['Khaled And I AM, I Am & Khaled'],
      artist: 'Khaled And I AM, I Am & Khaled',
      album: 'Sahra',
      durationMs: 265_773,
    }),
  ];

  it('Deezer: accepts the studio recording and rejects both live ones', () => {
    const r = pickBestTrack(src, deezer);
    expect(r.accepted?.item.id).toBe('515038112');
    expect(r.accepted?.score).toBeGreaterThanOrEqual(ACCEPT_TRACK);
    expect(r.ranked.map((x) => x.item.id)).toEqual(['515038112', '2298124', '2797929262']);
    expect(r.ranked[1]?.reject).toMatch(/version: studio vs live/);
    expect(r.ranked[2]?.reject).toMatch(/version: studio vs live/);
    expect(r.ranked[2]?.reject).toMatch(/duration \+179\.6s/);
  });

  it('Apple: prefers the same album over a closer-duration compilation', () => {
    const r = pickBestTrack(src, apple);
    expect(r.accepted?.item.id).toBe('1444130134');
    expect(r.ranked.map((x) => x.item.id)).toEqual(['1444130134', '1400382182', '1444050118', '1444130029']);
    expect(r.ranked[1]?.reject).toBeUndefined();
    expect((r.ranked[0]?.score ?? 0) - (r.ranked[1]?.score ?? 0)).toBeGreaterThan(TIE_EPSILON);
    expect(r.ranked[2]?.reject).toMatch(/version: studio vs live/);
    expect(r.ranked[3]?.reject).toMatch(/^title: /);
  });

  it('Apple: the compilation is still accepted when it is the only studio hit', () => {
    const r = pickBestTrack(src, apple.filter((t) => t.album !== 'Sahra'));
    expect(r.accepted?.item.id).toBe('1400382182');
  });

  it('nothing is accepted when only live versions exist', () => {
    const r = pickBestTrack(src, [deezer[1], deezer[2], apple[1]].filter((t): t is TrackMeta => !!t));
    expect(r.accepted).toBeNull();
    expect(r.ranked.every((x) => x.reject)).toBe(true);
  });

  it('a transliterated title with a matching duration is a fuzzy match', () => {
    const r = pickBestTrack(src, [track({ ...itunes, id: 'translit', title: 'Weli L Darek', album: 'Sahra', durationMs: 189_500 })]);
    expect(r.accepted?.item.id).toBe('translit');
  });
});

describe('real search results', () => {
  // Deezer (whole seconds) and iTunes (ms) search hits, recorded live.
  const stromae = { artists: ['Stromae'], artist: 'Stromae' };
  const src = track({ ...stromae, title: 'Alors on danse - Radio Edit', album: 'Cheese', durationMs: 206_066 });
  const radioEdit = track({ ...stromae, id: 'dz-edit', title: 'Alors on danse (Radio Edit)', album: 'Cheese', durationMs: 208_000, durationPrecisionMs: 1000 });
  const hassle = track({ ...stromae, id: 'dz-hassle', title: 'Alors On Danse (Featuring Erik Hassle)', album: 'Alors On Danse', durationMs: 208_000, durationPrecisionMs: 1000 });
  const extended = track({ ...stromae, id: 'dz-ext', title: 'Alors On Danse (Extended Mix)', album: 'Alors On Danse', durationMs: 257_000, durationPrecisionMs: 1000 });

  it('Stromae: the radio edit wins; the Erik Hassle version alone is not accepted', () => {
    expect(pickBestTrack(src, [hassle, extended, radioEdit]).accepted?.item.id).toBe('dz-edit');
    const alone = pickBestTrack(src, [hassle, extended]);
    expect(alone.accepted).toBeNull();
    expect(alone.ranked[0]?.item.id).toBe('dz-hassle');
    expect(alone.ranked[1]?.reject).toBe('duration +50.9s; version: edit vs extended');
  });

  it('Queen: same album without edition suffixes beats the deluxe edition', () => {
    const queen = { artists: ['Queen'], artist: 'Queen' };
    const spotify = track({ ...queen, title: 'Bohemian Rhapsody - Remastered 2011', album: 'A Night At The Opera (2011 Remaster)', durationMs: 354_320 });
    const r = pickBestTrack(spotify, [
      track({ ...queen, id: 'deluxe', title: 'Bohemian Rhapsody', album: 'A Night At The Opera (Deluxe Edition)', durationMs: 355_155 }),
      track({ ...queen, id: 'plain', title: 'Bohemian Rhapsody', album: 'A Night At The Opera', durationMs: 355_155 }),
      track({ ...queen, id: 'ost', title: 'Bohemian Rhapsody', album: 'Bohemian Rhapsody (The Original Soundtrack)', durationMs: 354_947 }),
      track({ ...queen, id: 'platinum', title: 'Bohemian Rhapsody', album: 'The Platinum Collection', durationMs: 355_467 }),
      track({ ...queen, id: 'wembley', title: 'Bohemian Rhapsody (Live At Wembley Stadium / July 1986)', album: 'Live at Wembley Stadium', durationMs: 351_000 }),
      track({ ...queen, id: 'acapella', title: 'Bohemian Rhapsody (Operatic Section / 2011 A Cappella Mix)', album: 'A Night At The Opera (Deluxe Edition)', durationMs: 64_969 }),
    ]);
    expect(r.ranked.map((x) => x.item.id)).toEqual(['plain', 'deluxe', 'ost', 'platinum', 'acapella', 'wembley']);
    expect(r.ranked[5]?.reject).toBe('duration -3.3s; version: studio vs live');
  });

  it('Taylor Swift: the re-recording is never a match for the original', () => {
    const ts = { artists: ['Taylor Swift'], artist: 'Taylor Swift' };
    const src2 = track({ ...ts, title: 'Love Story', album: 'Fearless', durationMs: 235_280 });
    const r = pickBestTrack(src2, [
      track({ ...ts, id: 'tv', title: 'Love Story (Taylor’s Version)', album: "Fearless (Taylor's Version)", durationMs: 235_767 }),
      track({ ...ts, id: 'pop', title: 'Love Story (Pop mix)', album: 'Love Story (Pop Mix) - Single', durationMs: 233_653 }),
    ]);
    expect(r.accepted).toBeNull();
    expect(r.ranked.map((x) => x.reject)).toEqual(['version: studio vs rerecorded', 'version: studio vs remix']);
  });

  it('Kino: Cyrillic on Deezer, Latin on Apple', () => {
    const apple = track({ title: 'Группа крови', artists: ['Kino'], artist: 'Kino', album: 'Группа крови', durationMs: 284_003 });
    const r = pickBestTrack(apple, [
      track({ id: 'english', title: 'Группа крови (Английская версия)', artists: ['Виктор Цой'], artist: 'Виктор Цой', album: 'Виктор Цой и Группа Кино. Полная Дискография', durationMs: 284_000, durationPrecisionMs: 1000 }),
      track({ id: 'kino', title: 'Группа крови', artists: ['Кино'], artist: 'Кино', album: 'Группа крови', durationMs: 284_000, durationPrecisionMs: 1000 }),
      track({ id: 'legend', title: 'Группа крови', artists: ['Кино'], artist: 'Кино', album: 'Легенда', durationMs: 240_000, durationPrecisionMs: 1000 }),
    ]);
    expect(r.ranked.map((x) => x.item.id)).toEqual(['kino', 'legend', 'english']);
    expect(r.ranked[1]?.reject).toBe('duration -44.0s');
    expect(r.ranked[2]?.reject).toBe('artist: Kino vs Виктор Цой; version: studio vs variant:англииская');
  });

  it('Khaled: "Version Mixte" and "Mixed Version" are the same recording', () => {
    const deezerSrc = track({ artists: ['Khaled'], artist: 'Khaled', title: 'Aïcha (Version Mixte)', album: 'Sahra', durationMs: 260_000, durationPrecisionMs: 1000 });
    const apple = track({ artists: ['Khaled'], artist: 'Khaled', title: 'Aicha (Mixed Version)', album: 'Sahra', durationMs: 259_667 });
    const r = scoreTrack(deezerSrc, apple);
    expect(r.reject).toBeUndefined();
    expect(r.score).toBeGreaterThanOrEqual(ACCEPT_TRACK);
  });
});

describe('pickBestTrack: ranking and tie-breaks', () => {
  it('prefers a non-compilation within TIE_EPSILON', () => {
    const src = track({ title: 'Song', albumType: 'compilation', explicit: false });
    const r = pickBestTrack(src, [
      track({ id: 'comp', title: 'Song', album: 'Greatest Hits', explicit: false }),
      track({ id: 'studio', title: 'Song', album: 'Sahra', explicit: false, durationMs: 201_200 }),
    ]);
    expect((r.ranked[0]?.score ?? 0) < (r.ranked[1]?.score ?? 0)).toBe(true);
    expect(r.accepted?.item.id).toBe('studio');
  });

  it('prefers explicit agreement with the source', () => {
    const src = track({ title: 'Song', explicit: true });
    const r = pickBestTrack(src, [track({ id: 'unknown', title: 'Song' }), track({ id: 'explicit', title: 'Song', explicit: true })]);
    expect(r.accepted?.item.id).toBe('explicit');
  });

  it('explicit source: the clean version loses on score', () => {
    const src = track({ title: 'Song', explicit: true });
    const r = pickBestTrack(src, [track({ id: 'clean', title: 'Song', explicit: false }), track({ id: 'explicit', title: 'Song', explicit: true })]);
    expect(r.ranked.map((x) => x.item.id)).toEqual(['explicit', 'clean']);
  });

  it('prefers the source album', () => {
    const src = track({ title: 'Song', album: 'Sahra' });
    const r = pickBestTrack(src, [
      track({ id: 'deluxe', title: 'Song', album: 'Sahra (Deluxe Edition)' }),
      track({ id: 'same', title: 'Song', album: 'Sahra', durationMs: 200_900 }),
    ]);
    expect(r.ranked.map((x) => x.item.id)).toEqual(['same', 'deluxe']);
  });

  it('prefers the earlier release, then input order', () => {
    const src = track({ title: 'Song' });
    const r = pickBestTrack(src, [
      track({ id: 'reissue', title: 'Song', releaseDate: '2011-05-01' }),
      track({ id: 'undated', title: 'Song' }),
      track({ id: 'original', title: 'Song', releaseDate: '1996-03-04' }),
      track({ id: 'undated2', title: 'Song' }),
    ]);
    expect(r.ranked.map((x) => x.item.id)).toEqual(['original', 'reissue', 'undated', 'undated2']);
  });

  it('a clearly better score beats the tie-breaks', () => {
    const src = track({ title: 'Song', explicit: false });
    const r = pickBestTrack(src, [
      track({ id: 'far', title: 'Song', durationMs: 202_900, releaseDate: '1990' }),
      track({ id: 'close', title: 'Song', durationMs: 200_100, releaseDate: '2020' }),
    ]);
    expect(r.accepted?.item.id).toBe('close');
  });

  it('does not accept below ACCEPT_TRACK even without a hard reject', () => {
    const src = track({ title: 'Ouelli El Darek', artists: ['Khaled'], artist: 'Khaled', album: 'Sahra' });
    const weak = track({
      title: 'Ouelli El Darek (feat. Someone Else)',
      artists: ['I Am', 'Khaled'],
      artist: 'I Am, Khaled',
      album: 'Compil',
      durationMs: 203_000,
    });
    const s = scoreTrack(src, weak);
    expect(s.reject).toBeUndefined();
    expect(s.score).toBeLessThan(ACCEPT_TRACK);
    const r = pickBestTrack(src, [weak]);
    expect(r.accepted).toBeNull();
    expect(r.ranked[0]?.reject).toBeUndefined();
  });

  it('returns an empty result for no candidates', () => {
    expect(pickBestTrack(track({ title: 'Song' }), [])).toEqual({ accepted: null, ranked: [] });
  });

  it('ranks rejected candidates by how close they came', () => {
    const src = track({ title: 'Song' });
    const r = pickBestTrack(src, [
      track({ id: 'other', title: 'Completely Different', artists: ['X'], artist: 'X' }),
      track({ id: 'live', title: 'Song (Live)' }),
    ]);
    expect(r.ranked.map((x) => x.item.id)).toEqual(['live', 'other']);
  });
});

describe('verifyTrackById', () => {
  const src = track({ title: 'Song', artists: ['IU'], artist: 'IU', album: 'Album' });

  it.each([
    ['translated title, same artist', track({ title: '노래', artists: ['IU'], artist: 'IU', album: 'Album' }), true, false],
    ['same title, artist in another script', track({ title: 'Song', artists: ['아이유'], artist: '아이유', album: 'Album' }), true, false],
    ['artist and title both differ', track({ title: '노래', artists: ['아이유'], artist: '아이유' }), false, false],
    ['duration out of tolerance', track({ title: 'Song', artists: ['IU'], artist: 'IU', durationMs: 230_000 }), false, false],
    ['live version', track({ title: 'Song (Live)', artists: ['IU'], artist: 'IU' }), false, false],
    ['on a live album', track({ title: 'Song', artists: ['IU'], artist: 'IU', album: 'Live in Seoul' }), false, false],
    ['radio edit, same duration', track({ title: 'Song (Radio Edit)', artists: ['IU'], artist: 'IU' }), true, true],
    ['identical', track({ title: 'Song', artists: ['IU'], artist: 'IU', album: 'Album' }), true, true],
  ])('%s: non-strict %s, strict %s', (_label, cand, nonStrictOk, strictOk) => {
    expect(verifyTrackById(src, cand, { strict: false }).reject === undefined).toBe(nonStrictOk);
    expect(verifyTrackById(src, cand, { strict: true }).reject === undefined).toBe(strictOk);
  });

  it('strict applies the acceptance threshold', () => {
    const s = track({ title: 'Ouelli El Darek', artists: ['Khaled'], artist: 'Khaled', album: 'Sahra' });
    const weak = track({ title: 'Ouelli El Darek (feat. Someone Else)', artists: ['I Am', 'Khaled'], artist: 'I Am, Khaled', album: 'Compil', durationMs: 203_000 });
    expect(verifyTrackById(s, weak, { strict: true }).reject).toMatch(/^score 0\.\d\d < 0\.7$/);
    expect(verifyTrackById(s, weak, { strict: false }).reject).toBeUndefined();
  });

  it('non-strict keeps a score for ranking', () => {
    const r = verifyTrackById(src, track({ title: '노래', artists: ['IU'], artist: 'IU', album: 'Album' }), { strict: false });
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(1);
  });
});

describe('pickBestById', () => {
  const src = track({ title: 'Ouelli El Darek', artists: ['Khaled'], artist: 'Khaled', album: 'Sahra', explicit: false });

  it('several items with one ISRC: the album version wins over compilation and single', () => {
    const r = pickBestById(
      src,
      [
        track({ id: 'best-of', title: 'Ouelli El Darek', artists: ['Khaled'], artist: 'Khaled', album: 'Best Of' }),
        track({ id: 'single', title: 'Ouelli El Darek', artists: ['Khaled'], artist: 'Khaled', album: 'Ouelli El Darek - Single', albumType: 'single', releaseDate: '1995' }),
        track({ id: 'album', title: 'Ouelli El Darek', artists: ['Khaled'], artist: 'Khaled', album: 'Sahra', releaseDate: '1996' }),
      ],
      { strict: false },
    );
    expect(r.accepted?.item.id).toBe('album');
    expect(r.ranked.map((x) => x.item.id)).toEqual(['album', 'single', 'best-of']);
  });

  it('accepts nothing when every hit fails verification', () => {
    const r = pickBestById(src, [track({ title: 'Ouelli El Darek (Live)', artists: ['Khaled'], artist: 'Khaled' })], { strict: false });
    expect(r.accepted).toBeNull();
    expect(r.ranked[0]?.reject).toBe('version: studio vs live');
  });

  it('works for albums', () => {
    const a = album({ title: 'Sahra', trackCount: 15, releaseDate: '1996' });
    const r = pickBestById(a, [album({ id: 'deluxe', title: 'Sahra (Deluxe)', trackCount: 20 }), album({ id: 'same', title: 'Sahra', trackCount: 15 })], {
      strict: false,
    });
    expect(r.accepted?.item.id).toBe('same');
    expect(r.ranked[1]?.reject).toBe('tracks: 15 vs 20');
  });
});

describe('scoreAlbum', () => {
  const src = album({ title: 'Abbey Road', artists: ['The Beatles'], artist: 'The Beatles', trackCount: 17, releaseDate: '1969-09-26', albumType: 'album' });

  it('identical album scores 1', () => {
    expect(scoreAlbum(src, { ...src, id: 'other' }).score).toBe(1);
  });

  it.each([
    ['deluxe with more tracks', album({ title: 'Abbey Road (Super Deluxe Edition)', artist: 'The Beatles', artists: ['The Beatles'], trackCount: 40 }), /^tracks: 17 vs 40$/],
    ['live album', album({ title: 'Abbey Road (Live)', artist: 'The Beatles', artists: ['Beatles'], trackCount: 17 }), /^version: studio vs live$/],
    ['remix album', album({ title: 'Abbey Road (Remixes)', artist: 'The Beatles', artists: ['Beatles'], trackCount: 17 }), /^version: studio vs remix$/],
    ['instrumental album', album({ title: 'Abbey Road (Instrumentals)', artist: 'The Beatles', artists: ['Beatles'], trackCount: 17 }), /^version: studio vs instrumental$/],
    ['other artist', album({ title: 'Abbey Road', artist: 'Abbey Road Tribute Band', artists: ['Abbey Road Tribute Band'], trackCount: 17 }), /^artist: /],
    ['other title', album({ title: 'Let It Be', artist: 'The Beatles', artists: ['The Beatles'], trackCount: 12 }), /^title: .*; tracks: 17 vs 12$/],
  ])('%s is rejected', (_label, cand, reason) => {
    const r = scoreAlbum(src, cand);
    expect(r.score).toBe(0);
    expect(r.reject).toMatch(reason);
  });

  it('deluxe 18 vs 12 tracks is rejected', () => {
    const r = scoreAlbum(album({ title: 'Album', trackCount: 12 }), album({ title: 'Album (Deluxe Edition)', trackCount: 18 }));
    expect(r.reject).toBe('tracks: 12 vs 18');
  });

  it('a remastered reissue is accepted with a lower score than the original', () => {
    const reissue = album({ id: 'reissue', title: 'Abbey Road (Remastered)', artists: ['The Beatles'], artist: 'The Beatles', trackCount: 17, releaseDate: '2009-09-09' });
    const r = scoreAlbum(src, reissue);
    expect(r.reject).toBeUndefined();
    expect(r.score).toBeGreaterThanOrEqual(0.7);
    expect(r.score).toBeLessThan(1);
    const picked = pickBestAlbum(src, [reissue, { ...src, id: 'original' }]);
    expect(picked.ranked.map((x) => x.item.id)).toEqual(['original', 'reissue']);
  });

  it('edit/extended labels on albums are not excused by equal track counts (a single has one track either way)', () => {
    const spotify = album({ title: 'Get Lucky (Radio Edit) [feat. Pharrell Williams and Nile Rodgers]', albumType: 'single', trackCount: 1 });
    const deezer = album({ title: 'Get Lucky (feat. Pharrell Williams and Nile Rodgers)', trackCount: 1 });
    expect(scoreAlbum(spotify, deezer).reject).toBe('version: edit vs studio');
    expect(scoreAlbum(spotify, { ...deezer, trackCount: undefined }).reject).toBe('version: edit vs studio');
    expect(scoreAlbum(spotify, { ...deezer, title: 'Get Lucky (Live)' }).reject).toBe('version: edit vs live');
  });

  it('track count off by one is tolerated with a lower score', () => {
    const r = scoreAlbum(src, { ...src, trackCount: 18 });
    expect(r.reject).toBeUndefined();
    expect(r.details.trackCount).toBe(0.7);
  });

  it.each([
    ['Spotify single vs Apple " - Single"', album({ title: 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)', albumType: 'single', trackCount: 1 }), album({ title: 'Get Lucky (feat. Pharrell Williams & Nile Rodgers) - Single', trackCount: 1 }), 0],
    ['EP hint vs single type', album({ title: 'Songs - EP', trackCount: 4 }), album({ title: 'Songs', albumType: 'single', trackCount: 4 }), 0],
    ['single vs album', album({ title: 'Songs', albumType: 'single', trackCount: 3 }), album({ title: 'Songs', albumType: 'album', trackCount: 3 }), PENALTY.albumType],
    ['" - Single" vs album', album({ title: 'Songs - Single', trackCount: 2 }), album({ title: 'Songs', albumType: 'album', trackCount: 2 }), PENALTY.albumType],
    ['deluxe vs standard', album({ title: 'Songs', trackCount: 12 }), album({ title: 'Songs (Deluxe)', trackCount: 13 }), PENALTY.deluxe],
    ['compilation vs studio', album({ title: 'Songs', trackCount: 12 }), album({ title: 'Songs', albumType: 'compilation', trackCount: 12 }), PENALTY.compilation],
    ['explicit lost', album({ title: 'Songs', explicit: true, trackCount: 12 }), album({ title: 'Songs', explicit: false, trackCount: 12 }), PENALTY.explicitLost],
  ])('%s: penalty %d', (_label, a, b, penalty) => {
    const r = scoreAlbum(a, b);
    expect(r.reject).toBeUndefined();
    expect(r.details.penalty).toBeCloseTo(penalty, 5);
  });

  it.each([
    ['1969', '1970', 1],
    ['1969', '2009', 0.3],
    ['1969', undefined, 0.5],
  ])('year %s vs %s scores %d', (a, b, score) => {
    const r = scoreAlbum({ ...src, releaseDate: a }, { ...src, releaseDate: b });
    expect(r.details.year).toBe(score);
  });

  it('Various Artists compilations match each other only', () => {
    const va = album({ title: 'Now Thats What I Call Music! 85', artists: ['Various Artists'], artist: 'Various Artists', trackCount: 40 });
    expect(scoreAlbum(va, { ...va, artist: 'Verschiedene Interpreten', artists: ['Verschiedene Interpreten'] }).reject).toBeUndefined();
    expect(scoreAlbum(va, { ...va, artist: 'Daft Punk', artists: ['Daft Punk'] }).reject).toMatch(/^artist: /);
    expect(scoreAlbum(va, { ...va, title: 'Now Thats What I Call Music! 86' }).reject).toMatch(/^title: /);
  });
});

describe('pickBestAlbum', () => {
  const src = album({ title: 'Sahra', artists: ['Khaled'], artist: 'Khaled', trackCount: 15, releaseDate: '1996', albumType: 'album' });

  it('chooses the matching album and rejects live, deluxe and compilation mismatches', () => {
    const r = pickBestAlbum(src, [
      album({ id: 'live', title: 'Hafla (Live)', artists: ['Khaled'], artist: 'Khaled', trackCount: 10 }),
      album({ id: 'best', title: 'Best Of', artists: ['Khaled'], artist: 'Khaled', trackCount: 15, albumType: 'compilation' }),
      album({ id: 'sahra', title: 'Sahra', artists: ['Cheb Khaled'], artist: 'Cheb Khaled', trackCount: 15, releaseDate: '1996-01-01' }),
    ]);
    expect(r.accepted?.item.id).toBe('sahra');
    expect(r.ranked.slice(1).every((x) => x.reject)).toBe(true);
  });

  it('a live album with the same name is not a match', () => {
    const r = pickBestAlbum(album({ title: 'Hafla', artists: ['Khaled'], artist: 'Khaled' }), [album({ title: 'Hafla (Live)', artists: ['Khaled'], artist: 'Khaled' })]);
    expect(r.accepted).toBeNull();
  });
});

describe('verifyAlbumById', () => {
  const src = album({ title: 'Sahra', artists: ['Khaled'], artist: 'Khaled', trackCount: 15 });

  it.each([
    ['localized title, same artist', album({ title: 'صحرا', artists: ['Khaled'], artist: 'Khaled', trackCount: 15 }), true, false],
    ['same title, artist in another script', album({ title: 'Sahra', artists: ['خالد'], artist: 'خالد', trackCount: 15 }), true, false],
    ['both differ', album({ title: 'صحرا', artists: ['خالد'], artist: 'خالد', trackCount: 15 }), false, false],
    ['track count differs', album({ title: 'Sahra', artists: ['Khaled'], artist: 'Khaled', trackCount: 18 }), false, false],
    ['live-labelled edition, same UPC', album({ title: 'Sahra (Live)', artists: ['Khaled'], artist: 'Khaled', trackCount: 15 }), true, false],
    ['identical', album({ title: 'Sahra', artists: ['Khaled'], artist: 'Khaled', trackCount: 15 }), true, true],
  ])('%s: non-strict %s, strict %s', (_label, cand, nonStrictOk, strictOk) => {
    expect(verifyAlbumById(src, cand, { strict: false }).reject === undefined).toBe(nonStrictOk);
    expect(verifyAlbumById(src, cand, { strict: true }).reject === undefined).toBe(strictOk);
  });
});
