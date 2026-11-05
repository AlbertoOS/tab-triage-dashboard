# Changelog

Released changes are listed here; proposed work lives in the [roadmap](ROADMAP.md).
GitHub release versions and browser-store versions can differ while store review is pending.
See [GitHub Releases](https://github.com/AlbertoOS/tab-triage-dashboard/releases) for release notes and downloads, including earlier versions not summarized here.

## [1.4.4](https://github.com/AlbertoOS/tab-triage-dashboard/releases/tag/v1.4.4) — 2026-11-04

### Tab management

- Fix Age sorting to use numeric elapsed time, with oldest tabs first by default.
- Cycle each sort column through its default direction, reverse direction and off. Title and Domain start A–Z; other columns start descending. Preserve multi-column priorities when a sort is removed.

### Release reliability

- Add bounded diagnostics for release planning, package verification and browser-store publication without logging credentials or raw provider responses.
- Distinguish an uncertain dispatch from a confirmed failure, and keep unavailable diagnostic output from changing publication results.

[Full comparison](https://github.com/AlbertoOS/tab-triage-dashboard/compare/v1.4.3...v1.4.4)

## [1.4.3](https://github.com/AlbertoOS/tab-triage-dashboard/releases/tag/v1.4.3) — 2026-11-02

### Development toolchain

- Adopt Node.js 26 LTS and enforce a minimum of 26.13.0 in package metadata, version selectors and CI.
- Update development dependencies, including js-yaml, undici and fast-uri. These are tooling changes, not new extension runtime permissions or dependencies.

[Full comparison](https://github.com/AlbertoOS/tab-triage-dashboard/compare/v1.4.2...v1.4.3)

## [1.4.2](https://github.com/AlbertoOS/tab-triage-dashboard/releases/tag/v1.4.2) — 2026-11-02

### Firefox publication

- Accept formatting-only changes to Mozilla-signed manifest JSON while retaining strict typed-value comparison and exact checks for the other application files.
- Preserve numeric precision and reject unsupported manifest encodings, ambiguous JSON and unexpected package contents during readback verification.

[Full comparison](https://github.com/AlbertoOS/tab-triage-dashboard/compare/v1.4.1...v1.4.2)

## [1.4.1](https://github.com/AlbertoOS/tab-triage-dashboard/releases/tag/v1.4.1) — 2026-11-02

### Release automation

- Prepare version metadata in the original pull request and classify the full commit range for semantic releases after merge.
- Publish annotated release tags, categorized GitHub release notes, both browser archives and provenance built from the merged commit.
- Dispatch separate Firefox and Chrome publishing workflows after release publication, with trusted-main source verification and isolated store credentials.

### Reliability

- Handle final Chrome Web Store submission states and publication to testers.
- Attempt to dispatch to both stores before reporting a coordinator failure, and run verification separately from publication.
- Reject malformed legacy lockfile versions before writing any version metadata.

### Documentation

- Add a privacy policy describing local data, exports, favicon requests and deletion.

[Full comparison](https://github.com/AlbertoOS/tab-triage-dashboard/compare/v1.4.0...v1.4.1)

## [1.4.0](https://github.com/AlbertoOS/tab-triage-dashboard/releases/tag/v1.4.0) — 2026-10-29

### Tab management

- Select and close multiple tabs, and export selected or all links to local text files.
- Add fuzzy search, fragment-aware duplicate detection and persisted URL/domain ignores.
- Report failures when discarding inactive tabs.
- Offer **Restore most recently closed tab/window** using browser-wide session history. This restores one browser-chosen session, not an exact undo of a dashboard operation or batch.

### Reliability and accessibility

- Protect loaded and loading dashboard tabs during bulk closure.
- Preserve domain selections and logical keyboard focus through refreshes.
- Improve contrast, visible focus, menu placement and long notifications, including narrow windows and zoom.
- Remove broad host permissions from Chrome while retaining Firefox's existing host permissions.
- Package both browsers at the exact source version with tag-bound provenance and verified source identity on publication retries.
