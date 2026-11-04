// Record upstream responses as test fixtures.
// Usage: npm run record -- <url> [<url> ...]
// Redirects are not followed (short-link tests need the 3xx itself). Apple MusicKit calls need a
// token and are recorded by `npm run smoke -- --record` instead.
import { writeFixture } from './fixture-io.ts';

const USER_AGENT = 'music-links/0.1 (+https://github.com/colecharb/music-links)';
const urls = process.argv.slice(2);
if (!urls.length) {
  console.error('usage: npm run record -- <url> [<url> ...]');
  process.exit(1);
}
for (const url of urls) {
  const res = await fetch(url, { redirect: 'manual', headers: { 'user-agent': USER_AGENT } });
  const body = await res.text();
  const path = writeFixture(url, res.status, res.headers, body);
  console.log(`${res.status} ${url}\n    -> ${path}`);
  // Be polite to upstream APIs.
  await new Promise((r) => setTimeout(r, 400));
}
