// Amazon Music has no public catalog API, so it is always linked through its web search.

import type { SearchQuery } from '../types';

export const AMAZON_MUSIC = 'https://music.amazon.com';

export function amazonSearchUrl(q: SearchQuery): string {
  const text = [q.title, q.artist].map((s) => s.trim()).filter(Boolean).join(' ');
  return `${AMAZON_MUSIC}/search/${encodeURIComponent(text)}`;
}
