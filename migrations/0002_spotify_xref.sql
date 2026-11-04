-- Spotify cross-reference, learned from Spotify-sourced resolutions (no Spotify API).
-- Rows per normalized identifier (ISRC for tracks, UPC without leading zeros for albums): the Spotify
-- items it was matched to, with the metadata snapshot that later matches are verified against. Several
-- Spotify copies can share an identifier (album version, single, compilation); the few most recently
-- learned are kept and the normal matching tie-breaks choose between them.
CREATE TABLE IF NOT EXISTS spotify_xref (
  kind TEXT NOT NULL CHECK (kind IN ('track', 'album')),
  identifier TEXT NOT NULL,
  spotify_id TEXT NOT NULL,
  -- JSON SpotifySnapshot (src/xref.ts)
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (kind, identifier, spotify_id)
);

-- Cached (KV) entries resolved with a Spotify search link, by the identifiers they carry. When a
-- mapping for one of them is learned, the entry is re-checked and patched with the direct link, but only
-- if it is still the resolution that waited (resolved_at = the entry's resolvedAt).
-- Rows older than the longest KV TTL point at expired entries and are pruned.
CREATE TABLE IF NOT EXISTS spotify_xref_waiting (
  kind TEXT NOT NULL CHECK (kind IN ('track', 'album')),
  identifier TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  resolved_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (kind, identifier, cache_key)
);
CREATE INDEX IF NOT EXISTS spotify_xref_waiting_cache_key ON spotify_xref_waiting (cache_key);
CREATE INDEX IF NOT EXISTS spotify_xref_waiting_updated_at ON spotify_xref_waiting (updated_at);
