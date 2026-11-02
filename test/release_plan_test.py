"""Offline semantic release integration tests using disposable real Git repositories."""

import json
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PLANNER = ROOT / "scripts/release_plan.py"
SOURCES = (
    "package.json",
    "manifest.firefox.json",
    "manifest.chrome.json",
    "package-lock.json",
)


class ReleasePlanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(
            prefix="release-plan-", dir=os.environ.get("TMPDIR")
        )
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "commit.gpgsign", "false")
        self.git("config", "core.hooksPath", str(self.repo / "disabled-hooks"))
        self.versions("1.4.0")
        self.anchor = self.commit("chore: baseline")
        self.git("tag", "-a", "v1.4.0", "-m", "Baseline")
        self.config = {
            "baseline": {
                "version": "1.4.0",
                "tag": "v1.4.0",
                "tagObject": self.git("rev-parse", "v1.4.0"),
                "commit": self.anchor,
            }
        }
        (self.repo / "scripts").mkdir()
        (self.repo / "scripts/release-config.json").write_text(
            json.dumps(self.config) + "\n"
        )
        self.commit("ci: configure planner")
        self.base = self.git("rev-parse", "HEAD")
        self.git("checkout", "-b", "topic")

    def git(self, *args):
        result = subprocess.run(
            ["git", "-C", str(self.repo), *args],
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip()

    def commit(self, message):
        self.git("add", ".")
        self.git("commit", "--allow-empty", "-m", message)
        return self.git("rev-parse", "HEAD")

    def versions(self, version):
        for name in SOURCES:
            data = {"name": "fixture", "version": version}
            if name == "package-lock.json":
                data.update(
                    {
                        "lockfileVersion": 1,
                        "dependencies": {"fixture": {"version": "7.8.9"}},
                    }
                )
            (self.repo / name).write_text(json.dumps(data, indent=2) + "\n")

    def cli(self, *args, ok=True):
        result = subprocess.run(
            ["python3", "-B", str(PLANNER), *args],
            cwd=self.repo,
            capture_output=True,
            text=True,
        )
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("Traceback", result.stderr)
        return result

    def test_prepare_preview_then_write_and_check(self):
        self.commit("feat: add clustering")
        before = {name: (self.repo / name).read_bytes() for name in SOURCES}
        refs = self.git("show-ref")
        result = json.loads(self.cli("prepare", "--base", self.base).stdout)
        self.assertEqual(result["version"], "1.5.0")
        self.assertEqual(result["bump"], "minor")
        self.assertEqual(
            before, {name: (self.repo / name).read_bytes() for name in SOURCES}
        )
        self.cli("prepare", "--base", self.base, "--write")
        for name in SOURCES:
            self.assertEqual(
                json.loads((self.repo / name).read_text())["version"], "1.5.0"
            )
        self.assertEqual(
            json.loads((self.repo / "package-lock.json").read_text())["dependencies"][
                "fixture"
            ]["version"],
            "7.8.9",
        )
        self.assertEqual(refs, self.git("show-ref"))
        self.commit("chore(release): prepare versions")
        self.cli(
            "check",
            "--base",
            self.base,
            "--head",
            "HEAD",
            "--pr-title",
            "feat: add clustering",
        )


    def test_pending_planned_boundaries_prevent_version_reuse(self):
        self.versions("1.5.0")
        first = self.commit("feat: clustering (#21)")
        self.git("branch", "-f", "main", first)
        self.commit("docs: release guidance")
        base = self.git("rev-parse", "HEAD")
        self.git("branch", "-f", "main", base)
        self.versions("1.5.1")
        second = self.commit("fix: preserve tab focus (#22)")
        self.git("branch", "-f", "main", second)
        pending = json.loads(self.cli("pending", "--head", second).stdout)
        self.assertEqual(pending["head"], second)
        self.assertEqual(pending["releases"], [
            {"version": "1.5.0", "tag": "v1.5.0", "commit": first, "previousCommit": self.anchor, "previousTag": "v1.4.0", "bump": "minor"},
            {"version": "1.5.1", "tag": "v1.5.1", "commit": second, "previousCommit": first, "previousTag": "v1.5.0", "bump": "patch"},
        ])
        self.git("tag", "-a", "v1.5.0", first, "-m", "Already published")
        self.assertEqual(json.loads(self.cli("pending", "--head", second).stdout), pending)
        self.commit("fix: next PR")
        plan = json.loads(self.cli("prepare", "--base", second).stdout)
        self.assertEqual(plan["version"], "1.5.2")
        self.assertEqual(plan["previousCommit"], second)


    def test_release_notes_use_dag_bodies_links_and_escape_untrusted_text(self):
        first = self.commit("fix: avoid [bad](https://invalid.example) <script> (#31)")
        breaking = self.commit("refactor: change protocol\n\nBREAKING-CHANGE: remove legacy payload")
        self.versions("2.0.0")
        release = self.commit("feat: ship protocol (#32)")
        text = self.cli("notes", "--commit", release, "--repository", "owner/repo").stdout
        self.assertIn("### Breaking changes", text)
        self.assertIn("### Features", text)
        self.assertIn("### Fixes", text)
        self.assertIn(f"https://github.com/owner/repo/commit/{first}", text)
        self.assertIn(f"https://github.com/owner/repo/commit/{breaking}", text)
        self.assertIn("https://github.com/owner/repo/pull/31", text)
        self.assertIn("https://github.com/owner/repo/pull/32", text)
        self.assertIn("https://github.com/owner/repo/compare/v1.4.0...v2.0.0", text)
        self.assertNotIn("<script>", text)
        self.assertNotIn("[bad](https://invalid.example)", text)
        self.cli("notes", "--commit", self.anchor, "--repository", "owner/repo", ok=False)
        self.cli("notes", "--commit", release, "--repository", "owner/repo;echo", ok=False)


    def test_stale_base_is_rejected_against_known_main_ref(self):
        self.commit("docs: first change")
        new_base = self.commit("docs: advance main")
        self.git("branch", "-f", "main", new_base)
        self.commit("fix: candidate")
        self.cli("prepare", "--base", self.base, ok=False)
        self.cli("prepare", "--base", new_base)


    def test_conventional_commit_severity_and_no_release_matrix(self):
        cases = [
            ("feat: add groups", "minor", "1.5.0"),
            ("fix(scope): restore focus", "patch", "1.4.1"),
            ("feat!: remove legacy view", "major", "2.0.0"),
            ("docs!: replace documented protocol", "major", "2.0.0"),
            ("ci(build)!: change contract", "major", "2.0.0"),
            ("refactor: protocol\n\nBREAKING CHANGE: remove field", "major", "2.0.0"),
            ("chore: protocol\n\nBREAKING-CHANGE: remove field", "major", "2.0.0"),
            ("docs: prose mentions BREAKING CHANGE: example", None, "1.4.0"),
            ("docs: example\n\nNot a BREAKING CHANGE: marker", None, "1.4.0"),
            ("docs: update guide", None, "1.4.0"),
            ("ci: update job", None, "1.4.0"),
            ("test: add fixtures", None, "1.4.0"),
            ("chore: tidy files", None, "1.4.0"),
            ("chore(release)!: change the release contract\n\nBREAKING CHANGE: incompatible release contract", "major", "2.0.0"),
            ("FEAT: add search", "minor", "1.5.0"),
            ("Fix(scope): restore focus", "patch", "1.4.1"),
        ]
        for index, (message, bump, version) in enumerate(cases):
            with self.subTest(message=message):
                self.git("checkout", "-b", f"case-{index}", self.base)
                head = self.commit(message)
                plan = json.loads(self.cli("prepare", "--base", self.base).stdout)
                self.assertEqual((plan["bump"], plan["version"]), (bump, version))
                if bump:
                    self.cli("pending", "--head", head, ok=False)
                else:
                    self.assertEqual(json.loads(self.cli("pending", "--head", head).stdout)["releases"], [])

    def test_merge_uses_full_dag_and_highest_body_severity(self):
        self.commit("fix: low priority")
        change = self.commit("refactor: change storage\n\nBREAKING CHANGE: incompatible data")
        self.versions("2.0.0")
        self.commit("chore(release): prepare versions")
        self.git("checkout", "main")
        self.git("merge", "--no-ff", "topic", "-m", "Merge pull request #44 from owner/topic")
        merged = self.git("rev-parse", "HEAD")
        releases = json.loads(self.cli("pending", "--head", merged).stdout)["releases"]
        self.assertEqual(len(releases), 1)
        self.assertEqual((releases[0]["commit"], releases[0]["bump"]), (merged, "major"))
        notes = self.cli("notes", "--commit", merged, "--repository", "owner/repo").stdout
        self.assertIn(f"/commit/{change}", notes)
        self.assertIn("/pull/44", notes)
        self.assertNotIn("chore(release)", notes)

    def test_late_fix_after_preparation_preserves_supported_merge_contract(self):
        self.git("checkout", "-b", "late-fix")
        self.commit("feat: add search")
        self.cli("prepare", "--base", self.base, "--write")
        self.commit("chore(release): prepare versions")
        self.commit("fix: preserve focus")
        self.cli("check", "--base", self.base, "--head", "HEAD", "--pr-title", "feat: add search")
        plan = json.loads(self.cli("prepare", "--base", self.base).stdout)
        self.assertEqual(plan["version"], "1.5.0")
        self.cli("pending", "--head", "HEAD", ok=False)

        self.git("checkout", "main")
        self.git("merge", "--no-ff", "late-fix", "-m", "Merge pull request #13 from example/late-fix")
        merged = json.loads(self.cli("pending", "--head", "HEAD").stdout)["releases"]
        self.assertEqual(merged[0]["version"], "1.5.0")
        self.assertEqual(merged[0]["commit"], self.git("rev-parse", "HEAD"))

        self.git("checkout", "-b", "squash-late-fix", self.base)
        self.git("merge", "--squash", "late-fix")
        self.commit("feat: add search (#13)")
        squashed = json.loads(self.cli("pending", "--head", "HEAD").stdout)["releases"]
        self.assertEqual(squashed[0]["version"], "1.5.0")
        self.assertEqual(squashed[0]["commit"], self.git("rev-parse", "HEAD"))

    def test_check_title_cannot_hide_actual_pr_severity(self):
        self.versions("2.0.0")
        self.commit("refactor!: remove API")
        for title in ("fix: improve API", "feat: improve API", "docs: update API"):
            self.cli("check", "--base", self.base, "--head", "HEAD", "--pr-title", title, ok=False)
        self.cli("check", "--base", self.base, "--head", "HEAD", "--pr-title", "refactor!: remove API")

    def test_squash_title_severity_must_match_not_overstate_pr_commits(self):
        self.versions("1.4.1")
        self.commit("fix: preserve focus")
        for title in ("feat: preserve focus", "fix!: preserve focus"):
            self.cli("check", "--base", self.base, "--head", "HEAD", "--pr-title", title, ok=False)
        self.cli("check", "--base", self.base, "--head", "HEAD", "--pr-title", "fix: preserve focus")
        self.git("checkout", "-b", "docs-only", self.base)
        self.commit("docs: explain focus")
        self.cli("check", "--base", self.base, "--head", "HEAD", "--pr-title", "fix: explain focus", ok=False)

    def test_check_binds_configuration_to_committed_candidate(self):
        path = self.repo / "scripts/release-config.json"
        path.write_text('{"baseline": {}}')
        self.commit("docs: corrupt committed config")
        path.write_text(json.dumps(self.config))
        self.cli("check", "--base", self.base, "--head", "HEAD", ok=False)

    def test_preparation_does_not_change_non_lock_packages_metadata(self):
        package = self.repo / "package.json"
        data = json.loads(package.read_text())
        data["packages"] = {"": {"version": "9.9.9"}}
        original = json.dumps(data, indent=2) + "\n"
        package.write_text(original)
        self.commit("fix: preserve unrelated metadata")
        self.cli("prepare", "--base", self.base, "--write")
        self.assertEqual(package.read_text(), original.replace('"version": "1.4.0"', '"version": "1.4.1"'))

    def test_check_rejects_mismatched_candidate_sources(self):
        self.commit("feat: add feature")
        self.cli("check", "--base", self.base, "--head", "HEAD", ok=False)
        self.versions("1.5.0")
        (self.repo / "manifest.chrome.json").write_text('{"version": "1.4.0"}')
        self.commit("chore(release): incomplete versions")
        self.cli("check", "--base", self.base, "--head", "HEAD", ok=False)

    def test_invalid_planned_transition_is_rejected(self):
        for index, (message, version) in enumerate((("docs: no release", "1.4.1"), ("feat: feature", "1.4.1"), ("fix: fix", "1.6.0"))):
            with self.subTest(message=message, version=version):
                self.git("checkout", "-b", f"bad-{index}", self.base)
                self.versions(version)
                head = self.commit(message)
                self.cli("pending", "--head", head, ok=False)

    def test_trailing_releasing_commits_fail_but_docs_are_allowed(self):
        self.versions("1.4.1")
        release = self.commit("fix: first change")
        docs = self.commit("docs: explain change")
        self.assertEqual(len(json.loads(self.cli("pending", "--head", docs).stdout)["releases"]), 1)
        self.commit("feat: missing version preparation")
        self.cli("pending", "--head", "HEAD", ok=False)
        self.assertEqual(len(json.loads(self.cli("pending", "--head", release).stdout)["releases"]), 1)

    def test_source_duplicates_and_symlinks_are_rejected_without_writes(self):
        self.commit("fix: new change")
        target = self.repo / "manifest.chrome.json"
        target.write_text('{"version":"1.4.0","version":"1.4.0"}')
        before = (self.repo / "package.json").read_bytes()
        self.cli("prepare", "--base", self.base, "--write", ok=False)
        self.assertEqual((self.repo / "package.json").read_bytes(), before)
        target.unlink()
        target.symlink_to("package.json")
        self.cli("prepare", "--base", self.base, "--write", ok=False)
        self.commit("chore: symlink source")
        self.cli("check", "--base", self.base, "--head", "HEAD", ok=False)
        self.cli("pending", "--head", "HEAD", ok=False)

    def test_moved_and_lightweight_anchors_are_rejected(self):
        self.git("tag", "-f", "v1.4.0", self.anchor)
        self.cli("prepare", "--base", self.base, ok=False)
        self.git("tag", "-f", "-a", "v1.4.0", self.anchor, "-m", "Replacement object")
        self.cli("prepare", "--base", self.base, ok=False)
        self.git("tag", "-f", "-a", "v1.4.0", self.base, "-m", "Moved commit")
        self.cli("pending", "--head", "HEAD", ok=False)

    def test_config_ambiguity_and_snapshot_binding(self):
        path = self.repo / "scripts/release-config.json"
        path.write_text('{"baseline":{},"baseline":{}}')
        self.cli("prepare", "--base", self.base, ok=False)
        self.assertEqual(json.loads(self.cli("pending", "--head", self.base).stdout)["releases"], [])
        self.commit("ci: corrupt config")
        self.cli("pending", "--head", "HEAD", ok=False)

    def test_nonancestor_and_optionlike_refs_are_rejected(self):
        future = self.commit("docs: divergent base")
        self.git("checkout", "-b", "divergent", self.base)
        self.commit("fix: independent change")
        self.cli("prepare", "--base", future, ok=False)
        self.cli("prepare", "--base=-invalid-ref", ok=False)

    def test_shallow_history_is_rejected(self):
        clone = self.repo / "shallow"
        subprocess.run(["git", "clone", "--depth", "1", "--branch", "main", self.repo.as_uri(), str(clone)], capture_output=True, check=True)
        result = subprocess.run(["python3", "-B", str(PLANNER), "pending", "--head", "HEAD"], cwd=clone, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Traceback", result.stderr)

    def test_prepare_preserves_bytes_and_fixes_only_lock_root_versions(self):
        lock = self.repo / "package-lock.json"
        original = '{\r\n\t"name":"fixture", "version" : "0.1.0",\r\n"lockfileVersion":3,"packages":{"":{"version":"0.1.0","name":"fixture"},"node_modules/lib":{"version":"7.8.9"}},"extra":["1.4.0",{"version":"1.4.0"}]}\r\n'
        lock.write_bytes(original.encode())
        self.commit("fix: lock metadata")
        self.cli("prepare", "--base", self.base, "--write")
        self.assertEqual(lock.read_bytes(), original.replace('"0.1.0"', '"1.4.1"').encode())
        self.commit("chore(release): prepare versions")
        self.cli("check", "--base", self.base, "--head", "HEAD")

    def test_legacy_lock_without_root_version_can_be_prepared(self):
        lock = self.repo / "package-lock.json"
        data = json.loads(lock.read_text())
        del data["version"]
        lock.write_text(json.dumps(data))
        self.commit("fix: migrate release metadata")
        self.cli("prepare", "--base", self.base, "--write")
        data = json.loads(lock.read_text())
        self.assertEqual(data["version"], "1.4.1")
        self.assertEqual(data["dependencies"]["fixture"]["version"], "7.8.9")

    def test_unsupported_versions_are_rejected(self):
        for version in ("1.4.0-dev", "1.4", "01.4.0", "65536.0.0", "0.0.0", 17):
            with self.subTest(version=version):
                self.versions(version)
                self.cli("prepare", "--base", self.base, ok=False)


    def test_browser_component_overflow_is_rejected(self):
        for index, (version, message) in enumerate((("65535.0.0", "feat!: overflow"), ("1.65535.0", "feat: overflow"), ("1.4.65535", "fix: overflow"))):
            with self.subTest(version=version):
                self.git("checkout", "-b", f"overflow-{index}", self.base)
                self.versions(version)
                anchor = self.commit("chore: high version baseline")
                tag = "v" + version
                self.git("tag", "-a", tag, "-m", "High baseline")
                config = {"baseline": {"version": version, "tag": tag, "tagObject": self.git("rev-parse", tag), "commit": anchor}}
                (self.repo / "scripts/release-config.json").write_text(json.dumps(config))
                base = self.commit("ci: new fixture baseline")
                self.git("branch", "-f", "main", base)
                self.commit(message)
                self.cli("prepare", "--base", base, ok=False)

    def test_first_parent_anchor_cannot_be_only_a_merged_side_parent(self):
        self.git("checkout", "--orphan", "unrelated")
        (self.repo / "marker").write_text("unrelated history")
        self.commit("chore: unrelated root")
        self.git("merge", "--no-ff", "--allow-unrelated-histories", "main", "-m", "Merge baseline as second parent")
        self.cli("pending", "--head", "HEAD", ok=False)

    def test_bootstrap_config_can_be_uncommitted_for_preparation_only(self):
        self.git("checkout", "-b", "bootstrap", self.anchor)
        (self.repo / "scripts").mkdir(exist_ok=True)
        (self.repo / "scripts/release-config.json").write_text(json.dumps(self.config))
        self.git("branch", "-f", "main", self.anchor)
        self.cli("prepare", "--base", self.anchor)
        self.cli("pending", "--head", self.anchor, ok=False)

    def test_pr_links_require_reliable_subject_markers(self):
        self.commit("fix: discuss #98 without a reliable marker\n\nSee #99 in prose")
        self.versions("1.4.1")
        release = self.commit("fix: deliver change (#100)")
        text = self.cli("notes", "--commit", release, "--repository", "owner/repo").stdout
        self.assertIn("/pull/100", text)
        self.assertNotIn("/pull/98", text)
        self.assertNotIn("/pull/99", text)

    def test_no_release_check_requires_unchanged_consistent_versions(self):
        self.commit("docs: release reference")
        self.cli("check", "--base", self.base, "--head", "HEAD", "--pr-title", "docs: release reference")
        self.versions("1.4.1")
        self.commit("chore(release): unnecessary version bump")
        self.cli("check", "--base", self.base, "--head", "HEAD", ok=False)


    def test_prepare_rejects_malformed_lock_before_any_write(self):
        self.commit("fix: new change")
        before = (self.repo / "package.json").read_bytes()
        for data in ({}, {"lockfileVersion": True}, {"lockfileVersion": 99}, {"lockfileVersion": 3, "packages": {"": {}}}):
            with self.subTest(data=data):
                (self.repo / "package-lock.json").write_text(json.dumps(data))
                self.cli("prepare", "--base", self.base, "--write", ok=False)
                self.assertEqual((self.repo / "package.json").read_bytes(), before)


    def test_public_import_contract_and_legacy_anchor_lock_exception(self):
        lock = self.repo / "package-lock.json"
        data = json.loads(lock.read_text())
        del data["version"]
        lock.write_text(json.dumps(data))
        anchor = self.commit("chore: legacy anchor metadata")
        self.git("tag", "-f", "-a", "v1.4.0", anchor, "-m", "Fixture legacy anchor")
        self.config["baseline"]["commit"] = anchor
        self.config["baseline"]["tagObject"] = self.git("rev-parse", "v1.4.0")
        (self.repo / "scripts/release-config.json").write_text(json.dumps(self.config))
        base = self.commit("ci: fixture migration")
        self.git("branch", "-f", "main", base)
        self.commit("fix: migrate metadata")
        self.cli("prepare", "--base", base, "--write")
        commit = self.commit("chore(release): prepare versions")
        spec = importlib.util.spec_from_file_location("release_plan_fixture", PLANNER)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        intents = module.pending_releases(self.repo)
        self.assertEqual(len(intents), 1)
        self.assertEqual(intents[0]["commit"], commit)
        self.assertEqual(intents[0]["previousCommit"], anchor)
        self.assertEqual(module.load_config(self.repo), self.config)
        self.assertEqual(module.git(self.repo, "rev-parse", "HEAD"), commit)
        self.assertIn("/compare/v1.4.0...v1.4.1", module.release_notes(self.repo, intents[0], "owner/repo"))


if __name__ == "__main__":
    unittest.main()
