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
9. **Integration tests replay whole resolutions** (`test/resolve.test.ts`) from fixtures recorded by
   `npm run smoke -- --record`, asserting each Apple/Deezer outcome and matched id per test link. Expected
   ids were checked by hand against the live run. *Alternative:* snapshot tests, which would accept any
   change silently on update.

## Link parsing

10. **Extra formats beyond the brief**, all unambiguous: `spotify:` URIs, Spotify/Apple/YouTube/Deezer
    embed URLs, `youtube-nocookie.com`, legacy `itunes.apple.com/.../id123?i=`, `apple.co` / `spoti.fi` /
    `*.app.link` short links, and redirector wrappers (Outlook Safe Links, `l.facebook.com`,
    `google.com/url`, `youtube.com/redirect`) unwrapped one level. YouTube Shorts are rejected: usually
    song snippets that match poorly. *Alternative:* only the brief's formats.
11. **Pasted text with several URLs:** the first song/album link wins, even over an earlier artist or
    playlist link; otherwise the most specific error. Real share text includes promo copy, emoji, CJK
    punctuation and zero-width characters, all handled.
12. **Short links** are followed manually (`redirect: 'manual'`, ≤ 5 hops, loop detection). A 200 HTML
    interstitial is scanned for the target only on short-link hosts, so a landing page never turns into
    "the first track linked from it". Dead codes (Spotify → home page, Deezer → `deezer-links-404`) say
    "Couldn't open that short link". *Alternative:* `fetch` with automatic redirects, which can't tell
    a dead code from a real target.
13. **Strict id validation** (Spotify base62 × 22, numeric ids without leading zeros, YouTube 11 chars) so
    each item has exactly one cache key and path, and route params never reach upstream unvalidated.

## Sources

14. **Spotify: meta tags plus the embedded `initialState` JSON** (base64, read with HTMLRewriter). Meta tags
    alone are enough to produce an item; the state adds separate artist names, millisecond duration
    (meta tags give whole seconds), explicit flag, album type and track count, which make matching
    stricter. Only the entity for the requested id is used. *Alternative:* meta tags only (spec
    minimum): coarser duration, no explicit flag, artists as one string.
15. **Spotify outbound is always a search link** (no Web API, per the brief).
16. **Deezer advanced search syntax is not used.** Verified live (2026-10-26): `artist:"…" track:"…"`
    returns 0 results even for Deezer's documented examples. Instead two plain queries run in parallel:
    `<artist> <title>` and `<title> <last other credit>` (or `<title>` alone). The second query is what
    finds e.g. the Bieber remix of "Despacito", and is immune to artist spellings that differ between
    catalogs. *Alternative:* the brief's advanced syntax, which currently finds nothing.
17. **Deezer search hits already carry the ISRC** (contrary to older docs), so the follow-up `/track/{id}`
    call is skipped when present: one fewer sequential round trip. Albums still need `/album/{id}` for the UPC.
18. **Deezer identifier lookups are double-checked:** a hit whose ISRC/UPC differs from the requested one
    is discarded (Deezer returns junk for e.g. `upc:000000000000`), and 12/13-digit UPC forms are both tried.
19. **Apple: MusicKit when the three secrets are present and valid, otherwise iTunes Search/Lookup.** The
    ES256 token (jose) is cached per isolate for 12 h. A 401/403 from MusicKit downgrades the request to
    iTunes and stops this isolate from retrying the bad token for a while. iTunes can't filter by ISRC
    but *can* look up by UPC, so albums can still be `exact` in fallback mode.
20. **Apple storefront** = visitor `cf.country` lowercased, falling back to `us` on 400 (no such store)
    or 404 (not sold there). Emitted URLs are storefront-less. See README for the regional limitation.
21. **YouTube: oEmbed only, so no duration.** The watch page (which has the duration) answers server
    requests with a redirect to Google's bot check; we don't work around that. Matching from YouTube
    sources is therefore stricter on titles (see 26). Titles are cleaned of video noise ("Official
    Video", "4K Remaster", "M/V"), " - Topic" channels give the artist, VEVO channel names are split.
22. **Apple/Deezer fallback search links** go to `music.apple.com/search?term=` and
    `www.deezer.com/search/`, so a failed match still opens a useful page.

## Matching

23. **What `exact` means.** Found by ISRC/UPC *and* re-verified against the source metadata. When the
    identifier comes from the source platform itself (Deezer source, MusicKit source) verification is
    lenient (duration, version tags, and artist-or-title). When it was derived from a fuzzy Deezer
    match (Spotify/YouTube sources), the Apple hit must pass the full fuzzy rules too. The Deezer item
    itself stays `fuzzy`. *Alternative:* never call anything from a Spotify source `exact`, which would
    hide the extra certainty an ISRC/UPC agreement between two catalogs gives.
24. **Edit vs extended vs original** labels are hard version markers, except when both durations are known
    and agree: platforms label the same single edit inconsistently, and the duration settles it. Live,
    remix, acoustic, instrumental, demo, sped up, slowed, karaoke and re-recorded ("Taylor's Version")
    never get that exception. Qualifiers must agree too: a "Tiësto Remix" never matches a "David Guetta
    Remix", and two live recordings on different (non-compilation) live albums are different concerts.
25. **Unclassified "<words> version" on one side only** ("Piano Version", "Spanish Version") rejects a
    search hit even when durations agree ("Faded" vs "Faded (Piano Version)" are 2.5 s apart).
26. **No duration (YouTube sources):** title similarity needs 0.9 instead of 0.8, near-miss spellings don't
    count ("Animals"/"Animal"), and an unexplained bracket group on one side only caps similarity at 0.85.
    Found live: Deezer's only Rick Astley candidate was the 2023 "(Pianoforte)" re-recording; without
    this rule it was presented as a direct link.
27. **Featured artists** count as credits (Apple puts them in titles, Spotify in artist lists). A featured
    artist that the other side doesn't credit anywhere costs 0.15: usually a different version.
28. **Numbers and distinct parts cap title similarity** ("Pt. 1"/"Pt. 2", "Greatest Hits II"/"III",
    "(Interlude)", "(Reprise)", "(Commentary)").
29. **Tie-breaks** (within 0.02): non-compilation (incl. bundles like "3 Originals", "Original Album
    Classics") → explicit agrees with source → same album title → earlier release → API order.
30. **Transliteration:** consonant skeletons for Latin transliterations ("Ouelli El Darek" / "Weli L
    Darek"), and Cyrillic/Greek → Latin ("Кино" / "Kino"). Capped below the no-duration threshold.
    CJK/Arabic/Hangul have no transliteration (known gap).
31. **Search queries** use the title without featured clauses and non-version suffixes, plus hard-version
    words ("live", "remix") and remixer names; venue strings are left out (formatted differently
    everywhere). Apple gets one second-chance search (title + last credit, or title alone) only when
    the first finds nothing acceptable, to spare the iTunes rate limit.

## Resolution, data and routes

32. **Misses are logged for Apple and Deezer only**, the services where matching is attempted. Spotify,
    YouTube Music and Amazon are search links by design; logging them on every resolve would bury the
    real misses. Rows store the best rejected candidate and every reject reason.
33. **KV TTL:** 30 days when Apple and Deezer are both exact/fuzzy (the source service counts as exact),
    else 6 hours. Upstream failures are not cached at all (502 page, retry on reload); a missing source
    item is a 404.
34. **In-isolate memory cache (5 min, 500 entries) and in-flight dedupe** in front of KV. KV writes land in
    the background and aren't instantly visible, so the button click right after a first view would
    otherwise resolve everything again. *Alternative:* embed target URLs in the page, which would bypass
    the go route that sets the preference cookie.
35. **`pref` cookie is also HttpOnly** (nothing on the page needs to read it).
36. **`/api/resolve/:p/:k/:id`** returns the full resolution with diagnostics for the smoke script. It
    is disabled unless `DEBUG_API=1`, because it bypasses the cache.
37. **Art:** the source's art, except YouTube sources, which use square cover art from a match when one
    exists instead of a letterboxed 480×360 video thumbnail.

## Page

38. **The copy button is hidden without JS**; its script reads the URL from an escaped `data-url`
    attribute, so nothing is ever interpolated into script context. Go links are relative.
39. **The album line is omitted when it equals the track title** (singles), on the page and in previews.
