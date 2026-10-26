# music-links

Paste a link to a song or album from Spotify, Apple Music, Deezer or YouTube and get one short link
that opens the same item on every major service. Recipients tap their service and land directly on the
song or album; after their first tap, future links open their service automatically.

```
https://<your-host>/sp/t/2qQ3IRCPx3aESBFomT2n2N
https://<your-host>/https://open.spotify.com/track/2qQ3IRCPx3aESBFomT2n2N   (prefix any link)
```

The product is matching quality. A wrong direct link is treated as much worse than a search link, so
every match is checked against artist, title, duration (±3 s), version markers (live, remix, acoustic,
edit, ...) and, for albums, track count and year. Anything below the confidence threshold becomes a
"Search on …" button instead. See [MATCH_REPORT.md](MATCH_REPORT.md) for live results and
[DECISIONS.md](DECISIONS.md) for why things work the way they do.

## How it works

1. **Parse** the link (`src/parse.ts`): Spotify, Apple Music, Deezer, YouTube / YouTube Music, plus
   short links (`spotify.link`, `link.deezer.com`, `apple.co`, ...), which are followed.
2. **Read the source item** (`src/sources/`): Spotify page meta tags via HTMLRewriter, Deezer's public
   API, Apple's MusicKit API (or the public iTunes API), YouTube oEmbed.
3. **Match on each other service** (`src/resolve.ts`, `src/match.ts`), all upstream calls in parallel
   where the dependency graph allows:
   1. identifier lookup (ISRC for tracks, UPC for albums) → `exact`, re-verified against the metadata;
   2. metadata search, scored → `fuzzy` only above the threshold;
   3. otherwise a search URL → `search`.
   When the source has no ISRC/UPC (Spotify, YouTube), the best Deezer match supplies one for Apple.
   Spotify, YouTube Music and Amazon Music are always search links when they aren't the source (no
   usable public APIs).
4. **Cache** the result in KV (30 days when Apple and Deezer both matched, 6 hours otherwise so
   late-indexed releases fill in) and **log** every non-exact Apple/Deezer outcome to D1.
5. **Render** a ~5 KB page: art, title, artist, one button per service, copy-link, full OG/Twitter tags
   for message previews.

### Routes

| Route | |
|---|---|
| `GET /` | Home page with one input. Submits to `/?u=<url>`, which 302s to the share path or re-renders with an error. |
| `GET /<any streaming URL>` | Prefix trick: `/https://open.spotify.com/...`, `/open.spotify.com/...`, URL-encoded. 301 to the share path. |
| `GET /:p/:k/:id` | Share page. `p` = `sp` `am` `dz` `yt`, `k` = `t` (track) or `a` (album). Redirects to the visitor's preferred service when its match is direct (cookie `pref`, skip with `?stay`). |
| `GET /go/:service/:p/:k/:id` | Sets `pref=<service>` (1 year) and redirects to that service's link. Every button goes through here. |
| `GET /api/resolve/:p/:k/:id` | Fresh resolution as JSON with diagnostics. Only when the `DEBUG_API` var is `1` (used by the smoke script). |

## Local setup

Requirements: Node ≥ 22.18 (scripts use Node's built-in TypeScript support).

```sh
npm ci                      # installs from the lockfile (see DECISIONS.md #1 if you add packages)
cp .dev.vars.example .dev.vars   # optional: Apple MusicKit secrets, see below
npm run db:migrate:local    # creates the misses table in the local D1 (.wrangler/state)
npm run dev                 # wrangler dev on http://localhost:8787
```

KV and D1 are simulated locally by `wrangler dev`; nothing needs to exist in your Cloudflare account to
develop. Behind an HTTPS proxy (corporate networks, sandboxes), use `npm run dev:proxied` instead:
workerd ignores `HTTPS_PROXY`, so this starts the same worker through wrangler's API and forwards its
upstream requests through Node.

### Apple Music secrets

Without them, Apple matching uses the public iTunes Search/Lookup API: it works, but can't look up by
ISRC (track matches are search-based) and is rate-limited to roughly 20 requests per minute per IP.
**For production, set up MusicKit.**

1. Apple Developer → Certificates, Identifiers & Profiles → Keys → **+** → enable **MusicKit** →
   download the `.p8` file (once).
2. Note the **Key ID** and your **Team ID** (top right of the developer portal).
3. Locally, put them in `.dev.vars` (see `.dev.vars.example`; the key can be one line with `\n`).
4. In production: `npx wrangler secret put APPLE_TEAM_ID`, `... APPLE_KEY_ID`, `... APPLE_PRIVATE_KEY`
   (paste the whole `.p8` contents).

Missing or invalid secrets never break anything: the worker logs one warning and uses iTunes.

## Tests

```sh
npm test                    # unit + fixture-based integration tests, offline (vitest in workerd)
npm run typecheck
npm run smoke               # live: resolves scripts/test-links.ts against the real APIs, prints a report
npm run smoke -- --out MATCH_REPORT.md   # ...and writes it into MATCH_REPORT.md
npm run smoke -- --record   # ...and records every upstream response into test/fixtures/http
npm run smoke -- https://open.spotify.com/track/...   # just these links
npm run record -- '<url>'   # record one upstream URL as a fixture
```

Tests never touch the network: upstream calls go through an injected `fetch` that replays
`test/fixtures/http/<host>/*.json`. `test/resolve.test.ts` replays complete resolutions of every test
link. When matching logic changes on purpose, rerun the smoke test, review MATCH_REPORT.md, rerecord
if needed and update the expectations.

The smoke script waits 8 s between links to stay under iTunes' rate limit (`SMOKE_DELAY_MS` overrides).

## Deploy

```sh
npx wrangler login

# 1. KV namespace for the cache: put the printed id into wrangler.toml ([[kv_namespaces]] id)
npx wrangler kv namespace create LINKS

# 2. D1 database for the misses log: put the printed database_id into wrangler.toml
npx wrangler d1 create music_links
npx wrangler d1 migrations apply music_links --remote

# 3. Apple MusicKit secrets (recommended, see above)
npx wrangler secret put APPLE_TEAM_ID
npx wrangler secret put APPLE_KEY_ID
npx wrangler secret put APPLE_PRIVATE_KEY

# 4. Deploy
npx wrangler deploy
```

Then add a custom domain in the Cloudflare dashboard (Workers → music-links → Settings → Domains &
Routes). Don't set `DEBUG_API` in production.

## The misses log

Every Apple or Deezer outcome that isn't `exact` is a row in D1 `misses`: `fuzzy` (direct link from a
search, with its score), `search` (no confident match; the best rejected candidate and the reasons are
stored) or `error` (upstream failed). Query it with `wrangler d1 execute` (`--remote` for production,
`--local` for `wrangler dev`):

```sh
# Latest misses
npx wrangler d1 execute music_links --remote --command \
  "SELECT created_at, service, outcome, source_title, source_artist, candidate_title, score, note
   FROM misses ORDER BY id DESC LIMIT 50"

# Outcome counts per service over the last 7 days
npx wrangler d1 execute music_links --remote --command \
  "SELECT service, outcome, COUNT(*) AS n FROM misses
   WHERE created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
   GROUP BY service, outcome ORDER BY service, n DESC"

# Most common reject reasons for search fallbacks
npx wrangler d1 execute music_links --remote --command \
  "SELECT service, substr(note, 1, 60) AS reason, COUNT(*) AS n FROM misses
   WHERE outcome = 'search' GROUP BY service, reason ORDER BY n DESC LIMIT 20"

# Fuzzy matches closest to the threshold (worth spot-checking)
npx wrangler d1 execute music_links --remote --command \
  "SELECT source_title, source_artist, candidate_title, candidate_artist, source_duration_ms,
          candidate_duration_ms, score FROM misses WHERE outcome = 'fuzzy' ORDER BY score ASC LIMIT 20"

# Upstream errors (rate limits, timeouts)
npx wrangler d1 execute music_links --remote --command \
  "SELECT service, note, COUNT(*) AS n FROM misses WHERE outcome = 'error' GROUP BY service, note ORDER BY n DESC"
```

## Limitations

- **Regional availability.** Apple lookups use the visitor's storefront (`cf.country`, falling back to
  `us`), and Deezer search only returns tracks available where the request comes from. Results are cached
  per link for everyone, and Apple links are emitted without a storefront, so a match found in one
  country can open Apple's "not available in your country" page for a visitor elsewhere. Items sold only
  in the storefront of the original Apple link (and not in the visitor's or `us`) can't be read at all.
- **Spotify outbound links are always searches** (the Web API is not usable for this), as are YouTube
  Music and Amazon Music.
- **YouTube sources have no duration** (oEmbed doesn't provide it), so matching from YouTube needs closer
  title agreement and falls back to search more often.
- **iTunes fallback mode** can't look up by ISRC and is rate-limited; see Apple Music secrets above.
- Cross-script titles (e.g. a Japanese title vs its romanization) only match through ISRC/UPC.
