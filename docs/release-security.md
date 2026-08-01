# Release-security checklist

Public installation remains disabled until every item in this checklist is
complete. Preparing the workflow does not claim the npm name and does not make
the library production-ready by itself.

## One-time owner setup

1. Create or recover the maintainer's npm account and enable account-level 2FA.
   Store recovery codes offline.
2. Use only the maintainer-controlled npm package `@aryarh/cascan`. npm rejected
   the unscoped `cascan` name as too similar to an existing package; never work
   around that protection or publish under an unrelated account.
3. Make the GitHub repository public before relying on npm provenance. The
   package metadata already points to `aryarahimi1/cascan`, and that URL must
   continue to match exactly.
4. Staged publishing cannot create a brand-new npm package. Perform the
   one-time namespace bootstrap from a reviewed, clean, annotated prerelease
   tag using `npm publish --access public --tag next`. This direct publish is an
   operator action requiring npm authentication and 2FA; it is intentionally
   not automated by this repository. The tag workflow explicitly excludes only
   `v0.4.0-beta.0` and `v0.4.0-beta.1` so neither the rejected unscoped attempt
   nor the reviewed scoped bootstrap can create a doomed or duplicate staged-
   publish run. Never bootstrap a stable `latest` release.
5. In npm package settings for `@aryarh/cascan`, configure the GitHub Actions
   trusted publisher for repository `aryarahimi1/cascan` and workflow
   `.github/workflows/stage-npm-release.yml`. Permit staged publishing, not
   direct publishing.
6. Require 2FA for package settings and publishing and disallow reusable write
   tokens. Do not add an npm automation token or `NODE_AUTH_TOKEN` secret to
   GitHub.
7. In GitHub, protect `v*` tags from deletion or rewriting. Configure the
   `npm-production` environment with only the required maintainers and an
   approval rule.

## Every release

1. Review all changes since the previous tag and confirm CI is green.
2. Update `package.json` with the intended semantic version.
3. Run `npm test`, `node scripts/verify-release.mjs vX.Y.Z`, and
   `npm pack --dry-run`. Inspect the complete file list for secrets, test data,
   unexpected executables, and generated artifacts.
4. Create an annotated `vX.Y.Z` tag on the reviewed commit. The workflow rejects
   lightweight tags and version mismatches.
5. Let the tag workflow test and stage the package using GitHub OIDC. Versions
   containing a prerelease suffix use the `next` distribution tag; stable
   versions use `latest`. Inspect
   the staged package on npm, then approve it there with 2FA. If anything is
   unexpected, reject it; do not approve and attempt to repair afterward.
6. Verify the public npm page shows the exact version, repository, provenance,
   and expected files. Install into a disposable directory using the exact
   version and run a smoke test.
7. Only after that verification, create the matching GitHub release and update
   public install documentation. Never instruct users to install from `main`.
