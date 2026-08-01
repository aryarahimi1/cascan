import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('browser demo: has a restrictive CSP and no unsafe HTML sinks', async () => {
  const html = await readFile(new URL('../examples/browser/index.html', import.meta.url), 'utf8');
  const script = await readFile(new URL('../examples/browser/app.js', import.meta.url), 'utf8');

  assert.match(html, /default-src 'none'/);
  assert.match(html, /connect-src wss:/);
  assert.doesNotMatch(script, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  assert.match(script, /\.textContent/);
});

test('fundme pilot: is display-only, chipnet-fixed, and uses safe DOM sinks', async () => {
  const html = await readFile(
    new URL('../examples/fundme-pilot/index.html', import.meta.url),
    'utf8',
  );
  const script = await readFile(
    new URL('../examples/fundme-pilot/app.js', import.meta.url),
    'utf8',
  );

  assert.match(html, /default-src 'none'/);
  assert.match(html, /Display only/i);
  assert.match(html, /must never release, claim, refund, sign, or credit money/i);
  assert.doesNotMatch(html, /<button[^>]*>\s*(?:pledge|claim|refund|pay)/i);
  assert.match(script, /network: 'chipnet'/);
  assert.match(script, /\.textContent/);
  assert.doesNotMatch(script, /\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  assert.doesNotMatch(script, /fetch\(|XMLHttpRequest|localStorage|sessionStorage/);
});
