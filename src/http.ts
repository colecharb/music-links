// Upstream HTTP: every call gets a timeout and goes through an injectable fetch so tests
// can replay recorded fixtures and one failing service never breaks the page.

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Developer token for the Apple Music API. */
export interface AppleAuth {
  token: string;
}

/** Per-request context handed to every source module. */
export interface UpstreamCtx {
  fetch: FetchFn;
  /** Per-call timeout in ms. */
  timeoutMs: number;
  /** MusicKit developer token, or null to use the public iTunes Search/Lookup API. */
  apple: AppleAuth | null;
  /** Apple storefront for lookups (visitor country, lowercased), e.g. "us". */
  storefront: string;
}

export const UPSTREAM_TIMEOUT_MS = 2500;
export const USER_AGENT = 'music-links/0.1 (+https://github.com/colecharb/music-links)';

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/** fetch with a timeout and our User-Agent. Throws UpstreamError on network failure or timeout. */
export async function fetchWithTimeout(ctx: UpstreamCtx, url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('user-agent')) headers.set('user-agent', USER_AGENT);
  try {
    return await ctx.fetch(url, { ...init, headers, signal: AbortSignal.timeout(ctx.timeoutMs) });
  } catch (err) {
    const reason = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError') ? 'timeout' : String(err);
    throw new UpstreamError(`${hostOf(url)}: ${reason}`);
  }
}

/** GET JSON. Throws UpstreamError on non-2xx, timeout or invalid JSON. */
export async function getJson<T>(ctx: UpstreamCtx, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetchWithTimeout(ctx, url, init);
  if (!res.ok) {
    await res.body?.cancel();
    throw new UpstreamError(`${hostOf(url)}: HTTP ${res.status}`, res.status);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new UpstreamError(`${hostOf(url)}: invalid JSON`, res.status);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
