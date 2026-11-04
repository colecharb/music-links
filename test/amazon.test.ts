import { describe, expect, it } from 'vitest';
import { amazonSearchUrl } from '../src/sources/amazon';

describe('amazonSearchUrl', () => {
  it.each([
    ['Ouelli El Darek', 'Khaled', 'https://music.amazon.com/search/Ouelli%20El%20Darek%20Khaled'],
    ['Rock & Roll', 'Led Zeppelin', 'https://music.amazon.com/search/Rock%20%26%20Roll%20Led%20Zeppelin'],
    ['#1 Crush', 'Garbage', 'https://music.amazon.com/search/%231%20Crush%20Garbage'],
    ['Back In Black', 'AC/DC', 'https://music.amazon.com/search/Back%20In%20Black%20AC%2FDC'],
    ['夜に駆ける', 'YOASOBI', 'https://music.amazon.com/search/%E5%A4%9C%E3%81%AB%E9%A7%86%E3%81%91%E3%82%8B%20YOASOBI'],
    [`"Heroes"`, 'David Bowie', 'https://music.amazon.com/search/%22Heroes%22%20David%20Bowie'],
    [`Don't Stop Me Now`, 'Queen', "https://music.amazon.com/search/Don't%20Stop%20Me%20Now%20Queen"],
    ['100%?', 'Artist+Name', 'https://music.amazon.com/search/100%25%3F%20Artist%2BName'],
    ['  Padded  ', '  ', 'https://music.amazon.com/search/Padded'],
  ])('(%j, %j)', (title, artist, url) => {
    expect(amazonSearchUrl({ kind: 'track', title, artist })).toBe(url);
  });

  it('builds the same URL for albums (album field is not part of the query)', () => {
    expect(amazonSearchUrl({ kind: 'album', title: 'Sahra', artist: 'Khaled', album: 'ignored' })).toBe(
      'https://music.amazon.com/search/Sahra%20Khaled',
    );
  });

  it('round-trips through URL parsing', () => {
    const url = new URL(amazonSearchUrl({ kind: 'track', title: 'a/b?c#d&e', artist: 'Ünïcødé' }));
    expect(url.host).toBe('music.amazon.com');
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
    expect(decodeURIComponent(url.pathname.replace('/search/', ''))).toBe('a/b?c#d&e Ünïcødé');
  });
});
