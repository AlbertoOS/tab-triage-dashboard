"""Trusted store publisher. Standard library only; archives are passive data.

Never print subprocess/HTTP responses or exception text: those may contain secrets.
"""

import base64
from decimal import Decimal, DecimalException
import hashlib
import hmac
import io
import json
import math
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
from workflow_diagnostics import emit as store_diagnostic, write_record as write_chrome_diagnostic

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


def canonical_manifest(raw):
    negative_integer_zero = object()

    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "Manifest JSON has duplicate keys.")
            result[key] = value
        return result

    def reject_constant(value):
        raise Failure("Manifest JSON contains a non-finite number.")

    def exact_decimal(token):
        value = Decimal(token)
        require(
            value.is_finite() and math.isfinite(float(value)),
            "Manifest JSON contains a non-finite number.",
        )
        return value

    def exact_integer(token):
        # JSON.parse preserves integer-spelled negative zero; Python int does not.
        return negative_integer_zero if token == "-0" else int(token)

    def typed_value(value):
        if value is negative_integer_zero:
            return (int, 0, True)
        if type(value) is dict:
            return (dict, {key: typed_value(item) for key, item in value.items()})
        if type(value) is list:
            return (list, tuple(typed_value(item) for item in value))
        if type(value) is Decimal and value.is_zero():
            return (Decimal, value, value.is_signed())
        return (type(value), value)

    try:
        value = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=object_pairs,
            parse_constant=reject_constant,
            parse_float=exact_decimal,
            parse_int=exact_integer,
        )
        require(type(value) is dict, "Manifest JSON must be an object.")
        # Type tags prevent bool/int equality; Decimal retains exact numeric values.
        return typed_value(value)
    except (ValueError, UnicodeError, RecursionError, DecimalException, OverflowError):
        raise Failure("Manifest JSON is invalid or contains a non-finite number.") from None


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
        entries.keys() == expected.keys()
        and (not signed or "manifest.json" in expected)
        and all(
            canonical_manifest(entries[name]) == canonical_manifest(data)
            if signed and name == "manifest.json"
            else entries[name] == data
            for name, data in expected.items()
        ),
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
    store_diagnostic("release", "verify_release", "start")
    store_diagnostic("release", "metadata", "start")
    tag_value(tag)
    release, oid, commit = release_identity(tag)
    store_diagnostic("release", "metadata", "complete", commit=commit, asset_count=len(release["assets"]))
    store_diagnostic("release", "tag", "start")
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
    store_diagnostic("release", "tag", "complete", commit=commit)
    store_diagnostic("release", "source", "start")
    blobs = {}
    for browser in ("firefox", "chrome"):
        version, blobs[browser] = source_files(commit, browser)
        require(
            version == tag.removeprefix("v"), "Tag and tagged source version differ."
        )
    store_diagnostic("release", "source", "complete", version=version, count=len(blobs["firefox"]))
    store_diagnostic("release", "assets", "start")
    downloads = {}
    repo = os.environ["GITHUB_REPOSITORY"]
    for asset in release["assets"]:
        raw = gh(f"repos/{repo}/releases/assets/{asset['id']}", binary=True)
        require(len(raw) == asset["size"], "Downloaded release asset size differs.")
        downloads[asset["name"]] = raw
    store_diagnostic("release", "assets", "complete", asset_count=len(downloads))
    store_diagnostic("release", "provenance", "start")
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
    store_diagnostic("release", "provenance", "complete")
    for browser, name in zip(("firefox", "chrome"), ZIP_NAMES):
        store_diagnostic(browser, "archive", "start")
        verify_zip(downloads[name], blobs[browser])
        store_diagnostic(browser, "archive", "complete", digest=hashes[name])
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
    store_diagnostic("release", "receipt", "start")
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name, data in downloads.items():
        (output / name).write_bytes(data)
    (output / "verified.json").write_text(json.dumps(receipt))
    store_diagnostic("release", "receipt", "complete")
    store_diagnostic("release", "verify_release", "complete", version=version, commit=commit)
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
    store_diagnostic(browser, "prerequisites", "start")
    env = os.environ if env is None else env
    if browser == "firefox":
        require(
            env.get("WEB_EXT_API_KEY") and env.get("WEB_EXT_API_SECRET"),
            "Configure WEB_EXT_API_KEY and WEB_EXT_API_SECRET in firefox-release.",
        )
        store_diagnostic(browser, "prerequisites", "complete")
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
    store_diagnostic(browser, "prerequisites", "complete")


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
            if url.startswith((CWS, AMO, *download_prefixes)):
                record = {
                    "http_status": code if type(code) is int and 100 <= code <= 599 else "unknown",
                    "method": method if method in ("GET", "POST") else "unknown",
                }
                prefix = "Chrome HTTP diagnostic: " if url.startswith(CWS) else "Firefox HTTP diagnostic: "
                write_chrome_diagnostic(prefix, record)
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
    firefox_diagnostic("archive", "start", version.get("version"))
    raw = http(url, binary=True)
    require(
        file.get("hash") == "sha256:" + digest(raw),
        "AMO file SHA256 readback differs from API metadata.",
    )
    verify_zip(raw, expected, signed=True)
    firefox_diagnostic("archive", "complete", version.get("version"))
    return "public" if state == "public" else "submitted-for-review"


def firefox_diagnostic(stage, event, version, status=None):
    """Project Firefox status without identities, URLs or validation messages."""
    def safe_version(value):
        return value if type(value) is str and len(value) <= 32 and re.fullmatch(
            r"[0-9]{1,5}(?:\.[0-9]{1,5}){2,3}", value
        ) and all(int(part) <= 65535 for part in value.split(".")) else "invalid"

    record: dict[str, Any] = {
        "component": "firefox",
        "stage": stage if stage in ("preflight", "upload", "validation", "version_create", "readback", "archive") else "unknown",
        "event": event if event in ("start", "response", "complete", "uncertain") else "unknown",
        "version": safe_version(version),
    }
    if event == "response":
        record["present"] = status is not None
        if type(status) is dict:
            for key in ("processed", "valid"):
                if key in status:
                    record[key] = status[key] if type(status[key]) is bool else "unknown"
            if "version" in status:
                record["observed_version"] = safe_version(status["version"])
                record["version_matches"] = status["version"] == version
            if "channel" in status:
                record["channel"] = status["channel"] if type(status["channel"]) is str and status["channel"] in ("listed", "unlisted") else "unknown"
            file = status.get("file")
            if type(file) is dict:
                state = file.get("status")
                record["file_state"] = state if type(state) is str and state in ("public", "unreviewed", "disabled") else "unknown"
            validation = status.get("validation")
            if type(validation) is dict:
                for key in ("errors", "warnings"):
                    values = validation.get(key)
                    if type(values) is list:
                        record["error_count" if key == "errors" else "warning_count"] = len(values) if len(values) <= 65535 else "unknown"
        elif status is not None:
            record["schema"] = "unexpected"
    write_chrome_diagnostic("Workflow diagnostic: ", record)


def publish_firefox(receipt, expected, raw):
    version = receipt["version"]
    base = "addons/addon/" + urllib.parse.quote(GUID, safe="") + "/versions/"
    firefox_diagnostic("preflight", "start", version)
    existing = amo(base + version + "/", missing=True)
    firefox_diagnostic("preflight", "response", version, existing)
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
    firefox_diagnostic("upload", "start", version)
    upload = http(
        AMO + "addons/upload/",
        "POST",
        data,
        {**amo_headers(), "Content-Type": "multipart/form-data; boundary=" + boundary},
    )
    firefox_diagnostic("upload", "response", version, upload)
    upload_id = upload.get("uuid", "")
    require(
        re.fullmatch(r"[0-9a-f]{32}", upload_id),
        "AMO returned an invalid upload identity.",
    )
    for attempt in range(POLL_COUNT):
        firefox_diagnostic("validation", "start", version)
        status = amo(f"addons/upload/{upload_id}/")
        firefox_diagnostic("validation", "response", version, status)
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
    firefox_diagnostic("version_create", "start", version)
    amo(base, "POST", {"upload": upload_id})
    firefox_diagnostic("version_create", "response", version)
    # Always read back the exact version, not latest/current_version.
    for attempt in range(POLL_COUNT):
        firefox_diagnostic("readback", "start", version)
        current = amo(base + version + "/", missing=True)
        firefox_diagnostic("readback", "response", version, current)
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
                result = amo_readback(current, expected, raw)
                firefox_diagnostic("readback", "complete", version)
                return result
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
            if state == "PUBLISHED_TO_TESTERS":
                return "published-to-testers"
            if state == "PENDING_REVIEW":
                return "submitted-for-review"
            if state == "STAGED":
                return "staged-not-public"
    return None


def chrome_diagnostic(stage, event, version, status=None):
    """Log a bounded projection, never raw API data or credential fields."""
    require(
        stage in ("preflight", "upload", "upload_poll", "publish", "readback")
        and event in ("start", "response", "complete"),
        "Invalid Chrome diagnostic stage/event.",
    )

    def safe_version(value):
        return (
            type(value) is str
            and len(value) <= 32
            and re.fullmatch(r"[0-9]{1,5}(?:\.[0-9]{1,5}){2,3}", value) is not None
            and all(int(part) <= 65535 for part in value.split("."))
        )

    def safe_state(value, allowed):
        return value if type(value) is str and value in allowed else "unknown"

    record = {
        "stage": stage, "event": event,
        "target_version": version if safe_version(version) else "invalid",
    }
    if event == "start":
        record["runtime"] = "python " + ".".join(map(str, sys.version_info[:3]))
    if status is not None or event == "response" and stage != "publish":
        if type(status) is not dict:
            record["schema"] = "unexpected"
        else:
            for key, label in (
                ("publishedItemRevisionStatus", "published"),
                ("submittedItemRevisionStatus", "submitted"),
            ):
                revision = status.get(key)
                state, versions = "absent", []
                if revision is not None:
                    state = "unknown"
                    if type(revision) is dict:
                        state = safe_state(revision.get("state"), {
                            "PUBLISHED", "PUBLISHED_TO_TESTERS", "PENDING_REVIEW",
                            "STAGED", "REJECTED", "CANCELLED", "ITEM_STATE_UNSPECIFIED",
                        })
                        channels = revision.get("distributionChannels")
                        if type(channels) is list:
                            versions = sorted({
                                channel["crxVersion"] for channel in channels[:8]
                                if type(channel) is dict
                                and safe_version(channel.get("crxVersion"))
                            })
                record[label] = {"state": state, "versions": versions}
            record["upload_state"] = safe_state(
                status.get("uploadState", status.get("lastAsyncUploadState")),
                {"SUCCEEDED", "IN_PROGRESS", "FAILED", "UPLOAD_STATE_UNSPECIFIED"},
            )
            for key, label in (("warned", "warned"), ("takenDown", "taken_down")):
                value = status.get(key, False)
                record[label] = value if type(value) is bool else "unknown"
            if "crxVersion" in status:
                value = status["crxVersion"]
                record["uploaded_version"] = value if safe_version(value) else "invalid"
    write_chrome_diagnostic("Chrome diagnostic: ", record)


def publish_chrome(receipt, expected, raw):
    require(
        os.environ.get("CWS_ACCESS_TOKEN"),
        "Chrome requires a short-lived WIF OAuth access token.",
    )
    name = f"publishers/{os.environ['CWS_PUBLISHER_ID']}/items/{os.environ['CWS_EXTENSION_ID']}"
    version = receipt["version"]
    chrome_diagnostic("preflight", "start", version)
    status = chrome(name + ":fetchStatus")
    chrome_diagnostic("preflight", "response", version, status)
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
    submission = status.get("submittedItemRevisionStatus")
    # Rejected/cancelled historical revisions are not active submissions.
    require(
        submission is None or submission.get("state") in ("REJECTED", "CANCELLED"),
        "Chrome has an active or unknown submission state; do not replace it.",
    )
    require(
        status.get("lastAsyncUploadState") != "IN_PROGRESS",
        "Chrome has an asynchronous upload in progress; inspect dashboard before retrying.",
    )
    fence(receipt)
    chrome_diagnostic("upload", "start", version)
    upload = chrome(name + ":upload", "POST", raw=raw)
    chrome_diagnostic("upload", "response", version, upload)
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
            chrome_diagnostic("upload_poll", "start", version)
            upload_status = chrome(name + ":fetchStatus")
            chrome_diagnostic("upload_poll", "response", version, upload_status)
            state = upload_status.get("lastAsyncUploadState")
            if state != "IN_PROGRESS":
                break
            time.sleep(POLL_SECONDS)
        require(state == "SUCCEEDED", "Chrome asynchronous upload failed/timed out.")
    fence(receipt)
    chrome_diagnostic("publish", "start", version)
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
    chrome_diagnostic("publish", "response", version)
    for attempt in range(POLL_COUNT):
        chrome_diagnostic("readback", "start", version)
        current = chrome(name + ":fetchStatus")
        chrome_diagnostic("readback", "response", version, current)
        require(
            current.get("name") == name
            and current.get("itemId") == os.environ["CWS_EXTENSION_ID"],
            "Chrome readback returned another store item.",
        )
        result = chrome_state(current, version)
        if result:
            chrome_diagnostic("readback", "complete", version)
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
    store_diagnostic(browser, "context", "start", runtime_version=".".join(map(str, sys.version_info[:3])))
    guard(browser)
    store_diagnostic(browser, "context", "complete")
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
        try:
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
                summary.write(message + "\n")
        except (OSError, ValueError):
            # The accepted provider result does not depend on a summary sink.
            pass


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
