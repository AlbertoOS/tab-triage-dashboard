# Releases

Merged changes on `main` produce semantically versioned GitHub Releases. Prepare version metadata in the original pull request; no additional release PR or direct version-bump push to `main` is needed.

## Prepare a pull request

Use Python 3.10+, Git, and the project's Node.js toolchain. Commit the implementation on a topic branch and refresh `origin/main`. If it has advanced, merge it into your branch before preparing the version:

```sh
git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main
npm run release:prepare -- --base origin/main
npm run release:prepare -- --base origin/main --write
```

The command without `--write` previews the plan. `--write` updates only version metadata in `package.json`, `package-lock.json`, `manifest.firefox.json`, and `manifest.chrome.json`. It does not stage, commit, tag, push, create a release, or contact a store. Review and commit those changes on the same topic branch using the usual signed-commit workflow.

The analyzer reads full commit messages across the unreleased range. Breaking headers (`type!:`) and breaking-change footers select major; otherwise `feat` selects minor and `fix` selects patch. Other types alone do not release. A documentation-only HEAD can still release earlier unreleased fixes. Commit version metadata with a non-releasing type, such as `chore(release)`.

Use a Conventional Commit PR title that preserves the highest classification of the PR's changes, including `!` for breaking changes. This retains the release meaning when squash merging. With merge commits, the individual commit messages remain in history. Rerun preparation when the target branch or the PR changes; CI rejects stale or inconsistent metadata instead of guessing.

This release path supports **merge and squash only**, as enforced by the existing active `main` ruleset. Rebase merging is unsupported: it can turn intermediate PR version commits into main release boundaries and leave a later fix unprepared, even when the PR's final version is correct. Do not bypass that rule or enable rebase merging for `main` without changing and testing the planner's history contract.

The **Release plan** check validates the candidate without publication credentials. Making it a required, up-to-date check is a repository-rules decision; adding a workflow alone does not enforce that rule. A post-merge mismatch stops release publication rather than bypassing protection or rewriting `main`.

## Automatic publication

After validation on `main`, the release workflow:

1. Reconciles planned releases in first-parent order from Git history, including work missed when a pending workflow run was replaced.
2. Creates an annotated `vMAJOR.MINOR.PATCH` tag at the exact reviewed main commit. The tag object has deterministic metadata so replacement objects, even at the same commit, are conflicts.
3. Builds the Firefox and Chrome ZIPs from that tag using the maintained build-only packager. Historical tag scripts are never executed.
4. Creates a draft GitHub Release, uploads both ZIPs and `provenance.json`, then reads back and verifies every asset against the tag and source blobs.
5. Publishes the verified draft and explicitly dispatches the main-only **Store publication** coordinator (`publish-stores.yml`) with `GITHUB_TOKEN`.

The publication job has repository-content write permission, but no store environment, store credentials, or OIDC. Store dispatch runs separately with Actions write permission. Store credentials remain in the existing browser-specific environments.

`GITHUB_TOKEN` does not trigger an ordinary downstream `release.published` workflow. Automatic publication therefore uses explicit dispatch; the release-event listener remains for releases published outside this automation. Do not change the automatic publisher's token type without reviewing this duplicate-trigger boundary.

`main` is not modified after merge. Version transitions record release intent before publication, so later PRs can reserve the next version while an earlier publication needs recovery. A published release is verified but not rebuilt, overwritten, or automatically redispatched.

The migration baseline is pinned in `scripts/release-config.json`. The existing v1.4.0 tag, assets and submitted store packages are outside the automatic backlog and remain unchanged.

## Recovery

Inspect the failed run, remote tag, draft/release assets and store workflow runs before retrying. Never move a tag, use asset clobbering, or delete an earlier release to make a retry pass.

| State | Recovery |
| --- | --- |
| Tag absent | The reconciler validates source identity and creates the planned tag. |
| Correct tag, no release | Resume building and draft creation. |
| Draft with some ZIPs | Verify and retain uploaded bytes; upload only missing assets and provenance. |
| Provenance exists but an archive is missing | Rebuilt bytes must match its recorded hash. Otherwise preserve the conflict for manual recovery. |
| Complete draft | Read back all assets, verify, then publish. |
| Published release | Verify identity and assets without uploading or replacing anything. |
| Conflicting tag or asset | Stop. Inspect and choose a new reviewed release or another explicitly authorized recovery. |

To reconcile GitHub publication again, dispatch the release workflow from `main`:

```sh
gh workflow run release.yml --ref main
```

Cancellation or a failure between publication and handoff can leave a valid GitHub Release without a confirmed store dispatch. The reconciler deliberately does not redispatch an already published release: a timeout can mean the first request succeeded. Inspect **Store publication** and both provider workflows first. Only after ruling out an existing/active attempt, dispatch the coordinator with the desired published tag:

```sh
gh workflow run publish-stores.yml --ref main -f release-tag="$TAG"
```

Each provider has separate queues for publication and verification-only runs, so verification cannot displace pending publication. Their `queue: max` capacity is bounded at 100 pending runs; overflow and failed/cancelled runs still require inspection. Queue entry order is not release order. Store verification rejects active, conflicting or unknown provider state rather than cancelling an existing submission or downgrading a package. Older workflow linters, including actionlint 1.7.12, do not recognize this GitHub-documented queue field; `npm run lint` validates the extension, not workflow YAML.

A successful dispatch is not successful upload, submission or public availability. In particular, do not resubmit v1.4.0 while its Chrome review is pending. See [Browser store publication](STORE_PUBLISHING.md) for provider-specific verification and recovery.

## Local verification and legacy commands

Run `npm test` and `npm run lint`. The release tests use disposable Git repositories and synthetic API responses, not live publishing credentials. They exercise the real archive builder and partial-upload recovery; hosted write permissions, GitHub's tag serialization and store acceptance still require live activation evidence.

The older `release.sh` and `npm run release:publish` commands remain available for explicit legacy recovery. They can commit/push/tag or replace existing release assets and are **not** the merge-driven path described here. Do not use them to retry an automatic release. For read-only inspection of an existing local tag, use the build-only command documented in the README. In recovery commands, set `$TAG` to the intended published tag before running them.
