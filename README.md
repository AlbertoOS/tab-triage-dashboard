# 🧐 Tab Triage

A Firefox extension for triaging 1000+ tabs with sorting, filtering, grouping, and bulk actions.

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

## Install (temporary, for development)

1. Open `about:debugging` in Firefox
2. Click **This Firefox** → **Load Temporary Add-on**
3. Select `manifest.json`
4. Click the 🧐 icon in the toolbar

## Install (permanent, signed)

### Option A: AMO web upload

1. Create an account at [addons.mozilla.org](https://addons.mozilla.org/developers/)
2. Go to **Submit a New Add-on** → choose **On your own** (self-distributed/unlisted)
3. Zip the extension: `zip -r tab-triage.zip manifest.json background.js triage.* icons/`
4. Upload the zip — Mozilla signs it and returns an `.xpi`
5. In Firefox: `about:addons` → gear icon → **Install Add-on From File** → select the `.xpi`

### Option B: web-ext CLI

```sh
npm install -g web-ext
```

Get API credentials at https://addons.mozilla.org/developers/addon/api/key/ then:

```sh
web-ext sign --api-key=YOUR_KEY --api-secret=YOUR_SECRET
```

## Permissions

- `tabs` — read tab metadata (title, URL, favicons, status)
- `storage` — persist favicon size and ignore lists
- `<all_urls>` — access tab favicons from any domain

## License

MIT
