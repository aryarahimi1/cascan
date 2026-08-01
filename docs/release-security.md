# Release-security checklist

This checklist records the controls required for every public package release.
Publishing a package does not make the library production-ready by itself.

## Bootstrap record

`@aryarh/cascan@0.4.0-beta.1` was published from annotated tag
`v0.4.0-beta.1` at commit `07a653cd45eae24a4fe4e9cb7fda96bf182dcebd`.
Its registry SHA-1 is `799b125e9d9b8fa75051ee6d05d8b65f9f9a6a3d`; the
SHA-512 integrity is
`sha512-4wLILc0BBwtqQ8CLlbZ2rnNZ8G3Z69zw9NA1V6uI2VEd0luP5sL0lTyyzAAqofGfE3+ej6HwpRBa2IsoM9BkgA==`.
The scoped package is public, package publishing requires 2FA and disallows
reusable tokens, and its trusted GitHub publisher can only create a staged
package through the protected `npm-production` environment.

npm assigned `latest` to the only published version and rejects removing that
required tag. Public beta instructions therefore pin the exact prerelease;
`latest` is not a claim of production stability.

## Promoted beta record

`@aryarh/cascan@0.4.0-beta.2` was staged by the trusted GitHub publisher from
annotated tag `v0.4.0-beta.2` at commit
`194efe12cb0437c40317b19a97a2cffc67e0662c`, inspected from npm's staging
queue, and approved with maintainer 2FA. Its registry SHA-1 is
`7ad7965bb108eb61c367e990cc3216de9b180f68`; its SHA-512 integrity is
`sha512-gatkGp/4fF5wr2uk7D3tm9km16WayoCGmi5mqW9w4DVeAIJ1WZnFoDBKz3347jL7btYXKpuh/64Ke/gMq72bqQ==`.
npm records SLSA provenance for the GitHub Actions build, and a clean `@next`
install verified the Node export, browser export, CLI version, and zero known
production dependency vulnerabilities.

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
