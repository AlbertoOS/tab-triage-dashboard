# One-time Firefox publication bootstrap

**Merge [PR #13](https://github.com/AlbertoOS/tab-triage-dashboard/pull/13) (the Firefox publishing automation) before this follow-up.**
The current checkout must already contain `.github/workflows/publish-firefox.yml`.
The bootstrap does not execute that file locally or replace its verification gates.

A trusted push to `main` that introduces `bootstrap-firefox.yml` makes **one
automatic dispatch attempt** for the latest published stable GitHub Release.
The dispatch targets `publish-firefox.yml` at `main`, with `operation: publish`
and the validated `vMAJOR.MINOR.PATCH` release tag. The existing publisher
independently verifies the exact release, tag, source and assets before using
store credentials.

The bootstrap requires a nonzero, available before-commit, exact before/after
commit identifiers and matching checkout HEAD. The bootstrap workflow must be
absent before the push and a regular tracked file afterward. Missing history
(including an initial all-zero before SHA) fails closed. Later workflow edits
skip without querying GitHub; ordinary pushes are excluded by the path filter.
Rerun attempts greater than one skip: use the manual Firefox publisher instead.
Deliberate deletion followed by reintroduction can rearm the bootstrap; this is
an introduction gate, not a permanent repository-wide delivery ledger.

There is no release creation, rebuild, retag, Chrome dispatch, store secret,
OIDC identity or deployment environment in this bootstrap. Its opaque runner
token stays in the environment, with only `contents: read` and `actions: write`.
Git checkout does not persist credentials. Provider output and rejected inputs
are not printed; subprocesses have a 30-second timeout and no automatic retry.

## Recovery and acceptance

A successful dispatch is not proof of upload, submission or public availability,
nor an exactly-once store-delivery guarantee. If dispatch fails or times out,
the outcome is uncertain: inspect existing Firefox workflow runs **before** a
manual retry. Select `publish` to retry publication, or `verify-release-only`
to check the release without store authentication. Those options and future
release-event coordination remain owned by PR #13, unchanged by this follow-up.

Local tests use disposable Git histories and fake GitHub CLI I/O, without store
access. Run `node --test test/firefox-bootstrap.test.js`, `npm test`,
`npm run lint`, and `actionlint .github/workflows/bootstrap-firefox.yml`.
Hosted workflow execution, release verification and eventual store delivery
remain separate acceptance checks after the prerequisite and follow-up merge.
