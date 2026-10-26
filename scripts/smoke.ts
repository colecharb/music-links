// Live smoke test: resolves every link in scripts/test-links.ts against the real upstream APIs and
// prints a markdown table per link per service.
//
//   npm run smoke                          # print the report
//   npm run smoke -- --out MATCH_REPORT.md  # also write it between the smoke markers in that file
//   npm run smoke -- --record              # also record every upstream response as a test fixture
//   npm run smoke -- <url> [<url> ...]      # only these links
//
// Upstream rate limits (iTunes allows ~20 requests/minute) are respected with a delay between links.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { startProxiedWorker } from './proxied-worker.ts';
import { TEST_LINKS, type TestLink } from './test-links.ts';

const SERVICES = ['spotify', 'apple', 'deezer', 'youtubeMusic', 'amazon'] as const;
const NAMES: Record<string, string> = {
  spotify: 'Spotify',
  apple: 'Apple Music',
  deezer: 'Deezer',
  youtubeMusic: 'YouTube Music',
  amazon: 'Amazon Music',
};
const BEGIN = '<!-- smoke:begin -->';
const END = '<!-- smoke:end -->';

const args = process.argv.slice(2);
const record = args.includes('--record');
const outIdx = args.indexOf('--out');
const outFile = outIdx >= 0 ? args[outIdx + 1] : undefined;
const only = args.filter((a) => /^https?:\/\//.test(a));
const links: TestLink[] = only.length ? only.map((url) => ({ url, why: 'ad hoc' })) : TEST_LINKS;
// iTunes allows ~20 requests/minute and a link can need up to 3 Apple calls.
const DELAY_MS = Number(process.env.SMOKE_DELAY_MS ?? 8000);
const PORT = Number(process.env.SMOKE_PORT ?? 8788);
const STATE = '.wrangler/smoke-state';

interface Item {
  title: string;
  artist: string;
  album?: string;
  durationMs?: number;
  url: string;
  trackCount?: number;
  releaseDate?: string;
}
interface Detail {
  match: string;
  outcome: string;
  via: string;
  url: string;
  item?: Item;
  score?: number;
  rejected?: { item: Item; score: number; reason?: string };
  note?: string;
  ms?: number;
}
interface Result {
  key: string;
  source: Item & { kind: string; isrc?: string; upc?: string };
  entry: { appleMode: string };
  details: Record<string, Detail>;
  ms: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dur = (ms?: number) => (ms == null ? '' : `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}`);
const cell = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const describe = (i?: Item) =>
  i ? `${i.title} — ${i.artist}${i.album ? ` (${i.album})` : ''}${i.trackCount ? ` [${i.trackCount} tracks]` : ''}` : '';

rmSync(STATE, { recursive: true, force: true });
execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'music_links', '--local', '--persist-to', STATE], {
  stdio: 'ignore',
  env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
});
const worker = await startProxiedWorker({ port: PORT, persist: STATE, record, vars: { DEBUG_API: '1' } });
const base = `http://127.0.0.1:${PORT}`;

const counts: Record<string, Record<string, number>> = Object.fromEntries(
  SERVICES.map((s) => [s, { source: 0, exact: 0, fuzzy: 0, search: 0, error: 0 }]),
);
const sections: string[] = [];
let appleMode = 'unknown';

for (const [i, link] of links.entries()) {
  if (i > 0) await sleep(DELAY_MS);
  const lines: string[] = [];
  const head = await fetch(`${base}/?u=${encodeURIComponent(link.url)}`, { redirect: 'manual' });
  const path = head.headers.get('location');
  if (!path) {
    sections.push(`### ${i + 1}. ${link.url}\n\n_${link.why}_\n\n**Parse failed** (HTTP ${head.status}).\n`);
    console.error(`[${i + 1}/${links.length}] parse failed: ${link.url}`);
    continue;
  }
  const res = await fetch(`${base}/api/resolve${path}`);
  if (!res.ok) {
    sections.push(`### ${i + 1}. ${link.url}\n\n_${link.why}_\n\n**Resolve failed** (HTTP ${res.status}): ${cell(await res.text())}\n`);
    console.error(`[${i + 1}/${links.length}] resolve failed: ${link.url}`);
    continue;
  }
  const r = (await res.json()) as Result;
  appleMode = r.entry.appleMode;

  const t0 = performance.now();
  const page = await fetch(`${base}${path}`);
  const html = await page.text();
  const pageMs = performance.now() - t0;

  const s = r.source;
  lines.push(`### ${i + 1}. ${cell(s.title)} — ${cell(s.artist)}`);
  lines.push('');
  lines.push(`_${link.why}_ · source \`${r.key}\` · ${link.url}`);
  lines.push('');
  const facts = [
    s.kind,
    s.album ? `album “${s.album}”` : '',
    s.durationMs ? `duration ${dur(s.durationMs)} (${s.durationMs} ms)` : 'duration unknown',
    s.trackCount ? `${s.trackCount} tracks` : '',
    s.releaseDate ? `released ${s.releaseDate}` : '',
    s.isrc ? `ISRC ${s.isrc}` : '',
    s.upc ? `UPC ${s.upc}` : '',
  ].filter(Boolean);
  lines.push(`Source: ${facts.join(' · ')}. Resolved in ${r.ms} ms; cached page in ${pageMs.toFixed(0)} ms (${html.length} bytes).`);
  lines.push('');
  lines.push('| Service | Match | Via | Matched item | Duration | Score | Note |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const svc of SERVICES) {
    const d = r.details[svc]!;
    const kind = d.via === 'source' ? 'source' : d.outcome;
    counts[svc]![kind] = (counts[svc]![kind] ?? 0) + 1;
    const shown = d.item ?? d.rejected?.item;
    const note = [d.rejected && !d.item ? `best rejected: ${describe(d.rejected.item)}` : '', d.note ?? ''].filter(Boolean).join(' — ');
    lines.push(
      `| ${NAMES[svc]} | ${kind === 'source' ? 'exact (source)' : d.outcome} | ${d.via} | ${cell(d.item ? describe(d.item) : '')} | ${dur(shown?.durationMs)} | ${d.score != null ? d.score.toFixed(2) : d.rejected ? d.rejected.score.toFixed(2) : ''} | ${cell(note)} |`,
    );
  }
  sections.push(lines.join('\n') + '\n');
  console.error(`[${i + 1}/${links.length}] ${s.title} — ${s.artist}: ${SERVICES.map((x) => `${x}=${r.details[x]!.outcome}`).join(' ')}`);
}

await worker.dispose();

const summary = [
  `Generated ${new Date().toISOString()} · ${links.length} links · Apple mode: **${appleMode}**${appleMode === 'itunes' ? ' (no MusicKit secrets: iTunes Search API, no ISRC lookups, degraded matching)' : ''}.`,
  '',
  '| Service | source | exact | fuzzy | search | error |',
  '|---|---|---|---|---|---|',
  ...SERVICES.map((s) => `| ${NAMES[s]} | ${['source', 'exact', 'fuzzy', 'search', 'error'].map((k) => counts[s]![k]).join(' | ')} |`),
  '',
].join('\n');
const report = `${summary}\n${sections.join('\n')}`;
console.log(report);

if (outFile) {
  const block = `${BEGIN}\n${report}\n${END}`;
  const current = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
  const next =
    current.includes(BEGIN) && current.includes(END)
      ? current.slice(0, current.indexOf(BEGIN)) + block + current.slice(current.indexOf(END) + END.length)
      : `${current}${current ? '\n' : ''}${block}\n`;
  writeFileSync(outFile, next);
  console.error(`wrote ${outFile}`);
}
