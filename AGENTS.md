# AGENTS.md

## Project Overview

**Tab Triage** is a Firefox WebExtension (Manifest V2) for managing and triaging large numbers of browser tabs (1000+). It opens a full-page tab manager with sorting, filtering, grouping, and search.

## Architecture

```
background.js    → Minimal message broker (open triage page, tab CRUD)
triage.html      → Single-page UI shell
triage.js        → All frontend logic (~850 lines, single file)
triage.css       → Catppuccin Macchiato dark theme (~720 lines)
manifest.json    → Manifest V2, Firefox-only (browser.* APIs)
icons/icon.svg   → Extension icon
```

### Data Flow

`loadTabs()` → message to background → `enrichTabs()` → `getFilteredTabs()` → `sortTabs()` → `groupTabs()` → `render()`

### Communication

Background script and triage page communicate via `browser.runtime.sendMessage`. Message types: `getTabs`, `goToTab`, `closeTab`, `closeTabs`.

### State

All state is module-level variables in `triage.js`: `allTabs`, `enrichedTabs`, `currentSort`, `collapsedGroups`, `ignoredUrls`, `ignoredDomains`, `showIgnored`. Persistence uses `browser.storage.local` for ignore lists and favicon size.

## Tech Stack

- **Vanilla JavaScript** — no frameworks, no dependencies, no build step
- **Firefox WebExtension API** (Manifest V2) — `browser.*` namespace only, not Chrome-compatible
- **Plain CSS** with CSS custom properties
- **No package.json, no bundler, no transpiler, no tests**

## Build & Packaging

Source files are the distribution files directly. Package with `web-ext build` or zip manually. The `.gitignore` excludes `*.xpi`, `*.zip`, and `web-ext-artifacts/`.

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

### Git
- Conventional Commits: `type: description` (e.g., `feat:`, `fix:`, `docs:`)
- Imperative mood in commit messages

## Key Files

| File | Purpose |
|---|---|
| `background.js` | Opens triage page on toolbar click, proxies tab operations |
| `triage.js` | All UI: data loading, enrichment, filtering, sorting, grouping, rendering, event handling |
| `triage.css` | Full styling with Catppuccin Macchiato palette |
| `triage.html` | Page structure: toolbar, filters, table, stats bar, panels |
| `manifest.json` | Extension metadata, permissions (`tabs`, `storage`, `<all_urls>`) |

## Important Patterns

- **Enrichment**: Raw tab data gets computed fields added (`domain`, `domainCount`, `ageMs`, `ageBucket`, `isDuplicate`, `statusList`, etc.)
- **Multi-column sort**: `currentSort` is an array of `{key, dir}` with three-state cycling (desc → asc → off)
- **Filter logic**: Age filters use OR, status filters use AND, domain filter uses inclusion set
- **Ignore system**: Set-based (`ignoredUrls`, `ignoredDomains`), persisted, with URL normalization for dedup
