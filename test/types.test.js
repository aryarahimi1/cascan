/**
 * Declaration drift guard: every runtime export has a TypeScript
 * declaration and every declared value exists at runtime. The compile-time
 * consumer fixtures run separately through `npm run test:types`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

function declaredValues(dts) {
  return [...dts.matchAll(/^export declare (?:class|function|const) ([A-Za-z_$][\w$]*)/gm)]
    .map(match => match[1]);
}

const unique = (names) => [...new Set(names)].sort();

for (const [entry, runtimePath, typesPath] of [
  ['@aryarh/cascan', '../src/index.js', '../types/index.d.ts'],
  ['@aryarh/cascan/browser', '../src/browser/index.js', '../types/browser.d.ts'],
]) {
  test(`${entry}: runtime exports and declarations match exactly`, async () => {
    const runtime = Object.keys(await import(runtimePath)).sort();
    assert.deepEqual(unique(declaredValues(read(typesPath))), runtime);
  });
}

test('package metadata points every entry point at shipped declarations', () => {
  const packageJson = JSON.parse(read('../package.json'));
  assert.ok(packageJson.files.includes('types'));
  assert.equal(packageJson.types, 'types/index.d.ts');

  const root = packageJson.exports['.'];
  assert.deepEqual(Object.keys(root), ['browser', 'node', 'types', 'default']);
  assert.equal(root.browser.types, './types/browser.d.ts');
  assert.equal(root.node.types, './types/index.d.ts');
  assert.equal(root.types, './types/index.d.ts');
  assert.equal(packageJson.exports['./browser'].types, './types/browser.d.ts');

  for (const path of [
    root.browser.types, root.browser.default,
    root.node.types, root.node.default,
    root.types, root.default,
    packageJson.exports['./browser'].types, packageJson.exports['./browser'].default,
  ]) {
    assert.ok(existsSync(new URL(`.${path}`, import.meta.url)), `${path} must exist`);
  }
});

test('declarations stay free of @types/node and DOM lib dependencies', () => {
  for (const path of ['../types/common.d.ts', '../types/index.d.ts', '../types/browser.d.ts']) {
    const dts = read(path);
    assert.doesNotMatch(dts, /from ['"]node:/, `${path} must not import Node built-ins`);
    assert.doesNotMatch(dts, /reference (types|lib)=/, `${path} must not pull in ambient libs`);
  }
});
