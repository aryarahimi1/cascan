/**
 * Regression tests for fail-closed package distribution.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('public tree excludes disabled installers and internal working material', () => {
  for (const path of [
    '../install.sh',
    '../Formula/cascan.rb',
    '../CLAUDE.md',
    '../VISION.md',
    '../docs/browser-security-review.md',
    '../docs/research',
  ]) {
    assert.equal(existsSync(new URL(path, import.meta.url)), false, `${path} must not ship`);
  }
});

test('README advertises only the exact verified scoped beta install path', () => {
  const readme = read('../README.md');
  assert.doesNotMatch(readme, /npm install -g cascan/);
  assert.match(readme, /npm install @aryarh\/cascan@0\.4\.0-beta\.2/);
  assert.match(readme, /npx --package=@aryarh\/cascan@0\.4\.0-beta\.2 cascan --help/);
  assert.doesNotMatch(readme, /npm install @aryarh\/cascan(?:\s|`|$)/m);
  assert.match(readme, /unscoped `cascan` package is \*\*not\*\* this project/i);
  assert.doesNotMatch(readme, /raw\.githubusercontent\.com.*install\.sh/);
  assert.doesNotMatch(readme, /brew install.*cascan\.rb/);
  assert.doesNotMatch(readme, /Never trust one server again/);
  assert.match(readme, /Never depend on one Fulcrum server again/);
  assert.match(readme, /not a standalone payment oracle/);
});

test('release workflow uses pinned actions, OIDC, staging, and no npm token', () => {
  const workflow = read('../.github/workflows/stage-npm-release.yml');
  assert.match(workflow, /tags:\s*\n\s*- 'v\*'/);
  assert.match(workflow, /- '!v0\.4\.0-beta\.0'/);
  assert.match(workflow, /- '!v0\.4\.0-beta\.1'/);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /npm stage publish \. --access public --tag "\$DIST_TAG"/);
  assert.match(workflow, /DIST_TAG=next/);
  assert.match(workflow, /DIST_TAG=latest/);
  assert.doesNotMatch(workflow, /^\s*run:\s*npm publish\b/m);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN\s*:/);
  assert.doesNotMatch(workflow, /registry-url:/);
  assert.match(workflow, /git cat-file -t/);
  assert.match(workflow, /verify-release\.mjs/);
});

test('release metadata is pinned to the official public npm registry', () => {
  const packageJson = JSON.parse(read('../package.json'));
  assert.equal(packageJson.name, '@aryarh/cascan');
  assert.deepEqual(packageJson.publishConfig, {
    access: 'public',
    registry: 'https://registry.npmjs.org/',
  });
  assert.equal(packageJson.bin.cascan, 'bin/cascan.js');
  assert.deepEqual(packageJson.dependencies, undefined);
  assert.equal(packageJson.devDependencies['@playwright/test'], '1.62.1');
  for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(packageJson.scripts[lifecycle], undefined);
  }
});

test('CLI and browser protocol identities match the package prerelease version', () => {
  const packageJson = JSON.parse(read('../package.json'));
  assert.match(packageJson.version, /-beta\.\d+$/);
  assert.match(read('../bin/cascan.js'), new RegExp(`const VERSION = '${packageJson.version}'`));
  assert.match(
    read('../src/browser/client.js'),
    new RegExp(`cascan-browser/${packageJson.version.replaceAll('.', '\\.').replaceAll('-', '\\-')}`),
  );
});

test('public readiness controls cover CI, browser engines, and private reporting', () => {
  const ci = read('../.github/workflows/ci.yml');
  for (const version of ['20.10.0', '22', '24']) assert.match(ci, new RegExp(`'${version}'`));
  for (const browser of ['chromium', 'firefox', 'webkit']) assert.match(ci, new RegExp(`- ${browser}`));
  assert.match(ci, /npm ci --ignore-scripts/);
  assert.match(ci, /npm audit --omit=dev/);
  assert.match(ci, /test:browser:live/);

  const policy = read('../SECURITY.md');
  assert.match(policy, /security\/advisories\/new/);
  assert.match(policy, /Do not open a public issue/);
  assert.match(policy, /does not.*browser quorum or SPV/is);
});

test('release check requires the tag to exactly match package version', () => {
  const packageJson = JSON.parse(read('../package.json'));
  const good = spawnSync(
    process.execPath,
    ['scripts/verify-release.mjs', `v${packageJson.version}`],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(good.status, 0, good.stderr);

  const bad = spawnSync(
    process.execPath,
    ['scripts/verify-release.mjs', 'v999.0.0'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /does not match package version/);
});
