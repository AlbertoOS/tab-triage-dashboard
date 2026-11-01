#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Legacy no-argument publishing remains supported; explicit selection is preferred.
TAG="${1-$(git describe --tags --abbrev=0 2> /dev/null || true)}"
BUILD_ONLY=""
if [ "$#" -gt 1 ]; then
  if [ "$#" -ne 3 ] || [ "$2" != "--build-only" ]; then
    echo "Usage: $0 [TAG [--build-only EXISTING-OUTPUT-DIR]]" >&2
    exit 1
  fi
  BUILD_ONLY="$(cd "$3" && pwd)"
fi
if [[ ! "$TAG" =~ ^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "Error: select an existing release tag matching [v]MAJOR.MINOR.PATCH." >&2
  exit 1
fi
git check-ref-format "refs/tags/$TAG"
TAG_OBJECT=$(git rev-parse --verify "refs/tags/$TAG")
COMMIT=$(git rev-parse --verify "${TAG_OBJECT}^{commit}")

umask 077
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/tab-triage-release.XXXXXX")
trap 'rm -rf -- "$SCRATCH"' EXIT
mkdir "$SCRATCH/source" "$SCRATCH/assets"
# Export only distribution inputs. Never execute scripts from a historical tag.
git archive --format=tar "$COMMIT" -- package.json manifest.firefox.json manifest.chrome.json \
  background.js triage.html triage.js utils.js triage.css icons/ | tar -xf - -C "$SCRATCH/source"
# Compare exported bytes with regular Git blobs; attributes must not rewrite them.
git ls-tree -rz "$COMMIT" -- package.json manifest.firefox.json manifest.chrome.json \
  background.js triage.html triage.js utils.js triage.css icons/ > "$SCRATCH/tree"
node - "$SCRATCH/source" "$SCRATCH/tree" << 'NODE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
try {
  const entries = fs.readFileSync(process.argv[3], "utf8").split("\0").filter(Boolean).map((entry) => {
    const tab = entry.indexOf("\t");
    const [mode, type, hash] = entry.slice(0, tab).split(" ");
    return { mode, type, hash, name: entry.slice(tab + 1) };
  });
  if (entries.some(({ mode, type }) => !["100644", "100755"].includes(mode) || type !== "blob")) throw new Error();
  for (const { hash, name } of entries) {
    const file = path.join(process.argv[2], name);
    if (!fs.lstatSync(file).isFile()) throw new Error();
    const bytes = fs.readFileSync(file);
    const actual = crypto.createHash(hash.length === 64 ? "sha256" : "sha1")
      .update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (actual !== hash) throw new Error();
  }
} catch {
  console.error("Error: exported source must match exact regular tag blobs (no symlinks or export transformations).");
  process.exit(1);
}
NODE
# Validate identity before packaging or any remote operation.
node - "$SCRATCH/source/package.json" "${TAG#v}" << 'NODE'
const fs = require("node:fs");
if (JSON.parse(fs.readFileSync(process.argv[2], "utf8")).version !== process.argv[3]) {
  console.error("Error: selected tag and source package version must match exactly.");
  process.exit(1);
}
NODE
bash "$ROOT/build-zip.sh" all "$SCRATCH/source" "$SCRATCH/assets"
ZIP_FF="$SCRATCH/assets/tab-triage-dashboard-firefox.zip"
ZIP_CR="$SCRATCH/assets/tab-triage-dashboard-chrome.zip"
node - "$SCRATCH/assets" "$TAG" "$TAG_OBJECT" "$COMMIT" << 'NODE'
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const [assets, tag, tagObject, commit] = process.argv.slice(2);
const sha256 = {};
for (const browser of ["firefox", "chrome"]) {
  const file = `tab-triage-dashboard-${browser}.zip`;
  sha256[file] = crypto.createHash("sha256").update(fs.readFileSync(path.join(assets, file))).digest("hex");
}
fs.writeFileSync(path.join(assets, "provenance.json"), JSON.stringify({ tag, tagObject, commit, version: tag.replace(/^v/, ""), sha256 }, null, 2) + "\n");
NODE
if [ -n "$BUILD_ONLY" ]; then
  cp "$ZIP_FF" "$ZIP_CR" "$SCRATCH/assets/provenance.json" "$BUILD_ONLY/"
  echo "Built $TAG from $COMMIT in $BUILD_ONLY (no publication)."
  exit 0
fi

# Push exactly the selected immutable tag object; a failed push stops publication.
[ "$(git rev-parse --verify "refs/tags/$TAG")" = "$TAG_OBJECT" ]
git push --no-follow-tags origin "$TAG_OBJECT:refs/tags/$TAG"

# --- Create or update GitHub release ---
if ! command -v gh &> /dev/null; then
  echo "Error: gh CLI not found. Install it from https://cli.github.com"
  exit 1
fi

# Get the parent tag for release notes
PREV_TAG=$(git describe --tags --abbrev=0 "$TAG^" 2> /dev/null || echo "")
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
  done <<< "$FEATURES"
fi
if [ -n "$FIXES" ]; then
  NOTES+=$'\n'"### Fixes"$'\n'
  while IFS= read -r line; do
    NOTES+="- $line"$'\n'
  done <<< "$FIXES"
fi
if [ -n "$OTHER" ]; then
  NOTES+=$'\n'"### Other"$'\n'
  while IFS= read -r line; do
    NOTES+="- $line"$'\n'
  done <<< "$OTHER"
fi

NOTES+=$'\n'"---"$'\n'
NOTES+=$'\n'"### All Commits"$'\n'
if [ -n "$PREV_TAG" ]; then
  NOTES+=$(git log "$PREV_TAG".."$TAG" --pretty=format:"- %s (%h)" | grep -v "chore: release" | grep -v "chore: prepare" || true)
else
  NOTES+=$(git log "$TAG" --pretty=format:"- %s (%h)" | grep -v "chore: release" | grep -v "chore: prepare" || true)
fi

if gh release view "$TAG" &> /dev/null; then
  echo "Release $TAG exists, uploading zips..."
  gh release upload "$TAG" "$ZIP_FF" "$ZIP_CR" "$SCRATCH/assets/provenance.json" --clobber
else
  echo "Creating GitHub release..."
  gh release create "$TAG" "$ZIP_FF" "$ZIP_CR" "$SCRATCH/assets/provenance.json" \
    --verify-tag --title "$TAG" \
    --notes "$NOTES"
fi

echo "Done. Published $TAG with Firefox and Chrome zips."
