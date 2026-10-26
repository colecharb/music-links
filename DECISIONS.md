# Decisions

Each entry: the decision, why, and the alternative considered.

## Tooling

1. **npm 11 for installs.** npm 10.9 (bundled with Node 22) crashes in its peer-dependency resolver
   (`Cannot read properties of null (reading 'edgesOut')`) on vitest 4's optional peers. Installing with
   `npx npm@11 install` works and records `allowScripts` for esbuild/workerd in package.json.
   *Alternative:* `--legacy-peer-deps` with npm 10, which needs an `.npmrc` and skips peer checks.
2. **`@cloudflare/vitest-pool-workers@0.23.0` + vitest 4.1.** Kept the fixed stack even though the package
   has since been renamed to `@cloudflare/vitest-plugin` (migration is a codemod). Its bundled workerd
   supports compatibility dates up to 2026-08-22, so `compatibility_date` is pinned to `2026-08-15` for both
   `wrangler dev` and tests. *Alternative:* switch to `@cloudflare/vitest-plugin` and a newer date.
3. **No `@cloudflare/workers-types`.** `wrangler types` generates runtime types into
   `worker-configuration.d.ts`; the extra package would duplicate them. Rerun `npm run types` after
   changing `wrangler.toml`.
4. **Scripts run with Node's built-in type stripping** (`node scripts/x.ts`, Node >= 22.18), so there is no
   `tsx` dependency. Scripts use only erasable TypeScript syntax and are not part of `tsc` checking.
5. **`vite/client` types** in tsconfig so tests can use `import.meta.glob` to load fixtures.

## Network

6. **Honest User-Agent** (`music-links/0.1 (+repo url)`) on every upstream request. No spoofing of browser
   or crawler user agents. Spotify serves full meta tags to it.
7. **`npm run dev:proxied` / smoke script use wrangler's `unstable_startWorker` with an `outboundService`**
   that forwards the worker's upstream requests through Node's `fetch` (`NODE_USE_ENV_PROXY=1`). workerd
   ignores `HTTPS_PROXY`, so plain `wrangler dev` cannot reach upstream from behind an HTTPS proxy (as in the
   build container). On a normal network `npm run dev` works as is. *Alternative:* a dev-only fetch
   rewrite inside the worker, which would put environment hacks into production code.

## Testing

8. **Fixtures are one JSON file per upstream URL** (`test/fixtures/http/<host>/`), replayed through an
   injected `fetch` (`UpstreamCtx.fetch`). Spotify pages are trimmed to `<head>` + the `initialState` script
   (~80KB instead of ~300KB), which is everything the parser reads. *Alternative:* MSW/undici mocks,
   which tie tests to the runtime's global fetch.
