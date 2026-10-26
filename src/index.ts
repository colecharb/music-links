import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { UpstreamError, UPSTREAM_TIMEOUT_MS, type FetchFn, type UpstreamCtx } from './http';
import { cacheKey, canonicalPath, extractUrlFromPath, parseInput, refFromParams } from './parse';
import { renderErrorPage, renderHomePage, renderSharePage } from './render';
import { resolveRef, type ResolveResult } from './resolve';
import { getAppleAuth } from './sources/apple';
import { logMisses, readEntry, writeEntry } from './store';
import type { AppEnv, ResolvedEntry, Service, SourceRef } from './types';
import { isDirect, SERVICE_NAMES, SERVICES } from './types';

export interface AppDeps {
  /** Upstream fetch; tests inject recorded fixtures. */
  fetch?: FetchFn;
}

type C = Context<{ Bindings: AppEnv }>;

const PREF_COOKIE = 'pref';
const PREF_MAX_AGE_S = 365 * 24 * 3600;
/** Recently resolved entries kept in isolate memory: KV writes land asynchronously, and the
 *  button click that follows a page view must not trigger a second resolution. */
const MEMORY_TTL_MS = 5 * 60 * 1000;
const MEMORY_MAX = 500;

const PLATFORM_NAMES: Record<SourceRef['platform'], string> = {
  sp: SERVICE_NAMES.spotify,
  am: SERVICE_NAMES.apple,
  dz: SERVICE_NAMES.deezer,
  yt: 'YouTube',
};

export function createApp(deps: AppDeps = {}) {
  const app = new Hono<{ Bindings: AppEnv }>();
  const memory = new Map<string, { entry: ResolvedEntry; at: number }>();
  const inflight = new Map<string, Promise<ResolveResult>>();

  async function upstream(c: C): Promise<UpstreamCtx> {
    const country = (c.req.raw as { cf?: { country?: unknown } }).cf?.country;
    return {
      fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      apple: await getAppleAuth(c.env),
      storefront: typeof country === 'string' && /^[a-z]{2}$/i.test(country) ? country.toLowerCase() : 'us',
    };
  }

  function remember(key: string, entry: ResolvedEntry) {
    if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value as string);
    memory.set(key, { entry, at: Date.now() });
  }

  /** Resolve once per key per isolate at a time; persist the result in the background. */
  async function resolveAndStore(c: C, ref: SourceRef): Promise<ResolveResult> {
    const key = cacheKey(ref);
    let p = inflight.get(key);
    if (!p) {
      p = upstream(c)
        .then((ctx) => resolveRef(ctx, ref))
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
      p.then(
        (result) => {
          remember(key, result.entry);
          background(c, writeEntry(c.env.LINKS, key, result.entry));
          background(c, logMisses(c.env.DB, result.misses));
        },
        () => {},
      );
    }
    return p;
  }

  async function getEntry(c: C, ref: SourceRef): Promise<ResolvedEntry> {
    const key = cacheKey(ref);
    const mem = memory.get(key);
    if (mem && Date.now() - mem.at < MEMORY_TTL_MS) return mem.entry;
    const cached = await readEntry(c.env.LINKS, key);
    if (cached) {
      remember(key, cached);
      return cached;
    }
    return (await resolveAndStore(c, ref)).entry;
  }

  async function failurePage(c: C, ref: SourceRef, err: unknown) {
    const where = PLATFORM_NAMES[ref.platform];
    const what = ref.kind === 'track' ? 'song' : 'album';
    if (err instanceof UpstreamError && err.status === 404) {
      return c.html(
        await renderErrorPage({ status: 404, title: 'Not found', message: `We couldn't find that ${what} on ${where}.` }),
        404,
      );
    }
    console.error('resolve failed', cacheKey(ref), err);
    return c.html(
      await renderErrorPage({
        status: 502,
        title: 'Try again',
        message: `We couldn't reach ${where} right now. Try again in a moment.`,
      }),
      502,
    );
  }

  app.get('/', async (c) => {
    const u = c.req.query('u');
    if (u === undefined) return c.html(await renderHomePage());
    const parsed = await parseInput(await upstream(c), u);
    if (!parsed.ok) return c.html(await renderHomePage({ error: parsed.error, value: u }), 400);
    return c.redirect(canonicalPath(parsed.ref), 302);
  });

  app.get('/go/:service/:p/:k/:id', async (c) => {
    const service = c.req.param('service') as Service;
    const ref = refFromParams(c.req.param('p'), c.req.param('k'), c.req.param('id'));
    if (!SERVICES.includes(service) || !ref) return c.html(await notFound(), 404);
    let entry: ResolvedEntry;
    try {
      entry = await getEntry(c, ref);
    } catch (err) {
      return failurePage(c, ref, err);
    }
    setCookie(c, PREF_COOKIE, service, {
      path: '/',
      maxAge: PREF_MAX_AGE_S,
      sameSite: 'Lax',
      secure: new URL(c.req.url).protocol === 'https:',
      httpOnly: true,
    });
    c.header('cache-control', 'no-store');
    return c.redirect(entry.links[service].url, 302);
  });

  // Fresh resolution with full diagnostics, for scripts/smoke.ts. Disabled unless DEBUG_API=1.
  app.get('/api/resolve/:p/:k/:id', async (c) => {
    if ((c.env as { DEBUG_API?: string }).DEBUG_API !== '1') return c.html(await notFound(), 404);
    const ref = refFromParams(c.req.param('p'), c.req.param('k'), c.req.param('id'));
    if (!ref) return c.json({ error: 'bad ref' }, 400);
    try {
      return c.json(await resolveAndStore(c, ref));
    } catch (err) {
      const status = err instanceof UpstreamError && err.status === 404 ? 404 : 502;
      return c.json({ error: String(err) }, status);
    }
  });

  app.get('/:p{sp|am|dz|yt}/:k{t|a}/:id', async (c, next) => {
    const ref = refFromParams(c.req.param('p'), c.req.param('k'), c.req.param('id'));
    if (!ref) return next();
    let entry: ResolvedEntry;
    try {
      entry = await getEntry(c, ref);
    } catch (err) {
      return failurePage(c, ref, err);
    }

    const url = new URL(c.req.url);
    const pref = getCookie(c, PREF_COOKIE) as Service | undefined;
    c.header('vary', 'Cookie');
    if (pref && SERVICES.includes(pref) && !url.searchParams.has('stay')) {
      const link = entry.links[pref];
      if (isDirect(link)) {
        c.header('cache-control', 'private, no-store');
        return c.redirect(link.url, 302);
      }
    }

    const canonicalUrl = url.origin + canonicalPath(ref);
    return c.html(await renderSharePage({ entry, ref, canonicalUrl, origin: url.origin }));
  });

  // Prefix trick: /https://open.spotify.com/track/..., /open.spotify.com/..., URL-encoded forms.
  app.get('*', async (c) => {
    const url = new URL(c.req.url);
    const embedded = extractUrlFromPath(url.pathname.slice(1) + url.search);
    if (!embedded) return c.html(await notFound(), 404);
    const parsed = await parseInput(await upstream(c), embedded);
    if (!parsed.ok) return c.html(await renderHomePage({ error: parsed.error, value: embedded }), 400);
    return c.redirect(canonicalPath(parsed.ref), 301);
  });

  app.onError(async (err, c) => {
    console.error('unhandled', err);
    return c.html(
      await renderErrorPage({ status: 500, title: 'Something went wrong', message: 'Please try again.' }),
      500,
    );
  });

  return app;
}

function notFound() {
  return renderErrorPage({ status: 404, title: 'Not found', message: 'There is nothing at this address.' });
}

/** waitUntil when there is an execution context (always in Workers); logging failures never surface. */
function background(c: C, p: Promise<unknown>) {
  const guarded = p.catch((err) => console.error('background task failed', err));
  try {
    c.executionCtx.waitUntil(guarded);
  } catch {
    // No execution context (e.g. app.request() in tests): let it run detached.
  }
}

export default createApp();
