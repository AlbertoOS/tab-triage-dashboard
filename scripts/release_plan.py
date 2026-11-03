#!/usr/bin/env python3
"""Deterministic, offline semantic release planning and original-PR preparation.

Only ``prepare --write`` changes files. No command changes Git references or calls
hosting APIs. Publication must consume planned source commits, not working files.
"""

import argparse
import html
import json
from pathlib import Path
import re
import stat
import subprocess
import sys
import unicodedata

from workflow_diagnostics import emit

SOURCES = (
    "package.json",
    "manifest.firefox.json",
    "manifest.chrome.json",
    "package-lock.json",
)
CONFIG = "scripts/release-config.json"
RANK = {None: 0, "patch": 1, "minor": 2, "major": 3}
HEADER = re.compile(r"^([a-z][a-z0-9-]*)(?:\(([^\r\n()]+)\))?(!)?: .+", re.ASCII | re.IGNORECASE)


class PlanError(ValueError):
    """An invalid or incomplete release history, safe to report to callers."""


def git(repo, *args):
    """Run Git with literal argv and never include child diagnostics in errors."""
    try:
        result = subprocess.run(
            ["git", "-C", str(repo), *args], capture_output=True, check=True
        )
        return result.stdout.decode("utf-8", errors="replace").rstrip("\n")
    except (OSError, subprocess.SubprocessError) as error:
        fields = {"exit_code": error.returncode} if isinstance(error, subprocess.CalledProcessError) else {}
        emit("planner", "runtime", "failed", **fields)
        raise PlanError(
            "Git operation failed; verify references and complete history"
        ) from None


def resolve(repo, ref):
    if (
        not isinstance(ref, str)
        or not ref
        or ref.startswith("-")
        or any(ord(c) < 32 for c in ref)
    ):
        raise PlanError("Invalid revision")
    return git(repo, "rev-parse", "--verify", "--end-of-options", ref + "^{commit}")


def version_parts(version):
    if not isinstance(version, str) or not re.fullmatch(
        r"(?:0|[1-9][0-9]{0,4})\.(?:0|[1-9][0-9]{0,4})\.(?:0|[1-9][0-9]{0,4})", version
    ):
        raise PlanError("Unsupported version; expected three numeric components")
    parts = tuple(map(int, version.split(".")))
    if max(parts) > 65535 or not any(parts):
        raise PlanError("Version outside browser component limits")
    return parts


def bumped(version, bump):
    parts = list(version_parts(version))
    if bump:
        index = {"major": 0, "minor": 1, "patch": 2}[bump]
        parts[index] += 1
        parts[index + 1 :] = [0] * (2 - index)
    result = ".".join(map(str, parts))
    version_parts(result)
    return result


def parse_json(text):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise PlanError("Duplicate JSON key")
            result[key] = value
        return result

    try:
        result = json.loads(
            text,
            object_pairs_hook=unique,
            parse_constant=lambda _: (_ for _ in ()).throw(
                PlanError("Invalid JSON constant")
            ),
        )
    except (ValueError, TypeError):
        raise PlanError("Invalid or ambiguous JSON") from None
    if not isinstance(result, dict):
        raise PlanError("Expected a JSON object")
    return result


def worktree_text(repo, name):
    path = Path(repo)
    mode = path.lstat().st_mode
    for component in Path(name).parts:
        path = path / component
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode):
            raise PlanError("Source and configuration paths must not be symlinks")
    if not stat.S_ISREG(mode):
        raise PlanError("Expected a regular source file")
    return path.read_bytes().decode("utf-8")


def blob_text(repo, ref, name):
    entry = git(repo, "ls-tree", ref, "--", name).split("\t", 1)
    if (
        len(entry) != 2
        or entry[1] != name
        or entry[0].split()[:2] not in (["100644", "blob"], ["100755", "blob"])
    ):
        raise PlanError("Expected a committed regular source blob")
    return git(repo, "show", ref + ":" + name)


def sources(repo, ref=None, legacy_lock=False) -> tuple[str, dict[str, str]]:
    texts = {
        name: worktree_text(repo, name) if ref is None else blob_text(repo, ref, name)
        for name in SOURCES
    }
    data = {name: parse_json(text) for name, text in texts.items()}
    version = data[SOURCES[0]].get("version")
    version_parts(version)
    if not isinstance(version, str):
        raise PlanError("Expected a source version string")
    for name in SOURCES[1:]:
        if name == "package-lock.json" and legacy_lock:
            if "version" in data[name] and not isinstance(data[name]["version"], str):
                raise PlanError("Legacy lockfile root version must be absent or a string")
            continue
        if data[name].get("version") != version:
            raise PlanError("Version sources disagree")
    lock = data["package-lock.json"]
    lock_version = lock.get("lockfileVersion")
    if type(lock_version) is not int or lock_version not in (1, 2, 3):
        raise PlanError("Unsupported lockfile structure")
    if lock_version >= 2 and "packages" not in lock:
        raise PlanError("Missing lockfile root package")
    if "packages" in lock:
        packages = lock["packages"]
        if not isinstance(packages, dict) or not isinstance(packages.get(""), dict):
            raise PlanError("Invalid lockfile root package")
        if not isinstance(packages[""].get("version"), str):
            raise PlanError("Missing lockfile root package version")
        if not legacy_lock and packages[""].get("version") != version:
            raise PlanError("Lockfile root package version disagrees")
    return version, texts


def load_config(repo, ref=None):
    """Load a validated immutable baseline (worktree by default, snapshot if ref)."""
    if git(repo, "rev-parse", "--is-shallow-repository") != "false":
        raise PlanError("Shallow history is not supported; fetch complete history")
    config = parse_json(
        worktree_text(repo, CONFIG) if ref is None else blob_text(repo, ref, CONFIG)
    )
    baseline = config.get("baseline")
    if (
        set(config) != {"baseline"}
        or not isinstance(baseline, dict)
        or set(baseline) != {"version", "tag", "tagObject", "commit"}
    ):
        raise PlanError("Invalid release baseline configuration")
    version_parts(baseline["version"])
    if baseline["tag"] != "v" + baseline["version"] or any(
        not isinstance(baseline[key], str)
        or not re.fullmatch(r"[0-9a-f]{40}", baseline[key])
        for key in ("commit", "tagObject")
    ):
        raise PlanError("Invalid release baseline identity")
    tag = "refs/tags/" + baseline["tag"]
    if (
        git(repo, "cat-file", "-t", tag) != "tag"
        or git(repo, "rev-parse", "--verify", tag) != baseline["tagObject"]
        or resolve(repo, tag) != baseline["commit"]
    ):
        raise PlanError("Baseline tag was moved or is not the pinned annotated tag")
    if sources(repo, baseline["commit"], legacy_lock=True)[0] != baseline["version"]:
        raise PlanError("Baseline source version disagrees")
    return config


def classification(message):
    lines = message.splitlines()
    match = HEADER.fullmatch(lines[0]) if lines else None
    if not match:
        return None
    if match[3] or any(
        re.match(r"^BREAKING(?: CHANGE|-CHANGE):\s*\S", line) for line in lines[1:]
    ):
        return "major"
    return {"feat": "minor", "fix": "patch"}.get(match[1].lower())


def messages(repo, previous, head):
    return [
        (sha, git(repo, "show", "-s", "--format=%B", sha))
        for sha in git(
            repo, "rev-list", "--reverse", previous + ".." + head
        ).splitlines()
    ]


def severity(repo, previous, head):
    return max(
        (classification(message) for _, message in messages(repo, previous, head)),
        key=lambda item: RANK[item],
        default=None,
    )


def ancestor(repo, previous, head):
    if git(repo, "merge-base", previous, head) != previous:
        raise PlanError("Base must be an ancestor of the candidate")


def scan(repo, head, config, require_prepared):
    """Find version transitions only on the selected first-parent main line."""
    baseline = config["baseline"]
    first_parents = git(repo, "rev-list", "--first-parent", head).splitlines()
    if baseline["commit"] not in first_parents:
        raise PlanError("Baseline must be on the selected first-parent history")
    commits = list(reversed(first_parents[:first_parents.index(baseline["commit"])]))
    previous, version, tag = baseline["commit"], baseline["version"], baseline["tag"]
    releases = []
    for commit in commits:
        current, _ = sources(repo, commit, legacy_lock=not releases)
        if current == version:
            continue
        sources(repo, commit)
        bump = severity(repo, previous, commit)
        if bump is None or current != bumped(version, bump):
            raise PlanError("Version transition does not match its semantic commit range")
        intent = {"version": current, "tag": "v" + current, "commit": commit,
                  "previousCommit": previous, "previousTag": tag, "bump": bump}
        releases.append(intent)
        previous, version, tag = commit, current, intent["tag"]
    if require_prepared and severity(repo, previous, head):
        raise PlanError("Releasing commits lack an original-PR version transition")
    if require_prepared:
        sources(repo, head)
    return releases


def pending_releases(repo, head="HEAD"):
    """Return every planned intent after the anchor, including published intents.

    Configuration is read from the exact selected commit, never the worktree.
    The caller reconciles immutable tags/releases with hosting-provider state.
    """
    head = resolve(repo, head)
    return scan(repo, head, load_config(repo, head), require_prepared=True)


def expectation(repo, base, head, committed_config=False):
    base, head = resolve(repo, base), resolve(repo, head)
    ancestor(repo, base, head)
    known_refs = git(repo, "for-each-ref", "--format=%(refname)", "refs/remotes/origin/main", "refs/heads/main").splitlines()
    main_ref = next((ref for ref in ("refs/remotes/origin/main", "refs/heads/main") if ref in known_refs), None)
    if main_ref is not None and resolve(repo, main_ref) != base:
        raise PlanError("Base is stale relative to the known main reference")
    config = load_config(repo, head if committed_config else None)
    releases = scan(repo, base, config, require_prepared=False)
    boundary = releases[-1] if releases else config["baseline"]
    bump = severity(repo, boundary["commit"], head)
    return {
        "version": bumped(boundary["version"], bump),
        "tag": "v" + bumped(boundary["version"], bump),
        "bump": bump,
        "head": head,
        "base": base,
        "previousCommit": boundary["commit"],
        "previousTag": boundary["tag"],
    }


def markdown(text):
    text = "".join(c if not unicodedata.category(c).startswith("C") else " " for c in text)
    text = html.escape(text, quote=False).replace("@", "&#64;")
    return re.sub(r"([\\`*_{}\[\]()#!|~])", r"\\\1", text)


def release_notes(repo, intent, repository):
    """Render safe categorized notes from the exact intent's complete DAG range."""
    if not isinstance(repository, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", repository):
        raise PlanError("Invalid repository identifier")
    if intent not in pending_releases(repo, intent["commit"]):
        raise PlanError("Notes require a validated planned release intent")
    url = "https://github.com/" + repository
    categories = {"Breaking changes": [], "Features": [], "Fixes": [], "Other changes": []}
    for sha, message in messages(repo, intent["previousCommit"], intent["commit"]):
        subject = message.splitlines()[0] if message.splitlines() else ""
        match = HEADER.fullmatch(subject)
        if match and match[1].lower() == "chore" and (match[2] or "").lower() == "release" and classification(message) is None:
            continue
        bump = classification(message)
        category = {None: "Other changes", "major": "Breaking changes", "minor": "Features", "patch": "Fixes"}[bump]
        links = [f"[{sha[:7]}]({url}/commit/{sha})"]
        pr = re.search(r"\(#([1-9][0-9]*)\)$", subject) or re.match(r"^Merge pull request #([1-9][0-9]*) from \S+$", subject)
        if pr:
            links.append(f"[#{pr[1]}]({url}/pull/{pr[1]})")
        categories[category].append(f"- {markdown(subject)} ({', '.join(links)})")
    lines = ["## " + intent["tag"], ""]
    for category, entries in categories.items():
        if entries:
            lines.extend(["### " + category, "", *entries, ""])
    lines.append(f"[Full changelog]({url}/compare/{intent['previousTag']}...{intent['tag']})")
    return "\n".join(lines) + "\n"


def replace_versions(text, version, lockfile=False):
    """Replace only version-value spans; keep all other bytes and formatting."""
    decoder = json.JSONDecoder()
    spans = {}

    def value(index, path):
        while text[index].isspace():
            index += 1
        start = index
        if text[index] == "{":
            index += 1
            while True:
                while text[index].isspace():
                    index += 1
                if text[index] == "}":
                    return index + 1
                key, index = decoder.raw_decode(text, index)
                while text[index].isspace():
                    index += 1
                index = value(index + 1, path + (key,))
                while text[index].isspace():
                    index += 1
                if text[index] == "}":
                    return index + 1
                index += 1
        if text[index] == "[":
            _, index = decoder.raw_decode(text, index)
        else:
            _, index = decoder.raw_decode(text, index)
        spans[path] = (start, index)
        return index

    value(0, ())
    replacements = []
    paths = (("version",), ("packages", "", "version")) if lockfile else (("version",),)
    for path in paths:
        if path in spans:
            replacements.append((*spans[path], json.dumps(version)))
    if ("version",) not in spans:
        # Legacy v1 locks can omit the root version entirely.
        opening = text.index("{") + 1
        replacements.append(
            (opening, opening, '\n  "version": ' + json.dumps(version) + ",")
        )
    for start, end, replacement in sorted(replacements, reverse=True):
        text = text[:start] + replacement + text[end:]
    return text


def main(argv=None):
    emit("planner", "runtime", "start", runtime_version=".".join(map(str, sys.version_info[:3])))
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("prepare")
    prepare.add_argument("--base", required=True)
    prepare.add_argument("--write", action="store_true")
    check = commands.add_parser("check")
    check.add_argument("--base", required=True)
    check.add_argument("--head", required=True)
    check.add_argument("--pr-title")
    pending = commands.add_parser("pending")
    pending.add_argument("--head", required=True)
    notes = commands.add_parser("notes")
    notes.add_argument("--commit", required=True)
    notes.add_argument("--repository", required=True)
    args = parser.parse_args(argv)
    repo = Path.cwd()
    emit("planner", "plan", "start")
    try:
        if args.command == "notes":
            commit = resolve(repo, args.commit)
            intents = pending_releases(repo, commit)
            intent = next((item for item in intents if item["commit"] == commit), None)
            if intent is None:
                raise PlanError("Commit is not a planned release boundary")
            print(release_notes(repo, intent, args.repository), end="")
            emit("planner", "plan", "complete", version=intent["version"], tag=intent["tag"], commit=commit)
            return 0
        if args.command == "pending":
            head = resolve(repo, args.head)
            releases = pending_releases(repo, head)
            print(json.dumps({"head": head, "releases": releases}, sort_keys=True))
            emit("planner", "plan", "complete", commit=head, release_count=len(releases))
            return 0
        intent = expectation(
            repo, args.base, "HEAD" if args.command == "prepare" else args.head,
            committed_config=args.command == "check",
        )
        if args.command == "prepare":
            _, texts = sources(repo, legacy_lock=True)
            if args.write:
                emit("planner", "metadata", "start", version=intent["version"], write=True)
                replacements = {
                    name: replace_versions(text, intent["version"], lockfile=name == "package-lock.json")
                    for name, text in texts.items()
                }
                for name, text in replacements.items():
                    (repo / name).write_bytes(text.encode("utf-8"))
                emit("planner", "metadata", "complete", count=len(replacements), write=True)
        else:
            if sources(repo, intent["head"])[0] != intent["version"]:
                raise PlanError(
                    "Candidate versions do not match the semantic release plan"
                )
            if (
                args.pr_title is not None
                and RANK[classification(args.pr_title)]
                != RANK[severity(repo, intent["base"], intent["head"])]
            ):
                raise PlanError("PR title severity differs from the PR commit severity")
        emit("planner", "plan", "complete", version=intent["version"], tag=intent["tag"],
             commit=intent["head"], bump=intent["bump"] or "none")
        print(json.dumps(intent, sort_keys=True))
        return 0
    except (PlanError, OSError, UnicodeError):
        emit("planner", "plan", "failed")
        print(
            "Release planning failed: invalid sources, configuration, versions, or history",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
