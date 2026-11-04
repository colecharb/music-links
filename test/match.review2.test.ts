// Second adversarial review of src/normalize.ts and src/match.ts: one block per finding. "Real" cases use
// metadata recorded from the iTunes and Deezer APIs (test/fixtures/http) or observed live.
import { describe, expect, it } from 'vitest';
import {
  artistMatch,
  DURATION_TOLERANCE_MS,
  pickBestAlbum,
  pickBestTrack,
  scoreAlbum,
  scoreTrack,
  verifyAlbumById,
  verifyTrackById,
} from '../src/match';
import { classifyDescriptor, fold, parseAlbumTitle, parseTitle, qualifiersConfirm, stripHonorifics } from '../src/normalize';
import { searchApple } from '../src/sources/apple';
import { searchDeezer } from '../src/sources/deezer';
import type { AlbumMeta, ItemMeta, TrackMeta } from '../src/types';
import { fixtureCtx } from './helpers/fixtures';

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
const deezerSeconds = { durationPrecisionMs: 1000 } as const;

function tracksOnly(items: ItemMeta[]): TrackMeta[] {
  return items.filter((i): i is TrackMeta => i.kind === 'track');
}

/** Candidates exactly as the recorded searches return them (both Deezer queries, the iTunes query). */
async function recorded(title: string, artist: string, credits?: string[]): Promise<{ apple: TrackMeta[]; deezer: TrackMeta[] }> {
  const q = { kind: 'track' as const, title, artist, credits };
  const [apple, deezer] = await Promise.all([searchApple(fixtureCtx(), q), searchDeezer(fixtureCtx(), q)]);
  return { apple: tracksOnly(apple), deezer: tracksOnly(deezer) };
}

describe('finding 1: a track inherits every hard tag of its album title', () => {
  // Rasheeda, "Touch Ya Toes": the vocal vs the same title on the "Instrumentals" album (ids from the review,
  // which found both accepted at the vocal's length; the lengths here are illustrative).
  const rasheeda = { artists: ['Rasheeda'], artist: 'Rasheeda' };
  const vocal = track({ ...rasheeda, id: 'spotify', title: 'Touch Ya Toes', album: 'Touch Ya Toes - Single', durationMs: 236_000 });
  const deezerInstrumental = track({ ...rasheeda, id: '69380607', title: 'Touch Ya Toes', album: 'Instrumentals', durationMs: 236_000, ...deezerSeconds });
  const appleInstrumental = track({ ...rasheeda, id: '491163231', title: 'Touch Ya Toes', album: 'Instrumentals', durationMs: 236_120 });

  it('Rasheeda: the instrumental album never stands in for the vocal', () => {
    expect(scoreTrack(vocal, deezerInstrumental).reject).toBe('version: studio vs instrumental');
    expect(scoreTrack(vocal, appleInstrumental).reject).toBe('version: studio vs instrumental');
    expect(pickBestTrack(vocal, [deezerInstrumental, appleInstrumental]).accepted).toBeNull();
    expect(scoreTrack(appleInstrumental, vocal).reject).toBe('version: instrumental vs studio');
  });

  it.each([
    ['Album (Remixes)', 'remix'],
    ['Album (Acoustic)', 'acoustic'],
    ['Album (A Cappella)', 'acapella'],
    ['Album (Sped Up)', 'sped_up'],
    ['Album (Karaoke Version)', 'karaoke'],
    ['Album (Demos)', 'demo'],
    ['Album (Slowed + Reverb)', 'slowed'],
  ])('a plain title on %j is %s', (albumTitle, tag) => {
    const src = track({ title: 'Song', album: 'Album' });
    expect(scoreTrack(src, track({ title: 'Song', album: albumTitle })).reject).toBe(`version: studio vs ${tag}`);
  });

  it('two tracks on releases with the same label agree', () => {
    const r = scoreTrack(track({ title: 'Song', album: 'Song (Remixes)' }), track({ title: 'Song', album: 'Song (The Remixes)' }));
    expect(r.reject).toBeUndefined();
  });

  it('an album label never excuses a title label: "Song (Remix)" vs a plain "Song" on a remix EP', () => {
    // Remix EPs often carry the original mix too.
    expect(scoreTrack(track({ title: 'Song (Remix)' }), track({ title: 'Song', album: 'Song (Remixes)' })).reject).toBe('version: remix vs studio');
  });

  it('a source-platform ISRC is not second-guessed by the album label; a derived one is', () => {
    const src = { ...vocal, isrc: 'USAAA0000001' };
    expect(verifyTrackById(src, appleInstrumental, { strict: false }).reject).toBeUndefined();
    expect(verifyTrackById(src, appleInstrumental, { strict: true }).reject).toBe('version: studio vs instrumental');
  });

  it('a single named after its track still carries only its own descriptors', () => {
    const ptm = { artists: ['Portugal. The Man'], artist: 'Portugal. The Man' };
    const single = track({ ...ptm, title: 'Live in the Moment', album: 'Live in the Moment - Single', durationMs: 246_000, ...deezerSeconds });
    expect(scoreTrack(track({ ...ptm, title: 'Live in the Moment', album: 'Woodstock', durationMs: 246_789 }), single).reject).toBeUndefined();
    const remixSingle = track({ ...ptm, title: 'Live in the Moment', album: 'Live in the Moment (Remixes) - Single' });
    expect(scoreTrack(track({ ...ptm, title: 'Live in the Moment', album: 'Woodstock' }), remixSingle).reject).toBe('version: studio vs remix');
  });
});

describe('finding 2: an unexplained bracket group is not excused by a matching duration', () => {
  const rick = { artists: ['Rick Astley'], artist: 'Rick Astley' };
  // iTunes 1559885421 and Deezer 3794316162 (the 2019 re-recording, ISRC GB5KW1903177).
  const apple = track({ ...rick, id: '1559885421', title: 'Never Gonna Give You Up', album: 'Whenever You Need Somebody', durationMs: 213_573 });
  const pianoforte = track({
    ...rick,
    id: '3794316162',
    title: 'Never Gonna Give You Up (Pianoforte)',
    album: 'Never Gonna Give You Up (Pianoforte)',
    durationMs: 213_000,
    ...deezerSeconds,
    isrc: 'GB5KW1903177',
  });

  it('Rick Astley: the Pianoforte re-recording 0.6 s apart is rejected for an Apple source', () => {
    expect(scoreTrack(apple, pianoforte).reject).toBe('title: 0.75 < 0.8');
    expect(scoreTrack(pianoforte, apple).reject).toBe('title: 0.75 < 0.8');
  });

  it('Rick Astley: Deezer has no acceptable hit among the recorded results for an Apple source', async () => {
    const { deezer } = await recorded('never gonna give you up', 'Rick Astley');
    expect(deezer.map((t) => t.id)).toContain('3794316162');
    const r = pickBestTrack(apple, deezer);
    expect(r.accepted, JSON.stringify(r.ranked.slice(0, 3).map((c) => [c.item.title, c.reject]))).toBeNull();
  });

  it.each(['Remake', 'New Recording', 'Reimagined', 'Orchestra', 'Unreleased', 'Dolby Atmos', '8D Audio'])(
    '"Never Gonna Give You Up (%s)" with the same duration is rejected',
    (group) => {
      const r = scoreTrack(apple, { ...apple, id: 'x', title: `Never Gonna Give You Up (${group})` });
      expect(r.reject).toMatch(/^title: /);
    },
  );

  it.each([
    ['Never Gonna Give You Up (Pianoforte)', 'Never Gonna Give You Up (Orchestra)'],
    ['Song (Pianoforte)', 'Song (Orchestra)'],
    ['Never Gonna Give You Up (Remake)', 'Never Gonna Give You Up (Reimagined)'],
  ])('different groups on each side: %j vs %j is rejected', (a, b) => {
    expect(scoreTrack(track({ title: a }), track({ title: b })).reject).toMatch(/^title: /);
  });

  it('PSY: the Hangul translation in brackets still matches (Deezer 60726278 vs iTunes 1445144527)', () => {
    const deezer = track({ artists: ['Psy'], artist: 'Psy', id: '60726278', title: 'Gangnam Style (강남스타일)', album: 'Gangnam Style (강남스타일)', durationMs: 219_000, ...deezerSeconds });
    const itunes = track({ artists: ['PSY'], artist: 'PSY', id: '1445144527', title: 'Gangnam Style', album: 'Gangnam Style - Single', durationMs: 219_493 });
    expect(scoreTrack(deezer, itunes).reject).toBeUndefined();
    expect(scoreTrack(itunes, deezer).reject).toBeUndefined();
    // A translation is explained even without a duration.
    expect(scoreTrack({ ...deezer, ...youtube, album: undefined }, itunes).reject).toBeUndefined();
  });

  it('YOASOBI: a romanized subtitle matches the Japanese title and the romanization alone', () => {
    const yoasobi = { artists: ['YOASOBI'], artist: 'YOASOBI' };
    const romanized = track({ ...yoasobi, title: '夜に駆ける (Yoru ni Kakeru)', durationMs: 261_000, ...deezerSeconds });
    expect(scoreTrack(romanized, track({ ...yoasobi, id: '1490256995', title: '夜に駆ける', durationMs: 261_013 })).reject).toBeUndefined();
    expect(scoreTrack(romanized, track({ ...yoasobi, title: 'Yoru ni Kakeru', durationMs: 261_013 })).reject).toBeUndefined();
    // Two Latin titles: not a translation, so a search link (iTunes 1526315265 is a cover anyway).
    expect(scoreTrack(track({ ...yoasobi, title: 'Yoru ni Kakeru' }), track({ ...yoasobi, title: 'Racing Into the Night (Yoru ni Kakeru)' })).reject).toMatch(/^title: /);
  });

  it.each([
    'From "Frozen 2"',
    'From the Motion Picture "The Lion King"',
    'Theme from "Shaft"',
    'Love Theme from "The Godfather"',
    '1996',
    'Bonus Track',
    'Japan Bonus Track',
    'Single',
    'Mono',
    'Edited',
    'Original Broadway Cast Recording',
    'Music From & Inspired By',
  ])('the legitimate group "(%s)" is still accepted', (group) => {
    const r = scoreTrack(track({ title: 'Never Gonna Give You Up' }), track({ title: `Never Gonna Give You Up (${group})` }));
    expect(r.reject).toBeUndefined();
  });

  it('a group that only names the credited artists explains itself (iTunes 1444130029)', () => {
    const iam = track({
      id: '1444130029',
      title: 'Oran Marseille (Khaled - I Am)',
      artists: ['Khaled And I AM, I Am & Khaled'],
      artist: 'Khaled And I AM, I Am & Khaled',
      album: 'Sahra',
      durationMs: 265_773,
    });
    const deezer = track({ title: 'Oran Marseille', artists: ['Khaled', 'IAM'], artist: 'Khaled', album: 'Sahra', durationMs: 266_000, ...deezerSeconds });
    expect(scoreTrack(deezer, iam).reject).toBeUndefined();
    expect(scoreTrack(iam, deezer).reject).toBeUndefined();
  });

  it('a Spotify-style " - " suffix counts as a group too', () => {
    const spotify = track({ ...rick, title: 'Never Gonna Give You Up - Pianoforte', durationMs: 213_000 });
    expect(parseTitle(spotify.title).extras).toEqual(['pianoforte']);
    expect(scoreTrack(spotify, apple).reject).toMatch(/^title: /);
    expect(scoreTrack(spotify, pianoforte).reject).toBeUndefined();
    expect(scoreTrack(track({ title: 'Part 1 - The Beginning' }), track({ title: 'Part 1 - The Beginning' })).reject).toBeUndefined();
  });

  it('the same words bracketed differently are not an unexplained group', () => {
    expect(scoreTrack(track({ title: 'Sunshine (The Light)' }), track({ title: 'Sunshine The Light' })).reject).toBeUndefined();
    expect(scoreTrack(track({ title: 'P.Y.T. (Pretty Young Thing)' }), track({ title: 'P.Y.T. (Pretty Young Thing)' })).reject).toBeUndefined();
  });
});

describe('finding 3: without a duration, live and remix versions must be named on both sides', () => {
  const queen = { artists: ['Queen'], artist: 'Queen' };
  const yt = (title: string) => track({ ...queen, id: 'youtube', title, ...youtube });

  it('Queen: a bare "(Live)" YouTube source matches none of the recorded live recordings', async () => {
    const { apple, deezer } = await recorded('bohemian rhapsody', 'Queen');
    for (const cands of [apple, deezer]) {
      const r = pickBestTrack(yt('Bohemian Rhapsody (Live)'), cands);
      expect(r.accepted, `${r.accepted?.item.title} on ${r.accepted?.item.album}`).toBeNull();
    }
    const montreal = apple.find((t) => t.id === '6781075714');
    expect(montreal && scoreTrack(yt('Bohemian Rhapsody (Live)'), montreal).reject).toBe('version: live (unnamed vs unnamed) without a duration');
  });

  it('Queen: "(Live Aid 1985)" picks the Live Aid recording, never Queen Rock Montreal', async () => {
    const { apple, deezer } = await recorded('bohemian rhapsody', 'Queen');
    const src = yt('Bohemian Rhapsody (Live Aid 1985)');
    expect(pickBestTrack(src, apple).accepted?.item.id).toBe('6781027700');
    expect(pickBestTrack(src, deezer).accepted?.item.id).toBe('4091936771');
    const montreal = apple.find((t) => t.id === '6781075714');
    expect(montreal && scoreTrack(src, montreal).reject).toBe('version: live (aid 1985 vs unnamed) without a duration');
  });

  it('Queen: the concert can come from the candidate album title ("Hungarian Rhapsody (Live In Budapest / 1986)")', async () => {
    const { apple, deezer } = await recorded('bohemian rhapsody', 'Queen');
    const src = yt('Bohemian Rhapsody (Live in Budapest 1986)');
    expect(pickBestTrack(src, apple).accepted?.item.id).toBe('6781079776');
    expect(pickBestTrack(src, deezer).accepted?.item.id).toBe('4092345051');
  });

  it('Queen: "(Live at Wembley Stadium)" picks the Wembley 1986 recording on both services', async () => {
    const { apple, deezer } = await recorded('bohemian rhapsody', 'Queen');
    const src = yt('Bohemian Rhapsody (Live at Wembley Stadium)');
    expect(pickBestTrack(src, apple).accepted?.item.id).toBe('6781081746');
    expect(pickBestTrack(src, deezer).accepted?.item.id).toBe('4092342471');
  });

  it('live album titles carry their concert as a qualifier', () => {
    expect(parseAlbumTitle('Live at Wembley Stadium').qualifiers.live).toEqual(['wembley', 'stadium']);
    expect(parseAlbumTitle('Hungarian Rhapsody (Live In Budapest / 1986)').qualifiers.live).toEqual(['budapest', '1986']);
  });

  it('remixes: an unnamed remix never picks a named one; the same remixer does', () => {
    expect(scoreTrack(track({ title: 'Song (Remix)', ...youtube }), track({ title: 'Song (Tiësto Remix)' })).reject).toBe(
      'version: remix (unnamed vs tiesto) without a duration',
    );
    expect(scoreTrack(track({ title: 'Song (Remix)', ...youtube }), track({ title: 'Song - Remix' })).reject).toMatch(/without a duration/);
    expect(scoreTrack(track({ title: 'Song (Tiësto Remix)', ...youtube }), track({ title: 'Song - Tiësto Remix' })).reject).toBeUndefined();
    // With both durations, a plain remix label still matches a named one (the duration identifies it).
    expect(scoreTrack(track({ title: 'Song (Remix)' }), track({ title: 'Song (Tiësto Remix)' })).reject).toBeUndefined();
  });

  it('Despacito: an official remix named by its guest is qualified by the featured artist', async () => {
    const { apple, deezer } = await recorded('despacito remix', 'Luis Fonsi', ['Justin Bieber']);
    const src = track({ artists: ['Luis Fonsi'], artist: 'Luis Fonsi', title: 'Despacito (feat. Justin Bieber) [Remix]', ...youtube });
    const r = pickBestTrack(src, apple);
    expect(['1447401626', '6817920720'], JSON.stringify(r.ranked.slice(0, 3).map((c) => [c.item.title, c.reject]))).toContain(r.accepted?.item.id);
    // Deezer titles it "Despacito (Remix)" with no guest: nothing names the remix, so a search link.
    expect(pickBestTrack(src, deezer).accepted).toBeNull();
    const majorLazer = apple.find((t) => t.id === '1444887221');
    expect(majorLazer && scoreTrack(src, majorLazer).reject).toBe('version: remix (justin bieber vs major lazer moska) without a duration');
  });
});

describe('finding 4: albums apply the variant and unexplained-group rules', () => {
  const aplin = { artists: ['Gabrielle Aplin'], artist: 'Gabrielle Aplin' };
  // Deezer's only hit for "Gabrielle Aplin waking up slow" was the piano single.
  const spotify = album({ ...aplin, id: 'spotify', title: 'Waking Up Slow', albumType: 'single', trackCount: 1 });
  const piano = album({ ...aplin, id: 'deezer', title: 'Waking Up Slow (Piano Version)', albumType: 'single', trackCount: 1 });

  it('Gabrielle Aplin: the piano single is not the single', () => {
    expect(scoreAlbum(spotify, piano).reject).toBe('version: studio vs variant:piano');
    expect(pickBestAlbum(spotify, [piano]).accepted).toBeNull();
  });

  it('a UPC derived from a fuzzy match is held to the same rule; the source platform UPC is not', () => {
    const apple = { ...piano, id: 'apple', title: 'Waking Up Slow (Piano Version) - Single' };
    expect(verifyAlbumById(spotify, apple, { strict: true }).reject).toBe('version: studio vs variant:piano');
    expect(verifyAlbumById(spotify, apple, { strict: false }).reject).toBeUndefined();
  });

  it.each(['Spanish Version', 'Japanese Ver.', 'Reimagined', 'Pianoforte'])('"Album (%s)" with the same track count is rejected', (label) => {
    const src = album({ title: 'Album', trackCount: 10, albumType: 'album' });
    const r = scoreAlbum(src, album({ title: `Album (${label})`, trackCount: 10, albumType: 'album' }));
    expect(r.reject).toMatch(/^version: studio vs variant:|^title: /);
  });

  it('look-alike variant labels on both sides with equal track counts are one edition', () => {
    const r = scoreAlbum(album({ title: 'Sahra (Version Mixte)', trackCount: 12 }), album({ title: 'Sahra (Mixed Version)', trackCount: 12 }));
    expect(r.reject).toBeUndefined();
    expect(scoreAlbum(album({ title: 'Sahra (Version Mixte)', trackCount: 12 }), album({ title: 'Sahra (Mixed Version)', trackCount: 13 })).reject).toMatch(
      /variant:mixte vs variant:mixed/,
    );
  });

  it('Hozier (iTunes 923529751 / 900672435): the expanded edition differs by track count only, not by version', () => {
    const hozier = { artists: ['Hozier'], artist: 'Hozier' };
    const r = scoreAlbum(album({ ...hozier, id: '923529751', title: 'Hozier', trackCount: 13 }), album({ ...hozier, id: '900672435', title: 'Hozier (Expanded Edition)', trackCount: 15 }));
    expect(r.reject).toBe('tracks: 13 vs 15');
    expect(scoreAlbum(album({ ...hozier, title: 'Hozier', trackCount: 14 }), album({ ...hozier, title: 'Hozier (Expanded Edition)', trackCount: 15 })).reject).toBeUndefined();
  });
});

describe('finding 5: edit/extended labels on albums are hard markers', () => {
  it.each([
    ['Song (Extended Mix)', 'Song', 'version: extended vs studio'],
    ['Song (Radio Edit)', 'Song (Extended Mix)', 'version: edit vs extended'],
    ['Song', 'Song (Edit)', 'version: studio vs edit'],
  ])('single %j vs single %j (one track each) is rejected', (a, b, reason) => {
    const r = scoreAlbum(album({ title: a, albumType: 'single', trackCount: 1 }), album({ title: b, albumType: 'single', trackCount: 1 }));
    expect(r.reject).toBe(reason);
  });

  it.each(['Extended Edition', 'Extended Deluxe Edition', 'Expanded Edition', 'Deluxe Extended Edition'])('"Album (%s)" is an edition, not an extended mix', (label) => {
    const p = parseAlbumTitle(`Album (${label})`);
    expect([...p.versions]).toEqual([]);
    expect([...p.soft]).toEqual(['deluxe']);
    expect(scoreAlbum(album({ title: 'Album', trackCount: 12 }), album({ title: `Album (${label})`, trackCount: 13 })).reject).toBeUndefined();
  });

  it('"Extended Play" is an EP', () => {
    expect(parseAlbumTitle('Songs (Extended Play)').albumHint).toBe('ep');
    expect([...parseAlbumTitle('Songs (Extended Play)').versions]).toEqual([]);
  });
});

describe('finding 6: ±3 s is a hard limit on the reported durations', () => {
  it.each([
    [1, 1],
    [1, 1000],
    [1000, 1],
    [1000, 1000],
  ])('precision %d vs %d: exactly the tolerance passes, 1 ms more fails', (sp, cp) => {
    const src = track({ title: 'Song', durationMs: 200_000, durationPrecisionMs: sp });
    const at = scoreTrack(src, track({ title: 'Song', durationMs: 200_000 + DURATION_TOLERANCE_MS, durationPrecisionMs: cp }));
    const over = scoreTrack(src, track({ title: 'Song', durationMs: 200_000 + DURATION_TOLERANCE_MS + 1, durationPrecisionMs: cp }));
    expect(at.reject).toBeUndefined();
    expect(over.reject).toBe('duration +3.0s');
  });

  it('Deezer whole seconds 3.5-4 s away are rejected (previously accepted with 0.5 s slack per side)', () => {
    const deezer = track({ title: 'Song', durationMs: 204_000, ...deezerSeconds });
    expect(scoreTrack(track({ title: 'Song', durationMs: 200_000, ...deezerSeconds }), deezer).reject).toBe('duration +4.0s');
    expect(scoreTrack(track({ title: 'Song', durationMs: 200_500 }), deezer).reject).toBe('duration +3.5s');
  });

  it('an ISRC hit is held to the same limit', () => {
    expect(verifyTrackById(track({ title: 'Song', durationMs: 200_000, ...deezerSeconds }), track({ title: 'Song', durationMs: 203_600 }), { strict: false }).reject).toBe(
      'duration +3.6s',
    );
  });
});

describe('finding 7: instrumental and karaoke labels', () => {
  it.each([
    ['Song (Off Vocal)', 'instrumental'],
    ['Song (Off Vocal Ver.)', 'instrumental'],
    ['Song - Off Vocal', 'instrumental'],
    ['Song (Without Vocals)', 'instrumental'],
    ['Song (No Vocals)', 'instrumental'],
    ['Song (Vocal-less)', 'instrumental'],
    ['夜に駆ける (オフボーカル)', 'instrumental'],
    ['夜に駆ける (オフボーカルver.)', 'instrumental'],
    ['夜に駆ける (オフ・ボーカル)', 'instrumental'],
    ['夜に駆ける (インスト)', 'instrumental'],
    ['夜に駆ける (インストゥルメンタル)', 'instrumental'],
    ['夜に駆ける (伴奏)', 'instrumental'],
    ['夜に駆ける (カラオケ)', 'karaoke'],
  ])('%j is %s', (raw, tag) => {
    const p = parseTitle(raw);
    expect([...p.versions]).toEqual([tag]);
    expect(p.extras).toEqual([]);
    expect(p.qualifiers[tag as 'instrumental'] ?? []).toEqual([]);
  });

  it('YOASOBI: an off-vocal track with the original length is not the original', () => {
    const yoasobi = { artists: ['YOASOBI'], artist: 'YOASOBI' };
    const deezer = track({ ...yoasobi, id: '824731152', title: '夜に駆ける', album: '夜に駆ける', durationMs: 261_000, ...deezerSeconds });
    expect(scoreTrack(deezer, track({ ...yoasobi, title: '夜に駆ける (オフボーカル)', durationMs: 261_013 })).reject).toBe('version: studio vs instrumental');
    expect(scoreTrack(deezer, track({ ...yoasobi, title: 'Yoru ni Kakeru (Off Vocal)', durationMs: 261_013 })).reject).toMatch(/studio vs instrumental/);
  });

  it('two instrumental labels for one recording agree', () => {
    expect(scoreTrack(track({ title: 'Song (Off Vocal)' }), track({ title: 'Song (Instrumental)' })).reject).toBeUndefined();
    expect(scoreTrack(track({ title: '夜に駆ける (オフボーカル)' }), track({ title: '夜に駆ける (Instrumental)' })).reject).toBeUndefined();
  });
});

describe('finding 8: consonant skeletons need the album to agree', () => {
  it.each([
    ['Stronger', 'Strange'],
    ['Diamonds', 'Demands'],
    ['Stars', 'Sisters'],
    ['Breathe', 'Brother'],
    ['Dreams', 'Drums'],
    ['Paradise', 'Parades'],
    ['Monster', 'Minister'],
  ])('%j vs %j, durations 1 s apart, different albums: rejected', (a, b) => {
    const r = scoreTrack(track({ title: a, album: `${a} - Single` }), track({ title: b, album: `${b} - Single`, durationMs: 201_000 }));
    expect(r.reject).toMatch(/^title: /);
    expect(scoreTrack(track({ title: a }), track({ title: b, durationMs: 201_000 })).reject).toMatch(/^title: /);
  });

  it('Khaled: the transliteration still matches on the same album, and not on another', () => {
    const khaled = { artists: ['Khaled'], artist: 'Khaled' };
    const src = track({ ...khaled, title: 'Ouelli El Darek', album: 'Sahra', durationMs: 189_360 });
    expect(scoreTrack(src, track({ ...khaled, title: 'Weli L Darek', album: 'Sahra', durationMs: 189_500 })).reject).toBeUndefined();
    expect(scoreTrack(src, track({ ...khaled, title: 'Weli L Darek', album: 'Best Of Cheb Khaled', durationMs: 189_500 })).reject).toMatch(/^title: /);
  });
});

describe('finding 9: ignorable words no longer hide the rest of a descriptor', () => {
  it.each([
    ['original piano version', 'variant:piano'],
    ['bonus track piano version', 'variant:piano'],
    ['soundtrack version', 'variant:soundtrack'],
    ['video version', 'variant:video'],
    ['official spanish version', 'variant:spanish'],
  ])('%j -> %s', (folded, variant) => {
    expect(classifyDescriptor(folded)).toMatchObject({ recognized: true, soft: [variant], hard: [] });
  });

  it('"8D Audio" stays an unrecognized group', () => {
    expect(classifyDescriptor('8d audio').recognized).toBe(false);
    expect(parseTitle('Song (8D Audio)').extras).toEqual(['8d audio']);
  });

  it.each([
    'Song (Original Piano Version)',
    'Song (Bonus Track - Piano Version)',
    'Song (8D Audio)',
    'Song (Soundtrack Version)',
    'Song (Video Version)',
  ])('%j is not "Song"', (title) => {
    expect(scoreTrack(track({ title: 'Song' }), track({ title })).reject).toBeDefined();
    expect(scoreTrack(track({ title }), track({ title: 'Song' })).reject).toBeDefined();
  });

  it.each([
    'album version',
    'original mix',
    'official music video',
    'official video with lyrics',
    'lyrics',
    'bonus track',
    'itunes bonus track',
    'original motion picture soundtrack',
    'the original soundtrack',
    'original broadway cast recording',
    'music from the motion picture',
    'from frozen 2',
    'theme from shaft',
    'prod by metro boomin',
    '2011',
  ])('%j is still ignorable', (folded) => {
    expect(classifyDescriptor(folded)).toMatchObject({ recognized: true, soft: [], hard: [] });
  });

  it('Let It Go: the Spotify soundtrack suffix is still ignorable', () => {
    expect(parseTitle('Let It Go - From "Frozen"/Soundtrack Version').base).toBe('let it go');
  });
});

describe('finding 10: "DJ" and "MC" are part of the name', () => {
  it.each([
    ['DJ Khaled', 'dj khaled'],
    ['MC Solaar', 'mc solaar'],
    ['Cheb Khaled', 'khaled'],
    ['The Beatles', 'beatles'],
  ])('stripHonorifics(%j) = %j', (name, expected) => {
    expect(stripHonorifics(name)).toBe(expected);
  });

  it('Khaled never matches DJ Khaled releases from the recorded iTunes search "Khaled"', async () => {
    const albums = (await searchApple(fixtureCtx(), { kind: 'album', title: '', artist: 'Khaled' })).filter((a): a is AlbumMeta => a.kind === 'album');
    const djKhaled = albums.filter((a) => /dj khaled/i.test(a.artist));
    expect(djKhaled.length).toBeGreaterThan(5);
    const khaled = { artists: ['Khaled'], artist: 'Khaled' };
    for (const a of djKhaled) expect(artistMatch(khaled, a).match, a.artist).toBe(false);
    expect(artistMatch(khaled, { artists: ['Cheb Khaled'], artist: 'Cheb Khaled' }).match).toBe(true);
  });
});

describe('finding 11: "(with Lyrics)" is not a featured artist', () => {
  it.each([
    ['Song (with Lyrics)', 'song'],
    ['Song [With Lyrics]', 'song'],
    ['Song (with Strings)', 'song with strings'],
    ['Song (with Full Orchestra)', 'song with full orchestra'],
    ['Song (with Choir)', 'song with choir'],
  ])('%j has no featured artist (base %j)', (raw, base) => {
    const p = parseTitle(raw);
    expect(p.featured).toEqual([]);
    expect(p.base).toBe(base);
  });

  it.each([
    ['Song (with Drake)', ['drake']],
    ['Song (with The London Symphony Orchestra)', ['the london symphony orchestra']],
    ['Song (with Lyric Thomas)', ['lyric thomas']],
  ])('%j still has the featured artist %j', (raw, featured) => {
    expect(parseTitle(raw).featured).toEqual(featured);
  });

  it('a YouTube "(with Lyrics)" title costs no uncredited-featured penalty', () => {
    const yt = track({ title: 'Blinding Lights (with Lyrics)', artists: ['The Weeknd'], artist: 'The Weeknd', ...youtube });
    const r = scoreTrack(yt, track({ title: 'Blinding Lights', artists: ['The Weeknd'], artist: 'The Weeknd' }));
    expect(r.reject).toBeUndefined();
    expect(r.details.penalty).toBe(0);
    expect(fold('with lyrics')).toBe('with lyrics');
  });
});

// Defects found while verifying the fixes above.
describe('verification: without a duration, qualifiers must positively agree', () => {
  const nirvana = { artists: ['Nirvana'], artist: 'Nirvana' };
  const queen = { artists: ['Queen'], artist: 'Queen' };

  it.each([
    [['1981'], ['aid'], false],
    [['1986'], ['wembley', 'stadium', '1986'], false],
    [['1991'], ['reading'], false],
    [['1991'], ['1991'], true],
    [['1991'], ['1992'], false],
    [['aid', '1985'], ['aid'], true],
    [['wembley', 'stadium'], ['wembley', 'stadium', '1986'], true],
    [['budapest', '1986'], ['wembley', 'stadium', '1986'], false],
    [['rm'], ['tiesto'], false],
    [[], ['tiesto'], false],
  ])('qualifiersConfirm(%j, %j) = %s', (a, b, ok) => {
    expect(qualifiersConfirm(a, b)).toBe(ok);
    expect(qualifiersConfirm(b, a)).toBe(ok);
  });

  it('Nirvana: "(Live 1991)" names no concert, so none of the recorded 1991 concerts is picked on Apple', async () => {
    // Apple has Del Mar (Dec 1991) and the Paramount (Oct 1991); a year alone used to pick Del Mar.
    const { apple } = await recorded('smells like teen spirit live', 'Nirvana');
    const src = track({ ...nirvana, title: 'Smells Like Teen Spirit (Live 1991)', ...youtube });
    const r = pickBestTrack(src, apple);
    expect(r.accepted, `${r.accepted?.item.title}`).toBeNull();
    const delMar = apple.find((t) => t.id === '1440917612');
    expect(delMar && scoreTrack(src, delMar).reject).toBe('version: live (1991 vs mar fairgrounds 1991) without a duration');
    const reading = apple.find((t) => t.id === '1440797536');
    expect(reading && scoreTrack(src, reading).reject).toBe('version: live (1991 vs reading) without a duration');
  });

  it('Nirvana: a named concert still picks its recording on both services', async () => {
    const { apple, deezer } = await recorded('smells like teen spirit live', 'Nirvana');
    const reading = track({ ...nirvana, title: 'Smells Like Teen Spirit (Live at Reading)', ...youtube });
    expect(pickBestTrack(reading, apple).accepted?.item.id).toBe('1440797536');
    expect(pickBestTrack(reading, deezer).accepted?.item.id).toBe('4601811');
    const paramount = track({ ...nirvana, title: 'Smells Like Teen Spirit (Live at the Paramount)', ...youtube });
    expect(pickBestTrack(paramount, apple).accepted?.item.id).toBe('1458927240');
    expect(pickBestTrack(paramount, deezer).accepted?.item.id).toBe('661518662');
  });

  it('Queen: "(Live, 1981)" never picks Live Aid (1985), and "(Live 1986)" picks neither Wembley nor Budapest', async () => {
    const { apple, deezer } = await recorded('bohemian rhapsody', 'Queen');
    for (const title of ['Bohemian Rhapsody (Live, 1981)', 'Bohemian Rhapsody (Live 1986)']) {
      const src = track({ ...queen, title, ...youtube });
      for (const cands of [apple, deezer]) {
        const r = pickBestTrack(src, cands);
        expect(r.accepted, `${title}: ${r.accepted?.item.title} on ${r.accepted?.item.album}`).toBeNull();
      }
    }
  });

  it('a featured name too short to identify anyone is not a remix qualifier', () => {
    const src = track({ title: 'Song (feat. RM) [Remix]', ...youtube });
    const tiesto = track({ title: 'Song (Tiësto Remix)', artists: ['Artist', 'RM'] });
    expect(scoreTrack(src, tiesto).reject).toBe('version: remix (rm vs tiesto) without a duration');
  });

  it('with durations, a year on one side and a venue on the other does not excuse two live releases', () => {
    const src = track({ title: 'Song (Live 1986)', album: 'On Tour' });
    const wembley = track({ title: 'Song (Live at Wembley Stadium / July 1986)', album: 'Live at Wembley Stadium', durationMs: 201_000 });
    expect(scoreTrack(src, wembley).reject).toBe('version: live on On Tour vs Live at Wembley Stadium');
    const named = track({ title: 'Song (Live at Wembley 1986)', album: 'Magic Tour' });
    expect(scoreTrack(named, wembley).reject).toBeUndefined();
  });
});

describe('verification: a bracket group naming the artists needs a duration', () => {
  it('Avicii: "Wake Me Up (Avicii By Avicii)" is another recording, so a YouTube "Wake Me Up" does not take it', () => {
    const avicii = { artists: ['Avicii'], artist: 'Avicii' };
    const r = scoreTrack(track({ ...avicii, title: 'Wake Me Up', ...youtube }), track({ ...avicii, title: 'Wake Me Up (Avicii By Avicii)' }));
    expect(r.reject).toMatch(/^title: /);
  });
});

describe('verification: descriptors the finding 9 fix turned into unexplained groups', () => {
  it.each([
    'Official Dance Video',
    'Official Animated Video',
    'Official Performance Video',
    'Official Vertical Video',
    'Dance Video',
    'Video Musical',
    'Clipe Oficial',
    'Official M/V',
    'Official Version',
  ])(
    '"(%s)" describes the video, so it is ignorable',
    (group) => {
      expect(parseTitle(`Song (${group})`).extras).toEqual([]);
      expect(scoreTrack(track({ title: `Song (${group})`, ...youtube }), track({ title: 'Song' })).reject).toBeUndefined();
    },
  );

  it.each(['Piano Video', 'Cover Video'])('"(%s)" names another arrangement and stays unexplained', (group) => {
    expect(parseTitle(`Song (${group})`).extras).toEqual([fold(group)]);
    expect(scoreTrack(track({ title: `Song (${group})` }), track({ title: 'Song' })).reject).toMatch(/^title: /);
  });

  it('"(Video Version)" is still a variant', () => {
    expect(classifyDescriptor('video version')).toMatchObject({ recognized: true, soft: ['variant:video'] });
  });
});

describe('verification: "Vocal" still names a mix', () => {
  it('"Vocal Mix" vs "Tiësto Remix" are two mixes; the instrumental labels still carry no qualifier', () => {
    expect(parseTitle('Song (Vocal Mix)').qualifiers.remix).toEqual(['vocal']);
    expect(scoreTrack(track({ title: 'Song (Vocal Mix)' }), track({ title: 'Song (Tiësto Remix)' })).reject).toBe('version: remix (vocal vs tiesto)');
    expect(parseTitle('Song (Instrumental Without Vocals)').qualifiers.instrumental).toEqual([]);
  });
});

describe('verification: an "Original Mix" title on a remix release', () => {
  it('says itself that it is not a remix', () => {
    const onEp = track({ title: 'Song (Original Mix)', album: 'Song (Remixes)' });
    expect(parseTitle(onEp.title).original).toBe(true);
    expect(scoreTrack(onEp, track({ title: 'Song (Original Mix)', album: 'Song' })).reject).toBeUndefined();
    expect(scoreTrack(track({ title: 'Song', album: 'Song - Single' }), onEp).reject).toBeUndefined();
    // Without the label the album still decides.
    expect(scoreTrack(track({ title: 'Song', album: 'Song - Single' }), track({ title: 'Song', album: 'Song (Remixes)' })).reject).toBe('version: studio vs remix');
    expect(parseTitle('Song (Original Motion Picture Soundtrack)').original).toBe(false);
  });
});
