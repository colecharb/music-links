// Starts the worker through wrangler's programmatic API with every outbound request forwarded
// through Node's fetch. Node honors HTTPS_PROXY (with NODE_USE_ENV_PROXY=1) while workerd does
// not, so this is how to run against live upstream APIs from behind an HTTPS proxy.
// Optionally records each upstream response as a test fixture.
import { unstable_startWorker } from 'wrangler';
import { writeFixture } from './fixture-io.ts';

export interface ProxiedWorkerOptions {
  port?: number;
  /** Local state directory, or false for in-memory state. Defaults to wrangler's .wrangler/state. */
  persist?: string | false;
  /** Write every upstream response to test/fixtures/http. */
  record?: boolean;
  /** Extra plain-text vars for the worker. */
  vars?: Record<string, string>;
}

export async function startProxiedWorker(opts: ProxiedWorkerOptions = {}) {
  const bindings = Object.fromEntries(
    Object.entries(opts.vars ?? {}).map(([k, value]) => [k, { type: 'plain_text' as const, value }]),
  );
  const worker = await unstable_startWorker({
    config: 'wrangler.toml',
    bindings,
    dev: {
      server: { port: opts.port ?? 8787 },
      persist: opts.persist,
      outboundService: async (req: Request) => {
        const res = await fetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
          redirect: 'manual',
        });
        const body = await res.arrayBuffer();
        if (opts.record && req.method === 'GET') {
          writeFixture(req.url, res.status, res.headers, new TextDecoder().decode(body));
        }
        // Node's fetch already decoded the body; drop headers that no longer describe it.
        const headers = new Headers(res.headers);
        headers.delete('content-encoding');
        headers.delete('content-length');
        return new Response(res.status === 204 || res.status === 304 ? null : body, { status: res.status, headers });
      },
    },
  });
  await worker.ready;
  return worker;
}
