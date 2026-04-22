#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
MANIFEST_FF="$ROOT/manifest.firefox.json"
MANIFEST_CR="$ROOT/manifest.chrome.json"
PACKAGE="$ROOT/package.json"

# --- Read current version from manifest.firefox.json ---
CURRENT=$(grep '"version"' "$MANIFEST_FF" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')

# Normalize to semver (e.g. "1.0" -> "1.0.0")
IFS='.' read -r MAJOR MINOR PATCH <<<"$CURRENT"
MAJOR=${MAJOR:-0}
MINOR=${MINOR:-0}
PATCH=${PATCH:-0}

echo "Current version: $MAJOR.$MINOR.$PATCH"

# --- Determine bump type from conventional commits since last tag ---
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")

if [ -n "$LAST_TAG" ]; then
	COMMITS=$(git log "$LAST_TAG"..HEAD --pretty=format:"%s")
else
	COMMITS=$(git log --pretty=format:"%s")
fi

if [ -z "$COMMITS" ]; then
	echo "No commits since last release. Nothing to do."
	exit 0
fi

BUMP="patch"

while IFS= read -r msg; do
	# BREAKING CHANGE in footer or ! after type -> major
	if echo "$msg" | grep -qiE '^[a-z]+(\(.+\))?!:|BREAKING CHANGE'; then
		BUMP="major"
		break
	fi
	# feat: -> at least minor
	if echo "$msg" | grep -qE '^feat(\(.+\))?:'; then
		BUMP="minor"
	fi
done <<<"$COMMITS"

# --- Compute new version ---
case "$BUMP" in
major) NEW_VERSION="$((MAJOR + 1)).0.0" ;;
minor) NEW_VERSION="$MAJOR.$((MINOR + 1)).0" ;;
patch) NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))" ;;
esac

echo "Bump type: $BUMP"
echo "New version: $NEW_VERSION"
echo ""

# --- Show commits being released ---
echo "Commits in this release:"
if [ -n "$LAST_TAG" ]; then
	git log "$LAST_TAG"..HEAD --pretty=format:"  - %s"
else
	git log --pretty=format:"  - %s"
fi
echo ""
echo ""

# --- Confirm ---
read -rp "Release v$NEW_VERSION? [y/N] " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
	echo "Aborted."
	exit 1
fi

# --- Update version in manifest files and package.json ---
sed -i "s/\"version\": *\"$CURRENT\"/\"version\": \"$NEW_VERSION\"/" "$MANIFEST_FF"
sed -i "s/\"version\": *\"$CURRENT\"/\"version\": \"$NEW_VERSION\"/" "$MANIFEST_CR"
if grep -q '"version"' "$PACKAGE"; then
	sed -i "s/\"version\": *\"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" "$PACKAGE"
fi

# --- Lint and test before releasing ---
echo "Running lint..."
npm run lint

echo "Running tests..."
npm test

# --- Build zip ---
echo "Building zip..."
npm run zip

# --- Commit version bump, tag, and create GitHub release ---
git add "$MANIFEST_FF" "$MANIFEST_CR" "$PACKAGE"
git commit -m "chore: release v$NEW_VERSION"
git tag -a "v$NEW_VERSION" -m "v$NEW_VERSION"

echo "Pushing tag..."
git push && git push --tags

ZIP_FF="$ROOT/tab-triage-dashboard-firefox.zip"
ZIP_CR="$ROOT/tab-triage-dashboard-chrome.zip"
if command -v gh &>/dev/null && [ -f "$ZIP_FF" ]; then
	echo "Creating GitHub release..."
	# Build release notes from commits since last tag (excluding the release commit itself)
	COMMIT_LOG=""
	if [ -n "$LAST_TAG" ]; then
		COMMIT_LOG=$(git log "$LAST_TAG"..HEAD~1 --pretty=format:"%s")
	else
		COMMIT_LOG=$(git log HEAD~1 --pretty=format:"%s")
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
	if [ -n "$LAST_TAG" ]; then
		NOTES+=$(git log "$LAST_TAG"..HEAD~1 --pretty=format:"- %s (%h)")
	else
		NOTES+=$(git log HEAD~1 --pretty=format:"- %s (%h)")
	fi

	gh release create "v$NEW_VERSION" "$ZIP_FF" "$ZIP_CR" \
		--title "v$NEW_VERSION" \
		--notes "$NOTES"
else
	echo "Skipping GitHub release (gh CLI not found or zip missing)."
fi

git push

echo ""
echo "Released v$NEW_VERSION."
