# AGENTS.md

## Project Overview

**Tab Triage Dashboard** is a Manifest V3 WebExtension for Firefox and Chrome that manages and triages large numbers of browser tabs (1000+). It opens a full-page tab manager with sorting, filtering, display clusters, and search.

## Architecture

```
background.js        → Dashboard launch and tab queries/actions
triage.html          → Single-page UI shell
triage.js            → Frontend logic (single file)
triage.css           → Catppuccin Macchiato dark theme
manifest.firefox.json → Firefox Manifest V3 configuration
manifest.chrome.json  → Chrome Manifest V3 configuration
icons/icon.svg       → Extension icon
release.sh           → Legacy interactive release (commit, tag, push, publish)
release-publish.sh   → Legacy tag publisher and maintained build-only path
```

### Data Flow

`loadTabs()` → message to background → `enrichTabs()` → `getFilteredTabs()` → `sortTabs()` → `groupTabs()` → `render()`

### Communication

Background script and triage page communicate through `api.runtime.sendMessage`, where `api` resolves to `browser` or `chrome`. Chromium can expose both aliases; use the packaged manifest, not the selected alias, to determine the dashboard's browser context. Message types include `getTabs`, `goToTab`, `closeTab`, `closeTabs`, `discardTab`, and session restoration commands.

### State

All state is module-level variables in `triage.js`: `allTabs`, `enrichedTabs`, `currentSort`, `collapsedGroups`, `ignoredUrls`, `ignoredDomains`, `showIgnored`, and `fuzzySearch`. Persistence uses extension local storage for ignore lists and favicon size.

## Tech Stack

- **Vanilla JavaScript** — no frameworks or runtime dependencies; no bundling or transpiling
- **Firefox and Chrome WebExtension APIs** (Manifest V3) — the shared `api` alias resolves to `browser.*` or `chrome.*`
- **Plain CSS** with CSS custom properties
- **No bundler, no transpiler** — source files are the distribution
- **addons-linter** — Mozilla's extension validator, run via `npm run lint`

## Build & Packaging

Source files are the distribution files directly. `npm run zip` creates `tab-triage-dashboard-firefox.zip` and `tab-triage-dashboard-chrome.zip` using the distribution allowlist. Each archive contains its browser-specific source manifest as `manifest.json`; do not edit a generated manifest as a release input. The `.gitignore` excludes `*.xpi`, `*.zip`, `web-ext-artifacts/`, `node_modules/`, generated `manifest.json`, and the local `TODO.md` backlog.

## Linting

Run `npm run lint` to validate the extension with Mozilla's [addons-linter](https://github.com/mozilla/addons-linter). This zips only extension source files and lints the zip (to avoid scanning `.git/` and `node_modules/`). Warnings are treated as errors (`--warnings-as-errors`). CI runs this on every push and PR to `main` via GitHub Actions (`.github/workflows/lint.yml`).

## Releasing

Follow [RELEASING.md](RELEASING.md) for the normal merge-driven release path. Commit the implementation on its topic branch, refresh and integrate current `origin/main`, then preview with `npm run release:prepare -- --base origin/main`. Add `--write` to synchronize `package.json`, `package-lock.json` and both browser manifests, and commit the reviewed metadata on the same branch.

Conventional Commit messages determine the highest unreleased change: breaking changes select major, `feat:` minor and `fix:` patch. Ordinary docs/ci/test/chore-only ranges do not release. Keep the PR title's classification consistent, including for squash merges. Never invent a releasing commit type merely to publish documentation.

After a verified merge, the main workflow creates an annotated tag at the exact release commit, builds and verifies both archives and provenance, publishes the GitHub Release, and explicitly dispatches isolated store publishers. There is no separate release-preparation PR, direct-main version bump or post-release development-version commit.

`npm run release` and `npm run release:publish` are legacy mutation/recovery commands, not the normal automatic path. They can commit/push/tag or replace assets. Do not use them to retry automatic publication or overwrite an existing tag/release. See [STORE_PUBLISHING.md](STORE_PUBLISHING.md) for store-specific verification; dispatch or submission is not proof of public availability.

## npm Scripts

| Script | Purpose |
|---|---|
| `npm test` | Run tab-management, UI, packaging and release/store regression tests |
| `npm run lint` | Validate extension with addons-linter |
| `npm run zip` | Build separate Firefox and Chrome source archives |
| `npm run zip:firefox`, `npm run zip:chrome` | Build one browser archive |
| `npm run release:prepare -- --base origin/main` | Preview original-PR version preparation; add `--write` for source metadata |
| `npm run test:stores` | Run credential-free store publication regressions |
| `npm run release` | Legacy interactive release with commit/tag/push side effects |
| `npm run release:publish -- "$TAG"` | Legacy selected-tag publication that can replace release assets |

## Key Conventions

### Code Style
- ES6+: `const`/`let`, arrow functions, async/await, template literals, destructuring
- 2-space indentation, double quotes, semicolons, trailing commas
- Top-level functions use `function` declarations; callbacks use arrow functions

### Naming
- JavaScript: `camelCase` for functions and variables
- CSS classes: `kebab-case` with prefixes (`btn-`, `col-`, `badge-`)
- DOM IDs: mixed `camelCase` and `kebab-case`

### Security
- **No `innerHTML` with dynamic content.** All DOM is built with `createElement`/`textContent`/`appendChild`. This is enforced by Firefox add-on validation.
- `escapeHtml()` exists as a utility but should rarely be needed given DOM-based rendering.

### Public Repository Hygiene
- This repository is public and open source. Apply the same disclosure boundary to tracked files, fixtures, PR discussions, release notes, generated artifacts, and CI logs.
- Never publish credentials, tokens, private keys, cookies, or real secrets in test fixtures. Keep credential-transfer scripts and operational state outside the repository.
- Keep personal account details, local filesystem paths, private infrastructure identifiers, and raw operational transcripts out of public content. Use generic examples and GitHub environment variables or secrets for deployment-specific configuration.
- Preserve functional identifiers that are intentionally public, such as the extension GUID; do not confuse non-secret identifiers with credentials or expose unnecessary personal deployment details.
- Before every commit and push, review the exact changed/untracked/staged file inventory, the complete publication diff, and artifact/log output paths for sensitive information. A `.gitignore` entry or passing scanner alone is not proof of safe publication.

### GitHub Actions
- Select the latest compatible publisher-maintained major tag (`@vN`) for external actions when creating or updating workflows. Major tags receive compatible updates, but do not advance to the next major automatically.
- Verify current publisher releases, the target tag's inputs, and runner/runtime requirements before upgrading. Preserve existing authentication and publication boundaries; do not introduce commit-SHA pins or unversioned branches as the default.

### Git
- Conventional Commits: `type: description` (e.g., `feat:`, `fix:`, `docs:`)
- Imperative mood in commit messages
- Develop each feature or fix on a dedicated topic branch (`feat/`, `fix/`, `docs/`, etc.); do not develop feature work directly on `main`.
- Open a scoped, verified pull request targeting `main` for every feature or fix.

## Key Files

| File | Purpose |
|---|---|
| `background.js` | Opens or focuses the triage page on toolbar click, proxies tab operations |
| `triage.js` | All UI: data loading, enrichment, filtering, sorting, display clustering (`groupTabs()`), rendering, event handling |
| `triage.css` | Full styling with Catppuccin Macchiato palette |
| `triage.html` | Page structure: toolbar, filters, table, stats bar, panels |
| `manifest.firefox.json`, `manifest.chrome.json` | Browser-specific extension metadata and permissions |
| `RELEASING.md` | Merge-driven release preparation, publication and recovery |
| `STORE_PUBLISHING.md` | Isolated browser-store verification and publication |
| `scripts/release_plan.py`, `scripts/release_publish.py` | Automatic release planning and exact-source publication |
| `release.sh`, `release-publish.sh` | Legacy release commands and maintained tag-based build-only path |
| `AMO_LISTING.md` | Reference for Firefox Add-ons submission form |

## Important Patterns

- **Enrichment**: Raw tab data gets computed fields added (`domain`, `domainCount`, `ageMs`, `ageBucket`, `isDuplicate`, `statusList`, etc.)
- **Multi-column sort**: `currentSort` is an array of `{key, dir}` with three-state cycling (default direction → reverse → off; Title and Domain start ascending, other columns descending)
- **Filter logic**: Age filters use OR, status filters use AND, domain filter uses inclusion set
- **Ignore system**: Set-based (`ignoredUrls`, `ignoredDomains`), persisted, with URL normalization for dedup
