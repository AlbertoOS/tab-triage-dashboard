# 🧐 Tab Triage Dashboard

A Firefox extension for managing and triaging your tabs with sorting, filtering, grouping, and bulk actions.

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

### Manual install

1. Download the latest `.zip` from [Releases](../../releases)
2. In Firefox: `about:addons` → gear icon → **Install Add-on From File** → select the `.zip`

## Usage

Click the 🧐 icon in the toolbar to open the triage dashboard.

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
| `npm run zip` | Build `tab-triage-dashboard.zip` from source files |
| `npm run release` | Full release: bump version, lint, zip, tag, push, GitHub release |
| `npm run release:publish` | Create/update GitHub release for the latest tag |

### Linting

```sh
npm run lint
```

Runs Mozilla's [addons-linter](https://github.com/mozilla/addons-linter) with warnings as errors. This also runs in CI on every push and PR to `main`.

## Permissions

- `tabs` — read tab metadata (title, URL, favicons, status)
- `storage` — persist favicon size and ignore lists
- `<all_urls>` — access tab favicons from any domain

## Privacy

No data collection. No external requests. Everything stays in your browser.

## License

MIT
