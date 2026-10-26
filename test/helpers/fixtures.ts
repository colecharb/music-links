// Replays recorded upstream responses (test/fixtures/http) through an injected fetch.
import type { FetchFn, UpstreamCtx } from '../../src/http';

export interface HttpFixture {
  request: { url: string; method?: string };
  response: { status: number; headers?: Record<string, string>; body: string };
}

const modules = import.meta.glob<HttpFixture>('../fixtures/http/**/*.json', { eager: true, import: 'default' });

export const FIXTURES = new Map<string, HttpFixture>(
  Object.values(modules).map((f) => [new URL(f.request.url).toString(), f]),
);

export interface FixtureFetchOptions {
  /** What to do for a URL with no fixture: throw (default, surfaces missing recordings) or answer 404. */
  missing?: 'throw' | '404';
  /** Extra fixtures (e.g. hand-written error responses) that take precedence over recorded ones. */
  extra?: HttpFixture[];
  /** Every requested URL is appended here. */
  calls?: string[];
}

export function fixtureFetch(opts: FixtureFetchOptions = {}): FetchFn {
  const extra = new Map((opts.extra ?? []).map((f) => [new URL(f.request.url).toString(), f]));
  return async (input) => {
    const url = new URL(input).toString();
    opts.calls?.push(url);
    const f = extra.get(url) ?? FIXTURES.get(url);
    if (!f) {
      if (opts.missing === '404') return new Response('not found', { status: 404 });
      throw new Error(`No fixture for ${url} (record it with: npm run record -- '${url}')`);
    }
    return new Response(f.response.body, { status: f.response.status, headers: f.response.headers });
  };
}

export function fixtureCtx(overrides: Partial<UpstreamCtx> & FixtureFetchOptions = {}): UpstreamCtx {
  const { missing, extra, calls, ...ctx } = overrides;
  return {
    fetch: fixtureFetch({ missing, extra, calls }),
    timeoutMs: 2500,
    apple: null,
    storefront: 'us',
    ...ctx,
  };
}
