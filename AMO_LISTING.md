# AMO Listing

Reference for the [Firefox Add-ons](https://addons.mozilla.org/) submission form.

## Name

Tab Triage Dashboard

## Summary

Triage your tabs — sort by age, filter by status, group by domain, and close duplicates. A bit of organization to a tab chaos. :)

## Description

Manage hundreds or thousands of browser tabs from a single full-page dashboard.

**Core features:**
- **Multi-column sorting** — click column headers to stack sort layers (desc → asc → off)
- **Flexible filtering** — combine age buckets (OR), status filters (AND), and a searchable domain multi-select dropdown
- **Grouping** — by domain, window, age, status, or duplicates with collapsible groups
- **Full-text search** — across title, URL, and domain with instant results
- **Per-tab actions** — switch to tab, deduplicate, ignore by URL or domain, or close
- **Ignore system** — hide tabs by URL or domain, persisted across sessions, with a management panel to review and undo
- **Color coding** — stale tabs highlighted by age (30d+ orange, 90d+ red), high domain counts flagged, duplicate rows marked
- **Catppuccin Macchiato** dark theme with configurable favicon sizes

No data collection. No external requests. Everything stays in your browser.

## Categories

- Tabs

## License

MIT License

## Experimental

No

## Requires payment

No

## Privacy Policy

None — the extension collects no data and makes no network requests.

## Notes to Reviewer

This extension has no build step — source files are the distribution files
directly. The zip contains only: manifest.json, background.js, triage.html,
triage.js, triage.css, and icons/icon.svg.

All DOM rendering uses createElement/textContent/appendChild (no innerHTML
with dynamic content). The extension only uses browser.tabs, browser.storage,
and favicon URLs. No external network requests are made.
