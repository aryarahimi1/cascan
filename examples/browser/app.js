import { connect } from '../../src/browser/index.js';

const elements = {
  connectForm: document.querySelector('#connect-form'),
  watchForm: document.querySelector('#watch-form'),
  servers: document.querySelector('#servers'),
  address: document.querySelector('#address'),
  connect: document.querySelector('#connect'),
  failover: document.querySelector('#failover'),
  disconnect: document.querySelector('#disconnect'),
  watch: document.querySelector('#watch'),
  status: document.querySelector('#status'),
  current: document.querySelector('#current'),
  height: document.querySelector('#height'),
  watchStatus: document.querySelector('#watch-status'),
  pool: document.querySelector('#pool'),
  events: document.querySelector('#events'),
};

let cascan = null;
let stopWatching = null;
let connectionAttempt = 0;

elements.connectForm.addEventListener('submit', async event => {
  event.preventDefault();
  const attempt = ++connectionAttempt;
  disconnect();
  setConnecting(true);

  const servers = elements.servers.value
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean);

  try {
    const next = await connect(servers.length > 0 ? { servers } : {});
    if (attempt !== connectionAttempt) {
      next.close();
      return;
    }
    cascan = next;
    attachEvents(cascan);
    setConnected(true);
    log(`Connected to ${cascan.pool.current}`);
    await refresh();
  } catch (error) {
    if (attempt !== connectionAttempt) return;
    elements.status.textContent = 'Connection failed';
    log(`Connection failed: ${safeMessage(error)}`);
    setConnected(false);
  } finally {
    if (attempt === connectionAttempt) setConnecting(false);
  }
});

elements.failover.addEventListener('click', async () => {
  if (!cascan) return;
  elements.failover.disabled = true;
  log(`Killing ${cascan.pool.current} to demonstrate failover`);
  try {
    await cascan.killCurrent('browser demo button');
    await refresh();
  } catch (error) {
    log(`Failover exhausted the pool: ${safeMessage(error)}`);
  } finally {
    elements.failover.disabled = !cascan;
  }
});

elements.disconnect.addEventListener('click', () => {
  connectionAttempt++;
  disconnect();
  log('Disconnected');
});

elements.watchForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!cascan) return;
  stopWatching?.();
  stopWatching = null;
  try {
    stopWatching = await cascan.watch(elements.address.value, status => {
      elements.watchStatus.textContent = `Activity received: ${status ?? 'empty status'}`;
      log('Address status changed after subscription');
    });
    elements.watchStatus.textContent = 'Subscription active. Now kill the current server.';
    log('Address subscription active');
  } catch (error) {
    elements.watchStatus.textContent = `Subscription failed: ${safeMessage(error)}`;
  }
});

function attachEvents(instance) {
  instance.on('failover-start', event => {
    elements.status.textContent = 'Failing over…';
    log(`Lost ${event.from}: ${event.reason}`);
  });
  instance.on('failover', event => {
    elements.status.textContent = 'Connected';
    log(`Failed over to ${event.to}`);
    refresh().catch(error => log(`Refresh failed: ${safeMessage(error)}`));
  });
  instance.on('server-lost', event => {
    log(`Rejected ${event.server}: ${event.error}`);
  });
  instance.on('block', event => {
    elements.height.textContent = String(event.height);
  });
  instance.on('exhausted', () => {
    elements.status.textContent = 'All servers failed';
  });
}

async function refresh() {
  if (!cascan) return;
  elements.current.textContent = cascan.pool.current ?? '—';
  elements.height.textContent = String(await cascan.height());
  renderPool(cascan.servers());
}

function renderPool(servers) {
  const rows = servers.map(server => {
    const row = document.createElement('tr');
    const values = [
      server.url,
      server.connected ? 'connected' : 'standby',
      server.height ?? '—',
      server.latencyMs === null ? '—' : `${server.latencyMs} ms`,
      server.failures,
    ];
    for (const value of values) {
      const cell = document.createElement('td');
      cell.textContent = String(value);
      row.append(cell);
    }
    return row;
  });
  elements.pool.replaceChildren(...rows);
}

function disconnect() {
  stopWatching?.();
  stopWatching = null;
  cascan?.close();
  cascan = null;
  setConnected(false);
  elements.status.textContent = 'Disconnected';
  elements.current.textContent = '—';
  elements.height.textContent = '—';
  elements.watchStatus.textContent = 'No active subscription.';
  elements.pool.replaceChildren();
}

function setConnecting(connecting) {
  elements.connect.disabled = connecting;
  if (connecting) elements.status.textContent = 'Connecting and verifying BCH…';
}

function setConnected(connected) {
  elements.failover.disabled = !connected;
  elements.disconnect.disabled = !connected;
  elements.watch.disabled = !connected;
  if (connected) elements.status.textContent = 'Connected';
}

function log(message) {
  const item = document.createElement('li');
  item.textContent = safeMessage(message);
  elements.events.prepend(item);
  while (elements.events.children.length > 50) elements.events.lastElementChild.remove();
}

function safeMessage(value) {
  return String(value?.message ?? value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .slice(0, 500);
}
