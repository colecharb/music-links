import { describe, expect, it } from 'vitest';
import { UpstreamError } from '../src/http';
import {
  cleanChannelName,
  getYouTubeItem,
  parseYouTubeTitle,
  splitArtists,
  stripVideoNoise,
  youtubeMusicSearchUrl,
  youtubeMusicUrl,
  youtubeOEmbedUrl,
} from '../src/sources/youtube';
import type { TrackMeta } from '../src/types';
import { fixtureCtx } from './helpers/fixtures';

const thumb = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

describe('URL builders', () => {
  it('youtubeMusicUrl', () => {
    expect(youtubeMusicUrl('dQw4w9WgXcQ')).toBe('https://music.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(youtubeMusicUrl('a-b_c')).toBe('https://music.youtube.com/watch?v=a-b_c');
  });

  it('youtubeOEmbedUrl matches the recorded request', () => {
    expect(youtubeOEmbedUrl('dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json',
    );
  });

  it.each([
    ['Never Gonna Give You Up', 'Rick Astley', 'https://music.youtube.com/search?q=Never%20Gonna%20Give%20You%20Up%20Rick%20Astley'],
    ['Rock & Roll', 'Led Zeppelin', 'https://music.youtube.com/search?q=Rock%20%26%20Roll%20Led%20Zeppelin'],
    ['#1 Crush', 'Garbage', 'https://music.youtube.com/search?q=%231%20Crush%20Garbage'],
    ['Back In Black', 'AC/DC', 'https://music.youtube.com/search?q=Back%20In%20Black%20AC%2FDC'],
    ['Dynamite', '방탄소년단', 'https://music.youtube.com/search?q=Dynamite%20%EB%B0%A9%ED%83%84%EC%86%8C%EB%85%84%EB%8B%A8'],
    [`"Heroes"`, 'David Bowie', 'https://music.youtube.com/search?q=%22Heroes%22%20David%20Bowie'],
    ['a=b?c', 'x+y', 'https://music.youtube.com/search?q=a%3Db%3Fc%20x%2By'],
  ])('youtubeMusicSearchUrl(%j, %j)', (title, artist, url) => {
    expect(youtubeMusicSearchUrl({ kind: 'track', title, artist })).toBe(url);
    expect(new URL(url).searchParams.get('q')).toBe(`${title} ${artist}`);
  });
});

describe('getYouTubeItem (recorded oEmbed)', () => {
  it.each<[string, string, Omit<TrackMeta, 'kind' | 'id' | 'url' | 'art'>]>([
    ['official video with "(4K Remaster)"', 'dQw4w9WgXcQ', { title: 'Never Gonna Give You Up', artist: 'Rick Astley', artists: ['Rick Astley'] }],
    ['" - Topic" art track', 'lYBUbBu4W08', { title: 'Never Gonna Give You Up', artist: 'Rick Astley', artists: ['Rick Astley'] }],
    ['VEVO channel, "ft." after noise', 'OPf0YbXqDm0', { title: 'Uptown Funk ft. Bruno Mars', artist: 'Mark Ronson', artists: ['Mark Ronson'] }],
    ['VEVO channel, "ft." title', 'kJQP7kiw5Fk', { title: 'Despacito ft. Daddy Yankee', artist: 'Luis Fonsi', artists: ['Luis Fonsi'] }],
    ['label channel, quoted K-pop title', 'gdZLi9oWNZg', { title: 'Dynamite', artist: 'BTS (방탄소년단)', artists: ['BTS (방탄소년단)'] }],
  ])('%s (%s)', async (_label, id, expected) => {
    const calls: string[] = [];
    const item = await getYouTubeItem(fixtureCtx({ calls }), id);
    expect(item).toEqual({
      kind: 'track',
      id,
      url: `https://music.youtube.com/watch?v=${id}`,
      art: thumb(id),
      ...expected,
    });
    expect(item.durationMs).toBeUndefined();
    expect(calls).toEqual([youtubeOEmbedUrl(id)]);
  });

  it('nonexistent id (oEmbed 400 "Bad Request"): UpstreamError 404', async () => {
    const err = await getYouTubeItem(fixtureCtx(), 'ZZZZZZZZZZZ').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).status).toBe(404);
  });

  // oEmbed answers private / non-embeddable / removed videos with a plain-text status line. Those are
  // permanent, so they surface as 404 (not found page); server errors keep their status (retry page).
  it.each([
    [401, 'Unauthorized', 404],
    [403, 'Forbidden', 404],
    [404, 'Not Found', 404],
    [500, 'Internal Server Error', 500],
  ])('HTTP %i: UpstreamError (%s)', async (status, body, expected) => {
    const id = 'xxxxxxxxxxx';
    const ctx = fixtureCtx({ extra: [{ request: { url: youtubeOEmbedUrl(id) }, response: { status, body } }] });
    const err = await getYouTubeItem(ctx, id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).status).toBe(expected);
  });

  it('treats "(with Lyrics)" as video noise, not a featured artist', () => {
    expect(parseYouTubeTitle('Artist - Song (with Lyrics)', 'Some Channel')).toMatchObject({ title: 'Song', artist: 'Artist' });
  });

  it.each([
    ['invalid JSON', 'not json'],
    ['JSON without a title', JSON.stringify({ author_name: 'Someone' })],
    ['JSON null', 'null'],
  ])('200 with %s: UpstreamError', async (_label, body) => {
    const id = 'yyyyyyyyyyy';
    const ctx = fixtureCtx({
      extra: [{ request: { url: youtubeOEmbedUrl(id) }, response: { status: 200, headers: { 'content-type': 'application/json' }, body } }],
    });
    await expect(getYouTubeItem(ctx, id)).rejects.toBeInstanceOf(UpstreamError);
  });

  it('omits art when oEmbed has no thumbnail', async () => {
    const id = 'zzzzzzzzzzz';
    const body = JSON.stringify({ title: 'Song', author_name: 'Band - Topic' });
    const ctx = fixtureCtx({ extra: [{ request: { url: youtubeOEmbedUrl(id) }, response: { status: 200, body } }] });
    expect(await getYouTubeItem(ctx, id)).toEqual({
      kind: 'track',
      id,
      url: 'https://music.youtube.com/watch?v=zzzzzzzzzzz',
      title: 'Song',
      artist: 'Band',
      artists: ['Band'],
    });
  });

  it('network failure: UpstreamError without status', async () => {
    const ctx = fixtureCtx({ fetch: () => Promise.reject(new TypeError('connection reset')) });
    const err = await getYouTubeItem(ctx, 'dQw4w9WgXcQ').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).status).toBeUndefined();
  });
});

type Parsed = ReturnType<typeof parseYouTubeTitle>;

describe('parseYouTubeTitle', () => {
  it.each<[string, string, string, Parsed]>([
    // " - Topic" channels: title untouched, channel is one artist.
    ['topic', 'Never Gonna Give You Up', 'Rick Astley - Topic', { title: 'Never Gonna Give You Up', artist: 'Rick Astley', artists: ['Rick Astley'] }],
    ['topic keeps dashes', 'Oran Marseille - Oran Mix', 'Khaled - Topic', { title: 'Oran Marseille - Oran Mix', artist: 'Khaled', artists: ['Khaled'] }],
    ['topic keeps brackets', 'Song (Official Video)', 'Band - Topic', { title: 'Song (Official Video)', artist: 'Band', artists: ['Band'] }],
    ['topic with "&"', 'The Boxer', 'Simon & Garfunkel - Topic', { title: 'The Boxer', artist: 'Simon & Garfunkel', artists: ['Simon & Garfunkel'] }],
    ['topic non-Latin', '夜に駆ける', 'YOASOBI - Topic', { title: '夜に駆ける', artist: 'YOASOBI', artists: ['YOASOBI'] }],

    // Separators.
    ['hyphen', 'Daft Punk - Get Lucky', 'Some Label', { title: 'Get Lucky', artist: 'Daft Punk', artists: ['Daft Punk'] }],
    ['en dash', 'Daft Punk – Get Lucky', 'x', { title: 'Get Lucky', artist: 'Daft Punk', artists: ['Daft Punk'] }],
    ['em dash', 'Daft Punk — Get Lucky', 'x', { title: 'Get Lucky', artist: 'Daft Punk', artists: ['Daft Punk'] }],
    ['pipe', 'Daft Punk | Get Lucky', 'x', { title: 'Get Lucky', artist: 'Daft Punk', artists: ['Daft Punk'] }],
    ['first separator wins', 'Artist - Title - Club Mix', 'x', { title: 'Title - Club Mix', artist: 'Artist', artists: ['Artist'] }],
    ['hyphen inside names', 'Jay-Z - 99 Problems', 'x', { title: '99 Problems', artist: 'Jay-Z', artists: ['Jay-Z'] }],
    ['hyphen inside title', 'a-ha - Take On Me (Official Video) [Remastered in 4K]', 'a-ha', { title: 'Take On Me', artist: 'a-ha', artists: ['a-ha'] }],
    ['"Title - Artist" swapped via channel', 'Get Lucky - Daft Punk', 'Daft Punk', { title: 'Get Lucky', artist: 'Daft Punk', artists: ['Daft Punk'] }],
    ['no swap when channel is left side', 'Daft Punk - Daft Punk', 'Daft Punk', { title: 'Daft Punk', artist: 'Daft Punk', artists: ['Daft Punk'] }],
    ['song named Video', 'India.Arie - Video', 'IndiaArieVEVO', { title: 'Video', artist: 'India.Arie', artists: ['India.Arie'] }],
    ['extra whitespace', '  Artist  -  Song   (Official Video)  ', 'x', { title: 'Song', artist: 'Artist', artists: ['Artist'] }],

    // No separator: artist from the channel name.
    ['plain channel', 'Never Gonna Give You Up', 'Rick Astley', { title: 'Never Gonna Give You Up', artist: 'Rick Astley', artists: ['Rick Astley'] }],
    ['VEVO camelCase', 'Shake It Off', 'TaylorSwiftVEVO', { title: 'Shake It Off', artist: 'Taylor Swift', artists: ['Taylor Swift'] }],
    ['VEVO + noise', 'Hello (Official Music Video)', 'AdeleVEVO', { title: 'Hello', artist: 'Adele', artists: ['Adele'] }],
    ['spaced VEVO', 'Song', 'Taylor Swift VEVO', { title: 'Song', artist: 'Taylor Swift', artists: ['Taylor Swift'] }],
    ['" Official" suffix', 'Song', 'Rick Astley Official', { title: 'Song', artist: 'Rick Astley', artists: ['Rick Astley'] }],
    ['attached "Official"', 'Believer', 'ImagineDragonsOfficial', { title: 'Believer', artist: 'Imagine Dragons', artists: ['Imagine Dragons'] }],
    ['"Unofficial" is a name', 'Song', 'TheUnofficial', { title: 'Song', artist: 'TheUnofficial', artists: ['TheUnofficial'] }],
    ['no camelCase split without suffix', 'Strobe', 'deadmau5', { title: 'Strobe', artist: 'deadmau5', artists: ['deadmau5'] }],
    ['all-caps VEVO channel', 'Song', 'BLACKPINKVEVO', { title: 'Song', artist: 'BLACKPINK', artists: ['BLACKPINK'] }],
    ['no author', 'Song', '', { title: 'Song', artist: '', artists: [] }],
    ['quotes kept without MV marker', 'Theme From "Shaft"', 'Isaac Hayes', { title: 'Theme From "Shaft"', artist: 'Isaac Hayes', artists: ['Isaac Hayes'] }],
    ['quoted title kept without MV marker', '"Heroes"', 'David Bowie', { title: '"Heroes"', artist: 'David Bowie', artists: ['David Bowie'] }],

    // K-pop "Artist 'Title' MV" convention.
    ['K-pop quoted', "BTS (방탄소년단) 'Dynamite' Official MV", 'HYBE LABELS', { title: 'Dynamite', artist: 'BTS (방탄소년단)', artists: ['BTS (방탄소년단)'] }],
    ['K-pop curly quotes', 'IVE 아이브 ‘LOVE DIVE’ MV', 'STARSHIP', { title: 'LOVE DIVE', artist: 'IVE 아이브', artists: ['IVE 아이브'] }],
    ['K-pop separator + quotes', "BLACKPINK - '뚜두뚜두 (DDU-DU DDU-DU)' M/V", 'BLACKPINK', { title: '뚜두뚜두 (DDU-DU DDU-DU)', artist: 'BLACKPINK', artists: ['BLACKPINK'] }],

    // Multi-artist strings: split, full string kept.
    ['x', 'Calvin Harris x Dua Lipa - One Kiss', 'x', { title: 'One Kiss', artist: 'Calvin Harris x Dua Lipa', artists: ['Calvin Harris', 'Dua Lipa'] }],
    ['×', 'A × B - Song', 'x', { title: 'Song', artist: 'A × B', artists: ['A', 'B'] }],
    ['&', 'Simon & Garfunkel - The Boxer', 'x', { title: 'The Boxer', artist: 'Simon & Garfunkel', artists: ['Simon', 'Garfunkel'] }],
    ['commas and &', 'A, B & C - Song', 'x', { title: 'Song', artist: 'A, B & C', artists: ['A', 'B', 'C'] }],
    ['feat. in artist part', 'Luis Fonsi feat. Daddy Yankee - Despacito', 'x', { title: 'Despacito', artist: 'Luis Fonsi feat. Daddy Yankee', artists: ['Luis Fonsi', 'Daddy Yankee'] }],
    ['Ft in artist part', 'A Ft B - Song', 'x', { title: 'Song', artist: 'A Ft B', artists: ['A', 'B'] }],
    ['featuring in artist part', 'A featuring B - Song', 'x', { title: 'Song', artist: 'A featuring B', artists: ['A', 'B'] }],
    ['trailing uppercase X is a name', 'Lil Nas X - Old Town Road', 'x', { title: 'Old Town Road', artist: 'Lil Nas X', artists: ['Lil Nas X'] }],
    ['uppercase X between names is not a joiner', 'Lil Nas X X Someone - Song', 'x', { title: 'Song', artist: 'Lil Nas X X Someone', artists: ['Lil Nas X X Someone'] }],
    ['leading X is a name', 'X Ambassadors - Renegades', 'x', { title: 'Renegades', artist: 'X Ambassadors', artists: ['X Ambassadors'] }],
    ['dedupes', 'A & a - Song', 'x', { title: 'Song', artist: 'A & a', artists: ['A'] }],

    // feat. stays in the title.
    ['ft. after noise', 'Mark Ronson - Uptown Funk (Official Video) ft. Bruno Mars', 'MarkRonsonVEVO', { title: 'Uptown Funk ft. Bruno Mars', artist: 'Mark Ronson', artists: ['Mark Ronson'] }],
    ['(feat.) kept', 'Artist - Song (feat. Other) [Official Video]', 'x', { title: 'Song (feat. Other)', artist: 'Artist', artists: ['Artist'] }],

    // Everything is noise: keep the raw title rather than nothing.
    ['all noise', '(Official Video)', 'Rick Astley', { title: '(Official Video)', artist: 'Rick Astley', artists: ['Rick Astley'] }],
  ])('%s: %j by %j', (_label, title, author, expected) => {
    expect(parseYouTubeTitle(title, author)).toEqual(expected);
  });
});

describe('stripVideoNoise', () => {
  const noise = [
    '(Official Video)',
    '(Official Music Video)',
    '(Official Audio)',
    '(Official Lyric Video)',
    '(Lyric Video)',
    '(Lyrics Video)',
    '(Lyrics)',
    '[Lyrics]',
    '(Visualizer)',
    '(Official Visualiser)',
    '(Audio)',
    '(Video)',
    '(Music Video)',
    '(Official Videoclip)',
    '(HD)',
    '[HD]',
    '(HQ)',
    '(4K)',
    '(4K Remaster)',
    '(HD Remaster)',
    '(4K Remastered)',
    '[Remastered in 4K]',
    '(Official HD Video)',
    '(Official Video HD)',
    '(Official 4K Video)',
    '(OFFICIAL VIDEO)',
    '(official audio)',
    '[Official Video]',
    '(Official MV)',
    '[M/V]',
    '(Official)',
    '| Official Video',
    '| Official Music Video',
    '- Official Audio',
    '– Official Lyric Video',
    'Official MV',
    'M/V',
    'MV',
    'HD',
    '(Official Video) (4K Remaster)',
    '(Official Video) | HD',
  ];
  it.each(noise)('strips %j', (suffix) => {
    expect(stripVideoNoise(`Song ${suffix}`)).toBe('Song');
  });

  it.each([
    ['Song (Live)', 'Song (Live)'],
    ['Song (Live at Wembley 1986)', 'Song (Live at Wembley 1986)'],
    ['Song (Remix)', 'Song (Remix)'],
    ['Song (Official Remix)', 'Song (Official Remix)'],
    ['Song (Acoustic)', 'Song (Acoustic)'],
    ['Song (Acoustic Video)', 'Song (Acoustic Video)'],
    ['Song (feat. Other)', 'Song (feat. Other)'],
    ['Song [Extended Mix]', 'Song [Extended Mix]'],
    ['Song (Radio Edit) (Official Video)', 'Song (Radio Edit)'],
    ['Song (Live) [Official Video]', 'Song (Live)'],
    ['Song (2011 Remaster)', 'Song (2011 Remaster)'],
    // Lone words at the end of an unbracketed title can be part of the title.
    ['Home Video', 'Home Video'],
    ['Radio Audio', 'Radio Audio'],
    ['Song Lyrics', 'Song Lyrics'],
    ['Song - Video', 'Song - Video'],
  ])('keeps %j', (input, out) => {
    expect(stripVideoNoise(input)).toBe(out);
  });
});

describe('helpers', () => {
  it.each([
    ['TaylorSwiftVEVO', 'Taylor Swift'],
    ['MarkRonsonVEVO', 'Mark Ronson'],
    ['LuisFonsiVEVO', 'Luis Fonsi'],
    ['AdeleVevo', 'Adele'],
    ['Rick Astley', 'Rick Astley'],
    ['Rick Astley - Topic', 'Rick Astley'],
    ['HYBE LABELS', 'HYBE LABELS'],
    ['VEVO', 'VEVO'],
    ['Official', 'Official'],
    ['Blink182Official', 'Blink182'],
  ])('cleanChannelName(%j) = %j', (input, out) => {
    expect(cleanChannelName(input)).toBe(out);
  });

  it.each([
    ['A', ['A']],
    ['A, B', ['A', 'B']],
    ['A,B', ['A,B']],
    ['', []],
  ])('splitArtists(%j)', (input, out) => {
    expect(splitArtists(input)).toEqual(out);
  });
});
