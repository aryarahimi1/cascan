import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CACHE_VERSION, loadServerCache, saveServerCache } from '../src/pool/cache.js';

const record = {
  host: 'fulcrum.example',
  ports: { ssl: 50002 },
  transport: 'ssl',
  port: 50002,
  tlsStrict: true,
  verified: true,
};

test('server cache: private atomic persistence and future timestamps fail closed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cascan-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'state', 'servers.json');

  await saveServerCache([record], { path });
  assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual((await loadServerCache({ path })).servers, [record]);

  const raw = JSON.parse(await readFile(path, 'utf8'));
  raw.version = CACHE_VERSION;
  raw.updatedAt = Date.now() + 60_000;
  await writeFile(path, JSON.stringify(raw), { mode: 0o600 });
  assert.equal(await loadServerCache({ path }), null, 'future timestamps cannot pin a cache fresh forever');
});
