"""Dispatch the existing Firefox publisher once when this workflow is introduced."""

from datetime import datetime
import json
import os
import re
import stat
from pathlib import Path
import subprocess


def unique_object(pairs):
    """Reject ambiguous provider JSON rather than silently accepting the last key."""
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError
        result[key] = value
    return result


def main():
    env = os.environ
    attempt = env.get("GITHUB_RUN_ATTEMPT", "")
    repository = env.get("GITHUB_REPOSITORY", "")
    before = env.get("BOOTSTRAP_BEFORE", "")
    after = env.get("BOOTSTRAP_AFTER", "")
    sha = env.get("GITHUB_SHA", "")
    if (env.get("GITHUB_EVENT_NAME") != "push"
            or env.get("GITHUB_REF") != "refs/heads/main"
            or env.get("GITHUB_REF_TYPE") != "branch"
            or not re.fullmatch(r"[1-9][0-9]*", attempt)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", repository)
            or any(not re.fullmatch(r"[0-9a-f]{40}", value) or value == "0" * 40
                   for value in (before, after, sha))
            or after != sha):
        print("Firefox bootstrap rejected: invalid source context.")
        return 1
    if attempt != "1":
        print("Firefox bootstrap skipped: use the manual Firefox workflow for retries.")
        return 0
    try:
        def git(*args):
            return subprocess.run(
                ["git", *args], input="", capture_output=True, text=True,
                timeout=30, check=True,
            ).stdout.strip("\n")

        if git("cat-file", "-t", before) != "commit" or git("rev-parse", "HEAD") != sha:
            raise ValueError
        previous = git("ls-tree", "-z", before, "--", ".github/workflows/bootstrap-firefox.yml")
        current = git("ls-tree", "-z", after, "--", ".github/workflows/bootstrap-firefox.yml")
        if not re.fullmatch(
                r"100(?:644|755) blob [0-9a-f]{40}\t\.github/workflows/bootstrap-firefox\.yml\x00",
                current):
            raise ValueError
    except (OSError, ValueError, subprocess.SubprocessError):
        print("Firefox bootstrap rejected: checkout history could not be verified.")
        return 1
    if previous:
        print("Firefox bootstrap skipped: workflow already existed.")
        return 0
    try:
        publisher = ".github/workflows/publish-firefox.yml"
        entry = git("ls-tree", "-z", after, "--", publisher)
        if (not re.fullmatch(r"100(?:644|755) blob [0-9a-f]{40}\t" + re.escape(publisher) + r"\x00", entry)
                or not stat.S_ISREG(Path(publisher).lstat().st_mode)):
            raise ValueError
    except (OSError, ValueError, subprocess.SubprocessError):
        print("Firefox bootstrap rejected: merge the Firefox publishing workflow first.")
        return 1
    try:
        release = json.loads(subprocess.run(
            ["gh", "api", "--method", "GET", f"repos/{repository}/releases/latest"],
            input="", capture_output=True, text=True, timeout=30, check=True,
        ).stdout, object_pairs_hook=unique_object)
        if (not isinstance(release, dict)
                or type(release.get("id")) is not int or release["id"] <= 0
                or release.get("draft") is not False
                or release.get("prerelease") is not False
                or not isinstance(release.get("tag_name"), str)
                or not re.fullmatch(r"v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", release["tag_name"])
                or not isinstance(release.get("published_at"), str)
                or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", release["published_at"])):
            raise ValueError
        datetime.fromisoformat(release["published_at"])
    except (OSError, ValueError, RecursionError, subprocess.SubprocessError):
        print("Firefox bootstrap stopped: no verified published stable release is available.")
        return 1
    payload = {
        "ref": "main",
        "inputs": {
            "release-tag": release["tag_name"],
            "operation": "publish",
        },
    }
    try:
        subprocess.run(
            ["gh", "api", "--method", "POST",
             f"repos/{repository}/actions/workflows/publish-firefox.yml/dispatches",
             "--input", "-"],
            input=json.dumps(payload, separators=(",", ":")), capture_output=True,
            text=True, timeout=30, check=True,
        )
    except (OSError, ValueError, subprocess.SubprocessError):
        print("Firefox dispatch outcome uncertain: inspect Firefox workflow runs before a manual retry.")
        return 1
    print("Firefox bootstrap dispatch accepted; publication must be verified in the Firefox workflow.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
