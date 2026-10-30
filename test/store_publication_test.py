"""Offline only: real Git/ZIPs and real publisher; external transports are trapped."""

import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch, Mock
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "store_publish", ROOT / "scripts/store_publish.py"
)
assert SPEC is not None and SPEC.loader is not None


def archive(entries):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as z:
        for name, value in entries:
            z.writestr(name, value)
    return data.getvalue()


class StorePublicationTest(unittest.TestCase):
    def setUp(self):
        self.mod = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(self.mod)
        self.net = patch.object(
            socket.socket,
            "connect",
            side_effect=AssertionError("offline network forbidden"),
        )
        self.net.start()
        self.addCleanup(self.net.stop)
        for target in ("getaddrinfo",):
            block = patch.object(
                socket, target, side_effect=AssertionError("offline DNS forbidden")
            )
            block.start()
            self.addCleanup(block.stop)
        block_bind = patch.object(
            socket.socket, "bind", side_effect=AssertionError("offline bind forbidden")
        )
        block_bind.start()
        self.addCleanup(block_bind.stop)
        self.fence = patch.object(self.mod, "fence")
        self.fence.start()
        self.addCleanup(self.fence.stop)

    def test_event_guards(self):
        good = {
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_REF_TYPE": "branch",
            "GITHUB_REPOSITORY": "owner/repo",
            "GITHUB_WORKFLOW_REF": "owner/repo/.github/workflows/publish-firefox.yml@refs/heads/main",
        }
        self.mod.guard("firefox", good)
        for field, values in {
            "GITHUB_EVENT_NAME": [
                "pull_request",
                "pull_request_target",
                "release",
                "push",
            ],
            "GITHUB_REF": ["refs/tags/main", "refs/heads/topic"],
            "GITHUB_REF_TYPE": ["tag"],
            "GITHUB_WORKFLOW_REF": [
                "owner/repo/.github/workflows/evil.yml@refs/heads/main"
            ],
        }.items():
            for value in values:
                with (
                    self.subTest(field=field, value=value),
                    self.assertRaises(self.mod.Failure),
                ):
                    self.mod.guard("firefox", {**good, field: value})

    def test_zip_inventory_and_bytes(self):
        expected = {"manifest.json": b'{"version":"1.0.0"}', "triage.js": b"safe"}
        self.mod.verify_zip(archive(expected.items()), expected)
        for entries in [
            [*expected.items(), ("evil.sh", b"x")],
            [("manifest.json", expected["manifest.json"]), ("triage.js", b"changed")],
            [("../triage.js", b"safe")],
        ]:
            with self.subTest(entries=entries), self.assertRaises(self.mod.Failure):
                self.mod.verify_zip(archive(entries), expected)
        with self.assertWarns(UserWarning):
            duplicate = archive([("triage.js", b"safe"), ("triage.js", b"safe")])
        with self.assertRaises(self.mod.Failure):
            self.mod.verify_zip(duplicate, expected)

    def fixture(self):
        temp = tempfile.TemporaryDirectory(prefix="store-publication-")
        self.addCleanup(temp.cleanup)
        folder = Path(temp.name)
        (folder / "scripts").mkdir()
        (folder / "scripts/store_publish.py").write_bytes(
            (ROOT / "scripts/store_publish.py").read_bytes()
        )
        env = {
            **os.environ,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_AUTHOR_NAME": "Fixture",
            "GIT_AUTHOR_EMAIL": "test@example.invalid",
            "GIT_COMMITTER_NAME": "Fixture",
            "GIT_COMMITTER_EMAIL": "test@example.invalid",
            "GH_TOKEN": "fake-secret-sentinel",
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_REF_TYPE": "branch",
            "GITHUB_REPOSITORY": "owner/repo",
            "GITHUB_WORKFLOW_REF": "owner/repo/.github/workflows/publish-firefox.yml@refs/heads/main",
            "RELEASE_TAG": "v1.0.0",
            "STORE_ASSETS": str(folder / "verified"),
        }

        def git(*args):
            result = subprocess.run(
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
                cwd=folder,
                env=env,
                capture_output=True,
                check=True,
            )
            return result.stdout.decode().strip()

        git("init", "-q", "-b", "main")
        (folder / "package.json").write_text(json.dumps({"version": "1.0.0"}))
        for browser in ("firefox", "chrome"):
            (folder / f"manifest.{browser}.json").write_text(
                json.dumps(
                    {
                        "version": "1.0.0",
                        "browser_specific_settings": {"gecko": {"id": self.mod.GUID}},
                    }
                )
            )
        for name in self.mod.SOURCES:
            (folder / name).write_text("tagged passive bytes")
        (folder / "icons").mkdir()
        (folder / "icons/icon.svg").write_text("<svg/>")
        (folder / "build-zip.sh").write_text("touch SHOULD-NOT-EXECUTE; exit 94")
        git("add", ".")
        git("commit", "-qm", "fixture")
        git("tag", "-a", "v1.0.0", "-m", "release")
        git("remote", "add", "origin", str(folder))
        oid, commit = git("rev-parse", "v1.0.0"), git("rev-parse", "HEAD")
        assets = folder / "assets"
        assets.mkdir()
        for browser in ("firefox", "chrome"):
            entries = [
                (name, (folder / name).read_bytes())
                for name in [*self.mod.SOURCES, "icons/icon.svg"]
            ]
            entries.append(
                ("manifest.json", (folder / f"manifest.{browser}.json").read_bytes())
            )
            (assets / f"tab-triage-dashboard-{browser}.zip").write_bytes(
                archive(entries)
            )
        provenance = {
            "tag": "v1.0.0",
            "tagObject": oid,
            "commit": commit,
            "version": "1.0.0",
            "sha256": {
                name: self.mod.digest((assets / name).read_bytes())
                for name in self.mod.ZIP_NAMES
            },
        }
        (assets / "provenance.json").write_text(json.dumps(provenance))
        release = {
            "id": 10,
            "tag_name": "v1.0.0",
            "draft": False,
            "prerelease": False,
            "published_at": "2026-01-01T00:00:00Z",
            "assets": [
                {
                    "id": i + 1,
                    "name": name,
                    "size": (assets / name).stat().st_size,
                    "state": "uploaded",
                }
                for i, name in enumerate(self.mod.ASSETS)
            ],
        }
        responses = {
            "repos/owner/repo/releases/tags/v1.0.0": release,
            "repos/owner/repo/git/ref/tags/v1.0.0": {
                "ref": "refs/tags/v1.0.0",
                "object": {"type": "tag", "sha": oid},
            },
            f"repos/owner/repo/git/tags/{oid}": {
                "sha": oid,
                "tag": "v1.0.0",
                "object": {"type": "commit", "sha": commit},
            },
        }
        (folder / "responses.json").write_text(json.dumps(responses))
        (folder / "bin").mkdir()
        (folder / "bin/gh").write_text(
            """#!/usr/bin/env python3
import json,sys,pathlib,os
f=pathlib.Path(__file__).resolve().parents[1]
a=sys.argv[1:]
with open(f/'calls','a') as log: log.write(json.dumps(a)+'\n')
if os.environ.get('FAIL_GH'):
    print('fake-secret-sentinel rawresponse');sys.exit(1)
responses=json.loads((f/'responses.json').read_text())
endpoint=a[1]
if endpoint in responses:
    print(json.dumps(responses[endpoint]))
else:
    i=int(endpoint.rsplit('/',1)[1])-1
    names=['tab-triage-dashboard-firefox.zip','tab-triage-dashboard-chrome.zip','provenance.json']
    sys.stdout.buffer.write((f/'assets'/names[i]).read_bytes())
""".replace("+'\n')", "+'\\n')")
        )
        (folder / "bin/gh").chmod(0o755)
        env["PATH"] = str(folder / "bin") + os.pathsep + env["PATH"]
        return folder, env, responses, git

    def cli(self, folder, env, operation="verify", browser="firefox"):
        return subprocess.run(
            ["python3", "-B", "scripts/store_publish.py", operation, browser],
            cwd=folder,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
        )

    def test_real_entrypoint_verifies_git_assets_and_provenance(self):
        folder, env, responses, git = self.fixture()
        result = self.cli(folder, env)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((folder / "verified/verified.json").exists())
        self.assertFalse((folder / "SHOULD-NOT-EXECUTE").exists())
        self.assertNotIn("fake-secret-sentinel", result.stdout + result.stderr)

    def test_release_download_counters_do_not_masquerade_as_asset_drift(self):
        folder, env, responses, git = self.fixture()
        stub = folder / "bin/gh"
        source = stub.read_text()
        source = source.replace(
            "    print(json.dumps(responses[endpoint]))",
            """    result = responses[endpoint]
    if "/releases/tags/" in endpoint:
        for asset in result["assets"]:
            asset["download_count"] = len((f/"calls").read_text().splitlines())
    print(json.dumps(result))""",
        )
        stub.write_text(source)
        result = self.cli(folder, env)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_real_entrypoint_rejects_hostile_tag_before_gh(self):
        folder, env, responses, git = self.fixture()
        for tag in [
            "--help",
            "v1.0.0;touch PWNED",
            "$(touch PWNED)",
            "v01.0.0",
            "v1.0.0\n",
            "v1.0.0/topic",
            "v1.0.0-rc.1",
        ]:
            result = self.cli(folder, {**env, "RELEASE_TAG": tag})
            self.assertNotEqual(result.returncode, 0)
        self.assertFalse((folder / "calls").exists())
        self.assertFalse((folder / "PWNED").exists())

    def test_real_entrypoint_rejects_event_before_gh(self):
        folder, env, responses, git = self.fixture()
        for event in ["pull_request", "pull_request_target", "release", "push"]:
            self.assertNotEqual(
                self.cli(
                    folder, {**env, "GITHUB_EVENT_NAME": event}, "publish"
                ).returncode,
                0,
            )
        self.assertFalse((folder / "calls").exists())

    def test_release_metadata_failures(self):
        folder, env, responses, git = self.fixture()
        key = "repos/owner/repo/releases/tags/v1.0.0"
        original = json.loads(json.dumps(responses))
        for changed in [
            {"draft": True},
            {"prerelease": True},
            {"published_at": None},
            {"assets": []},
            {"assets": original[key]["assets"] + [original[key]["assets"][0]]},
        ]:
            data = json.loads(json.dumps(original))
            data[key].update(changed)
            (folder / "responses.json").write_text(json.dumps(data))
            result = self.cli(folder, env)
            self.assertNotEqual(result.returncode, 0, result.stdout)

    def test_content_tampering_with_same_version_and_updated_sha_is_rejected(self):
        folder, env, responses, git = self.fixture()
        asset = folder / "assets/tab-triage-dashboard-firefox.zip"
        entries = self.mod.zip_entries(asset.read_bytes())
        entries["triage.js"] = b"hostile same-version code"
        asset.write_bytes(archive(entries.items()))
        p = folder / "assets/provenance.json"
        data = json.loads(p.read_bytes())
        data["sha256"][asset.name] = self.mod.digest(asset.read_bytes())
        p.write_text(json.dumps(data))
        for a in responses["repos/owner/repo/releases/tags/v1.0.0"]["assets"]:
            a["size"] = (folder / "assets" / a["name"]).stat().st_size
        (folder / "responses.json").write_text(json.dumps(responses))
        result = self.cli(folder, env)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("content differs", result.stderr)

    def test_annotated_tag_and_main_ancestry_required(self):
        folder, env, responses, git = self.fixture()
        ref = "repos/owner/repo/git/ref/tags/v1.0.0"
        responses[ref]["object"]["type"] = "commit"
        (folder / "responses.json").write_text(json.dumps(responses))
        result = self.cli(folder, env)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("annotated", result.stderr)
        responses[ref]["object"]["type"] = "tag"
        git("checkout", "-q", "--orphan", "unrelated")
        (folder / "unrelated").write_text("new history")
        git("add", ".")
        git("commit", "-qm", "unrelated")
        git("branch", "-f", "main", "HEAD")
        (folder / "responses.json").write_text(json.dumps(responses))
        self.assertNotEqual(self.cli(folder, env).returncode, 0)

    def test_raw_subprocess_errors_are_not_logged(self):
        folder, env, responses, git = self.fixture()
        result = self.cli(folder, {**env, "FAIL_GH": "1"})
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("fake-secret-sentinel", result.stdout + result.stderr)
        self.assertNotIn("rawresponse", result.stdout + result.stderr)

    def test_chrome_prerequisites_before_network(self):
        with patch.object(
            self.mod, "http", side_effect=AssertionError("no auth/network")
        ):
            with self.assertRaisesRegex(
                self.mod.Failure, "before Google authentication"
            ):
                self.mod.prerequisites("chrome", {})
        for item in ["../escape", "a" * 31, "q" * 32, "a" * 32 + "\n"]:
            with self.assertRaises(self.mod.Failure):
                self.mod.prerequisites(
                    "chrome",
                    {"CWS_PUBLISHER_ID": "publisher", "CWS_EXTENSION_ID": item},
                )

    def chrome_fixture(self):
        name = "publishers/publisher/items/" + "a" * 32
        env = {
            "CWS_PUBLISHER_ID": "publisher",
            "CWS_EXTENSION_ID": "a" * 32,
            "CWS_ACCESS_TOKEN": "fake-secret-sentinel",
        }
        status = {"name": name, "itemId": "a" * 32}
        return name, env, status

    def test_chrome_equal_version_refuses_unverifiable_success(self):
        name, env, status = self.chrome_fixture()
        status["submittedItemRevisionStatus"] = {
            "state": "PENDING_REVIEW",
            "distributionChannels": [{"crxVersion": "1.0.0"}],
        }
        calls = []

        def transport(url, method="GET", *args, **kwargs):
            calls.append(method)
            return status

        with patch.dict(os.environ, env), patch.object(self.mod, "http", transport):
            with self.assertRaisesRegex(self.mod.Failure, "unverifiable equal-version"):
                self.mod.publish_chrome({"version": "1.0.0"}, {}, b"zip")
        self.assertEqual(calls, ["GET"])

    def test_chrome_upload_submit_and_exact_readback(self):
        name, env, status = self.chrome_fixture()
        calls = []
        final = {
            **status,
            "submittedItemRevisionStatus": {
                "state": "PENDING_REVIEW",
                "distributionChannels": [{"crxVersion": "1.0.0"}],
            },
        }
        responses = [
            status,
            {**status, "uploadState": "SUCCEEDED", "crxVersion": "1.0.0"},
            {"state": "PENDING_REVIEW"},
            final,
        ]

        def transport(url, method="GET", data=None, headers=None, **kwargs):
            calls.append((url, method, data, headers))
            return responses.pop(0)

        with patch.dict(os.environ, env), patch.object(self.mod, "http", transport):
            result = self.mod.publish_chrome({"version": "1.0.0"}, {}, b"verifiedzip")
        self.assertEqual(result, "submitted-for-review")
        self.assertEqual([x[1] for x in calls], ["GET", "POST", "POST", "GET"])
        self.assertEqual(calls[1][2], b"verifiedzip")
        self.assertEqual(json.loads(calls[2][2])["publishType"], "DEFAULT_PUBLISH")
        self.assertFalse(json.loads(calls[2][2])["skipReview"])
        self.assertIn("/upload/v2/", calls[1][0])

    def test_chrome_failed_upload_never_publishes(self):
        name, env, status = self.chrome_fixture()
        replies = [status, {**status, "uploadState": "FAILED"}]
        with (
            patch.dict(os.environ, env),
            patch.object(self.mod, "http", side_effect=lambda *a, **k: replies.pop(0)),
        ):
            with self.assertRaises(self.mod.Failure):
                self.mod.publish_chrome({"version": "1.0.0"}, {}, b"zip")
        self.assertEqual(replies, [])

    def test_live_tag_drift_stops_chrome_before_upload(self):
        self.fence.stop()
        name, env, status = self.chrome_fixture()
        calls = []

        def transport(url, method="GET", *args, **kwargs):
            calls.append(method)
            if method == "POST":
                raise self.mod.Failure("upload must not happen")
            return status

        receipt = {
            "version": "1.0.0",
            "tag": "v1.0.0",
            "tagObject": "a" * 40,
            "commit": "b" * 40,
            "releaseId": 10,
            "assetIds": {},
        }
        moved = ({"id": 10, "assets": []}, "c" * 40, "b" * 40)
        with (
            patch.dict(os.environ, env),
            patch.object(self.mod, "http", transport),
            patch.object(self.mod, "release_identity", return_value=moved),
        ):
            with self.assertRaises(self.mod.Failure):
                self.mod.publish_chrome(receipt, {}, b"zip")
        self.assertEqual(
            calls, ["GET"], "tag-object drift must stop before any store mutation"
        )

    def test_credentialfree_amo_cdn_redirect(self):
        url = "https://addons.mozilla.org/firefox/downloads/file/123/fixture.xpi"
        target = "https://addons.mozilla.org/user-media/addons/123/fixture.xpi"
        redirect = self.mod.urllib.error.HTTPError(
            url, 302, "Found", {"Location": target}, io.BytesIO()
        )
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = b"archive"
        opener = Mock()
        opener.open.side_effect = [redirect, response]
        with patch.object(self.mod.urllib.request, "build_opener", return_value=opener):
            self.assertEqual(self.mod.http(url, binary=True), b"archive")
        self.assertEqual(opener.open.call_args_list[1].args[0].full_url, target)
        self.assertIsNone(
            opener.open.call_args_list[1].args[0].get_header("Authorization")
        )

    def test_chrome_state_semantics_and_wrong_version(self):
        for state, result in [
            ("PENDING_REVIEW", "submitted-for-review"),
            ("PUBLISHED", "public"),
            ("STAGED", "staged-not-public"),
        ]:
            status = {
                "submittedItemRevisionStatus": {
                    "state": state,
                    "distributionChannels": [{"crxVersion": "1.0.0"}],
                }
            }
            self.assertEqual(self.mod.chrome_state(status, "1.0.0"), result)
            self.assertIsNone(self.mod.chrome_state(status, "2.0.0"))
        for state in ["REJECTED", "CANCELLED"]:
            with self.assertRaises(self.mod.Failure):
                self.mod.chrome_state(
                    {
                        "submittedItemRevisionStatus": {
                            "state": state,
                            "distributionChannels": [{"crxVersion": "1.0.0"}],
                        }
                    },
                    "1.0.0",
                )

    def amo_fixture(self, state="unreviewed"):
        entries = {"manifest.json": b'{"version":"1.0.0"}', "triage.js": b"safe"}
        data = archive([*entries.items(), ("META-INF/mozilla.rsa", b"signature")])
        version = {
            "version": "1.0.0",
            "channel": "listed",
            "file": {
                "status": state,
                "url": "https://addons.mozilla.org/firefox/downloads/file/123/fixture.xpi",
                "hash": "sha256:" + self.mod.digest(data),
            },
        }
        return entries, data, version

    def test_amo_existing_version_verifies_content_no_upload(self):
        expected, raw, version = self.amo_fixture()
        calls = []

        def transport(url, method="GET", *args, **kwargs):
            calls.append(method)
            return raw if kwargs.get("binary") else version

        with (
            patch.dict(
                os.environ,
                {"WEB_EXT_API_KEY": "fake-key", "WEB_EXT_API_SECRET": "fake-secret"},
            ),
            patch.object(self.mod, "http", transport),
        ):
            result = self.mod.publish_firefox({"version": "1.0.0"}, expected, b"zip")
        self.assertEqual(result, "submitted-for-review")
        self.assertEqual(calls, ["GET", "GET"])
        with (
            patch.object(self.mod, "http", return_value=raw),
            self.assertRaises(self.mod.Failure),
        ):
            self.mod.amo_readback(version, {**expected, "triage.js": b"different"})

    def test_amo_upload_validate_create_readback(self):
        expected, raw, version = self.amo_fixture()
        calls = []
        replies = [
            None,
            {"uuid": "11111111111111111111111111111111"},
            {"processed": False},
            {"processed": True, "valid": True, "version": "1.0.0", "channel": "listed"},
            {"id": 4},
            version,
            raw,
        ]

        def transport(url, method="GET", data=None, headers=None, **kwargs):
            calls.append((url, method, data))
            return replies.pop(0)

        with (
            patch.dict(
                os.environ,
                {"WEB_EXT_API_KEY": "fake-key", "WEB_EXT_API_SECRET": "fake-secret"},
            ),
            patch.object(self.mod, "http", transport),
            patch.object(self.mod.time, "sleep"),
        ):
            result = self.mod.publish_firefox(
                {"version": "1.0.0"}, expected, b"verifiedzip"
            )
        self.assertEqual(result, "submitted-for-review")
        self.assertEqual(len(replies), 0)
        self.assertIn(b"verifiedzip", calls[1][2])
        self.assertEqual([c[1] for c in calls].count("POST"), 2)

    def test_amo_validation_failure_never_creates_version(self):
        replies = [
            None,
            {"uuid": "11111111111111111111111111111111"},
            {
                "processed": True,
                "valid": False,
                "version": "1.0.0",
                "channel": "listed",
            },
        ]
        with (
            patch.dict(
                os.environ,
                {"WEB_EXT_API_KEY": "fake-key", "WEB_EXT_API_SECRET": "fake-secret"},
            ),
            patch.object(self.mod, "http", side_effect=lambda *a, **k: replies.pop(0)),
        ):
            with self.assertRaises(self.mod.Failure):
                self.mod.publish_firefox({"version": "1.0.0"}, {}, b"zip")
        self.assertEqual(replies, [])

    def test_amo_pending_exact_hash_does_not_require_public_download(self):
        expected = {"manifest.json": b'{"version":"1.0.0"}', "triage.js": b"safe"}
        raw = archive(expected.items())
        version = {
            "channel": "listed",
            "file": {"status": "unreviewed", "hash": "sha256:" + self.mod.digest(raw)},
        }
        with patch.object(
            self.mod,
            "http",
            side_effect=AssertionError("pending archive is not public yet"),
        ):
            self.assertEqual(
                self.mod.amo_readback(version, expected, raw), "submitted-for-review"
            )

    def test_real_publish_entrypoint_uploads_and_retry_only_reads_exact_amo_version(
        self,
    ):
        folder, env, responses, git = self.fixture()
        self.assertEqual(self.cli(folder, env).returncode, 0)
        env.update(
            {
                "WEB_EXT_API_KEY": "synthetic-key-not-real",
                "WEB_EXT_API_SECRET": "synthetic-secret-not-real",
            }
        )
        raw = (folder / "assets/tab-triage-dashboard-firefox.zip").read_bytes()
        version = {
            "version": "1.0.0",
            "channel": "listed",
            "file": {"status": "unreviewed", "hash": "sha256:" + self.mod.digest(raw)},
        }
        base = self.mod.AMO + "addons/addon/tab-triage-dashboard%40albertoos/versions/"
        plan = [
            ["GET", base + "1.0.0/", 404, {}],
            ["POST", self.mod.AMO + "addons/upload/", 200, {"uuid": "1" * 32}],
            [
                "GET",
                self.mod.AMO + "addons/upload/" + "1" * 32 + "/",
                200,
                {
                    "processed": True,
                    "valid": True,
                    "version": "1.0.0",
                    "channel": "listed",
                },
            ],
            ["POST", base, 200, version],
            ["GET", base + "1.0.0/", 200, version],
        ]
        runner = """import io,json,runpy,socket,sys,urllib.request,urllib.error
from pathlib import Path
socket.socket.connect=lambda *a,**k: (_ for _ in ()).throw(AssertionError("offline"))
socket.getaddrinfo=lambda *a,**k: (_ for _ in ()).throw(AssertionError("offline DNS"))
socket.socket.bind=lambda *a,**k: (_ for _ in ()).throw(AssertionError("offline bind"))
plan=json.loads(Path("http-plan.json").read_text())
class Reply(io.BytesIO):
    pass
class Opener:
    def open(self, request, timeout):
        method,url,status,payload=plan.pop(0)
        assert request.method==method and request.full_url==url
        assert request.get_header("Authorization").startswith("JWT ")
        with open("http-calls", "a") as log: log.write(method+"\\n")
        if status==404: raise urllib.error.HTTPError(url,404,"synthetic",{},io.BytesIO())
        return Reply(json.dumps(payload).encode())
urllib.request.build_opener=lambda *a: Opener()
sys.argv=["scripts/store_publish.py","publish","firefox"]
runpy.run_path("scripts/store_publish.py",run_name="__main__")
assert not plan
"""
        (folder / "http-plan.json").write_text(json.dumps(plan))
        result = subprocess.run(
            ["python3", "-B", "-c", runner],
            cwd=folder,
            env=env,
            text=True,
            capture_output=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("submitted-for-review", result.stdout)
        self.assertNotIn("synthetic-secret-not-real", result.stdout + result.stderr)
        self.assertEqual(
            (folder / "http-calls").read_text().splitlines(),
            ["GET", "POST", "GET", "POST", "GET"],
        )
        (folder / "http-calls").unlink()
        (folder / "http-plan.json").write_text(
            json.dumps([["GET", base + "1.0.0/", 200, version]])
        )
        retry = subprocess.run(
            ["python3", "-B", "-c", runner],
            cwd=folder,
            env=env,
            text=True,
            capture_output=True,
            timeout=30,
        )
        self.assertEqual(retry.returncode, 0, retry.stdout + retry.stderr)
        self.assertEqual((folder / "http-calls").read_text().splitlines(), ["GET"])

    def test_amo_signing_metadata_is_only_allowed_addition(self):
        expected, raw, version = self.amo_fixture()
        self.mod.verify_zip(raw, expected, signed=True)
        for status in ["disabled", "unknown"]:
            version["file"]["status"] = status
            with self.assertRaises(self.mod.Failure):
                self.mod.amo_readback(version, expected)

    def test_validation_and_async_upload_polling_are_bounded(self):
        calls = []

        def amo_transport(url, method="GET", *args, **kwargs):
            calls.append(method)
            if len(calls) == 1:
                return None
            if method == "POST":
                return {"uuid": "1" * 32}
            return {"processed": False}

        with (
            patch.dict(
                os.environ,
                {
                    "WEB_EXT_API_KEY": "synthetic-key",
                    "WEB_EXT_API_SECRET": "synthetic-secret",
                },
            ),
            patch.object(self.mod, "http", amo_transport),
            patch.object(self.mod.time, "sleep"),
        ):
            with self.assertRaisesRegex(self.mod.Failure, "validation timed out"):
                self.mod.publish_firefox({"version": "1.0.0"}, {}, b"zip")
        self.assertEqual(len(calls), 2 + self.mod.POLL_COUNT)
        self.assertEqual(calls.count("POST"), 1)
        name, env, status = self.chrome_fixture()
        calls = []

        def chrome_transport(url, method="GET", *args, **kwargs):
            calls.append(method)
            if len(calls) == 1:
                return status
            if method == "POST":
                return {**status, "uploadState": "IN_PROGRESS"}
            return {**status, "lastAsyncUploadState": "IN_PROGRESS"}

        with (
            patch.dict(os.environ, env),
            patch.object(self.mod, "http", chrome_transport),
            patch.object(self.mod.time, "sleep"),
        ):
            with self.assertRaisesRegex(
                self.mod.Failure, "asynchronous upload failed/timed out"
            ):
                self.mod.publish_chrome({"version": "1.0.0"}, {}, b"zip")
        self.assertEqual(len(calls), 2 + self.mod.POLL_COUNT)
        self.assertEqual(calls.count("POST"), 1)

    def test_zip_nul_filename_is_not_treated_as_its_safe_prefix(self):
        raw = archive([("triage.jsXevil.js", b"safe")]).replace(
            b"triage.jsXevil.js", b"triage.js\x00evil.js"
        )
        with self.assertRaises(self.mod.Failure):
            self.mod.verify_zip(raw, {"triage.js": b"safe"})

    def test_amo_signature_allowlist_rejects_executable_additions(self):
        expected, raw, version = self.amo_fixture()
        data = self.mod.zip_entries(raw)
        data["META-INF/evil.js"] = b"hostile"
        with self.assertRaises(self.mod.Failure):
            self.mod.verify_zip(archive(data.items()), expected, signed=True)

    def test_publish_refuses_pre_auth_receipt_substitution(self):
        folder, env, responses, git = self.fixture()
        self.assertEqual(self.cli(folder, env).returncode, 0)
        file = folder / "verified/verified.json"
        receipt = json.loads(file.read_bytes())
        receipt["commit"] = "0" * 40
        file.write_text(json.dumps(receipt))
        result = self.cli(folder, env, "publish")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("changed since pre-auth", result.stderr)

    def test_http_errors_and_redirects_do_not_leak_secrets(self):
        error = self.mod.urllib.error.HTTPError(
            self.mod.AMO,
            401,
            "fake-secret-sentinel",
            {},
            io.BytesIO(b"fake-secret-sentinel"),
        )
        opener = Mock()
        opener.open.side_effect = error
        with patch.object(self.mod.urllib.request, "build_opener", return_value=opener):
            with self.assertRaises(self.mod.Failure) as raised:
                self.mod.http(
                    self.mod.AMO, headers={"Authorization": "fake-secret-sentinel"}
                )
            self.assertNotIn("fake-secret-sentinel", str(raised.exception))
        redirect = self.mod.urllib.error.HTTPError(
            self.mod.AMO,
            302,
            "Found",
            {"Location": "https://evil.invalid"},
            io.BytesIO(),
        )
        opener.open.side_effect = redirect
        with (
            patch.object(self.mod.urllib.request, "build_opener", return_value=opener),
            self.assertRaises(self.mod.Failure),
        ):
            self.mod.http(
                "https://addons.mozilla.org/firefox/downloads/file/123/test.xpi",
                binary=True,
            )


if __name__ == "__main__":
    unittest.main()
