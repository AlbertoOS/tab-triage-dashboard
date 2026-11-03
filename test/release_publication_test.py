"""Offline release recovery contracts; no live GitHub/store operations."""

import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))


class PublicationTests(unittest.TestCase):
    def test_publisher_entrypoint_exists(self):
        self.assertTrue(
            (ROOT / "scripts/release_publish.py").is_file(),
            "a resumable main-only publisher must exist",
        )

    def module(self):
        import release_publish

        return release_publish

    def test_no_remote_mutation_outside_exact_main_workflow(self):
        module = self.module()
        allowed = {
            "GITHUB_REPOSITORY": "owner/repo",
            "GITHUB_EVENT_NAME": "push",
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_REF_TYPE": "branch",
            "GITHUB_WORKFLOW_REF": "owner/repo/.github/workflows/release.yml@refs/heads/main",
        }
        module.guard(allowed)
        for field, value in (
            ("GITHUB_EVENT_NAME", "pull_request"),
            ("GITHUB_REF", "refs/tags/main"),
            ("GITHUB_REF_TYPE", "tag"),
            (
                "GITHUB_WORKFLOW_REF",
                "owner/repo/.github/workflows/other.yml@refs/heads/main",
            ),
        ):
            with self.subTest(field=field), self.assertRaises(module.Failure):
                module.guard({**allowed, field: value})

    def test_real_api_and_command_boundaries_report_only_safe_status(self):
        module = self.module()
        sink = io.StringIO()
        with (
            patch.object(sys, "stderr", sink),
            patch.object(
                module,
                "run",
                return_value=(
                    1,
                    b"HTTP/2.0 429 synthetic-credential-sentinel\r\n\r\nsynthetic-credential-sentinel",
                ),
            ) as run,
        ):
            with self.assertRaises(module.Failure):
                module.api(
                    "synthetic-credential-sentinel",
                    payload={"token": "synthetic-credential-sentinel"},
                )
            self.assertEqual(run.call_count, 1)
        records = [
            json.loads(line.removeprefix("Workflow diagnostic: "))
            for line in sink.getvalue().splitlines()
        ]
        self.assertTrue(
            any(
                item.get("http_status") == 429 and item.get("exit_code") == 1
                for item in records
            ),
            "real API boundary must retain status without raw HTTP",
        )
        self.assertEqual(records[-1]["event"], "failed")
        self.assertNotIn("synthetic-credential-sentinel", sink.getvalue())
        sink = io.StringIO()
        with (
            patch.object(sys, "stderr", sink),
            patch.object(
                module, "run", return_value=(7, b"synthetic-credential-sentinel")
            ) as run,
        ):
            with self.assertRaises(module.Failure):
                module.command(["synthetic-credential-sentinel"])
            self.assertEqual(run.call_count, 1)
        self.assertIn('"exit_code": 7', sink.getvalue())
        self.assertNotIn("synthetic-credential-sentinel", sink.getvalue())

    def test_main_emits_runtime_and_persists_receipt_when_sink_fails_after_write(self):
        module = self.module()
        commit = "1" * 40
        intents = [{"tag": "v1.0.1"}, {"tag": "v1.0.2"}]
        with tempfile.TemporaryDirectory(prefix="release-diagnostic-") as temp:
            output = Path(temp) / "receipt.json"
            sink = io.StringIO()
            with (
                patch.object(
                    sys,
                    "argv",
                    ["release_publish.py", "--head", commit, "--output", str(output)],
                ),
                patch.object(sys, "stderr", sink),
                patch.object(module, "guard"),
                patch.object(module, "command", return_value=commit.encode()),
                patch.dict(
                    module.os.environ,
                    {"GITHUB_SHA": commit, "GITHUB_REPOSITORY": "owner/repo"},
                ),
                patch("release_plan.pending_releases", return_value=intents),
                patch.object(
                    module.Publisher, "publish", side_effect=[True, False]
                ) as publish,
                patch("builtins.print"),
            ):
                module.main()
                self.assertEqual(publish.call_count, 2)
            self.assertEqual(json.loads(output.read_text()), ["v1.0.1"])
            records = [
                json.loads(line.removeprefix("Workflow diagnostic: "))
                for line in sink.getvalue().splitlines()
            ]
            self.assertTrue(
                records, "real entrypoint must emit runtime and receipt diagnostics"
            )
            self.assertEqual(records[0]["stage"], "runtime")
            self.assertIn("runtime_version", records[0])
            self.assertIn(
                ("receipt", "complete"), [(r["stage"], r["event"]) for r in records]
            )

            class AfterWriteSink:
                def write(self, line):
                    if output.exists():
                        raise BrokenPipeError("synthetic-sink-failure")

            output.unlink()
            with (
                patch.object(
                    sys,
                    "argv",
                    ["release_publish.py", "--head", commit, "--output", str(output)],
                ),
                patch.object(sys, "stderr", AfterWriteSink()),
                patch.object(module, "guard"),
                patch.object(module, "command", return_value=commit.encode()),
                patch.dict(
                    module.os.environ,
                    {"GITHUB_SHA": commit, "GITHUB_REPOSITORY": "owner/repo"},
                ),
                patch("release_plan.pending_releases", return_value=intents),
                patch.object(
                    module.Publisher, "publish", side_effect=[True, False]
                ) as publish,
                patch("builtins.print"),
            ):
                module.main()
                self.assertEqual(publish.call_count, 2)
            self.assertEqual(json.loads(output.read_text()), ["v1.0.1"])
        sink = io.StringIO()
        with (
            patch.object(
                sys,
                "argv",
                ["release_publish.py", "--head", commit, "--output", "unused"],
            ),
            patch.object(sys, "stderr", sink),
            patch.object(module, "guard", side_effect=module.Failure("static failure")),
            patch.object(module, "command") as command,
        ):
            with self.assertRaises(module.Failure):
                module.main()
            command.assert_not_called()
        self.assertIn('"stage": "context"', sink.getvalue())
        self.assertIn('"event": "failed"', sink.getvalue())

    def test_malformed_api_status_retains_only_available_command_exit(self):
        module = self.module()
        sink = io.StringIO()
        with (
            patch.object(sys, "stderr", sink),
            patch.object(
                module, "run", return_value=(9, b"synthetic-credential-sentinel")
            ) as run,
        ):
            with self.assertRaises(module.Failure) as caught:
                module.api("synthetic-credential-sentinel")
            self.assertEqual(run.call_count, 1)
        self.assertEqual(
            str(caught.exception), "GitHub response did not contain an HTTP status."
        )
        self.assertIn('"exit_code": 9', sink.getvalue())
        self.assertNotIn("http_status", sink.getvalue())
        self.assertNotIn("synthetic-credential-sentinel", sink.getvalue())

    def test_api_only_interprets_an_explicit_404_as_absence(self):
        module = self.module()
        for status in (401, 403, 429, 500):
            with (
                self.subTest(status=status),
                patch.object(
                    module,
                    "run",
                    return_value=(1, f"HTTP/2.0 {status} Error\r\n\r\n{{}}".encode()),
                ),
            ):
                with self.assertRaises(module.Failure):
                    module.api("repos/owner/repo/releases/tags/v1.0.1", missing=True)
        with patch.object(
            module, "run", return_value=(1, b"HTTP/2.0 404 Not Found\r\n\r\n{}")
        ):
            self.assertIsNone(
                module.api("repos/owner/repo/releases/tags/v1.0.1", missing=True)
            )

    def test_tag_identity_includes_annotated_object_not_only_commit(self):
        module = self.module()
        publisher = module.Publisher(ROOT, "owner/repo")
        intent = {
            "tag": "v1.0.1",
            "version": "1.0.1",
            "commit": "1" * 40,
            "previousTag": "v1.0.0",
            "previousCommit": "0" * 40,
        }
        with (
            patch.object(publisher, "tag_object", return_value=("2" * 40, {})),
            patch.object(
                publisher,
                "request",
                return_value={"object": {"type": "tag", "sha": "3" * 40}},
            ),
        ):
            with self.assertRaises(module.Failure):
                publisher.ensure_tag(intent)

    def test_draft_lookup_paginates_and_rejects_duplicate_tag_matches(self):
        module = self.module()
        publisher = module.Publisher(ROOT, "owner/repo")
        draft = {"id": 8, "tag_name": "v1.0.1", "draft": True}
        first_page = [{"tag_name": "v0.0.1"}] * 100
        with patch.object(
            publisher, "request", side_effect=[None, first_page, [draft]]
        ) as request:
            self.assertEqual(publisher.find_release("v1.0.1"), draft)
            self.assertEqual(request.call_count, 3)
            self.assertIn("page=2", request.call_args.args[0])
        with patch.object(publisher, "request", side_effect=[None, [draft, draft]]):
            with self.assertRaises(module.Failure):
                publisher.find_release("v1.0.1")

    def test_provenance_matches_every_archive_and_exact_tag_identity(self):
        module = self.module()
        publisher = module.Publisher(ROOT, "owner/repo")
        intent = {"tag": "v1.0.1", "version": "1.0.1", "commit": "1" * 40}
        assets = {name: b"fixture" for name in module.ZIPS}
        provenance = publisher.provenance(intent, "2" * 40, assets)
        assets["provenance.json"] = provenance
        with patch.object(publisher, "verify_zip"):
            publisher.verify_assets(intent, "2" * 40, assets)
            with self.assertRaises(module.Failure):
                publisher.verify_assets(intent, "3" * 40, assets)
            assets[module.ZIPS[0]] = b"different bytes"
            with self.assertRaises(module.Failure):
                publisher.verify_assets(intent, "2" * 40, assets)

    def test_missing_asset_recovery_never_replaces_existing_bytes(self):
        module = self.module()
        publisher = module.Publisher(ROOT, "owner/repo")
        intent = {"tag": "v1.0.1", "version": "1.0.1", "commit": "1" * 40}
        existing = {module.ZIPS[0]: b"already-uploaded"}
        built = {name: b"rebuilt" for name in module.ZIPS}
        with (
            patch.object(publisher, "build", return_value=built),
            patch.object(publisher, "verify_zip"),
        ):
            combined = publisher.complete_assets(intent, "2" * 40, existing)
        self.assertEqual(combined[module.ZIPS[0]], b"already-uploaded")
        self.assertEqual(existing, {module.ZIPS[0]: b"already-uploaded"})

    def test_existing_provenance_conflict_cannot_be_repaired_by_overwrite(self):
        module = self.module()
        publisher = module.Publisher(ROOT, "owner/repo")
        intent = {"tag": "v1.0.1", "version": "1.0.1", "commit": "1" * 40}
        original = {name: b"original" for name in module.ZIPS}
        partial = {
            module.ZIPS[0]: b"original",
            "provenance.json": publisher.provenance(intent, "2" * 40, original),
        }
        with (
            patch.object(
                publisher,
                "build",
                return_value={name: b"different" for name in module.ZIPS},
            ),
            patch.object(publisher, "verify_zip"),
        ):
            with self.assertRaises(module.Failure):
                publisher.complete_assets(intent, "2" * 40, partial)

    def test_published_release_is_verified_but_never_uploaded_or_redispatched(self):
        module = self.module()
        publisher = module.Publisher(ROOT, "owner/repo")
        intent = {"tag": "v1.0.1", "version": "1.0.1", "commit": "1" * 40}
        release = {
            "id": 5,
            "tag_name": intent["tag"],
            "draft": False,
            "prerelease": False,
            "target_commitish": "main",
        }
        with (
            patch.object(publisher, "ensure_tag", return_value="2" * 40),
            patch.object(publisher, "request", return_value=release),
            patch.object(publisher, "read_assets", return_value={}),
            patch.object(publisher, "verify_assets") as verify,
            patch.object(publisher, "upload") as upload,
            patch.object(publisher, "assert_main"),
            patch.object(publisher, "assert_tag"),
        ):
            self.assertFalse(publisher.publish(intent))
            verify.assert_called_once()
            upload.assert_not_called()

    def test_published_readback_must_succeed_before_dispatch_output(self):
        module = self.module()
        publisher = module.Publisher(ROOT, "owner/repo")
        intent = {"tag": "v1.0.1", "version": "1.0.1", "commit": "1" * 40}
        draft = {
            "id": 5,
            "tag_name": intent["tag"],
            "draft": True,
            "prerelease": False,
            "target_commitish": intent["commit"],
        }
        assets = {name: b"fixture" for name in module.ASSETS}
        requests = [draft, draft, draft]
        with (
            patch.object(publisher, "ensure_tag", return_value="2" * 40),
            patch.object(publisher, "request", side_effect=requests),
            patch.object(publisher, "read_assets", return_value=assets),
            patch.object(publisher, "complete_assets", return_value=assets),
            patch.object(publisher, "verify_assets"),
            patch.object(publisher, "assert_main"),
            patch.object(publisher, "assert_tag"),
        ):
            with self.assertRaises(module.Failure):
                publisher.publish(intent)


class RecoveryFixtureTests(unittest.TestCase):
    def test_real_archives_survive_partial_upload_and_completed_retry(self):
        import release_publish as module

        with tempfile.TemporaryDirectory(prefix="release-recovery-") as temp:
            root = Path(temp)
            paths = [
                "package.json",
                "manifest.firefox.json",
                "manifest.chrome.json",
                "background.js",
                "triage.html",
                "triage.js",
                "utils.js",
                "triage.css",
                "build-zip.sh",
                "release-publish.sh",
            ]
            paths += [
                str(p.relative_to(ROOT))
                for p in (ROOT / "icons").rglob("*")
                if p.is_file()
            ]
            for name in paths:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((ROOT / name).read_bytes())

            def git(*args):
                return (
                    subprocess.check_output(
                        [
                            "git",
                            "-c",
                            "core.hooksPath=/dev/null",
                            "-c",
                            "commit.gpgsign=false",
                            "-c",
                            "tag.gpgsign=false",
                            *args,
                        ],
                        cwd=root,
                        stderr=subprocess.PIPE,
                    )
                    .decode()
                    .strip()
                )

            git("init", "-b", "main")
            git("config", "user.name", "Fixture")
            git("config", "user.email", "fixture@example.invalid")
            git("add", ".")
            git("commit", "-m", "fix: recovery fixture")
            git("tag", "-a", "v0.0.0", "-m", "Fixture baseline")
            commit = git("rev-parse", "HEAD")
            version = json.loads((root / "package.json").read_text())["version"]
            intent = {
                "tag": "v" + version,
                "version": version,
                "commit": commit,
                "previousTag": "v0.0.0",
                "previousCommit": commit,
            }

            class Backend(module.Publisher):
                def __init__(self):
                    super().__init__(root, "owner/repo")
                    self.ref = None
                    self.release = None
                    self.assets = {}
                    self.fail_upload = True
                    self.uploads = []
                    self.creations = 0
                    self.operations = []

                def request(
                    self,
                    suffix,
                    method="GET",
                    payload=None,
                    missing=False,
                    binary=False,
                ):
                    self.operations.append((suffix, method, payload, missing, binary))
                    if suffix.startswith("compare/"):
                        return {"status": "identical", "base_commit": {"sha": commit}}
                    if suffix.startswith("git/ref/tags/"):
                        return self.ref
                    if suffix == "git/tags":
                        return {"sha": self.tag_object(intent)[0]}
                    if suffix == "git/refs":
                        self.ref = {"object": {"type": "tag", "sha": payload["sha"]}}
                        return self.ref
                    if suffix.startswith("releases/tags/"):
                        return (
                            dict(self.release)
                            if self.release and not self.release["draft"]
                            else None
                        )
                    if suffix.startswith("releases?per_page=100&page="):
                        return [dict(self.release)] if self.release else []
                    if suffix == "releases" and method == "POST":
                        self.creations += 1
                        self.release = {"id": 7, **payload}
                        return dict(self.release)
                    if suffix == "releases/7" and method == "PATCH":
                        self.release.update(payload)
                        return dict(self.release)
                    if suffix.startswith("releases/7/assets?"):
                        return [
                            {
                                "id": i,
                                "name": name,
                                "size": len(raw),
                                "state": "uploaded",
                            }
                            for i, (name, raw) in enumerate(self.assets.items())
                        ]
                    if suffix.startswith("releases/assets/") and binary:
                        return list(self.assets.values())[int(suffix.rsplit("/", 1)[1])]
                    raise AssertionError("Unexpected fixture API operation")

                def upload(self, tag, name, raw):
                    self.uploads.append(name)
                    self.operations.append(("upload", tag, name))
                    if name in self.assets:
                        raise AssertionError("Existing asset must not be overwritten")
                    self.assets[name] = raw
                    if self.fail_upload:
                        self.fail_upload = False
                        raise module.Failure("Synthetic uncertain upload result.")

            backend = Backend()
            diagnostic_sink = io.StringIO()
            stderr_patch = patch.object(sys, "stderr", diagnostic_sink)
            stderr_patch.start()
            self.addCleanup(stderr_patch.stop)
            notes = SimpleNamespace(release_notes=lambda *args: "## Fixture notes\n")
            with patch.dict(sys.modules, {"release_plan": notes}):
                with self.assertRaises(module.Failure):
                    backend.publish(intent)
                self.assertTrue(backend.release["draft"])
                records = [
                    json.loads(line.removeprefix("Workflow diagnostic: "))
                    for line in diagnostic_sink.getvalue().splitlines()
                    if line.startswith("Workflow diagnostic: ")
                ]
                markers = [(item["stage"], item["event"]) for item in records]
                self.assertIn(("source", "complete"), markers)
                self.assertIn(("tag", "complete"), markers)
                self.assertIn(("build", "complete"), markers)
                self.assertIn(("provenance", "complete"), markers)
                self.assertIn(("draft", "complete"), markers)
                self.assertIn(("asset_upload", "uncertain"), markers)
                self.assertTrue(any(item.get("digest") for item in records))
                first = dict(backend.assets)
                self.assertEqual(len(first), 1)
                self.assertTrue(backend.publish(intent))
                records = [
                    json.loads(line.removeprefix("Workflow diagnostic: "))
                    for line in diagnostic_sink.getvalue().splitlines()
                    if line.startswith("Workflow diagnostic: ")
                ]
                markers = [(item["stage"], item["event"]) for item in records]
                self.assertIn(("asset_verify", "complete"), markers)
                self.assertIn(("publish", "complete"), markers)
                self.assertIn(("release_readback", "complete"), markers)
                self.assertEqual(backend.creations, 1)
                self.assertFalse(backend.release["draft"])
                self.assertEqual(set(backend.assets), set(module.ASSETS))
                for name, raw in first.items():
                    self.assertEqual(backend.assets[name], raw)
                backend.verify_assets(
                    intent, backend.ref["object"]["sha"], backend.assets
                )
                count = len(backend.uploads)
                self.assertFalse(backend.publish(intent))
                self.assertEqual(len(backend.uploads), count)
                normal = Backend()
                normal.fail_upload = False
                self.assertTrue(normal.publish(intent))
                interrupted_sink = Backend()
                interrupted_sink.fail_upload = False

                class AfterUploadSink:
                    def write(self, line):
                        if interrupted_sink.assets:
                            raise OSError("synthetic-sink-failure")

                with patch.object(sys, "stderr", AfterUploadSink()):
                    self.assertTrue(interrupted_sink.publish(intent))
                self.assertEqual(interrupted_sink.operations, normal.operations)
                self.assertEqual(set(interrupted_sink.assets), set(normal.assets))
                # Independent passive builds can differ in ZIP timestamps; compare sources.
                import zipfile

                for name in module.ZIPS:
                    with (
                        zipfile.ZipFile(io.BytesIO(normal.assets[name])) as expected,
                        zipfile.ZipFile(
                            io.BytesIO(interrupted_sink.assets[name])
                        ) as actual,
                    ):
                        self.assertEqual(
                            {name: expected.read(name) for name in expected.namelist()},
                            {name: actual.read(name) for name in actual.namelist()},
                        )
                assert interrupted_sink.ref is not None
                interrupted_sink.verify_assets(
                    intent,
                    interrupted_sink.ref["object"]["sha"],
                    interrupted_sink.assets,
                )
                assert interrupted_sink.release is not None
                self.assertFalse(interrupted_sink.release["draft"])
                backend.assets[module.ZIPS[0]] += b"tampering"
                with self.assertRaises(module.Failure):
                    backend.publish(intent)


if __name__ == "__main__":
    unittest.main()
