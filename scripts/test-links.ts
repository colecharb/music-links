// Test set for scripts/smoke.ts (live) and the MATCH_REPORT. Add links here.
export interface TestLink {
  url: string;
  /** What the case exercises. */
  why: string;
}

export const TEST_LINKS: TestLink[] = [
  // From the brief.
  {
    url: 'https://open.spotify.com/track/2qQ3IRCPx3aESBFomT2n2N',
    why: 'Khaled: region-locked Spotify copy with multiple releases (studio, live, best-of)',
  },
  // Spotify sources.
  { url: 'https://open.spotify.com/track/7tFiyTwD0nx5a1eklYtX2J', why: 'remaster suffix, deluxe album' },
  { url: 'https://open.spotify.com/track/2Foc5Q5nqNiosCNqttzHof', why: 'radio edit + featured artists in brackets' },
  { url: 'https://open.spotify.com/track/6rPO02ozF3bM7NnOV4h6s2', why: 'remix with a featured artist' },
  { url: 'https://open.spotify.com/track/03UrZgTINDqvnUMbbIMhql', why: 'mixed Latin/Hangul title' },
  { url: 'https://open.spotify.com/track/6mpyO7bJaCrHzE0iQEtZiN', why: 'live version: must not match the studio recording' },
  { url: 'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b', why: 'very popular track with many alternate versions' },
  { url: 'https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa', why: 'album' },
  { url: 'https://open.spotify.com/album/5eA0qtE7Yu29XiMlwoby2G', why: 'super deluxe edition (75 tracks)' },
  // Apple Music sources.
  {
    url: 'https://music.apple.com/us/album/where-did-you-sleep-last-night-live-acoustic/1440892370?i=1440893075',
    why: 'Apple track via album ?i= URL, live acoustic',
  },
  { url: 'https://music.apple.com/us/album/sahra/1444129774', why: 'Apple album, non-English' },
  // Deezer sources.
  { url: 'https://www.deezer.com/track/824731152', why: 'Japanese title (non-Latin)' },
  { url: 'https://www.deezer.com/en/track/448260732', why: 'Cyrillic title, same title exists in another version' },
  { url: 'https://www.deezer.com/track/4304169612', why: 'recent release (2026-09-25)' },
  { url: 'https://www.deezer.com/track/96996588', why: 'obscure track, "Cheikha" honorific' },
  { url: 'https://www.deezer.com/album/1002561451', why: 'recent album (2026-06-12)' },
  // YouTube sources.
  { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', why: 'official video title noise, no duration' },
  { url: 'https://music.youtube.com/watch?v=lYBUbBu4W08', why: 'YouTube Music " - Topic" channel' },
];
