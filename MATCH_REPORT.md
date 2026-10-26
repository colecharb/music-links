# Match report

Live results of `npm run smoke -- --out MATCH_REPORT.md` for the 18 links in `scripts/test-links.ts`
(Spotify, Apple Music, Deezer and YouTube sources: tracks and albums, a remaster, a radio edit with
featured artists, a remix, a live recording, a super-deluxe edition, Japanese/Korean/Cyrillic titles,
a 2026-09-25 release, an obscure raï track and the Khaled case from the brief). The tables below the
summary are generated; this summary was written after checking each direct link by hand.

**Mode: Apple ran in the degraded iTunes fallback** (no MusicKit secrets in the build environment), so
Apple tracks were matched by search, never by ISRC. Apple albums can still be `exact` through iTunes' UPC
lookup. The MusicKit path is covered only by unit tests built from Apple's documented response format.

## Summary

Counts exclude each link's own service (`source`). Spotify, YouTube Music and Amazon Music are search
links by design when they aren't the source (no usable public API), so only Apple and Deezer are matched.

| Service | links | exact | fuzzy | search | error |
|---|---|---|---|---|---|
| Apple Music | 16 | 2 | 13 | 1 | 0 |
| Deezer | 13 | 0 | 11 | 2 | 0 |
| Spotify | 9 | 0 | 0 | 9 (by design) | 0 |
| YouTube Music | 16 | 0 | 0 | 16 (by design) | 0 |
| Amazon Music | 18 | 0 | 0 | 18 (by design) | 0 |

**Wrong direct links in this run: none found.** Every `exact`/`fuzzy` link was checked against the source:
same title and version, artist, duration within ±3 s, and the right edition for albums.

Speed (local dev server, live upstream APIs): uncached resolve 1.2 s average, 1.7 s max; cached page
6.9 ms average, 9 ms max; largest page 5.7 KB.

## Notable results

- **Khaled, "Ouelli El Darek" (the brief's case).** Apple: the same-album recording on *Sahra* (3:11,
  score 0.96), chosen over the *Best Of* copy and the live *Hafla* version. Deezer has no *Sahra*-album
  copy of this track from this region, so it links the *Best Of* copy (3:12, 2.6 s from the source,
  same title and artist; the live versions are rejected). That is the same song, but possibly a different
  master; the duration difference is within tolerance.
- **Live:** "Smells Like Teen Spirit - Live In Del Mar, California/1991" links the same Del Mar 1991
  recording on *From the Muddy Banks of the Wishkah* on both services, never the studio cut.
- **Remix with a featured artist:** "Despacito - Remix" links the Justin Bieber remix on both services.
  Deezer only surfaces it when the query names the featured artist (DECISIONS #16).
- **Remaster:** "Bohemian Rhapsody - Remastered 2011" links "Bohemian Rhapsody" on *A Night at the Opera*
  on both services (5:54, same duration; the remaster label is a soft marker).
- **Albums:** the 75-track *Nevermind (30th Anniversary Super Deluxe)* matches the super-deluxe edition,
  and on Apple it's `exact` via the UPC of the Deezer match. *Random Access Memories* on Apple is `exact`
  via UPC too (iTunes reports 14 tracks for the same UPC Deezer lists with 13).
- **Non-Latin:** 夜に駆ける (YOASOBI), Группа крови (Кино ↔ Kino on Apple) and Gangnam Style (강남스타일) all match.
- **Recent and obscure:** Taylor Swift "Patient Zero" (released 2026-09-25) and the Olivia Rodrigo album
  (2026-06-12) match; Cheikha Rimitti "Win rak tergoud ?" matches on Apple.

## Search fallbacks (no direct link) and why

| Link | Service | Why |
|---|---|---|
| Get Lucky (Radio Edit) [feat. …] | Apple | iTunes US search returns only the 6:09 album version, the 10:33 remix and covers. All are rightly rejected (duration, version). The radio edit wasn't found by a second-chance search either. With MusicKit the Deezer match's ISRC would be looked up directly. |
| Never Gonna Give You Up (YouTube, both links) | Deezer | Deezer's search doesn't return the 1987 original from this region. Its only Rick Astley candidates are remixes from the 2022 deluxe edition and the 2023 "(Pianoforte)" re-recording, all rejected. Apple links the original album. |

## Wrong matches found during development (all fixed, all now regression tests)

- **YouTube Rick Astley → Deezer "Never Gonna Give You Up (Pianoforte)"** (first live run). A re-recording
  was accepted because nothing contradicted an unknown bracket group without a duration. Now any
  unexplained one-sided group caps the title score below the threshold, with or without a duration.
- **Independent review (synthetic and recorded data, not in this test set):** the same "(Pianoforte)"
  copy for Spotify/Apple sources of the original; plainly titled tracks on *Instrumentals* albums;
  unqualified "(Live)" from YouTube picking an arbitrary concert; "(Piano Version)" albums; one-track
  "(Extended Mix)" singles; withdrawn Deezer duplicates returned by ISRC lookups; "Stronger"/"Strange"-style
  consonant collisions; DJ Khaled vs Khaled. See DECISIONS #24-31b.

## Caveats

- 18 links is a small sample, chosen to be hard rather than representative. The misses log (D1) is the
  way to measure quality at scale; see README for queries.
- Live catalogs change: search rankings, regional availability and new releases can change these results
  between runs. `test/resolve.test.ts` pins the recorded snapshot so logic changes are visible.
- Regional availability: Apple was queried in the `us` storefront and Deezer from a US egress, so results
  can differ for visitors elsewhere (README, Limitations).

## Generated results

<!-- smoke:begin -->
Generated 2026-10-26T21:12:25.892Z · 18 links · Apple mode: **itunes** (no MusicKit secrets: iTunes Search API, no ISRC lookups, degraded matching).

| Service | source | exact | fuzzy | search | error |
|---|---|---|---|---|---|
| Spotify | 9 | 0 | 0 | 9 | 0 |
| Apple Music | 2 | 2 | 13 | 1 | 0 |
| Deezer | 5 | 0 | 11 | 2 | 0 |
| YouTube Music | 2 | 0 | 0 | 16 | 0 |
| Amazon Music | 0 | 0 | 0 | 18 | 0 |

### 1. Ouelli El Darek — Khaled

_Khaled: region-locked Spotify copy with multiple releases (studio, live, best-of)_ · source `sp:t:2qQ3IRCPx3aESBFomT2n2N` · https://open.spotify.com/track/2qQ3IRCPx3aESBFomT2n2N

Source: track · album “Sahra” · duration 3:09 (189360 ms) · released 1996-01-01. Resolved in 1343 ms; cached page in 9 ms (5118 bytes).

| Service | Match | Via | Matched item | Duration | Score | Note |
|---|---|---|---|---|---|---|
| Spotify | exact (source) | source | Ouelli El Darek — Khaled (Sahra) | 3:09 |  |  |
| Apple Music | fuzzy | search | Ouelli el Darek — Khaled (Sahra) | 3:11 | 0.96 |  |
| Deezer | fuzzy | search | Ouelli El Darek — Khaled (Best Of) | 3:12 | 0.80 |  |
| YouTube Music | search | search-url |  |  |  |  |
| Amazon Music | search | search-url |  |  |  |  |

### 2. Bohemian Rhapsody - Remastered 2011 — Queen

_remaster suffix, deluxe album_ · source `sp:t:7tFiyTwD0nx5a1eklYtX2J` · https://open.spotify.com/track/7tFiyTwD0nx5a1eklYtX2J

Source: track · album “A Night At The Opera (Deluxe Remastered Version)” · duration 5:54 (354320 ms) · released 1975-11-21. Resolved in 1357 ms; cached page in 9 ms (5423 bytes).

| Service | Match | Via | Matched item | Duration | Score | Note |
|---|---|---|---|---|---|---|
| Spotify | exact (source) | source | Bohemian Rhapsody - Remastered 2011 — Queen (A Night At The Opera (Deluxe Remastered Version)) | 5:54 |  |  |
| Apple Music | fuzzy | search | Bohemian Rhapsody — Queen (A Night At The Opera (Deluxe Edition)) | 5:54 | 0.97 |  |
| Deezer | fuzzy | search | Bohemian Rhapsody — Queen (A Night At The Opera) | 5:54 | 0.97 |  |
| YouTube Music | search | search-url |  |  |  |  |
| Amazon Music | search | search-url |  |  |  |  |

### 3. Get Lucky (Radio Edit) [feat. Pharrell Williams and Nile Rodgers] — Daft Punk, Pharrell Williams, Nile Rodgers

_radio edit + featured artists in brackets_ · source `sp:t:2Foc5Q5nqNiosCNqttzHof` · https://open.spotify.com/track/2Foc5Q5nqNiosCNqttzHof

Source: track · album “Get Lucky (Radio Edit) [feat. Pharrell Williams and Nile Rodgers]” · duration 4:08 (247632 ms) · released 2013-04-19. Resolved in 1384 ms; cached page in 8 ms (5673 bytes).

| Service | Match | Via | Matched item | Duration | Score | Note |
|---|---|---|---|---|---|---|
| Spotify | exact (source) | source | Get Lucky (Radio Edit) [feat. Pharrell Williams and Nile Rodgers] — Daft Punk, Pharrell Williams, Nile Rodgers (Get Lucky (Radio Edit) [feat. Pharrell Williams and Nile Rodgers]) | 4:08 |  |  |
| Apple Music | search | search-url |  | 10:33 | 0.00 | best rejected: Get Lucky (feat. Pharrell Williams & Nile Rodgers) [Daft Punk Remix] — Daft Punk (Get Lucky (feat. Pharrell Williams & Nile Rodgers) [Daft Punk Remix]) — duration +385.1s; version: edit vs remix |
| Deezer | fuzzy | search | Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers) — Daft Punk (Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers)) | 4:08 | 1.00 |  |
| YouTube Music | search | search-url |  |  |  |  |
| Amazon Music | search | search-url |  |  |  |  |

### 4. Despacito - Remix — Luis Fonsi, Daddy Yankee, Justin Bieber

_remix with a featured artist_ · source `sp:t:6rPO02ozF3bM7NnOV4h6s2` · https://open.spotify.com/track/6rPO02ozF3bM7NnOV4h6s2

Source: track · album “Despacito Feat. Justin Bieber (Remix)” · duration 3:49 (228826 ms) · released 2017-04-17. Resolved in 1199 ms; cached page in 6 ms (5491 bytes).

| Service | Match | Via | Matched item | Duration | Score | Note |
|---|---|---|---|---|---|---|
| Spotify | exact (source) | source | Despacito - Remix — Luis Fonsi, Daddy Yankee, Justin Bieber (Despacito Feat. Justin Bieber (Remix)) | 3:49 |  |  |
| Apple Music | fuzzy | search | Despacito (feat. Justin Bieber) [Remix] — Luis Fonsi & Daddy Yankee (VIDA) | 3:50 | 0.87 |  |
| Deezer | fuzzy | search | Despacito (Remix) — Luis Fonsi (VIDA) | 3:49 | 0.88 |  |
| YouTube Music | search | search-url |  |  |  |  |
| Amazon Music | search | search-url |  |  |  |  |

### 5. Gangnam Style (강남스타일) — PSY

_mixed Latin/Hangul title_ · source `sp:t:03UrZgTINDqvnUMbbIMhql` · https://open.spotify.com/track/03UrZgTINDqvnUMbbIMhql

Source: track · album “Gangnam Style (강남스타일)” · duration 3:39 (219493 ms) · released 2012-01-01. Resolved in 1430 ms; cached page in 6 ms (5078 bytes).

| Service | Match | Via | Matched item | Duration | Score | Note |
|---|---|---|---|---|---|---|
| Spotify | exact (source) | source | Gangnam Style (강남스타일) — PSY (Gangnam Style (강남스타일)) | 3:39 |  |  |
| Apple Music | fuzzy | search | Gangnam Style — PSY (Gangnam Style) | 3:39 | 0.97 |  |
| Deezer | fuzzy | search | Gangnam Style (강남스타일) — Psy (Gangnam Style (강남스타일)) | 3:39 | 1.00 |  |
| YouTube Music | search | search-url |  |  |  |  |
| Amazon Music | search | search-url |  |  |  |  |

### 6. Smells Like Teen Spirit - Live In Del Mar, California/1991 — Nirvana

_live version: must not match the studio recording_ · source `sp:t:6mpyO7bJaCrHzE0iQEtZiN` · https://open.spotify.com/track/6mpyO7bJaCrHzE0iQEtZiN

Source: track · album “From The Muddy Banks Of The Wishkah (Live)” · duration 4:47 (287066 ms) · released 1996-10-01. Resolved in 1637 ms; cached page in 6 ms (5574 bytes).

| Service | Match | Via | Matched item | Duration | Score | Note |
|---|---|---|---|---|---|---|
| Spotify | exact (source) | source | Smells Like Teen Spirit - Live In Del Mar, California/1991 — Nirvana (From The Muddy Banks Of The Wishkah (Live)) | 4:47 |  |  |
| Apple Music | fuzzy | search | Smells Like Teen Spirit (Live At Del Mar Fairgrounds, CA., December 28, 1991) — Nirvana (From the Muddy Banks of the Wishkah (Live)) | 4:47 | 1.00 |  |
| Deezer | fuzzy | search | Smells Like Teen Spirit (Live In Del Mar, California/1991) — Nirvana (From The Muddy Banks Of The Wishkah (Live)) | 4:47 | 1.00 |  |
| YouTube Music | search | search-url |  |  |  |  |
| Amazon Music | search | search-url |  |  |  |  |

### 7. Blinding Lights — The Weeknd

_very popular track with many alternate versions_ · source `sp:t:0VjIjW4GlUZAMYd2vXMi3b` · https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b

Source: track · album “After Hours” · duration 3:20 (200040 ms) · released 2020-03-20. Resolved in 1215 ms; cached page in 7 ms (5170 bytes).

| Service | Match | Via | Matched item | Duration | Score | Note |
|---|---|---|---|---|---|---|
| Spotify | exact (source) | source | Blinding Lights — The Weeknd (After Hours) | 3:20 |  |  |
| Apple Music | fuzzy | search | Blinding Lights — The Weeknd (After Hours) | 3:20 | 1.00 |  |
| Deezer | fuzzy | search | Blinding Lights — The Weeknd (After Hours) | 3:20 | 1.00 |  |
| YouTube Music | search | search-url |  |  |  |  |
| Amazon Music | search | search-url |  |  |  |  |

### 8. Random Access Memories — Daft Punk

_album_ · source `sp:a:4m2880jivSbbyEGAKfITCa` · https://open.spotify.com/album/4m2880jivSbbyEGAKfITCa

Source: album · duration unknown · 13 tracks · released 2013-05-20. Resolved in 1686 ms; cached page in 7 ms (5131 bytes).

| Service | Match | Via | Matched item | Duration | Score | Note |
|---|---|---|---|---|---|---|
| Spotify | exact (source) | source | Random Access Memories — Daft Punk [13 tracks] |  |  |  |
| Apple Music | exact | upc | Random Access Memories — Daft Punk [14 tracks] |  | 0.95 |  |
| Deezer | fuzzy | search | Random Access Memories — Daft Punk [13 tracks] |  | 0.93 |  |
| YouTube Music | search | search-url |  |  |  |  |
| Amazon Music | search | search-url |  |  |  |  |

### 9. Nevermind (30th Anniversary Super Deluxe) — Nirvana

_super deluxe edition (75 tracks)_ · source `sp:a:5eA0qtE7Yu29XiMlwoby2G` · https://open.spotify.com/album/5eA0qtE7Yu29XiMlwoby2G

Source: album · duration unknown · 75 tracks · released 2021-11-12. Resolved in 1628 ms; cached page in 6 ms (5250 bytes).

| Service | Match | Via | Matched item | Duration | Score | Note |
|---|---|---|---|---|---|---|
| Spotify | exact (source) | source | Nevermind (30th Anniversary Super Deluxe) — Nirvana [75 tracks] |  |  |  |
| Apple Music | exact | upc | Nevermind (30th Anniversary Super Deluxe) — Nirvana [75 tracks] |  | 0.90 |  |
| Deezer | fuzzy | search | Nevermind (30th Anniversary Super Deluxe) — Nirvana [75 tracks] |  | 0.93 |  |
| YouTube Music | search | search-url |  |  |  |  |
| Amazon Music | search | search-url |  |  |  |  |

### 10. Where Did You Sleep Last Night (Live Acoustic) — Nirvana

_Apple track via album ?i= URL, live acoustic_ · source `am:t:1440893075` · https://music.apple.com/us/album/where-did-you-sleep-last-night-live-acoustic/1440892370?i=1440893075

Source: track · album “MTV Unplugged In New York (Live Acoustic)” · duration 5:06 (306067 ms) · released 1994-11-01. Resolved in 970 ms; cached page in 5 ms (5605 bytes).

| Service | Match | Via | Matched item | Duration | Score | Note |
|---|---|---|---|---|---|---|
| Spotify | search | search-url |  |  |  |  |
| Apple Music | exact (source) | source | Where Did You Sleep Last Night (Live Acoustic) — Nirvana (MTV Unplugged In New York (Live Acoustic)) | 5:06 |  |  |
| Deezer | fuzzy | search | Where Did You Sleep Last Night (Live) — Nirvana (MTV Unplugged In New York) | 5:07 | 1.00 |  |
| YouTube Music | search | search-url |  |  |  |  |
| Amazon Music | search | search-url |  |  |  |  |

### 11. Sahra — Khaled

_Apple album, non-English_ · source `am:a:1444129774` · https://music.apple.com/us/album/sahra/1444129774

Source: album · duration unknown · 12 tracks · released 1996-11-08. Resolved in 1224 ms; cached page in 6 ms (5104 bytes).

| Service | Match | Via | Matched item | Duration | Score | Note |
|---|---|---|---|---|---|---|
| Spotify | search | search-url |  |  |  |  |
| Apple Music | exact (source) | source | Sahra — Khaled [12 tracks] |  |  |  |
| Deezer | fuzzy | search | Sahra — Khaled [12 tracks] |  | 0.93 |  |
| YouTube Music | search | search-url |  |  |  |  |
| Amazon Music | search | search-url |  |  |  |  |

### 12. 夜に駆ける — YOASOBI

_Japanese title (non-Latin)_ · source `dz:t:824731152` · https://www.deezer.com/track/824731152

Source: track · album “夜に駆ける” · duration 4:21 (261000 ms) · released 2019-12-15 · ISRC JPP301900716. Resolved in 1082 ms; cached page in 7 ms (5005 bytes).

| Service | Match | Via | Matched item | Duration | Score | Note |
|---|---|---|---|---|---|---|
| Spotify | search | search-url |  |  |  |  |
| Apple Music | fuzzy | search | 夜に駆ける — YOASOBI (夜に駆ける) | 4:21 | 1.00 |  |
| Deezer | exact (source) | source | 夜に駆ける — YOASOBI (夜に駆ける) | 4:21 |  |  |
| YouTube Music | search | search-url |  |  |  |  |
| Amazon Music | search | search-url |  |  |  |  |

### 13. Группа крови — Кино

_Cyrillic title, same title exists in another version_ · source `dz:t:448260732` · https://www.deezer.com/en/track/448260732

Source: track · album “Группа крови” · duration 4:44 (284000 ms) · released 1988-01-01 · ISRC RUB421401310. Resolved in 1275 ms; cached page in 8 ms (5033 bytes).

| Service | Match | Via | Matched item | Duration | Score | Note |
|---|---|---|---|---|---|---|
| Spotify | search | search-url |  |  |  |  |
| Apple Music | fuzzy | search | Группа крови — Kino (Группа крови) | 4:44 | 1.00 |  |
| Deezer | exact (source) | source | Группа крови — Кино (Группа крови) | 4:44 |  |  |
| YouTube Music | search | search-url |  |  |  |  |
| Amazon Music | search | search-url |  |  |  |  |

### 14. Patient Zero — Taylor Swift

_recent release (2026-09-25)_ · source `dz:t:4304169612` · https://www.deezer.com/track/4304169612

Source: track · album “The Life of a Showgirl: The Encore” · duration 3:45 (225000 ms) · released 2026-09-25 · ISRC USUG12602391. Resolved in 828 ms; cached page in 7 ms (5275 bytes).

| Service | Match | Via | Matched item | Duration | Score | Note |
|---|---|---|---|---|---|---|
| Spotify | search | search-url |  |  |  |  |
| Apple Music | fuzzy | search | Patient Zero — Taylor Swift (The Life of a Showgirl: The Encore) | 3:46 | 1.00 |  |
| Deezer | exact (source) | source | Patient Zero — Taylor Swift (The Life of a Showgirl: The Encore) | 3:45 |  |  |
| YouTube Music | search | search-url |  |  |  |  |
| Amazon Music | search | search-url |  |  |  |  |

### 15. Win rak tergoud ? — Cheikha Rimitti

_obscure track, "Cheikha" honorific_ · source `dz:t:96996588` · https://www.deezer.com/track/96996588

Source: track · album “Aux sources du raï (Musiques et chants d'Algérie)” · duration 6:56 (416000 ms) · released 2015-03-16 · ISRC FR43D1500746. Resolved in 901 ms; cached page in 8 ms (5389 bytes).

| Service | Match | Via | Matched item | Duration | Score | Note |
|---|---|---|---|---|---|---|
| Spotify | search | search-url |  |  |  |  |
| Apple Music | fuzzy | search | Win rak tergoud ? — Cheikha Rimitti (Aux sources du raï (Musiques et chants d'Algérie)) | 6:57 | 1.00 |  |
| Deezer | exact (source) | source | Win rak tergoud ? — Cheikha Rimitti (Aux sources du raï (Musiques et chants d'Algérie)) | 6:56 |  |  |
| YouTube Music | search | search-url |  |  |  |  |
| Amazon Music | search | search-url |  |  |  |  |

### 16. you seem pretty sad for a girl so in love — Olivia Rodrigo

_recent album (2026-06-12)_ · source `dz:a:1002561451` · https://www.deezer.com/album/1002561451

Source: album · duration unknown · 13 tracks · released 2026-06-12 · UPC 199957766142. Resolved in 805 ms; cached page in 6 ms (5319 bytes).

| Service | Match | Via | Matched item | Duration | Score | Note |
|---|---|---|---|---|---|---|
| Spotify | search | search-url |  |  |  |  |
| Apple Music | fuzzy | search | you seem pretty sad for a girl so in love — Olivia Rodrigo [13 tracks] |  | 0.94 |  |
| Deezer | exact (source) | source | you seem pretty sad for a girl so in love — Olivia Rodrigo [13 tracks] |  |  |  |
| YouTube Music | search | search-url |  |  |  |  |
| Amazon Music | search | search-url |  |  |  |  |

### 17. Never Gonna Give You Up — Rick Astley

_official video title noise, no duration_ · source `yt:t:dQw4w9WgXcQ` · https://www.youtube.com/watch?v=dQw4w9WgXcQ

Source: track · duration unknown. Resolved in 945 ms; cached page in 7 ms (5240 bytes).

| Service | Match | Via | Matched item | Duration | Score | Note |
|---|---|---|---|---|---|---|
| Spotify | search | search-url |  |  |  |  |
| Apple Music | fuzzy | search | Never Gonna Give You Up — Rick Astley (Whenever You Need Somebody) | 3:34 | 0.87 |  |
| Deezer | search | search-url |  | 5:47 | 0.00 | best rejected: Never Gonna Give You Up (Cake Mix) — Rick Astley (Whenever You Need Somebody (Deluxe Edition / Remastered 2022)) — version: studio vs remix |
| YouTube Music | exact (source) | source | Never Gonna Give You Up — Rick Astley |  |  |  |
| Amazon Music | search | search-url |  |  |  |  |

### 18. Never Gonna Give You Up — Rick Astley

_YouTube Music " - Topic" channel_ · source `yt:t:lYBUbBu4W08` · https://music.youtube.com/watch?v=lYBUbBu4W08

Source: track · duration unknown. Resolved in 1028 ms; cached page in 6 ms (5240 bytes).

| Service | Match | Via | Matched item | Duration | Score | Note |
|---|---|---|---|---|---|---|
| Spotify | search | search-url |  |  |  |  |
| Apple Music | fuzzy | search | Never Gonna Give You Up — Rick Astley (Whenever You Need Somebody) | 3:34 | 0.87 |  |
| Deezer | search | search-url |  | 5:47 | 0.00 | best rejected: Never Gonna Give You Up (Cake Mix) — Rick Astley (Whenever You Need Somebody (Deluxe Edition / Remastered 2022)) — version: studio vs remix |
| YouTube Music | exact (source) | source | Never Gonna Give You Up — Rick Astley |  |  |  |
| Amazon Music | search | search-url |  |  |  |  |

<!-- smoke:end -->
