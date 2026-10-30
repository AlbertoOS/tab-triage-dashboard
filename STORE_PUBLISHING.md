# Browser store publication

Publishing a stable GitHub Release automatically dispatches separate Firefox and Chrome workflows **on `main`**. Each store runs independently. Publication is the default; no per-release sign-in or approval prompt is required once the accounts and protected environments are configured. Store review can still delay availability.

The workflows update existing store listings. They do not create a Chrome Web Store listing, change its visibility, bypass review, cancel submissions, or delete store versions.

## One-time setup

Create GitHub environments named `firefox-release` and `chrome-release`. Under deployment branches/tags, choose **Selected branches and tags**, allow the **branch `main` only**, and allow no tags. Do not select all protected branches. Required reviewers are optional policy, not a requirement of this automation. Keep store secrets in their environment, not repository/organization scope.

| Environment | Setting | Purpose |
| --- | --- | --- |
| `firefox-release` | Secrets `WEB_EXT_API_KEY`, `WEB_EXT_API_SECRET` | AMO API credentials for an author of the existing listed add-on `tab-triage-dashboard@albertoos` |
| `chrome-release` | Variable `GCP_WORKLOAD_IDENTITY_PROVIDER` | Full Workload Identity Federation provider resource name |
| `chrome-release` | Variable `GCP_SERVICE_ACCOUNT` | Service account to impersonate |
| `chrome-release` | Variables `CWS_PUBLISHER_ID`, `CWS_EXTENSION_ID` | Real publisher and existing item IDs from the Chrome Developer Dashboard |

Never commit credentials, service-account keys, browser session cookies, or OAuth refresh tokens. Firefox signs a fresh short-lived HS256 JWT for each API request. Chrome uses `google-github-actions/auth@v3` to impersonate the service account and generate a short-lived access token scoped to `https://www.googleapis.com/auth/chromewebstore`; it does not create a credentials file or export ambient credentials.

### Chrome dashboard and WIF

1. Enable the Chrome Web Store API for the service account's project.
2. Open the [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole/). Select the intended publisher. In **Account → Service account**, link the exact service-account email. Follow Google's [service-account setup guide](https://developer.chrome.com/docs/webstore/service-accounts); cloud IAM permissions alone do not grant access to the publisher.
3. Create the initial extension item in the dashboard and complete its Store listing, Privacy, distribution and any account verification requirements. The API only uploads to an **existing item**. Where the dashboard requires initial manual publication or a visibility change, complete that there; do not invent an item ID or treat an uploaded draft as published.
4. Copy the publisher ID from **Publisher → Settings** and the extension's 32-character item ID into the environment variables above. Leave these variables unset until the real listing exists. A publication run with missing IDs fails explicitly **before Google authentication**.
5. Allow the GitHub identity to impersonate only the intended service account (`roles/iam.workloadIdentityUser`). Restrict the WIF provider to the repository's numeric repository/owner IDs, `ref == 'refs/heads/main'`, `event_name == 'workflow_dispatch'`, the subject `repo:OWNER/REPOSITORY:environment:chrome-release`, and the exact `workflow_ref == 'OWNER/REPOSITORY/.github/workflows/publish-chrome.yml@refs/heads/main'`. Keep that workflow filename stable or deliberately update the provider condition before renaming it.

The `auth@v3` publisher metadata specifies Node 24, supported by the repository's `ubuntu-latest` GitHub-hosted runner. Its `workload_identity_provider`, `service_account`, `token_format`, `access_token_scopes`, `access_token_lifetime`, `create_credentials_file`, and `export_environment_variables` inputs are used directly. No third-party store-publisher action or additional Python package is installed.

## Release requirements

Store verification requires exactly these uploaded GitHub Release assets:

- `tab-triage-dashboard-firefox.zip`
- `tab-triage-dashboard-chrome.zip`
- `provenance.json`

The existing release scripts attach all three. The release must be published, non-draft and non-prerelease. Select a stable `[v]MAJOR.MINOR.PATCH` **annotated tag** pointing directly to a commit on freshly fetched `main`. Package and both manifest versions must equal the tag's version, and the Firefox GUID must match the existing listing.

The trusted workflow commit is checked out with persisted Git credentials disabled. The verifier reads historical files as Git blobs, never checks out or executes tag scripts, and treats both ZIPs as passive data. It compares every distribution file's bytes and the complete archive inventory against the tagged Git source. Same-version substituted code, extra files, symlinks, duplicate/escaping paths, oversized archives, wrong manifests, missing inputs, and provenance mismatches fail before store authentication.

`provenance.json` binds the literal tag, annotated tag object ID, peeled commit ID, version, and both archive SHA-256 hashes. ZIP metadata/timestamps need not be reproducible: **content parity**, not rebuilding an identical compressed byte stream, is checked. The verifier then rechecks live tag/release identity, repeats the entire verification in the publication job, compares its pre-auth receipt at the credential boundary, and fences every store mutation against live tag/asset replacement. This checks source provenance, not cryptographic tag signatures. A final remote race cannot be made atomic across GitHub and either store; retain protected immutable release/tag policy.

Older releases without the receipt fail closed. To prepare an authorized retry, inspect a build-only export and use the trusted release publisher to attach the source-matched ZIPs and provenance together. Replacing assets on an already published release does not emit another `release.published` event; dispatch the store workflows manually afterward. Do not regenerate or replace artifacts merely to hide a store mismatch.

## Run and inspect

After merging the workflows into `main`, set `TAG` to the desired existing release tag:

```sh
# Default operation is publish; each workflow uses its own store environment.
gh workflow run publish-firefox.yml --ref main -f release-tag="$TAG"
gh workflow run publish-chrome.yml --ref main -f release-tag="$TAG"

# Verify artifacts/source only: no store environment job, secrets, or Google auth.
gh workflow run publish-chrome.yml --ref main \
  -f release-tag="$TAG" -f operation=verify-release-only
```

`verify-release-only` also works for Firefox. It does **not** validate credentials, dashboard linking, listing completeness, or store acceptance.

The credentialless `publish-stores.yml` coordinator listens only to `release.published` and dispatches the two workflows with `ref: main` and `operation: publish`. Its sole write permission is job-scoped `actions: write`; it has no checkout, store environment, secrets, or OIDC. Releases created using a workflow's `GITHUB_TOKEN` may not trigger a downstream release event; in that case dispatch from `main` explicitly. A coordinator success means dispatch succeeded, not that either store accepted the package. Inspect both workflow runs and their job summaries.

Both credential jobs and their verification jobs require `workflow_dispatch`, branch ref `refs/heads/main`, and ref type `branch`. The Python entrypoint independently enforces the exact workflow identity. PR, PR-target, topic-branch, and tag runs cannot reach credentials. Only the Chrome publication job has `id-token: write`. Store credentials are passed only to the upload/readback step (the preceding Chrome auth step mints its token); they are never passed to builds, selected-tag code, or tests.

## Results and retries

Each provider polls at most 30 times per validation/readback phase, with 10-second intervals and 60-second HTTP deadlines. Publication jobs have a 20-minute overall deadline. Polling stops once the exact version's accepted state is read back; it does not wait indefinitely for human review.

- **Firefox:** An existing exact version is never uploaded again. Its enabled listed channel and file identity must match the selected source: either its API SHA-256 equals the verified release archive exactly, or the downloaded signed archive passes checksum and content-parity verification. Pending unsigned files need not be publicly downloadable yet. Only known Mozilla signature files may differ from the unsigned package. New uploads must pass AMO validation before version creation; the exact version is then fetched again and its content checked. `unreviewed` is reported as **submitted-for-review**, not public; `public` is reported only for an approved file. Rejected/disabled versions fail. Downloads have no authorization header and only bounded HTTPS redirects to Mozilla download/CDN paths are permitted.
- **Chrome:** The official v2 API returns upload version/state and exact-version publication status but **does not expose a package digest or draft download**. A new upload sends the verified release bytes, waits for upload completion, submits for automatic publication after review (`DEFAULT_PUBLISH`, review enabled, warnings blocking, 100% rollout), then reads back the exact item and version. `PENDING_REVIEW`, `STAGED` and `PUBLISHED` remain distinct. Published visibility remains whatever the dashboard configured.
- **Conservative Chrome retry:** An already submitted/published equal version is not proof of package identity. The workflow fails without reuploading or claiming success. Another active submission, an in-progress upload, or a policy warning/takedown also stops publication. After an interrupted upload, the API can reject a repeated draft version; the workflow never cancels or replaces that draft to get around the conflict. Inspect/reconcile the exact package in the dashboard rather than blindly retrying or bumping the version to evade the check. This deliberate failure avoids unverifiable idempotency claims.

HTTP/GitHub failures, validation failures, unexpected states and timeouts are fatal. Responses and raw exception text are suppressed because they can contain credentials. An interrupted or timed-out POST may have succeeded remotely: inspect the dashboard before retrying. Never infer public availability from a successful upload, dispatch, or submission response.

## Offline verification

Run `npm test` for the whole suite, or `npm run test:stores` for publication checks. Tests require Python 3.10+, Git and the existing packaging test tools. They use synthetic credentials, real disposable Git histories and ZIPs, a fake `gh` executable, blocked sockets, and mocked official HTTP boundaries. No store credentials are needed in CI. These tests do not establish live API authorization, WIF admission, listing readiness, or actual store publication.

## API references

- [AMO authentication](https://mozilla.github.io/addons-server/topics/api/auth.html)
- [AMO upload, version creation and version/file states](https://mozilla.github.io/addons-server/topics/api/addons.html)
- [Chrome Web Store v2 API](https://developer.chrome.com/docs/webstore/api/reference/rest)
- [Chrome API discovery schema](https://chromewebstore.googleapis.com/$discovery/rest?version=v2)
- [Chrome service accounts](https://developer.chrome.com/docs/webstore/service-accounts)
- [Google auth action inputs](https://github.com/google-github-actions/auth/blob/v3/action.yml)
