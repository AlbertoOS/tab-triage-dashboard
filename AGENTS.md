# AGENTS.md

## Project Overview

**Tab Triage Dashboard** is a Manifest V3 WebExtension for Firefox and Chrome that manages and triages large numbers of browser tabs (1000+). It opens a full-page tab manager with sorting, filtering, clustering, grouping, and search.

## Architecture

```
background.js        → Minimal message broker (open triage page, tab CRUD)
triage.html          → Single-page UI shell
triage.js            → All frontend logic (~850 lines, single file)
triage.css           → Catppuccin Macchiato dark theme (~720 lines)
manifest.firefox.json → Firefox Manifest V3 configuration
manifest.chrome.json  → Chrome Manifest V3 configuration
icons/icon.svg       → Extension icon
release.sh           → Release script (version bump, tag, publish)
release-publish.sh   → Standalone GitHub release publisher
```

### Data Flow

`loadTabs()` → message to background → `enrichTabs()` → `getFilteredTabs()` → `sortTabs()` → `groupTabs()` → `render()`

### Communication

Background script and triage page communicate through `api.runtime.sendMessage`, where `api` resolves to Firefox's `browser` or Chrome's `chrome`. Message types include `getTabs`, `goToTab`, `closeTab`, `closeTabs`, `discardTab`, and session restoration commands.

### State

All state is module-level variables in `triage.js`: `allTabs`, `enrichedTabs`, `currentSort`, `collapsedGroups`, `ignoredUrls`, `ignoredDomains`, `showIgnored`, and `fuzzySearch`. Persistence uses extension local storage for ignore lists and favicon size.

## Tech Stack

- **Vanilla JavaScript** — no frameworks, no dependencies, no build step
- **Firefox and Chrome WebExtension APIs** (Manifest V3) — the shared `api` alias resolves to `browser.*` or `chrome.*`
- **Plain CSS** with CSS custom properties
- **No bundler, no transpiler** — source files are the distribution
- **addons-linter** — Mozilla's extension validator, run via `npm run lint`

## Build & Packaging

Source files are the distribution files directly. Package with `npm run zip` which creates Firefox and Chrome archives containing only extension source files. The `.gitignore` excludes `*.xpi`, `*.zip`, `web-ext-artifacts/`, `node_modules/`, generated `manifest.json`, and the local `TODO.md` backlog.

## Linting

Run `npm run lint` to validate the extension with Mozilla's [addons-linter](https://github.com/mozilla/addons-linter). This zips only extension source files and lints the zip (to avoid scanning `.git/` and `node_modules/`). Warnings are treated as errors (`--warnings-as-errors`). CI runs this on every push and PR via GitHub Actions (`.github/workflows/lint.yml`).

## Releasing

- **`npm run release`** — full release flow:
  1. Parses conventional commits since last tag to infer semver bump (`feat:` → minor, `fix:` → patch, `BREAKING CHANGE` → major)
  2. Updates version in `manifest.json` and `package.json`
  3. Runs lint, builds zip, commits, tags, pushes
  4. Creates a GitHub release with the zip via `gh` CLI
  5. Bumps to next dev version and commits

- **`npm run release:publish`** — retry/standalone publish: builds zip if needed and creates or updates the GitHub release for the latest existing tag. Use when the full release failed partway through or a tag was created manually.

## npm Scripts

| Script | Purpose |
|---|---|
| `npm run lint` | Validate extension with addons-linter |
| `npm run zip` | Build `tab-triage-dashboard.zip` from source files |
| `npm run release` | Full release: bump, lint, zip, tag, push, GitHub release, prep next dev |
| `npm run release:publish` | Create/update GitHub release for the latest tag |

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
| `background.js` | Opens triage page on toolbar click, proxies tab operations |
| `triage.js` | All UI: data loading, enrichment, filtering, sorting, grouping, rendering, event handling |
| `triage.css` | Full styling with Catppuccin Macchiato palette |
| `triage.html` | Page structure: toolbar, filters, table, stats bar, panels |
| `manifest.firefox.json`, `manifest.chrome.json` | Browser-specific extension metadata and permissions |
| `release.sh` | Full release automation script |
| `release-publish.sh` | Standalone GitHub release publisher |
| `AMO_LISTING.md` | Reference for Firefox Add-ons submission form |

## Important Patterns

- **Enrichment**: Raw tab data gets computed fields added (`domain`, `domainCount`, `ageMs`, `ageBucket`, `isDuplicate`, `statusList`, etc.)
- **Multi-column sort**: `currentSort` is an array of `{key, dir}` with three-state cycling (desc → asc → off)
- **Filter logic**: Age filters use OR, status filters use AND, domain filter uses inclusion set
- **Ignore system**: Set-based (`ignoredUrls`, `ignoredDomains`), persisted, with URL normalization for dedup
