#!/usr/bin/env bash
# build-zip.sh — Build extension zip(s) with computed build number
# Usage: bash build-zip.sh [firefox|chrome|all]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-all}"

# --- Compute version with build number ---
BASE_VERSION=$(grep '"version"' "$ROOT/manifest.firefox.json" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [ -n "$LAST_TAG" ]; then
	BUILD=$(git rev-list "$LAST_TAG"..HEAD --count)
else
	BUILD=$(git rev-list HEAD --count)
fi
VERSION="$BASE_VERSION.$BUILD"
echo "Build version: $VERSION"

SRC_FILES="background.js triage.html triage.js utils.js triage.css icons/"

build_zip() {
	local browser="$1"
	local manifest_src="$ROOT/manifest.${browser}.json"
	local zip_out="$ROOT/tab-triage-dashboard-${browser}.zip"
	local tmpdir
	tmpdir=$(mktemp -d)

	# Copy sources to temp dir
	for f in $SRC_FILES; do
		cp -r "$ROOT/$f" "$tmpdir/"
	done

	# Copy manifest with computed version
	cp "$manifest_src" "$tmpdir/manifest.json"
	sed -i "s/\"version\": *\"[^\"]*\"/\"version\": \"$VERSION\"/" "$tmpdir/manifest.json"

	(cd "$tmpdir" && zip -r -FS "$zip_out" manifest.json $SRC_FILES -x '*.DS_Store')
	rm -rf "$tmpdir"
	echo "Built $zip_out (v$VERSION)"
}

case "$TARGET" in
	firefox) build_zip firefox ;;
	chrome)  build_zip chrome ;;
	all)     build_zip firefox; build_zip chrome ;;
	*)       echo "Usage: $0 [firefox|chrome|all]"; exit 1 ;;
esac
