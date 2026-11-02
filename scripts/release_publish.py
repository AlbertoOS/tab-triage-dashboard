"""Resumable GitHub releases from reviewed main commits; no store credentials."""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from typing import Any

import store_publish as store

ROOT = Path(__file__).resolve().parents[1]
ZIPS = store.ZIP_NAMES
ASSETS = store.ASSETS
LIMIT = store.LIMIT
BOT = "github-actions[bot]"
EMAIL = "41898282+github-actions[bot]@users.noreply.github.com"


class Failure(Exception):
    """Static, safe diagnostics only."""


def require(condition, message):
    if not condition:
        raise Failure(message)


def guard(env=None):
    env = os.environ if env is None else env
    repo = env.get("GITHUB_REPOSITORY", "")
    require(
        re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo), "Invalid repository."
    )
    require(
        env.get("GITHUB_EVENT_NAME") in ("push", "workflow_dispatch")
        and env.get("GITHUB_REF") == "refs/heads/main"
        and env.get("GITHUB_REF_TYPE") == "branch"
        and env.get("GITHUB_WORKFLOW_REF")
        == f"{repo}/.github/workflows/release.yml@refs/heads/main",
        "Release publication requires the exact trusted main workflow.",
    )


def run(args, cwd=ROOT, data=None):
    result = subprocess.run(args, cwd=cwd, input=data, capture_output=True, timeout=180)
    require(len(result.stdout) <= LIMIT, "Operation result exceeds the size limit.")
    return result.returncode, result.stdout


def command(args, cwd=ROOT, data=None):
    code, raw = run(args, cwd, data)
    require(code == 0, "Git/GitHub operation failed; inspect state before retrying.")
    return raw


def api(endpoint, method="GET", payload=None, missing=False, binary=False) -> Any:
    args = ["gh", "api", endpoint, "--method", method]
    if binary:
        args += ["-H", "Accept: application/octet-stream"]
        return command(args)
    args += ["--include"]
    if payload is not None:
        args += ["--input", "-"]
    code, raw = run(
        args, data=json.dumps(payload).encode() if payload is not None else None
    )
    header, separator, body = raw.replace(b"\r\n", b"\n").partition(b"\n\n")
    status = re.match(rb"HTTP/\S+ ([0-9]{3})", header)
    if not separator or status is None:
        raise Failure("GitHub response did not contain an HTTP status.")
    status = int(status[1])
    if missing and status == 404:
        return None
    require(
        code == 0 and 200 <= status < 300,
        "GitHub request failed; no absence or success is assumed.",
    )
    return json.loads(body) if body.strip() else None


class Publisher:
    def __init__(self, root, repository):
        self.root = Path(root)
        require(
            re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository),
            "Invalid repository.",
        )
        self.repository = repository

    def git(self, *args, data=None):
        return command(["git", *args], self.root, data)

    def request(self, suffix, **kwargs) -> Any:
        return api(f"repos/{self.repository}/{suffix}", **kwargs)

    def assert_main(self, intent):
        comparison = self.request(f"compare/{intent['commit']}...main")
        require(
            comparison.get("status") in ("ahead", "identical")
            and comparison.get("base_commit", {}).get("sha") == intent["commit"],
            "Release source is no longer reachable from remote main.",
        )

    def tag_object(self, intent):
        epoch = int(self.git("show", "-s", "--format=%ct", intent["commit"]).strip())
        date = (
            datetime.datetime.fromtimestamp(epoch, datetime.timezone.utc)
            .isoformat()
            .replace("+00:00", "Z")
        )
        message = f"Release {intent['tag']}\n\nSource: {intent['commit']}\nPrevious: {intent['previousTag']}\n"
        raw = (
            f"object {intent['commit']}\ntype commit\ntag {intent['tag']}\n"
            f"tagger {BOT} <{EMAIL}> {epoch} +0000\n\n{message}"
        ).encode()
        oid = (
            self.git("hash-object", "-w", "-t", "tag", "--stdin", data=raw)
            .decode()
            .strip()
        )
        payload = {
            "tag": intent["tag"],
            "message": message,
            "object": intent["commit"],
            "type": "commit",
            "tagger": {"name": BOT, "email": EMAIL, "date": date},
        }
        return oid, payload

    def assert_tag(self, intent, oid):
        ref = self.request(f"git/ref/tags/{intent['tag']}")
        require(
            ref.get("object", {}).get("type") == "tag"
            and ref.get("object", {}).get("sha") == oid,
            "Annotated remote tag identity changed; it will not be replaced.",
        )

    def ensure_tag(self, intent):
        oid, payload = self.tag_object(intent)
        ref = self.request(f"git/ref/tags/{intent['tag']}", missing=True)
        if ref is None:
            self.assert_main(intent)
            created = self.request("git/tags", method="POST", payload=payload)
            require(
                created.get("sha") == oid,
                "Server tag object differs from the deterministic tag identity.",
            )
            self.request(
                "git/refs",
                method="POST",
                payload={"ref": f"refs/tags/{intent['tag']}", "sha": oid},
            )
            self.assert_tag(intent, oid)
        else:
            require(
                ref.get("object", {}).get("type") == "tag"
                and ref["object"]["sha"] == oid,
                "Existing tag conflicts with the exact planned annotated object.",
            )
        local = self.git("show-ref", "--tags").decode().splitlines()
        existing = [
            line.split()[0]
            for line in local
            if line.split()[1] == f"refs/tags/{intent['tag']}"
        ]
        require(
            not existing or existing == [oid],
            "Local tag conflicts with the planned release.",
        )
        if not existing:
            self.git("update-ref", f"refs/tags/{intent['tag']}", oid, "0" * len(oid))
        return oid

    def verify_zip(self, intent, name, raw):
        browser = "firefox" if name == ZIPS[0] else "chrome"
        tree = self.git(
            "ls-tree",
            "-rz",
            intent["commit"],
            "--",
            *store.SOURCES,
            "icons/",
            f"manifest.{browser}.json",
        )
        expected = {}
        for record in tree.split(b"\0"):
            if not record:
                continue
            meta, path = record.split(b"\t", 1)
            mode, kind, oid = meta.decode().split()
            require(
                mode in ("100644", "100755") and kind == "blob",
                "Release source has a non-regular entry.",
            )
            name_in_zip = (
                "manifest.json"
                if path.decode() == f"manifest.{browser}.json"
                else path.decode()
            )
            expected[name_in_zip] = self.git("cat-file", "blob", oid)
        require(
            all(name in expected for name in store.SOURCES)
            and any(name.startswith("icons/") for name in expected),
            "Release distribution is incomplete.",
        )
        require(
            json.loads(expected["manifest.json"])["version"] == intent["version"],
            "Archive source version mismatch.",
        )
        store.verify_zip(raw, expected)

    def provenance(self, intent, oid, assets):
        return (
            json.dumps(
                {
                    "tag": intent["tag"],
                    "tagObject": oid,
                    "commit": intent["commit"],
                    "version": intent["version"],
                    "sha256": {
                        name: hashlib.sha256(assets[name]).hexdigest() for name in ZIPS
                    },
                },
                indent=2,
            )
            + "\n"
        ).encode()

    def verify_assets(self, intent, oid, assets):
        require(
            set(assets) == set(ASSETS),
            "Release must contain exactly both archives and provenance.",
        )
        provenance = json.loads(assets["provenance.json"])
        require(
            provenance == json.loads(self.provenance(intent, oid, assets)),
            "Release provenance/asset hashes conflict.",
        )
        for name in ZIPS:
            self.verify_zip(intent, name, assets[name])

    def build(self, intent):
        with tempfile.TemporaryDirectory(prefix="release-build-") as temp:
            command(
                [
                    "bash",
                    str(self.root / "release-publish.sh"),
                    intent["tag"],
                    "--build-only",
                    temp,
                ],
                self.root,
            )
            return {name: (Path(temp) / name).read_bytes() for name in ZIPS}

    def complete_assets(self, intent, oid, existing):
        require(
            set(existing) <= set(ASSETS),
            "Unexpected release assets require manual inspection.",
        )
        assets = dict(existing)
        if any(name not in assets for name in ZIPS):
            built = self.build(intent)
            for name in ZIPS:
                assets.setdefault(name, built[name])
        assets.setdefault("provenance.json", self.provenance(intent, oid, assets))
        self.verify_assets(intent, oid, assets)
        return assets

    def read_assets(self, release):
        assets = {}
        page = 1
        while True:
            batch = self.request(
                f"releases/{release['id']}/assets?per_page=100&page={page}"
            )
            require(isinstance(batch, list), "Invalid release asset inventory.")
            for entry in batch:
                name = entry.get("name")
                require(
                    name in ASSETS
                    and name not in assets
                    and entry.get("state") == "uploaded"
                    and 0 < entry.get("size", 0) <= LIMIT,
                    "Release asset inventory conflicts or is incomplete.",
                )
                assets[name] = self.request(
                    f"releases/assets/{entry['id']}", binary=True
                )
                require(
                    len(assets[name]) == entry["size"],
                    "Downloaded release asset size mismatch.",
                )
            if len(batch) < 100:
                return assets
            page += 1

    def upload(self, tag, name, raw):
        with tempfile.TemporaryDirectory(prefix="release-upload-") as temp:
            file = Path(temp) / name
            file.write_bytes(raw)
            command(
                ["gh", "release", "upload", tag, str(file), "--repo", self.repository],
                self.root,
            )

    def validate_release(self, release, intent):
        # GitHub may retain a branch hint here; the annotated tag and provenance bind source identity.
        require(
            type(release.get("id")) is int
            and release.get("tag_name") == intent["tag"]
            and type(release.get("draft")) is bool
            and release.get("prerelease") is False,
            "GitHub release identity conflicts with the plan.",
        )

    def find_release(self, tag):
        published = self.request(f"releases/tags/{tag}", missing=True)
        if published is not None:
            return published
        # The by-tag endpoint excludes drafts; authenticated inventory is required for recovery.
        matches = []
        page = 1
        while True:
            batch = self.request(f"releases?per_page=100&page={page}")
            require(isinstance(batch, list), "Invalid release inventory.")
            matches.extend(item for item in batch if item.get("tag_name") == tag)
            require(len(matches) <= 1, "Multiple releases match the tag; manual inspection is required.")
            if len(batch) < 100:
                return matches[0] if matches else None
            page += 1

    def publish(self, intent):
        self.assert_main(intent)
        oid = self.ensure_tag(intent)
        release = self.find_release(intent["tag"])
        if release is not None:
            self.validate_release(release, intent)
            if release["draft"] is False:
                self.verify_assets(intent, oid, self.read_assets(release))
                self.assert_tag(intent, oid)
                return False
        existing = self.read_assets(release) if release is not None else {}
        assets = self.complete_assets(intent, oid, existing)
        if release is None:
            from release_plan import release_notes

            self.assert_main(intent)
            self.assert_tag(intent, oid)
            release = self.request(
                "releases",
                method="POST",
                payload={
                    "tag_name": intent["tag"],
                    "target_commitish": intent["commit"],
                    "name": intent["tag"],
                    "body": release_notes(self.root, intent, self.repository),
                    "draft": True,
                    "prerelease": False,
                    "generate_release_notes": False,
                },
            )
            self.validate_release(release, intent)
            require(
                release["draft"],
                "Release creation must remain draft until assets are verified.",
            )
        for name in ASSETS:
            if name not in existing:
                self.assert_main(intent)
                self.assert_tag(intent, oid)
                self.upload(intent["tag"], name, assets[name])
        self.verify_assets(intent, oid, self.read_assets(release))
        self.assert_main(intent)
        self.assert_tag(intent, oid)
        self.request(
            f"releases/{release['id']}",
            method="PATCH",
            payload={"draft": False, "prerelease": False, "make_latest": "true"},
        )
        verified = self.request(f"releases/tags/{intent['tag']}")
        self.validate_release(verified, intent)
        require(
            verified["draft"] is False,
            "Publication has not been confirmed by readback.",
        )
        self.verify_assets(intent, oid, self.read_assets(verified))
        self.assert_tag(intent, oid)
        return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--head", required=True, help="Pinned trusted main snapshot")
    parser.add_argument(
        "--output",
        required=True,
        help="Newly published tags for the separate dispatch job",
    )
    args = parser.parse_args()
    guard()
    from release_plan import pending_releases

    head = (
        command(["git", "rev-parse", "--verify", f"{args.head}^{{commit}}"], ROOT)
        .decode()
        .strip()
    )
    require(
        head == os.environ.get("GITHUB_SHA"),
        "Selected source must match the trusted workflow snapshot.",
    )
    intents = pending_releases(ROOT, head)
    published = []
    publisher = Publisher(ROOT, os.environ["GITHUB_REPOSITORY"])
    # Persist each success before proceeding; failed later releases must not hide earlier handoffs.
    output = Path(args.output)
    output.write_text("[]\n")
    for intent in intents:
        if publisher.publish(intent):
            published.append(intent["tag"])
            output.write_text(json.dumps(published) + "\n")
        print(
            f"Verified GitHub release {intent['tag']}; existing publications are not overwritten or redispatched."
        )


if __name__ == "__main__":
    try:
        main()
    except (
        Failure,
        store.Failure,
        ValueError,
        KeyError,
        TypeError,
        OSError,
        subprocess.SubprocessError,
    ):
        raise SystemExit(
            "Release operation stopped; inspect tag, draft, assets and dispatch runs before recovery. No raw response is logged."
        )
