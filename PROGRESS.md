# Progress

## Done

- **Routes** (`src/index.ts`): home + `/?u=`, the prefix trick (`/https://…`, scheme-less, URL-encoded),
  the share page `/:p/:k/:id` with the preferred-service redirect (cookie, direct links only, `?stay`),
  `/go/:service/…` setting the `pref` cookie, error pages (404 for missing items, 502 "try again" for
  outages, never cached), and a `DEBUG_API`-gated JSON resolve endpoint for the smoke script.
- **Parsing** (`src/parse.ts`): every format in the brief plus URIs, embeds, legacy iTunes ids, redirector
  wrappers and short links (`spotify.link`, `link.deezer.com`, `deezer.page.link`, `apple.co`, …).
- **Sources:** Spotify page meta tags via HTMLRewriter (enriched by the embedded state), Deezer public API,
  Apple MusicKit with ES256 token (jose) and automatic iTunes fallback, YouTube oEmbed, search URLs for
  Spotify / YouTube Music / Amazon. 2.5 s timeout on every call, failures isolated per service.
- **Matching** (`src/normalize.ts`, `src/match.ts`): the ISRC/UPC → scored search → search URL ladder,
  hard rejects on artist, title, duration (±3 s), version markers and their qualifiers, album track
  count; named thresholds; tie-breaks for originals over compilations and explicit agreement.
- **Data:** KV cache with 30 d / 6 h TTL, D1 misses log written with `waitUntil`, in-isolate cache and
  in-flight dedupe.
- **Page:** ~5 KB, OG/Twitter tags verified, light/dark, verified at 320 px in Chromium, no layout shift,
  copy-link button as the only JS.
- **Tests:** 1,795 passing (`npm test`), typecheck clean. Unit tests for parsing, normalization and scoring;
  replay of all 18 recorded live resolutions; route tests incl. a cache-miss flow writing KV and D1.
- **Live smoke run** (`npm run smoke`) → MATCH_REPORT.md. `npm run dev` checked under `wrangler dev`;
  full flow checked through `npm run dev:proxied`.
- **Reviews:** an independent five-reviewer pass with adversarial verification confirmed 23 findings (6
  that could produce wrong direct links). All are fixed, and the fixes were themselves verified.
- README (setup, secrets, deploy, misses-log queries), DECISIONS.md (40+ decisions with reasons).

## In progress

- Nothing.

## Blocked

- **MusicKit not exercised live:** no Apple developer credentials here, so every live run used the iTunes
  fallback. The MusicKit code is tested against fixtures written from Apple's documented format; one run
  with real secrets (`npm run smoke` with `.dev.vars` filled) would confirm it, especially `playParams`
  filtering and the UPC format `filter[upc]` accepts.

## Known gaps

- Spotify, YouTube Music and Amazon Music outbound links are always searches (no usable public APIs).
- YouTube sources have no duration (oEmbed only; the watch page is behind a bot check), so YouTube-sourced
  matches fall back to search more often, and live/remix videos need a named concert or remixer.
- Cross-script titles (Japanese vs its romanization, Arabic vs Latin) only match through ISRC/UPC.
- Regional availability: Apple uses the first visitor's storefront and Deezer the worker's egress region;
  results are cached for everyone (README, Limitations). Items sold only in the original link's storefront
  can't be read when that differs from the visitor's and `us`.
- iTunes fallback is rate-limited (~20 requests/min per IP), which is not viable at production volume.
- A Latin bracket group on a non-Latin title ("봄날 (Pianoforte)") is treated as a translation and excused;
  album edition labels outside the vocabulary ("(Standard)", "(通常盤)") reject (search links, not wrong links).
- Positive short-link resolution is tested with hand-written fixtures modeled on real redirect chains (no
  live working share code was available to record).
- Dev tooling: `@cloudflare/vitest-pool-workers` is deprecated (renamed `@cloudflare/vitest-plugin`) and
  pins old wrangler/miniflare with 6 high npm-audit advisories (dev-only; runtime deps have none).

## Morning summary

**What works.** Every route works locally, and all 1,795 tests and the typecheck pass. On the 18-link live
test set, every direct link was checked and none were wrong. Apple got a direct link for 15 of 16, Deezer
for 11 of 13, and the three search fallbacks are cases where the right copy genuinely wasn't findable.
The brief's Khaled track resolves to the same-album Apple recording (the case song.link misses). Cached
pages take about 7 ms locally, cold resolves about 1.2 s.

**What doesn't.** Everything ran in the iTunes fallback mode, so ISRC lookups on Apple (the strongest
path) are untested live. Spotify, YouTube Music and Amazon only ever get search links. YouTube sources are
weaker because oEmbed gives no duration.

**Top 3 next improvements.**
1. **Add MusicKit secrets and rerun the smoke test** with them. ISRC lookups would turn most Apple
   `fuzzy` results into `exact`, recover cases like the Get Lucky radio edit, and remove the iTunes rate
   limit, which would break at production volume. Then re-record fixtures for the MusicKit path.
2. **Grow the test set from real traffic.** Deploy, then review the D1 misses log weekly (README has the
   queries): `search` rows show recall gaps, and low-score `fuzzy` rows are where wrong links would hide.
   Turn each confirmed case into a recorded regression in `test/resolve.test.ts`.
3. **Better outbound links for Spotify/YouTube Music.** A licensed metadata source with Spotify/YouTube
   ids by ISRC (or an Odesli-style partner API) would turn the three search-only services into direct
   links. Also give YouTube sources a duration, e.g. via the YouTube Data API with a key.
