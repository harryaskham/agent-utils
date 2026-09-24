# Fleet image gallery

```sh
ag image                             # pull selected/all enabled nodes, open viewer
ag image pull                        # bulk cache only; no browser
ag image --offline                   # local cache, no SSH
ag --host ms-mac --host sgu24 image
ag image --cache-dir ~/Pictures/ag-cache
ag image pull --checksum              # repair corrupt same-size/mtime cache entries
ag --json image                      # counts, node receipts, HTML path; no browser
```

The gallery sees **all valid registered image/sidecar pairs** in the collected archives, not just the latest 100 or the existing list command's 1,000-record ceiling. Registration is the producer sidecar commit marker; arbitrary files, missing/invalid sidecars and checksum failures are not presented as valid images. The HTML index is bounded to 64 MiB with an explicit error, not truncation. Browser format support still applies; an unsupported HEIC/TIFF or failed decode displays a placeholder with metadata.

The first run incrementally pulls each selected image archive with rsync over the existing SSH configuration. Remote nodes need rsync, **not an upgraded `ag`**, for this path. The remote login environment resolves Nix-installed rsync and producer default paths; usernames, ports, strict host-key verification and configured path overrides are preserved. Images are downloaded in bulk per host rather than invoking SSH separately for each image. Source archives are never modified. Symlinks, devices/special files, deep descendants and oversized files are skipped.

The default cache is `~/.cache/ag/images`, honoring `XDG_CACHE_HOME`; `gallery.cache_dir` and `--cache-dir` override it. Default transfer concurrency is four nodes with a 300-second per-node bound (`gallery.parallelism`, `gallery.sync_timeout_seconds`). SSH connect deadlines still apply. Only explicit runs sync data; no daemon or idle timer is added. An advisory lock prevents concurrent cache writers, and cancelling tears down owned transfer process groups.

This is an **additive cached snapshot**, not a live feed: offline/failed nodes retain previously verified images and their last-sync timestamp, and files removed from a source remain in the collector cache. Errors and invalid registrations are visible in the node panel and CLI receipts. Partial CLI results exit 3. The cache has no automatic disk quota/eviction; allow space for the initial fleet download and manage the cache explicitly.

The generated private HTML works locally with relative cached image paths. It embeds its manifest, CSS and JS, uses no CDN/analytics or external resources, and opens through the platform browser command. JSON and `pull` never open a browser. `ag_image_pull` exposes the same typed cache/index operation over MCP with `confirmed=true`; it returns bounded receipts, not raw images or an unbounded catalog in model context.

## Interaction

- Node and agent filters, plus label/ID search.
- 120 thumbnails per page, lazy image loading and access to every page.
- Click a thumbnail for full-size inspection; ←/→ browse, +/− zoom, Fit resets, drag pans, Escape closes.
- Desktop/mobile layout and dark/light themes.
- Provenance includes node, agent, timestamp, image ID, bytes and SHA-256.

## Validation and visual review

[Gallery contract](../ag/gallery-acceptance.json). Rust tests in `ag/tests/gallery.rs` and `ag/tests/gallery_timeout.rs` exercise 1,005-image catalogs, incremental reuse, offline retention, invalid metadata/checksums, source symlink refusal, repair, CLI default-view dispatch, browser suppression under JSON, confirmation-gated MCP parity, transfer deadlines, and a real rsync protocol crossing a fake SSH/login shell with quoted paths and a failed peer.

The complete 22-test Rust integration suite passed in the Nix package build. Both root and standalone `ag` flake entrypoints built `ag` 0.3.0. The Nix-built binary regenerated a two-node, 130-image offline fixture gallery. Source Clippy and formatting checks passed. Some local test runs hit the external command wall-clock limit under machine load; the final Nix build/test receipt passed.

Actual browser tests verified: all-pages reachability, cached-offline node filtering, search, decoded previews, keyboard next, zoom/Fit, Escape, theme switching and mobile width containment. All data was generated from deterministic non-private screenshots; no production fleet archive was fetched or shown during this review.

| State | Evidence | Review finding |
| --- | --- | --- |
| Desktop contact sheet | [Screenshot](assets/ag-gallery/desktop.png) | Four columns with image-dominant tiles and aligned node/agent provenance. Offline and synced node receipts remain distinct above the grid. |
| Narrow viewport | [Screenshot](assets/ag-gallery/mobile.png) | Search moves to a full-width row; two-column images and stacked host receipts stay within 390 px without horizontal overflow. |
| Full-size preview | [Screenshot](assets/ag-gallery/preview.png) | Image stays contained above a separate metadata area; browsing, zoom/Fit and close controls remain available. |
| Light theme | [Screenshot](assets/ag-gallery/light.png) | Theme changes all gallery chrome; original dark screenshot pixels remain unchanged as content. |

Intentional limitations: source removal does not prune this additive cache; unsupported browser formats have explicit placeholders; this is a static snapshot, so run `ag image pull` or `ag image` again to refresh. No remote package installation or system switch occurs.
