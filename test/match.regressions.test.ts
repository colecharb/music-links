// Cases found by the live smoke run (scripts/smoke.ts), kept as regressions.
import { describe, expect, it } from 'vitest';
import { pickBestTrack, scoreTrack } from '../src/match';
import { buildQuery } from '../src/resolve';
import type { TrackMeta } from '../src/types';

const track = (t: Partial<TrackMeta> & { title: string; artist: string }): TrackMeta => ({
  kind: 'track',
  id: t.title,
  url: `https://example.com/${encodeURIComponent(t.title)}`,
  artists: [t.artist],
  ...t,
});

describe('no duration (YouTube sources)', () => {
  const source = track({ title: 'Never Gonna Give You Up', artist: 'Rick Astley' });

  it('rejects a title that only matches once an unrecognized bracket group is stripped', () => {
    // Deezer had no copy of the original in this region; its only Rick Astley candidate was the 2023 piano version.
    const piano = track({
      title: 'Never Gonna Give You Up (Pianoforte)',
      artist: 'Rick Astley',
      album: 'Never Gonna Give You Up (Pianoforte)',
      durationMs: 213000,
      durationPrecisionMs: 1000,
    });
    expect(scoreTrack(source, piano).reject).toMatch(/title/);
    expect(pickBestTrack(source, [piano]).accepted).toBeNull();
  });

  it('still accepts the exact title', () => {
    const original = track({ title: 'Never Gonna Give You Up', artist: 'Rick Astley', album: 'Whenever You Need Somebody', durationMs: 213573 });
    expect(pickBestTrack(source, [original]).accepted?.item).toBe(original);
  });

  it('accepts a stripped bracket group when both durations confirm it', () => {
    const src = track({ title: 'Gangnam Style (강남스타일)', artist: 'PSY', durationMs: 219493 });
    const cand = track({ title: 'Gangnam Style', artist: 'PSY', durationMs: 219000, durationPrecisionMs: 1000 });
    expect(scoreTrack(src, cand).reject).toBeUndefined();
  });
});

describe('search queries', () => {
  it('carries the other credited artists, last one being the featured artist', () => {
    const q = buildQuery(track({ title: 'Despacito - Remix', artist: 'Luis Fonsi, Daddy Yankee, Justin Bieber', artists: ['Luis Fonsi', 'Daddy Yankee', 'Justin Bieber'] }));
    expect(q).toMatchObject({ title: 'despacito remix', artist: 'Luis Fonsi', credits: ['Daddy Yankee', 'Justin Bieber'] });
  });

  it('adds featured artists from the title', () => {
    const q = buildQuery(track({ title: 'Get Lucky (feat. Pharrell Williams)', artist: 'Daft Punk' }));
    expect(q.credits).toEqual(['pharrell williams']);
  });

  it('has no credits for a single artist', () => {
    expect(buildQuery(track({ title: 'Blinding Lights', artist: 'The Weeknd' })).credits).toBeUndefined();
  });
});

describe('compilation bundles', () => {
  it('prefers the original album over a multi-album bundle with the same recording', () => {
    // Live run: Apple returned the same 1987 recording on "3 Originals" first, tied with the original album.
    const source = track({ title: 'Never Gonna Give You Up', artist: 'Rick Astley' });
    const bundle = track({ title: 'Never Gonna Give You Up', artist: 'Rick Astley', album: '3 Originals', durationMs: 214720 });
    const original = track({ title: 'Never Gonna Give You Up', artist: 'Rick Astley', album: 'Whenever You Need Somebody', durationMs: 213573 });
    expect(pickBestTrack(source, [bundle, original]).accepted?.item).toBe(original);
  });
});
