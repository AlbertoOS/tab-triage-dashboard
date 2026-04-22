#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
ZIP_FF="$ROOT/tab-triage-dashboard-firefox.zip"
ZIP_CR="$ROOT/tab-triage-dashboard-chrome.zip"

# --- Determine tag ---
TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [ -z "$TAG" ]; then
	echo "Error: no git tag found. Run 'npm run release' first."
	exit 1
fi

echo "Publishing release for tag: $TAG"

# --- Build zips if missing ---
if [ ! -f "$ZIP_FF" ] || [ ! -f "$ZIP_CR" ]; then
	echo "Building zips..."
	npm run zip
fi

# --- Ensure tag is pushed ---
git push --tags 2>/dev/null || true

# --- Create or update GitHub release ---
if ! command -v gh &>/dev/null; then
	echo "Error: gh CLI not found. Install it from https://cli.github.com"
	exit 1
fi

# Get the parent tag for release notes
PREV_TAG=$(git describe --tags --abbrev=0 "$TAG^" 2>/dev/null || echo "")
if [ -n "$PREV_TAG" ]; then
	COMMIT_LOG=$(git log "$PREV_TAG".."$TAG" --pretty=format:"%s" | grep -v "^chore: release" | grep -v "^chore: prepare" || true)
else
	COMMIT_LOG=$(git log "$TAG" --pretty=format:"%s" | grep -v "^chore: release" | grep -v "^chore: prepare" || true)
fi

# Categorize commits
FEATURES=$(echo "$COMMIT_LOG" | grep -E '^feat(\(.+\))?:' | sed 's/^feat\([^)]*\)\?: //' || true)
FIXES=$(echo "$COMMIT_LOG" | grep -E '^fix(\(.+\))?:' | sed 's/^fix\([^)]*\)\?: //' || true)
OTHER=$(echo "$COMMIT_LOG" | grep -vE '^(feat|fix)(\(.+\))?:' | grep -vE '^$' || true)

NOTES="## What's Changed"$'\n'
if [ -n "$FEATURES" ]; then
	NOTES+=$'\n'"### Features"$'\n'
	while IFS= read -r line; do
		NOTES+="- $line"$'\n'
	done <<<"$FEATURES"
fi
if [ -n "$FIXES" ]; then
	NOTES+=$'\n'"### Fixes"$'\n'
	while IFS= read -r line; do
		NOTES+="- $line"$'\n'
	done <<<"$FIXES"
fi
if [ -n "$OTHER" ]; then
	NOTES+=$'\n'"### Other"$'\n'
	while IFS= read -r line; do
		NOTES+="- $line"$'\n'
	done <<<"$OTHER"
fi

NOTES+=$'\n'"---"$'\n'
NOTES+=$'\n'"### All Commits"$'\n'
if [ -n "$PREV_TAG" ]; then
	NOTES+=$(git log "$PREV_TAG".."$TAG" --pretty=format:"- %s (%h)" | grep -v "chore: release" | grep -v "chore: prepare" || true)
else
	NOTES+=$(git log "$TAG" --pretty=format:"- %s (%h)" | grep -v "chore: release" | grep -v "chore: prepare" || true)
fi

if gh release view "$TAG" &>/dev/null; then
	echo "Release $TAG exists, uploading zips..."
	gh release upload "$TAG" "$ZIP_FF" "$ZIP_CR" --clobber
else
	echo "Creating GitHub release..."
	gh release create "$TAG" "$ZIP_FF" "$ZIP_CR" \
		--title "$TAG" \
		--notes "$NOTES"
fi

echo "Done. Published $TAG with Firefox and Chrome zips."
