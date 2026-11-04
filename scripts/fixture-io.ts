// Shared by scripts/record-fixture.ts and scripts/smoke.ts (Node, run with type stripping).
// Writes one JSON file per upstream URL under test/fixtures/http/<host>/ so tests can replay them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

export const FIXTURE_DIR = join(import.meta.dirname, '..', 'test', 'fixtures', 'http');

// Only these headers matter to the code under test.
const KEEP_HEADERS = ['content-type', 'location'];

export function fixturePath(url: string): string {
  const u = new URL(url);
  const slug = (u.pathname + u.search)
    .replace(/^\/+/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, 100);
  const hash = createHash('sha1').update(u.toString()).digest('hex').slice(0, 8);
  return join(FIXTURE_DIR, u.host, `${slug || 'root'}_${hash}.json`);
}

/** Spotify pages are ~300KB; the code only reads <head> meta tags and the initialState script. */
export function trimBody(url: string, body: string): string {
  if (new URL(url).host !== 'open.spotify.com') return body;
  const headEnd = body.indexOf('</head>');
  const state = body.match(/<script id="initialState"[^>]*>[\s\S]*?<\/script>/);
  if (headEnd < 0) return body;
  return `${body.slice(0, headEnd + 7)}<body>${state ? state[0] : ''}</body></html>`;
}

export function writeFixture(url: string, status: number, headers: Headers, body: string): string {
  const keep: Record<string, string> = {};
  for (const h of KEEP_HEADERS) {
    const v = headers.get(h);
    if (v) keep[h] = v;
  }
  const path = fixturePath(url);
  mkdirSync(dirname(path), { recursive: true });
  const fixture = {
    request: { url: new URL(url).toString(), method: 'GET' },
    response: { status, headers: keep, body: trimBody(url, body) },
  };
  writeFileSync(path, JSON.stringify(fixture, null, 1) + '\n');
  return path;
}
