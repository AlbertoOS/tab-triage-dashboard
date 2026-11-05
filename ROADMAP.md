# Roadmap

These are proposed improvements, not shipped features or committed release dates.
Scope and order may change after design, browser-capability checks and testing.
See the [changelog](CHANGELOG.md) for released changes and the [README](README.md) for current behavior.

## Safer duplicate and bulk actions

- Make **keep this tab and close other copies** distinct from **close all copies**, with explicit counts and scope.
- Preview global deduplication and require explicit confirmation of its all-window scope, including tabs outside the current filter. Design a clear policy for pinned tabs and each window's active tab.
- Add bulk discard for selected inactive tabs, with a preview and visible skipped/failed outcomes.
- Explore exact recovery records where browser session APIs can reliably identify affected tabs; do not describe browser-wide restoration as exact undo.

## Related-tab clusters and saved rules

- Suggest related tabs using local, explainable URL/title/domain rules, including provider-aware repository scopes.
- Explore named regex-based **clusters** with keys built from regex capture groups, defensive matching and previews. Clusters are display relationships, not native browser tab groups.
- Save AND/OR rules for selecting, ignoring, discarding or moving matching tabs. Start with manual application rather than automatic cleanup.
- Support moving tabs into existing native tab groups where browser APIs allow it, with explicit capability checks.

## Performance and accessibility

- Measure large-session filtering and sorting before choosing paging or virtualization.
- Extend keyboard navigation, accessible labels and focus restoration across dashboard controls.
- Reuse an existing dashboard tab and evaluate saved views and persistent workspace choices.

## Browser capabilities and delivery

- Evaluate browser-specific permissions independently and document feature availability; do not assume Chrome and Firefox expose identical APIs.
- Research opt-in resource diagnostics. Shared-process CPU/memory must not be presented as precise per-tab measurements.
- Evaluate signed Chrome Web Store uploads with exact-content verification and a tested signing-key recovery process before making signed uploads mandatory.
- Expand disposable-profile browser checks and review development-dependency and security-scanning coverage.

## Contributing

Keep feature and fix work on focused branches and pull requests.
Discuss destructive behavior and cross-browser limitations before implementation, and keep tab data local.
