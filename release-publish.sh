#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
ZIP_FILE="$ROOT/tab-triage-dashboard.zip"

# --- Determine tag ---
TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [ -z "$TAG" ]; then
	echo "Error: no git tag found. Run 'npm run release' first."
	exit 1
fi

echo "Publishing release for tag: $TAG"

# --- Build zip if missing ---
if [ ! -f "$ZIP_FILE" ]; then
	echo "Building zip..."
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
	NOTES=$(git log "$PREV_TAG".."$TAG" --pretty=format:"- %s" | grep -v "^- chore: release" || true)
else
	NOTES=$(git log "$TAG" --pretty=format:"- %s" | grep -v "^- chore: release" || true)
fi

if gh release view "$TAG" &>/dev/null; then
	echo "Release $TAG exists, uploading zip..."
	gh release upload "$TAG" "$ZIP_FILE" --clobber
else
	echo "Creating GitHub release..."
	gh release create "$TAG" "$ZIP_FILE" \
		--title "$TAG" \
		--notes "$NOTES"
fi

echo "Done. Published $TAG with $ZIP_FILE."
