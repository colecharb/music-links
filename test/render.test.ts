import { describe, expect, it } from 'vitest';
import {
  LISTEN_ON,
  MAX_DESCRIPTION_CHARS,
  renderErrorPage,
  renderHomePage,
  renderSharePage,
  type SharePageOptions,
} from '../src/render';
import type { MatchType, ResolvedEntry, Service, SourceRef } from '../src/types';

const ORIGIN = 'https://links.example';
const SP_ID = '2qQ3IRCPx3aESBFomT2n2N';
const TRACK_REF: SourceRef = { platform: 'sp', kind: 'track', id: SP_ID };
const ALBUM_REF: SourceRef = { platform: 'am', kind: 'album', id: '1444129774' };

function links(m: Record<Service, MatchType>): ResolvedEntry['links'] {
  const url = (s: Service) => (m[s] === 'search' ? `https://search.example/${s}?q=x` : `https://direct.example/${s}/1`);
  return {
    spotify: { url: url('spotify'), match: m.spotify },
    apple: { url: url('apple'), match: m.apple },
    deezer: { url: url('deezer'), match: m.deezer },
    youtubeMusic: { url: url('youtubeMusic'), match: m.youtubeMusic },
    amazon: { url: url('amazon'), match: m.amazon },
  };
}

const TRACK: ResolvedEntry = {
  kind: 'track',
  title: 'Ouelli El Darek',
  artist: 'Khaled',
  album: 'Sahra',
  durationMs: 189360,
  releaseYear: 1996,
  art: 'https://i.scdn.co/image/ab67616d0000b273e1b1864f0ac9fc86215c3c85',
  resolvedAt: '2026-10-26T00:00:00.000Z',
  appleMode: 'itunes',
  links: links({ spotify: 'exact', apple: 'search', deezer: 'fuzzy', youtubeMusic: 'search', amazon: 'exact' }),
};

const ALBUM: ResolvedEntry = {
  kind: 'album',
  title: 'Random Access Memories',
  artist: 'Daft Punk',
  releaseYear: 2013,
  upc: '886443927087',
  art: 'https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/e8/43/5f/e8435ffa-b6b9-b171-40ab-4ff3959ab661/886443919266.jpg/600x600bb.jpg',
  resolvedAt: '2026-10-26T00:00:00.000Z',
  appleMode: 'musickit',
  links: links({ spotify: 'exact', apple: 'exact', deezer: 'exact', youtubeMusic: 'fuzzy', amazon: 'search' }),
};

function share(entry: ResolvedEntry, ref = TRACK_REF, extra: Partial<SharePageOptions> = {}) {
  const canonicalUrl = `${ORIGIN}/${ref.platform}/${ref.kind === 'track' ? 't' : 'a'}/${ref.id}`;
  return renderSharePage({ entry, ref, canonicalUrl, origin: ORIGIN, ...extra });
}

interface El {
  attrs: Record<string, string>;
  text: string;
}

/** Parse with workerd's streaming HTML parser; attribute values and text are entity-decoded. */
async function select(page: string, selector: string): Promise<El[]> {
  const out: El[] = [];
  let current: El | undefined;
  await new HTMLRewriter()
    .on(selector, {
      element(e) {
        current = { attrs: Object.fromEntries(e.attributes), text: '' };
        out.push(current);
      },
      text(t) {
        if (current) current.text += t.text;
      },
    })
    .transform(new Response(page))
    .text();
  return out.map((el) => ({
    attrs: Object.fromEntries(Object.entries(el.attrs).map(([k, v]) => [k, decode(v)])),
    text: decode(el.text),
  }));
}

/** lol-html hands over raw source text; undo the five escapes hono/html produces. */
function decode(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

async function attr(page: string, selector: string, name: string): Promise<string | undefined> {
  return (await select(page, selector))[0]?.attrs[name];
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe('share page head', () => {
  it.each([
    ['meta[property="og:title"]', 'content', 'Ouelli El Darek — Khaled'],
    ['meta[property="og:description"]', 'content', `Song · Sahra · 1996 · ${LISTEN_ON}`],
    ['meta[property="og:type"]', 'content', 'music.song'],
    ['meta[property="og:url"]', 'content', `${ORIGIN}/sp/t/${SP_ID}`],
    ['meta[property="og:site_name"]', 'content', 'music-links'],
    ['meta[property="og:image"]', 'content', TRACK.art],
    ['meta[property="og:image:alt"]', 'content', 'Cover art for Ouelli El Darek by Khaled'],
    ['meta[name="twitter:card"]', 'content', 'summary'],
    ['meta[name="twitter:title"]', 'content', 'Ouelli El Darek — Khaled'],
    ['meta[name="twitter:description"]', 'content', `Song · Sahra · 1996 · ${LISTEN_ON}`],
    ['meta[name="twitter:image"]', 'content', TRACK.art],
    ['meta[name="description"]', 'content', `Song · Sahra · 1996 · ${LISTEN_ON}`],
    ['link[rel="canonical"]', 'href', `${ORIGIN}/sp/t/${SP_ID}`],
    ['meta[name="viewport"]', 'content', 'width=device-width,initial-scale=1'],
    ['meta[name="color-scheme"]', 'content', 'light dark'],
  ])('%s %s', async (selector, name, expected) => {
    const page = await share(TRACK);
    const found = await select(page, selector);
    expect(found).toHaveLength(1);
    expect(found[0]?.attrs[name]).toBe(expected);
  });

  it('has the title and a theme color per scheme', async () => {
    const page = await share(TRACK);
    expect((await select(page, 'title'))[0]?.text).toBe('Ouelli El Darek — Khaled');
    const themes = await select(page, 'meta[name="theme-color"]');
    expect(themes.map((t) => t.attrs.media)).toEqual(['(prefers-color-scheme: light)', '(prefers-color-scheme: dark)']);
    expect(themes.every((t) => /^#[0-9a-f]{6}$/i.test(t.attrs.content ?? ''))).toBe(true);
    expect(page.startsWith('<!doctype html>')).toBe(true);
  });

  it('describes albums and uses album types', async () => {
    const page = await share(ALBUM, ALBUM_REF);
    expect(await attr(page, 'meta[property="og:type"]', 'content')).toBe('music.album');
    expect(await attr(page, 'meta[property="og:description"]', 'content')).toBe(`Album · 2013 · ${LISTEN_ON}`);
    expect(await attr(page, 'meta[property="og:title"]', 'content')).toBe('Random Access Memories — Daft Punk');
  });

  it.each<[string, Partial<ResolvedEntry>, string]>([
    ['no album, no year', { album: undefined, releaseYear: undefined }, `Song · ${LISTEN_ON}`],
    ['no year', { releaseYear: undefined }, `Song · Sahra · ${LISTEN_ON}`],
    ['no album', { album: undefined }, `Song · 1996 · ${LISTEN_ON}`],
    ['single named like the track', { album: 'ouelli el darek ' }, `Song · 1996 · ${LISTEN_ON}`],
  ])('omits missing parts (%s)', async (_, patch, expected) => {
    const page = await share({ ...TRACK, ...patch });
    expect(await attr(page, 'meta[property="og:description"]', 'content')).toBe(expected);
  });

  it('shortens a long album name to keep the description under the limit', async () => {
    const album = 'Live at the Royal Albert Hall, London, 12 November 2019 (Deluxe Edition) '.repeat(4).trim();
    const page = await share({ ...TRACK, album });
    const description = (await attr(page, 'meta[property="og:description"]', 'content')) ?? '';
    expect(Array.from(description).length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
    expect(description).toMatch(/^Song · Live at the Royal Albert Hall.*… · 1996 · Listen on /);
    expect(description.endsWith(LISTEN_ON)).toBe(true);
  });

  it.each([
    ['absent', undefined],
    ['not http(s)', 'javascript:alert(1)'],
    ['not a URL', 'cover.jpg'],
  ])('omits image tags when art is %s, keeping a same-size placeholder', async (_, art) => {
    const page = await share({ ...TRACK, art });
    expect(await select(page, 'meta[property="og:image"]')).toHaveLength(0);
    expect(await select(page, 'meta[property="og:image:alt"]')).toHaveLength(0);
    expect(await select(page, 'meta[name="twitter:image"]')).toHaveLength(0);
    expect(await select(page, 'img')).toHaveLength(0);
    expect(await select(page, 'div.art[aria-hidden="true"]')).toHaveLength(1);
    expect(page).not.toContain('javascript:');
  });
});

describe('share page body', () => {
  it('renders art without layout shift', async () => {
    const [img] = await select(await share(TRACK), 'img');
    expect(img?.attrs).toMatchObject({
      src: TRACK.art,
      width: '300',
      height: '300',
      alt: 'Cover art for Ouelli El Darek by Khaled',
      decoding: 'async',
      fetchpriority: 'high',
    });
    expect(await share(TRACK)).toMatch(/\.art\{[^}]*aspect-ratio:1/);
  });

  it('shows title, artist and a muted album line', async () => {
    const page = await share(TRACK);
    expect((await select(page, 'h1'))[0]?.text).toBe('Ouelli El Darek');
    expect((await select(page, 'p.artist'))[0]?.text).toBe('Khaled');
    expect((await select(page, 'p.album'))[0]?.text).toBe('Sahra');
  });

  it('has no album line for albums', async () => {
    expect(await select(await share({ ...ALBUM, album: 'ignored' }, ALBUM_REF), 'p.album')).toHaveLength(0);
  });

  it('orders direct links first, then search fallbacks, each in service order', async () => {
    const buttons = await select(await share(TRACK), 'ul a');
    expect(buttons.map((b) => [b.text, b.attrs.href, b.attrs.class, b.attrs.rel])).toEqual([
      ['Spotify', `/go/spotify/sp/t/${SP_ID}`, 'btn', 'nofollow'],
      ['Deezer', `/go/deezer/sp/t/${SP_ID}`, 'btn', 'nofollow'],
      ['Amazon Music', `/go/amazon/sp/t/${SP_ID}`, 'btn', 'nofollow'],
      ['Search on Apple Music', `/go/apple/sp/t/${SP_ID}`, 'btn alt', 'nofollow'],
      ['Search on YouTube Music', `/go/youtubeMusic/sp/t/${SP_ID}`, 'btn alt', 'nofollow'],
    ]);
  });

  it('builds go links from the ref (album code a)', async () => {
    const buttons = await select(await share(ALBUM, ALBUM_REF), 'ul a');
    expect(buttons.map((b) => b.attrs.href)).toEqual([
      '/go/spotify/am/a/1444129774',
      '/go/apple/am/a/1444129774',
      '/go/deezer/am/a/1444129774',
      '/go/youtubeMusic/am/a/1444129774',
      '/go/amazon/am/a/1444129774',
    ]);
    expect(buttons.at(-1)?.text).toBe('Search on Amazon Music');
  });

  it('never exposes service URLs directly (all buttons go through the go route)', async () => {
    const page = await share(TRACK);
    expect(page).not.toContain('direct.example');
    expect(page).not.toContain('search.example');
  });

  it('has a copy button that is revealed and wired by the only script', async () => {
    const page = await share(TRACK);
    const [button] = await select(page, 'button#copy');
    expect(button?.attrs['data-url']).toBe(`${ORIGIN}/sp/t/${SP_ID}`);
    expect(button?.attrs.type).toBe('button');
    expect(button?.attrs).toHaveProperty('hidden');
    expect(button?.text).toBe('Copy link');
    const scripts = await select(page, 'script');
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.attrs).toEqual({});
    const js = scripts[0]?.text ?? '';
    expect(js).toContain('navigator.clipboard.writeText');
    expect(js).toContain('prompt(');
    expect(js).toContain("'Copied'");
    expect(js).toContain('b.hidden=false');
    expect(() => new Function(js)).not.toThrow();
  });

  it('links to the page with ?stay to choose a different service', async () => {
    const page = await share(TRACK);
    const stay = (await select(page, 'a')).find((a) => a.text === 'Choose a different service');
    expect(stay?.attrs.href).toBe(`${ORIGIN}/sp/t/${SP_ID}?stay`);
  });

  it('escapes all interpolated text', async () => {
    const evil: ResolvedEntry = {
      ...TRACK,
      title: `</title><script>alert("x")</script> & 'q'`,
      artist: `A "B" & <C>`,
      album: '<b>bold</b>',
      art: 'https://img.example/a.jpg?x="><script>alert(1)</script>',
    };
    const canonicalUrl = `${ORIGIN}/sp/t/a"onmouseover="alert(1)`;
    const page = await share(evil, TRACK_REF, { canonicalUrl });
    expect(page.match(/<script/g)).toHaveLength(1);
    expect(page).not.toContain('<b>');
    expect(page).not.toContain('"onmouseover=');
    expect(page).toContain('&lt;/title&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;');
    expect((await select(page, 'h1'))[0]?.text).toBe(evil.title);
    expect((await select(page, 'p.artist'))[0]?.text).toBe(evil.artist);
    expect((await select(page, 'p.album'))[0]?.text).toBe(evil.album);
    expect(await attr(page, 'meta[property="og:title"]', 'content')).toBe(`${evil.title} — ${evil.artist}`);
    expect(await attr(page, 'img', 'src')).toBe(evil.art);
    expect(await attr(page, 'button#copy', 'data-url')).toBe(canonicalUrl);
  });

  it('stays under 15KB for a realistic entry with long titles', async () => {
    const entry: ResolvedEntry = {
      kind: 'track',
      title:
        'Symphony No. 9 in D Minor, Op. 125 "Choral": IV. Presto – Allegro assai – "O Freunde, nicht diese Töne!" – Allegro assai vivace (Alla marcia) (Live at Philharmonie, Berlin / 2023 Remaster)',
      artist:
        'Berliner Philharmoniker, Kirill Petrenko, Marlis Petersen, Elisabeth Kulman, Benjamin Bruns, Kwangchul Youn & Rundfunkchor Berlin',
      album:
        'Beethoven: Complete Symphonies & Overtures (Live at Philharmonie, Berlin, 2019–2023) [Deluxe Edition with Rehearsal Recordings]',
      durationMs: 1_404_000,
      releaseYear: 2023,
      isrc: 'DEF052310009',
      art: 'https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/12/34/56/12345678-90ab-cdef-1234-567890abcdef/23UMGIM12345.rgb.jpg/600x600bb.jpg',
      explicit: false,
      resolvedAt: '2026-10-26T00:00:00.000Z',
      appleMode: 'musickit',
      links: links({ spotify: 'fuzzy', apple: 'exact', deezer: 'search', youtubeMusic: 'search', amazon: 'search' }),
    };
    const page = await share(entry, { platform: 'am', kind: 'track', id: '1712345678' });
    expect(bytes(page)).toBeLessThan(15000);
  });
});

describe('home page', () => {
  it('renders a single GET form with one text input', async () => {
    const page = await renderHomePage();
    const forms = await select(page, 'form');
    expect(forms).toHaveLength(1);
    expect(forms[0]?.attrs).toMatchObject({ method: 'get', action: '/' });
    const inputs = await select(page, 'input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.attrs).toMatchObject({
      name: 'u',
      type: 'text',
      inputmode: 'url',
      placeholder: 'Paste a song or album link',
    });
    expect(inputs[0]?.attrs).toHaveProperty('autofocus');
    expect(inputs[0]?.attrs).toHaveProperty('required');
    expect(inputs[0]?.attrs).not.toHaveProperty('value');
    expect(await select(page, 'button[type="submit"]')).toHaveLength(1);
    expect(await select(page, '[role="alert"]')).toHaveLength(0);
    expect(await select(page, 'script')).toHaveLength(0);
    expect(await select(page, 'meta[name="color-scheme"]')).toHaveLength(1);
  });

  it('shows an error and keeps the submitted value, escaped', async () => {
    const value = `https://example.com/"><script>alert(1)</script>`;
    const page = await renderHomePage({ error: `That's not a <supported> link.`, value });
    const alerts = await select(page, '[role="alert"]');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.text).toBe(`That's not a <supported> link.`);
    expect(await attr(page, 'input', 'value')).toBe(value);
    expect(await attr(page, 'input', 'aria-describedby')).toBe(alerts[0]?.attrs.id);
    expect(page).not.toContain('<script');
    expect(page).not.toContain('<supported>');
  });
});

describe('error page', () => {
  it('shows the status, title and message with a link home', async () => {
    const page = await renderErrorPage({ status: 404, title: 'Not found', message: "We couldn't find that song on Spotify." });
    expect((await select(page, 'title'))[0]?.text).toBe('Not found · music-links');
    expect((await select(page, 'h1'))[0]?.text).toBe('Not found');
    expect(page).toContain('404');
    expect((await select(page, 'p')).map((p) => p.text)).toContain("We couldn't find that song on Spotify.");
    expect((await select(page, 'a')).map((a) => a.attrs.href)).toEqual(['/']);
    expect(await attr(page, 'meta[name="robots"]', 'content')).toBe('noindex');
  });

  it('offers a retry for server-side failures', async () => {
    const page = await renderErrorPage({ status: 502, title: 'Try again', message: 'Upstream is down.' });
    const anchors = await select(page, 'a');
    expect(anchors.map((a) => [a.text, a.attrs.href])).toEqual([
      ['Try again', ''],
      ['Paste another link', '/'],
    ]);
  });

  it('escapes its text', async () => {
    const page = await renderErrorPage({ status: 500, title: '<i>x</i>', message: '"a" & <b>' });
    expect(page).not.toContain('<i>');
    expect(page).not.toContain('<b>');
    expect((await select(page, 'h1'))[0]?.text).toBe('<i>x</i>');
  });
});
