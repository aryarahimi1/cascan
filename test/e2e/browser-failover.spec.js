import { test, expect } from '@playwright/test';

const checkpointHeaders = new Map([
  [478559, '00000020432d350741fbf28f2e1486eabe2c4e143bfe2241af6518010000000000000000abaa4bd8a48c1c6bc08ee39b66065e5e9484304cab8b56d5eed3e40b1ac996c899c480593547011822ca4ae8'],
  [556767, '0000002022938d4ece739b34d65de82f58c72c7a80d09bde4fd9020100000000000000004419fd3ebb093486e3a662ec67455bf1ff06ec9052e59aba4d1b6bbd0511f31ca8b4ed5bdb1f021881f61ee9'],
]);

async function installFulcrumMocks(page) {
  await page.routeWebSocket(/wss:\/\/(?:alpha|beta)\.test\//, socket => {
    socket.onMessage(rawMessage => {
      let request;
      try {
        request = JSON.parse(String(rawMessage).trim());
      } catch {
        return;
      }

      let result;
      switch (request.method) {
        case 'server.version':
          result = ['cascan-e2e-fulcrum', '1.6'];
          break;
        case 'blockchain.block.header':
          result = checkpointHeaders.get(request.params?.[0]);
          break;
        case 'blockchain.headers.subscribe':
          result = { height: 900_000 };
          break;
        case 'blockchain.address.subscribe':
          result = null;
          break;
        case 'blockchain.address.unsubscribe':
          result = true;
          break;
        case 'server.ping':
          result = null;
          break;
        default:
          socket.send(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32601, message: 'method not found in e2e fixture' },
          }));
          return;
      }

      socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    });
  });
}

test('demo server exposes only browser assets and library source', async ({ request }) => {
  await expect((await request.get('/examples/browser/')).status()).toBe(200);
  await expect((await request.get('/src/browser/index.js')).status()).toBe(200);
  await expect((await request.get('/package.json')).status()).toBe(404);
  await expect((await request.get('/.git/config')).status()).toBe(404);
});

test('real browser verifies checkpoints, fails over, and restores a subscription', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await installFulcrumMocks(page);
  await page.goto('/examples/browser/');

  await expect(page.locator('.notice')).toContainText('not that one server');
  await page.locator('#servers').fill('wss://alpha.test/\nwss://beta.test/');
  await page.locator('#connect').click();

  await expect(page.locator('#status')).toHaveText('Connected');
  await expect(page.locator('#current')).toContainText('alpha.test');
  await expect(page.locator('#height')).toHaveText('900000');

  await page.locator('#watch').click();
  await expect(page.locator('#watch-status')).toContainText('Subscription active');

  await page.locator('#failover').click();
  await expect(page.locator('#status')).toHaveText('Connected');
  await expect(page.locator('#current')).toContainText('beta.test');
  await expect(page.locator('#watch-status')).toContainText('Subscription active');
  await expect(page.locator('#events')).toContainText('Failed over to wss://beta.test/');
  expect(pageErrors).toEqual([]);
  await page.locator('#disconnect').click();
  await expect(page.locator('#status')).toHaveText('Disconnected');
});

test.describe('live BCH WSS endpoints', () => {
  const liveRequested = Boolean(process.env.CASCAN_LIVE_BROWSER)
    || process.env.npm_lifecycle_event === 'test:browser:live';
  test.skip(!liveRequested, 'run npm run test:browser:live to probe public WSS endpoints');

  test('connects and fails over @live', async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto('/examples/browser/');
    await page.locator('#connect').click();
    await expect(page.locator('#status')).toHaveText('Connected', { timeout: 30_000 });
    await expect.poll(async () => Number(await page.locator('#height').textContent()))
      .toBeGreaterThan(556767);

    await page.locator('#watch').click();
    await expect(page.locator('#watch-status')).toContainText('Subscription active');
    await page.locator('#failover').click();
    await expect(page.locator('#status')).toHaveText('Connected', { timeout: 30_000 });
    await expect(page.locator('#events')).toContainText('Failed over to');
    await page.locator('#disconnect').click();
    await expect(page.locator('#status')).toHaveText('Disconnected');
  });
});
