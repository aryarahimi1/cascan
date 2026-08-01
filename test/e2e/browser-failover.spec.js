import { test, expect } from '@playwright/test';

const checkpointHeaders = new Map([
  [478559, '00000020432d350741fbf28f2e1486eabe2c4e143bfe2241af6518010000000000000000abaa4bd8a48c1c6bc08ee39b66065e5e9484304cab8b56d5eed3e40b1ac996c899c480593547011822ca4ae8'],
  [556767, '0000002022938d4ece739b34d65de82f58c72c7a80d09bde4fd9020100000000000000004419fd3ebb093486e3a662ec67455bf1ff06ec9052e59aba4d1b6bbd0511f31ca8b4ed5bdb1f021881f61ee9'],
]);

const chipnetCheckpointHeaders = new Map([
  [120000, '000000205350d88f132343942b494ffa11efd996d4a05e6f8102b33517b3ad4d0000000042aed6021e11f87f1cd02908a1104fdd921de36ad6c9c3b352f02551ba61cdaa60a061638487001d03aca3c1'],
  [300000, '000000202cbcbd2e79a725ad3656f0598c6b3e77ad265ea215baf3bee8f1200200000000f4ce8156329d29f7bd3f2dddd3158408db01da18a84aa30ddf7df79367cfe5a93a7dd169941b2b1c02d0b3f6'],
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
          result = { height: 900_000, hex: '00'.repeat(80) };
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

async function installChipnetCampaignMocks(page) {
  await page.routeWebSocket(/wss:\/\/(?:alpha|beta)\.test\//, socket => {
    const host = new URL(socket.url()).hostname;
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
          result = ['cascan-chipnet-pilot', '1.6'];
          break;
        case 'blockchain.block.header':
          result = chipnetCheckpointHeaders.get(request.params?.[0]);
          break;
        case 'blockchain.headers.subscribe':
          result = { height: 317_111, hex: '00'.repeat(80) };
          break;
        case 'blockchain.address.get_balance':
          result = host === 'alpha.test'
            ? { confirmed: 25_000_000, unconfirmed: 0 }
            : { confirmed: 50_000_000, unconfirmed: 0 };
          break;
        case 'blockchain.address.subscribe':
          result = host === 'alpha.test' ? null : 'b'.repeat(64);
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
            error: { code: -32601, message: 'method not found in chipnet fixture' },
          }));
          return;
      }

      socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    });
  });
}

test('demo server exposes only browser assets and library source', async ({ request }) => {
  const demo = await request.get('/examples/browser/');
  const pilot = await request.get('/examples/fundme-pilot/');
  await expect(demo.status()).toBe(200);
  await expect(pilot.status()).toBe(200);
  await expect(pilot.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  await expect(pilot.headers()['x-frame-options']).toBe('DENY');
  await expect(pilot.headers()['referrer-policy']).toBe('no-referrer');
  await expect(pilot.headers()['cross-origin-resource-policy']).toBe('same-origin');
  await expect((await request.get('/src/browser/index.js')).status()).toBe(200);
  await expect((await request.get('/package.json')).status()).toBe(404);
  await expect((await request.get('/.git/config')).status()).toBe(404);
});

test('FundMe-style chipnet pilot displays progress and refreshes after failover', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await installChipnetCampaignMocks(page);
  await page.goto('/examples/fundme-pilot/');

  await expect(page.locator('#decision-boundary')).toContainText('Display only');
  await expect(page.getByRole('button', { name: /pledge|claim|refund|pay/i })).toHaveCount(0);
  await page.locator('#servers').fill('wss://alpha.test/\nwss://beta.test/');
  await page.locator('#connect').click();

  await expect(page.locator('#status')).toHaveText('Connected');
  await expect(page.locator('#current')).toContainText('alpha.test');
  await expect(page.locator('#height')).toHaveText('317111');
  await expect(page.locator('#raised')).toHaveText('0.25 BCH');
  await expect(page.locator('#goal-output')).toHaveText('1 BCH');
  await expect(page.locator('#percent')).toHaveText('25%');
  await expect(page.locator('#watch-status')).toContainText('Subscription active');

  await page.locator('#failover').click();
  await expect(page.locator('#current')).toContainText('beta.test');
  await expect(page.locator('#raised')).toHaveText('0.5 BCH');
  await expect(page.locator('#percent')).toHaveText('50%');
  await expect(page.locator('#events')).toContainText('Failed over to wss://beta.test/');

  await page.locator('#address').fill(
    'bitcoincash:qr7fzmep8g7h7ymfxy74lgc0v950j3r2959lhtxxsl',
  );
  await page.locator('#connect').click();
  await expect(page.locator('#status')).toHaveText('Connection failed');
  await expect(page.locator('#raised')).toHaveText('—');
  await expect(page.locator('#percent')).toHaveText('—');
  await expect(page.locator('#trust-label')).toContainText('no current snapshot');
  expect(pageErrors).toEqual([]);
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

  test('FundMe-style chipnet pilot connects and fails over @live', async ({ page }) => {
    test.setTimeout(90_000);

    await page.goto('/examples/fundme-pilot/');
    await page.locator('#connect').click();
    await expect(page.locator('#status')).toHaveText('Connected', { timeout: 45_000 });
    await expect.poll(async () => Number(await page.locator('#height').textContent()))
      .toBeGreaterThan(300_000);
    await expect(page.locator('#watch-status')).toContainText('Subscription active');
    await expect(page.locator('#trust-label')).toContainText('Unverified browser display');

    const first = await page.locator('#current').textContent();
    await page.locator('#failover').click();
    await expect(page.locator('#status')).toHaveText('Connected', { timeout: 45_000 });
    await expect(page.locator('#current')).not.toHaveText(first ?? '');
    await expect(page.locator('#events')).toContainText('Failed over to');

    await page.locator('#disconnect').click();
    await expect(page.locator('#status')).toHaveText('Disconnected');
  });
});
