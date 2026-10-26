// Server-rendered pages. Each page is one small self-contained response: inline CSS, and on the
// share page one tiny inline script. Every interpolation goes through hono/html, which escapes it.
import { html, raw } from 'hono/html';
import { CODE_BY_KIND, SERVICE_NAMES, SERVICES } from './types';
import type { ResolvedEntry, Service, ServiceLink, SourceRef } from './types';

type Html = ReturnType<typeof html>;

export const SITE_NAME = 'music-links';
/** Rendered art size; the img carries it as width/height so the layout never shifts. */
export const ART_SIZE_PX = 300;
/** Link previews cut long descriptions anyway; keep ours whole. */
export const MAX_DESCRIPTION_CHARS = 200;
export const THEME_COLOR_LIGHT = '#ffffff';
export const THEME_COLOR_DARK = '#121212';
export const COPIED_LABEL_MS = 1500;
export const HOME_PLACEHOLDER = 'Paste a Spotify, Apple Music, Deezer or YouTube link';
export const SEP = ' · ';
export const LISTEN_ON = `Listen on ${SERVICES.map((s) => SERVICE_NAMES[s]).join(', ')}`;

export interface SharePageOptions {
  entry: ResolvedEntry;
  ref: SourceRef;
  canonicalUrl: string;
  /** absolute origin, e.g. https://example.com */
  origin: string;
}

export interface ServiceButton {
  service: Service;
  href: string;
  label: string;
  direct: boolean;
}

const CSS = `:root{--bg:${THEME_COLOR_LIGHT};--fg:#111;--mut:#5f6368;--line:#d0d3d7;--btn:#111;--btnfg:#fff}
@media(prefers-color-scheme:dark){:root{--bg:${THEME_COLOR_DARK};--fg:#f1f1f1;--mut:#a0a4a8;--line:#3a3d40;--btn:#f1f1f1;--btnfg:#111}}
*{box-sizing:border-box}[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-text-size-adjust:100%}
main{max-width:440px;margin:0 auto;padding:24px 16px 32px;text-align:center}
h1{font-size:1.5rem;line-height:1.2;margin:0}
h1,p,.btn{overflow-wrap:anywhere}
p{margin:6px 0 0}
a{color:inherit}
.art{display:block;width:100%;max-width:${ART_SIZE_PX}px;height:auto;aspect-ratio:1;margin:0 auto 20px;border-radius:8px;background:var(--line);object-fit:cover}
.artist{font-size:1.1rem}
.mut,.album{color:var(--mut)}.album{font-size:.875rem}
ul{list-style:none;margin:24px 0 0;padding:0;display:grid;gap:10px}
.btn{display:block;width:100%;padding:14px 16px;border:2px solid var(--btn);border-radius:12px;background:var(--btn);color:var(--btnfg);font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
.alt{background:none;border-color:var(--line);color:var(--mut);font-weight:500}
.tools{margin-top:24px;font-size:.875rem}
.copy{padding:8px 16px;border:1px solid var(--line);border-radius:999px;background:none;color:var(--fg);font:inherit;cursor:pointer}
.small{margin-top:16px;font-size:.875rem;color:var(--mut)}
footer{margin-top:32px;font-size:.75rem;color:var(--mut)}
form{margin-top:24px;display:grid;gap:12px}
input{width:100%;padding:14px 16px;border:2px solid var(--line);border-radius:12px;background:none;color:var(--fg);font:inherit;text-align:left}
.err{margin:0;color:#c5221f}@media(prefers-color-scheme:dark){.err{color:#f28b82}}
a:focus-visible,button:focus-visible,input:focus-visible{outline:3px solid #4c8bf5;outline-offset:2px}`;

// The copy button is hidden until this runs, so without JS there is no dead control.
const COPY_SCRIPT = `(function(){var b=document.getElementById('copy');if(!b)return;var t=b.textContent,u=b.getAttribute('data-url');b.hidden=false;b.onclick=function(){function done(){b.textContent='Copied';setTimeout(function(){b.textContent=t},${COPIED_LABEL_MS})}function ask(){prompt('Copy this link:',u)}if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(u).then(done,ask);else ask()}})()`;

export function isDirect(link: ServiceLink): boolean {
  return link.match === 'exact' || link.match === 'fuzzy';
}

/** The share page's button target: the go route records the visitor's choice, then redirects. */
export function goPath(service: Service, ref: SourceRef): string {
  return `/go/${service}/${ref.platform}/${CODE_BY_KIND[ref.kind]}/${encodeURIComponent(ref.id)}`;
}

/** Direct links first (in SERVICES order), then search fallbacks (in SERVICES order). */
export function serviceButtons(entry: ResolvedEntry, ref: SourceRef): ServiceButton[] {
  const all = SERVICES.map((service) => {
    const direct = isDirect(entry.links[service]);
    const name = SERVICE_NAMES[service];
    return { service, href: goPath(service, ref), label: direct ? name : `Search on ${name}`, direct };
  });
  return [...all.filter((b) => b.direct), ...all.filter((b) => !b.direct)];
}

/** "Title — Artist" */
export function displayTitle(entry: ResolvedEntry): string {
  return `${entry.title} — ${entry.artist}`;
}

/** Album line for tracks; omitted for singles whose release shares the track's title. */
export function albumLine(entry: ResolvedEntry): string | undefined {
  const album = entry.kind === 'track' ? entry.album?.trim() : undefined;
  if (!album || album.toLowerCase() === entry.title.trim().toLowerCase()) return undefined;
  return album;
}

/** Tracks: "Song · Album · Year · Listen on …"; albums: "Album · Year · Listen on …". */
export function describeEntry(entry: ResolvedEntry): string {
  const label = entry.kind === 'track' ? 'Song' : 'Album';
  const year = validYear(entry.releaseYear);
  const album = albumLine(entry);
  const fixed = [label, year, LISTEN_ON].filter((p): p is string => !!p);
  if (!album) return fixed.join(SEP);
  // Only the album name is free text of unbounded length; shorten it to fit.
  const budget = MAX_DESCRIPTION_CHARS - fixed.join(SEP).length - SEP.length;
  return [label, truncate(album, budget), year, LISTEN_ON].filter((p): p is string => !!p).join(SEP);
}

export async function renderSharePage(o: SharePageOptions): Promise<string> {
  const { entry, ref, canonicalUrl, origin } = o;
  const title = displayTitle(entry);
  const description = describeEntry(entry);
  const art = safeHttpUrl(entry.art);
  const artAlt = `Cover art for ${entry.title} by ${entry.artist}`;
  const album = albumLine(entry);

  const head = html`<meta name="description" content="${description}">
<link rel="canonical" href="${canonicalUrl}">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:type" content="${entry.kind === 'track' ? 'music.song' : 'music.album'}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${canonicalUrl}">
${art ? html`<meta property="og:image" content="${art}">
<meta property="og:image:alt" content="${artAlt}">
` : ''}<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
${art ? html`<meta name="twitter:image" content="${art}">
<meta name="twitter:image:alt" content="${artAlt}">
` : ''}`;

  const body = html`${art
    ? html`<img class="art" src="${art}" width="${ART_SIZE_PX}" height="${ART_SIZE_PX}" alt="${artAlt}" decoding="async" fetchpriority="high">`
    : html`<div class="art" aria-hidden="true"></div>`}
<h1>${entry.title}</h1>
<p class="artist">${entry.artist}</p>
${album ? html`<p class="album">${album}</p>` : ''}
<ul>
${serviceButtons(entry, ref).map(
  (b) => html`<li><a class="${b.direct ? 'btn' : 'btn alt'}" href="${b.href}" rel="nofollow">${b.label}</a></li>
`,
)}</ul>
<p class="tools"><button type="button" id="copy" class="copy" data-url="${canonicalUrl}" hidden>Copy link</button></p>
<p class="small"><a href="${withStay(canonicalUrl)}">Choose a different service</a></p>
<footer><a href="${origin}/">${SITE_NAME}</a></footer>
<script>${raw(COPY_SCRIPT)}</script>`;

  return layout({ title, head, body });
}

export async function renderHomePage(o: { error?: string; value?: string } = {}): Promise<string> {
  const head = html`<meta name="description" content="Paste a song or album link and get one link that opens on every music service.">
<meta property="og:title" content="${SITE_NAME}">
<meta property="og:description" content="One link for every music service.">`;
  const body = html`<h1>${SITE_NAME}</h1>
<p class="mut">One link for every music service.</p>
<form method="get" action="/">
<input name="u" type="text" inputmode="url" placeholder="${HOME_PLACEHOLDER}" aria-label="Song or album link" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" autofocus required${o.value ? html` value="${o.value}"` : ''}${o.error ? raw(' aria-invalid="true" aria-describedby="err"') : ''}>
${o.error ? html`<p id="err" class="err" role="alert">${o.error}</p>
` : ''}<button type="submit" class="btn">Get links</button>
</form>`;
  return layout({ title: SITE_NAME, head, body });
}

export async function renderErrorPage(o: { status: number; title: string; message: string }): Promise<string> {
  const head = html`<meta name="robots" content="noindex">`;
  // Server-side failures are often transient: offer a reload of the same URL.
  const retry = o.status >= 500 ? html`<a class="btn" href="">Try again</a>` : '';
  const body = html`<p class="mut">${o.status}</p>
<h1>${o.title}</h1>
<p>${o.message}</p>
<ul>${retry ? html`<li>${retry}</li>` : ''}<li><a class="btn alt" href="/">Paste another link</a></li></ul>`;
  return layout({ title: `${o.title} · ${SITE_NAME}`, head, body });
}

async function layout(o: { title: string; head: Html; body: Html }): Promise<string> {
  const page = html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="${THEME_COLOR_LIGHT}" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="${THEME_COLOR_DARK}" media="(prefers-color-scheme: dark)">
<title>${o.title}</title>
${o.head}
<style>${raw(CSS)}</style>
</head>
<body>
<main>
${o.body}
</main>
</body>
</html>`;
  return String(await page);
}

function withStay(url: string): string {
  return url + (url.includes('?') ? '&stay' : '?stay');
}

function validYear(y: number | undefined): string | undefined {
  return y !== undefined && Number.isInteger(y) && y > 0 ? String(y) : undefined;
}

/** Shorten to at most `max` code points, ending with an ellipsis. */
function truncate(s: string, max: number): string {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return chars.slice(0, Math.max(0, max - 1)).join('').trimEnd() + '…';
}

/** Only absolute http(s) URLs reach src/content attributes. */
function safeHttpUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const p = new URL(u).protocol;
    return p === 'https:' || p === 'http:' ? u : undefined;
  } catch {
    return undefined;
  }
}
