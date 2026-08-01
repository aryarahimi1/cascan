#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const expectedRepository = 'git+https://github.com/aryarahimi1/cascan.git';
const expectedRegistry = 'https://registry.npmjs.org/';
const expectedName = '@aryarh/cascan';
const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
const errors = [];

if (packageJson.name !== expectedName) {
  errors.push(`package name must be exactly ${expectedName}`);
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version)) {
  errors.push(`package version is not valid release semver: ${packageJson.version}`);
}

if (!tag) {
  errors.push('release tag is required as argv[2] or GITHUB_REF_NAME');
} else if (tag !== `v${packageJson.version}`) {
  errors.push(`tag ${tag} does not match package version v${packageJson.version}`);
}

if (packageJson.repository?.url !== expectedRepository) {
  errors.push(`repository.url must be exactly ${expectedRepository}`);
}

if (packageJson.publishConfig?.registry !== expectedRegistry) {
  errors.push(`publishConfig.registry must be exactly ${expectedRegistry}`);
}

if (packageJson.publishConfig?.access !== 'public') {
  errors.push('publishConfig.access must be public');
}

if (packageJson.bin?.cascan !== 'bin/cascan.js') {
  errors.push('bin.cascan must be the npm-normalized path bin/cascan.js');
}

for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare']) {
  if (packageJson.scripts?.[lifecycle]) {
    errors.push(`consumer-executed lifecycle script is forbidden: ${lifecycle}`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`release check: ${error}`);
  process.exitCode = 1;
} else {
  console.log(`release check passed for ${packageJson.name}@${packageJson.version} (${tag})`);
}
