# 🧐 Tab Triage Dashboard

A Firefox and Chrome extension for managing and triaging your tabs with sorting, filtering, grouping, and bulk actions.

## Features

- **Multi-column sorting** — click columns to add sort layers (desc → asc → off), with priority indicators
- **Checkbox filters** — combine multiple age buckets (OR) and status filters (AND)
- **Domain multi-select** — searchable dropdown with checkboxes, select all/none
- **Grouping** — by domain, window, age bucket, status, or duplicates — collapsible groups sorted by count
- **Search** — debounced search across title, URL, and domain (Escape to clear)
- **Configurable favicon size** — slider from 16px to 48px, persisted across sessions
- **Actions per tab:**
  - **Go** — switch to the tab
  - **Dedup** — close all other tabs with the same URL, keep this one
  - **Ignore** — hide tabs by URL or entire domain (persisted, manageable)
  - **Close** — close the tab
- **Ignore management** — toggle to show ignored tabs only, panel to review/remove ignores, reset all
- **Color coding** — stale tabs (30d+ orange, 90d+ red), high domain count (5+ orange, 20+ red), duplicate rows highlighted
- **Catppuccin Macchiato** dark theme

## Install

Install from [Firefox Add-ons (AMO)](https://addons.mozilla.org/en-US/firefox/addon/tab-triage-dashboard/).

### Chrome development install

There is no Chrome Web Store listing yet. To test a local build:

1. Run `npm run zip:chrome` and extract `tab-triage-dashboard-chrome.zip` into a separate directory.
2. In a disposable Chrome profile, open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the extracted directory containing `manifest.json`.
4. Open the dashboard from the extension's toolbar icon. Use synthetic tabs, not an existing browsing session, when testing close or discard actions.

For temporary Firefox testing, run `npm run zip:firefox`, extract the archive, and load its manifest via `about:debugging` → **This Firefox** → **Load Temporary Add-on**. For a normal signed installation, use AMO.

## Usage

Filter and sort the tab list, then use **Select all filtered tabs** (or the checkbox in the table header) and **Close selected** to close the result in one batch. You can also select individual rows and clear the selection. Collapsed groups are included; dashboard tabs are excluded. Changing filters removes hidden tabs from the selection.

Use **Export selected links** to save the selection, or **Export all links** to save all open tabs regardless of filters and ignore lists. Exports are plain text files with one URL per line in the current sort order, preserving duplicate URLs. Dashboard tabs and empty URLs are excluded. To export a filtered result, select all filtered tabs and export the selection.

Click the 🧐 icon in the toolbar to open the triage dashboard.

The close notification offers **Restore most recently closed tab/window**. This uses browser-wide session history, not an exact undo of the dashboard action or batch. Another closure can change which session is restored; a session may contain an entire window. Each click restores at most one session. Private tabs and entries no longer retained by the browser may not be recoverable.

## Development

### Prerequisites

- Node.js 24+
- npm

### Setup

```sh
npm install
```

### Available scripts

| Script | Purpose |
|---|---|
| `npm run lint` | Validate extension with Mozilla's addons-linter |
| `npm run zip` | Build separate `tab-triage-dashboard-firefox.zip` and `tab-triage-dashboard-chrome.zip` archives |
| `npm run release` | Full release: bump version, lint, zip, tag, push, GitHub release |
| `npm run release:publish` | Create/update GitHub release for the latest tag |
| `npm run test:stores` | Run credential-free store publication checks (Python 3.10+ and Git) |

### Packaging and release retries

Packaging requires Node.js 24+, Bash, `zip`, and `unzip` (for the packaging tests). Tag-based builds also require Git and `tar`. Both source manifests and `package.json` must have exactly the same version; archives preserve that version without adding a Git commit-count suffix. Ordinary `npm run zip` packages the current source tree using the distribution allowlist.

For release retries, select an existing local `[v]MAJOR.MINOR.PATCH` tag explicitly:

```sh
npm run release:publish -- "$TAG"
```

This **pushes only the selected tag to `origin` and creates or updates its GitHub Release** using `gh`. A failed tag push stops publication. The no-argument invocation remains compatible and selects the nearest reachable tag (`git describe`), not necessarily the newest version; explicit selection is recommended.

To inspect artifacts without pushing tags or invoking `gh`, set `TAG` to the desired existing release tag and use a private output directory:

```sh
artifact_dir=$(mktemp -d "${TMPDIR:-/tmp}/tab-triage-artifacts.XXXXXX")
bash release-publish.sh "$TAG" --build-only "$artifact_dir"
```

Both release paths always rebuild **both** browser archives from a pinned tag commit exported with `git archive` into private scratch. They ignore cached ZIPs and current dirty/untracked files, use the maintained builder rather than executing historical scripts, and reject tag/source version mismatches, missing distribution inputs, symlinks, and export transformations. `provenance.json` records the selected tag object, commit, version, and SHA-256 hashes of both ZIPs. Both publication paths attach it to the GitHub Release; `--build-only` saves it alongside the inspected assets. The output directory must already exist. Scratch is removed on normal exit; forced termination may leave it behind. This is source-provenance checking, not tag-signature verification or a promise of byte-reproducible ZIP timestamps.

The full `npm run release` flow still prompts, bumps versions, validates, commits, and tags; its publishable assets now use that same tag-based build-only path. Publishing the GitHub Release automatically dispatches separate main-only browser-store workflows; see [Browser store publication](STORE_PUBLISHING.md) for setup, source verification, preflight-only runs and retry semantics. The local release script does not receive store credentials. A packaging failure after tagging can leave a local release commit/tag for an explicit retry; it is not rolled back automatically. Tags predating the dual-manifest/package layout cannot be rebuilt by this path.

### Linting

```sh
npm run lint
```

Runs Mozilla's [addons-linter](https://github.com/mozilla/addons-linter) with warnings as errors. This also runs in CI on every push and PR to `main`.

## Permissions

- `tabs` — read tab metadata (title, URL, favicons, status)
- `storage` — persist favicon size and ignore lists
- `sessions` — restore the browser's most recently closed tab or window
- Firefox currently retains `<all_urls>` host access; Chrome does not request host permissions. Metadata access in Chrome comes from `tabs`.

## Privacy

The extension reads tab titles, URLs, favicons, and status to render the dashboard. Preferences and ignore lists are stored locally in extension storage. It has no application backend or analytics and does not upload your tab list. Loading site favicons can cause browser network requests; unavailable icons are replaced with a bundled image. Link exports are local files you create, and they contain your browsing URLs, so review them before sharing.

## License

MIT
