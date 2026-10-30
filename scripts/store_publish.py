"""Trusted store publisher. Standard library only; archives are passive data.

Never print subprocess/HTTP responses or exception text: those may contain secrets.
"""

import base64
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
GUID = "tab-triage-dashboard@albertoos"
AMO = "https://addons.mozilla.org/api/v5/"
CWS = "https://chromewebstore.googleapis.com/"
ZIP_NAMES = [f"tab-triage-dashboard-{b}.zip" for b in ("firefox", "chrome")]
ASSETS = [*ZIP_NAMES, "provenance.json"]
SOURCES = ["background.js", "triage.html", "triage.js", "utils.js", "triage.css"]
LIMIT = 20 * 1024 * 1024
POLL_COUNT = 30
POLL_SECONDS = 10
SIGNATURES = {
    "META-INF/manifest.mf",
    "META-INF/mozilla.sf",
    "META-INF/mozilla.rsa",
    "META-INF/cose.manifest",
    "META-INF/cose.sig",
}


class Failure(Exception):
    """Only static, non-sensitive diagnostic messages belong here."""


def require(condition, message):
    if not condition:
        raise Failure(message)


def guard(browser, env=None):
    env = os.environ if env is None else env
    repo = env.get("GITHUB_REPOSITORY", "")
    require(
        browser in ("firefox", "chrome")
        and re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo),
        "Invalid store or repository context.",
    )
    require(
        env.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
        and env.get("GITHUB_REF") == "refs/heads/main"
        and env.get("GITHUB_REF_TYPE") == "branch",
        "Store jobs require workflow_dispatch on the main branch.",
    )
    require(
        env.get("GITHUB_WORKFLOW_REF")
        == f"{repo}/.github/workflows/publish-{browser}.yml@refs/heads/main",
        "Store job requires its exact main workflow identity.",
    )


def tag_value(value):
    require(
        re.fullmatch(r"v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", value),
        "Select a stable [v]MAJOR.MINOR.PATCH tag.",
    )
    return value


def command(args, cwd=ROOT, data=None):
    child_env = {
        key: value
        for key, value in os.environ.items()
        if key
        not in (
            "WEB_EXT_API_KEY",
            "WEB_EXT_API_SECRET",
            "CWS_ACCESS_TOKEN",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
            "ACTIONS_ID_TOKEN_REQUEST_URL",
        )
    }
    result = subprocess.run(
        args, cwd=cwd, input=data, env=child_env, capture_output=True, timeout=120
    )
    require(
        result.returncode == 0,
        "Git or GitHub operation failed; no raw response is logged.",
    )
    require(
        len(result.stdout) <= LIMIT, "Git or GitHub result exceeded the size limit."
    )
    return result.stdout


def gh(endpoint, binary=False) -> Any:
    args = ["gh", "api", endpoint]
    if binary:
        args += ["-H", "Accept: application/octet-stream"]
    raw = command(args)
    return raw if binary else json.loads(raw)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def zip_entries(raw):
    require(len(raw) <= LIMIT, "Archive exceeds size limit.")
    entries = {}
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        total = 0
        for entry in archive.infolist():
            name = entry.filename
            require(
                name == entry.orig_filename
                and name not in entries
                and "\\" not in name
                and not name.startswith("/")
                and all(p not in ("", ".", "..") for p in name.rstrip("/").split("/")),
                "Archive has duplicate or unsafe paths.",
            )
            mode = entry.external_attr >> 16
            require(
                not stat.S_ISLNK(mode)
                and stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR),
                "Archive has a non-regular entry.",
            )
            require(not entry.flag_bits & 1, "Encrypted archives are not accepted.")
            total += entry.file_size
            require(total <= LIMIT, "Expanded archive exceeds size limit.")
            entries[name] = archive.read(entry)
    return entries


def verify_zip(raw, expected, signed=False):
    entries = zip_entries(raw)
    # Directory metadata is not executable/content; permit only real parent directories.
    directories = {str(Path(name).parent) + "/" for name in expected if "/" in name}
    for name in list(entries):
        if name.endswith("/"):
            require(
                entries[name] == b""
                and (name in directories or signed and name == "META-INF/"),
                "Unexpected archive directory.",
            )
            del entries[name]
        elif signed and name in SIGNATURES:
            del entries[name]
    require(
        entries == expected,
        "Archive inventory/content differs from exact tagged Git blobs.",
    )


def git(*args):
    return command(["git", *args]).decode().strip()


def source_files(commit, browser):
    raw = command(
        [
            "git",
            "ls-tree",
            "-rz",
            commit,
            "--",
            *SOURCES,
            "icons/",
            "package.json",
            "manifest.firefox.json",
            "manifest.chrome.json",
        ]
    )
    files = {}
    for record in raw.split(b"\0"):
        if not record:
            continue
        meta, name = record.split(b"\t", 1)
        mode, kind, oid = meta.decode().split()
        require(
            mode in ("100644", "100755") and kind == "blob",
            "Distribution source must contain only regular Git blobs.",
        )
        files[name.decode()] = command(["git", "cat-file", "blob", oid])
    version = json.loads(files["package.json"])["version"]
    for target in ("firefox", "chrome"):
        require(
            json.loads(files[f"manifest.{target}.json"])["version"] == version,
            "Package and both manifest versions must match.",
        )
    require(
        json.loads(files["manifest.firefox.json"])["browser_specific_settings"][
            "gecko"
        ]["id"]
        == GUID,
        "Firefox GUID differs from the existing listed add-on.",
    )
    expected = {
        name: data
        for name, data in files.items()
        if name in SOURCES or name.startswith("icons/")
    }
    require(
        all(name in expected for name in SOURCES)
        and any(n.startswith("icons/") for n in expected),
        "Tagged distribution inputs are incomplete.",
    )
    expected["manifest.json"] = files[f"manifest.{browser}.json"]
    return version, expected


def release_identity(tag):
    repo = os.environ["GITHUB_REPOSITORY"]
    release = gh(f"repos/{repo}/releases/tags/{tag}")
    require(
        release.get("tag_name") == tag
        and release.get("draft") is False
        and release.get("prerelease") is False
        and release.get("published_at"),
        "Select a published, non-draft, non-prerelease GitHub release.",
    )
    assets = release.get("assets", [])
    require(
        len(assets) == len(ASSETS)
        and sorted(a.get("name", "") for a in assets) == sorted(ASSETS),
        "Release must contain exactly both browser ZIPs and provenance.json.",
    )
    require(
        all(
            type(a.get("id")) is int
            and 0 < a.get("size", 0) <= LIMIT
            and a.get("state") == "uploaded"
            for a in assets
        ),
        "Release assets are incomplete or oversized.",
    )
    ref = gh(f"repos/{repo}/git/ref/tags/{tag}")
    require(
        ref.get("ref") == f"refs/tags/{tag}"
        and ref.get("object", {}).get("type") == "tag",
        "Release requires an annotated tag object.",
    )
    oid = ref["object"]["sha"]
    require(re.fullmatch(r"[0-9a-f]{40}", oid), "Invalid annotated tag identity.")
    obj = gh(f"repos/{repo}/git/tags/{oid}")
    require(
        obj.get("sha") == oid
        and obj.get("tag") == tag
        and obj.get("object", {}).get("type") == "commit",
        "Annotated tag must point directly to a commit.",
    )
    commit = obj["object"]["sha"]
    require(re.fullmatch(r"[0-9a-f]{40}", commit), "Invalid tag commit identity.")
    return release, oid, commit


def verify_release(tag, output):
    tag_value(tag)
    release, oid, commit = release_identity(tag)
    # Do not execute, checkout, or extract tag scripts, attributes, or hooks.
    git(
        "-c",
        "core.hooksPath=/dev/null",
        "fetch",
        "--no-tags",
        "--no-prune",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        "--refmap=",
        "origin",
        "+refs/heads/main:refs/store-publish/main",
        f"+refs/tags/{tag}:refs/store-publish/selected-tag",
    )
    require(
        git("rev-parse", "refs/store-publish/selected-tag") == oid
        and git("rev-parse", f"{oid}^{{commit}}") == commit,
        "Live tag changed during source fetch.",
    )
    git("merge-base", "--is-ancestor", commit, "refs/store-publish/main")
    blobs = {}
    for browser in ("firefox", "chrome"):
        version, blobs[browser] = source_files(commit, browser)
        require(
            version == tag.removeprefix("v"), "Tag and tagged source version differ."
        )
    downloads = {}
    repo = os.environ["GITHUB_REPOSITORY"]
    for asset in release["assets"]:
        raw = gh(f"repos/{repo}/releases/assets/{asset['id']}", binary=True)
        require(len(raw) == asset["size"], "Downloaded release asset size differs.")
        downloads[asset["name"]] = raw
    provenance = json.loads(downloads["provenance.json"])
    hashes = {name: digest(downloads[name]) for name in ZIP_NAMES}
    require(
        provenance
        == {
            "tag": tag,
            "tagObject": oid,
            "commit": commit,
            "version": version,
            "sha256": hashes,
        },
        "Release provenance does not bind exact tag identities and archive SHA256.",
    )
    for browser, name in zip(("firefox", "chrome"), ZIP_NAMES):
        verify_zip(downloads[name], blobs[browser])
    # Fence replacement of either an annotated tag or release assets mid-verification.
    again, again_oid, again_commit = release_identity(tag)
    require(
        (
            again["id"],
            {a["name"]: (a["id"], a["size"], a.get("digest")) for a in again["assets"]},
            again_oid,
            again_commit,
        )
        == (
            release["id"],
            {
                a["name"]: (a["id"], a["size"], a.get("digest"))
                for a in release["assets"]
            },
            oid,
            commit,
        ),
        "Live release or tag changed during verification.",
    )
    receipt = {
        **provenance,
        "releaseId": release["id"],
        "assetIds": {a["name"]: a["id"] for a in release["assets"]},
    }
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name, data in downloads.items():
        (output / name).write_bytes(data)
    (output / "verified.json").write_text(json.dumps(receipt))
    return receipt, blobs


def fence(receipt):
    release, oid, commit = release_identity(receipt["tag"])
    require(
        oid == receipt["tagObject"]
        and commit == receipt["commit"]
        and release["id"] == receipt["releaseId"]
        and {a["name"]: a["id"] for a in release["assets"]} == receipt["assetIds"],
        "Live tag or release assets changed before store mutation.",
    )


def prerequisites(browser, env=None):
    env = os.environ if env is None else env
    if browser == "firefox":
        require(
            env.get("WEB_EXT_API_KEY") and env.get("WEB_EXT_API_SECRET"),
            "Configure WEB_EXT_API_KEY and WEB_EXT_API_SECRET in firefox-release.",
        )
        return
    require(
        env.get("CWS_PUBLISHER_ID") and env.get("CWS_EXTENSION_ID"),
        "Chrome prerequisite: link the service account in the publisher dashboard, create/complete the existing listing, then set CWS_PUBLISHER_ID and CWS_EXTENSION_ID in chrome-release before Google authentication.",
    )
    require(
        re.fullmatch(r"[A-Za-z0-9_-]+", env["CWS_PUBLISHER_ID"])
        and re.fullmatch(r"[a-p]{32}", env["CWS_EXTENSION_ID"]),
        "Chrome publisher/item identifiers have invalid syntax.",
    )
    require(
        re.fullmatch(
            r"projects/[0-9]+/locations/global/workloadIdentityPools/[A-Za-z0-9_-]+/providers/[A-Za-z0-9_-]+",
            env.get("GCP_WORKLOAD_IDENTITY_PROVIDER", ""),
        )
        and re.fullmatch(
            r"[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+\.iam\.gserviceaccount\.com",
            env.get("GCP_SERVICE_ACCOUNT", ""),
        ),
        "Configure keyless provider and service account variables in chrome-release.",
    )


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Let http() handle redirects explicitly, never forwarding authorization.
        return None


def http(
    url, method="GET", data=None, headers=None, missing=False, binary=False
) -> Any:
    download_prefixes = (
        "https://addons.mozilla.org/firefox/downloads/file/",
        "https://addons.mozilla.org/user-media/addons/",
        "https://addons.cdn.mozilla.net/user-media/addons/",
    )
    require(
        url.startswith((AMO, CWS, *download_prefixes)),
        "Unexpected API/download origin.",
    )
    require(
        not binary or method == "GET" and not headers and data is None,
        "Downloads must be credential-free GET requests.",
    )
    for hop in range(4):
        request = urllib.request.Request(
            url, data=data, method=method, headers=headers or {}
        )
        try:
            with urllib.request.build_opener(NoRedirect).open(
                request, timeout=60
            ) as response:
                raw = response.read(LIMIT + 1)
                require(len(raw) <= LIMIT, "Store response exceeded size limit.")
                return raw if binary else json.loads(raw)
        except urllib.error.HTTPError as error:
            code, location = error.code, error.headers.get("Location", "")
            error.close()
            if missing and code == 404:
                return None
            if binary and code in (301, 302, 303, 307, 308):
                target = urllib.parse.urljoin(url, location)
                require(
                    target.startswith(download_prefixes),
                    "Unexpected download redirect origin/path.",
                )
                url = target
                continue
            raise Failure(
                "Store HTTP request failed; inspect the developer dashboard (raw response suppressed)."
            ) from None
        except (urllib.error.URLError, TimeoutError):
            raise Failure(
                "Store request timed out or failed; do not blindly repeat an uncertain upload."
            ) from None
    raise Failure("Too many download redirects.")


def amo_headers():
    now = int(time.time())

    def encode(raw):
        return base64.urlsafe_b64encode(raw).rstrip(b"=")

    head = encode(b'{"alg":"HS256","typ":"JWT"}')
    body = encode(
        json.dumps(
            {
                "iss": os.environ["WEB_EXT_API_KEY"],
                "jti": str(uuid.uuid4()),
                "iat": now,
                "exp": now + 60,
            }
        ).encode()
    )
    signing = head + b"." + body
    signature = encode(
        hmac.new(
            os.environ["WEB_EXT_API_SECRET"].encode(), signing, hashlib.sha256
        ).digest()
    )
    return {"Authorization": "JWT " + (signing + b"." + signature).decode()}


def amo(path, method="GET", payload=None, missing=False):
    headers = amo_headers()
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode()
    return http(AMO + path, method, data, headers, missing=missing)


def amo_readback(version, expected, uploaded=None):
    require(
        version.get("channel") == "listed" and version.get("is_disabled") is not True,
        "AMO version is not an enabled listed submission.",
    )
    file = version.get("file", {})
    state = file.get("status")
    require(
        state in ("public", "unreviewed"),
        "AMO version is rejected/disabled or has an unknown state.",
    )
    if uploaded is not None and file.get("hash") == "sha256:" + digest(uploaded):
        # Pending unsigned files need not be publicly downloadable yet. The API
        # checksum proves exact archive identity, not merely version equality.
        verify_zip(uploaded, expected)
        return "public" if state == "public" else "submitted-for-review"
    url = file.get("url", "")
    require(
        url.startswith("https://addons.mozilla.org/firefox/downloads/file/"),
        "AMO file download URL has an unexpected origin/path.",
    )
    raw = http(url, binary=True)
    require(
        file.get("hash") == "sha256:" + digest(raw),
        "AMO file SHA256 readback differs from API metadata.",
    )
    verify_zip(raw, expected, signed=True)
    return "public" if state == "public" else "submitted-for-review"


def publish_firefox(receipt, expected, raw):
    version = receipt["version"]
    base = "addons/addon/" + urllib.parse.quote(GUID, safe="") + "/versions/"
    existing = amo(base + version + "/", missing=True)
    if existing is not None:
        require(existing.get("version") == version, "AMO returned a different version.")
        return amo_readback(existing, expected, raw)
    boundary = "store-" + uuid.uuid4().hex
    data = (
        (
            f'--{boundary}\r\nContent-Disposition: form-data; name="channel"\r\n\r\nlisted\r\n--{boundary}\r\nContent-Disposition: form-data; name="upload"; filename="extension.zip"\r\nContent-Type: application/zip\r\n\r\n'
        ).encode()
        + raw
        + f"\r\n--{boundary}--\r\n".encode()
    )
    fence(receipt)
    upload = http(
        AMO + "addons/upload/",
        "POST",
        data,
        {**amo_headers(), "Content-Type": "multipart/form-data; boundary=" + boundary},
    )
    upload_id = upload.get("uuid", "")
    require(
        re.fullmatch(r"[0-9a-f]{32}", upload_id),
        "AMO returned an invalid upload identity.",
    )
    for attempt in range(POLL_COUNT):
        status = amo(f"addons/upload/{upload_id}/")
        if status.get("processed") is True:
            require(
                status.get("valid") is True
                and status.get("version") == version
                and status.get("channel") == "listed",
                "AMO validation failed or returned mismatched version/channel.",
            )
            break
        time.sleep(POLL_SECONDS)
    else:
        raise Failure(
            "AMO validation timed out; inspect upload status before retrying."
        )
    fence(receipt)
    amo(base, "POST", {"upload": upload_id})
    # Always read back the exact version, not latest/current_version.
    for attempt in range(POLL_COUNT):
        current = amo(base + version + "/", missing=True)
        if current is not None:
            require(
                current.get("version") == version,
                "AMO readback returned a different version.",
            )
            if current.get("file", {}).get("status") == "disabled":
                raise Failure(
                    "AMO submission is disabled/rejected; inspect the developer dashboard."
                )
            if current.get("file", {}).get("status") in (
                "public",
                "unreviewed",
            ) and (
                current.get("file", {}).get("url")
                or current.get("file", {}).get("hash") == "sha256:" + digest(raw)
            ):
                return amo_readback(current, expected, raw)
        time.sleep(POLL_SECONDS)
    raise Failure(
        "AMO submission readback timed out; submission may exist, inspect before retrying."
    )


def chrome(path, method="GET", payload=None, raw=None):
    headers = {"Authorization": "Bearer " + os.environ["CWS_ACCESS_TOKEN"]}
    if raw is not None:
        headers["Content-Type"] = "application/zip"
        return http(CWS + "upload/v2/" + path, method, raw, headers)
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode()
    return http(CWS + "v2/" + path, method, data, headers)


def chrome_versions(status):
    return {
        c.get("crxVersion")
        for key in ("submittedItemRevisionStatus", "publishedItemRevisionStatus")
        for c in status.get(key, {}).get("distributionChannels", [])
    }


def chrome_state(status, version):
    require(
        not status.get("takenDown") and not status.get("warned"),
        "Chrome item has a policy warning/takedown; inspect the dashboard.",
    )
    for key in ("publishedItemRevisionStatus", "submittedItemRevisionStatus"):
        revision = status.get(key, {})
        if any(
            c.get("crxVersion") == version
            for c in revision.get("distributionChannels", [])
        ):
            state = revision.get("state")
            require(
                state not in ("REJECTED", "CANCELLED"),
                "Chrome submission was rejected or cancelled.",
            )
            if state == "PUBLISHED":
                return "public"
            if state == "PENDING_REVIEW":
                return "submitted-for-review"
            if state == "STAGED":
                return "staged-not-public"
    return None


def publish_chrome(receipt, expected, raw):
    require(
        os.environ.get("CWS_ACCESS_TOKEN"),
        "Chrome requires a short-lived WIF OAuth access token.",
    )
    name = f"publishers/{os.environ['CWS_PUBLISHER_ID']}/items/{os.environ['CWS_EXTENSION_ID']}"
    version = receipt["version"]
    status = chrome(name + ":fetchStatus")
    require(
        status.get("name") == name
        and status.get("itemId") == os.environ["CWS_EXTENSION_ID"],
        "Chrome returned another store item.",
    )
    require(
        not status.get("takenDown") and not status.get("warned"),
        "Chrome item has a policy warning/takedown.",
    )
    require(
        version not in chrome_versions(status),
        "Chrome already has this version; API has no package digest/download. Refusing duplicate upload or unverifiable equal-version success; reconcile exact package in dashboard.",
    )
    require(
        not status.get("submittedItemRevisionStatus"),
        "Chrome has another active submission; do not replace it.",
    )
    require(
        status.get("lastAsyncUploadState") != "IN_PROGRESS",
        "Chrome has an asynchronous upload in progress; inspect dashboard before retrying.",
    )
    fence(receipt)
    upload = chrome(name + ":upload", "POST", raw=raw)
    require(
        upload.get("name") == name
        and upload.get("itemId") == os.environ["CWS_EXTENSION_ID"],
        "Chrome upload returned another store item.",
    )
    state = upload.get("uploadState")
    require(
        state in ("SUCCEEDED", "IN_PROGRESS"),
        "Chrome upload failed or has an unknown state.",
    )
    if state == "SUCCEEDED":
        require(
            upload.get("crxVersion") == version,
            "Chrome upload readback version differs.",
        )
    else:
        # Async status exposes processing state, not the draft version. The final
        # submission must still read back this run's exact version below.
        for attempt in range(POLL_COUNT):
            state = chrome(name + ":fetchStatus").get("lastAsyncUploadState")
            if state != "IN_PROGRESS":
                break
            time.sleep(POLL_SECONDS)
        require(state == "SUCCEEDED", "Chrome asynchronous upload failed/timed out.")
    fence(receipt)
    chrome(
        name + ":publish",
        "POST",
        {
            "publishType": "DEFAULT_PUBLISH",
            "skipReview": False,
            "blockOnWarnings": True,
            "deployInfos": [{"deployPercentage": 100}],
        },
    )
    for attempt in range(POLL_COUNT):
        current = chrome(name + ":fetchStatus")
        require(
            current.get("name") == name
            and current.get("itemId") == os.environ["CWS_EXTENSION_ID"],
            "Chrome readback returned another store item.",
        )
        result = chrome_state(current, version)
        if result:
            return result
        time.sleep(POLL_SECONDS)
    raise Failure(
        "Chrome submission readback timed out; inspect dashboard before retrying."
    )


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    require(
        len(argv) == 2 and argv[0] in ("verify", "prerequisites", "publish"),
        "Usage: store_publish.py verify|prerequisites|publish firefox|chrome",
    )
    operation, browser = argv
    os.umask(0o077)
    guard(browser)
    if operation == "prerequisites":
        prerequisites(browser)
        print(
            "Store configuration prerequisites present (not an authentication check)."
        )
        return
    tag = tag_value(os.environ.get("RELEASE_TAG", ""))
    output = Path(os.environ["STORE_ASSETS"])
    previous = (
        json.loads((output / "verified.json").read_bytes())
        if operation == "publish"
        else None
    )
    # Repeat full verification at the credential boundary, comparing to pre-auth receipt.
    receipt, blobs = verify_release(tag, output)
    if operation == "verify":
        print(
            "Verified published release, annotated tag/main ancestry, archive content and SHA256 provenance; no store authentication."
        )
        return
    require(
        receipt == previous,
        "Release changed since pre-auth verification; refusing store upload.",
    )
    prerequisites(browser)
    raw = (output / f"tab-triage-dashboard-{browser}.zip").read_bytes()
    result = (publish_firefox if browser == "firefox" else publish_chrome)(
        receipt, blobs[browser], raw
    )
    message = f"{browser}: {result}; version {receipt['version']}; source {receipt['commit']}; archive sha256 {digest(raw)}"
    print(message)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
            summary.write(message + "\n")


if __name__ == "__main__":
    try:
        main()
    except Failure as error:
        print("Error: " + str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print(
            "Error: publication stopped; unexpected data/transport failure (details suppressed). Inspect the store dashboard before retrying.",
            file=sys.stderr,
        )
        sys.exit(1)
