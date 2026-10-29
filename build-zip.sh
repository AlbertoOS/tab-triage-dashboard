#!/usr/bin/env bash
# Build with verbatim source versions, never a Git-derived suffix.
# Usage: bash build-zip.sh [firefox|chrome|all] [source-dir] [output-dir]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-all}"
SOURCE="$(cd "${2:-$ROOT}" && pwd)"
OUTPUT="$(cd "${3:-$ROOT}" && pwd)"
case "$TARGET" in
  firefox | chrome | all) ;;
  *)
    echo "Usage: $0 [firefox|chrome|all] [source-dir] [output-dir]" >&2
    exit 1
    ;;
esac

VERSION=$(
  node - "$SOURCE" << 'NODE'
const fs = require("node:fs");
const path = require("node:path");
const versions = ["package.json", "manifest.firefox.json", "manifest.chrome.json"].map((file) =>
  JSON.parse(fs.readFileSync(path.join(process.argv[2], file), "utf8")).version);
if (versions.some((version) => typeof version !== "string" || version !== versions[0])) {
  console.error("Error: package and browser manifest versions must match exactly.");
  process.exit(1);
}
console.log(versions[0]);
NODE
)
echo "Build version: $VERSION"

umask 077
STAGING=$(mktemp -d "${TMPDIR:-/tmp}/tab-triage-build.XXXXXX")
trap 'rm -rf -- "$STAGING"' EXIT
SRC_FILES=(background.js triage.html triage.js utils.js triage.css icons/)

build_zip() {
  local browser="$1"
  local stage="$STAGING/$browser"
  local zip_out="$OUTPUT/tab-triage-dashboard-${browser}.zip"
  mkdir "$stage"
  for f in "${SRC_FILES[@]}"; do
    cp -r "$SOURCE/$f" "$stage/"
  done
  cp "$SOURCE/manifest.${browser}.json" "$stage/manifest.json"
  (cd "$stage" && zip -qr -X "$STAGING/$browser.zip" manifest.json "${SRC_FILES[@]}" -x '*.DS_Store')
  mv "$STAGING/$browser.zip" "$zip_out"
  echo "Built $zip_out (v$VERSION)"
}

case "$TARGET" in
  firefox | chrome) build_zip "$TARGET" ;;
  all)
    build_zip firefox
    build_zip chrome
    ;;
esac
