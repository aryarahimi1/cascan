import { connect } from '../../src/browser/index.js';
import {
  computeProgress,
  formatBch,
  parseGoalBch,
} from '../../src/campaign/progress.js';

const MAX_BCH_SATS = 2_100_000_000_000_000n;

const elements = {
  setupForm: document.querySelector('#setup-form'),
  address: document.querySelector('#address'),
  goal: document.querySelector('#goal'),
  servers: document.querySelector('#servers'),
  connect: document.querySelector('#connect'),
  failover: document.querySelector('#failover'),
  disconnect: document.querySelector('#disconnect'),
  status: document.querySelector('#status'),
  current: document.querySelector('#current'),
  height: document.querySelector('#height'),
  raised: document.querySelector('#raised'),
  goalOutput: document.querySelector('#goal-output'),
  percent: document.querySelector('#percent'),
  progress: document.querySelector('#progress'),
  trustLabel: document.querySelector('#trust-label'),
  watchStatus: document.querySelector('#watch-status'),
  events: document.querySelector('#events'),
};

let cascan = null;
let stopWatching = null;
let generation = 0;
let refreshChain = Promise.resolve();
let campaign = null;

elements.setupForm.addEventListener('submit', async event => {
  event.preventDefault();
  const attempt = ++generation;
  closeSession();
  resetDisplay();
  setConnecting(true);

  let next = null;
  try {
    const goalSats = parsePilotGoal(elements.goal.value.trim());
    const address = elements.address.value.trim();
    const servers = parseServers(elements.servers.value);
    next = await connect({
      network: 'chipnet',
      ...(servers.length > 0 ? { servers } : {}),
    });
    if (attempt !== generation) {
      next.close();
      return;
    }

    cascan = next;
    campaign = { address, goalSats };
    attachEvents(next, attempt);
    await queueRefresh(next, attempt, 'initial snapshot');
    stopWatching = await next.watch(address, async (_status, delivery) => {
      await queueRefresh(next, attempt, `subscription ${delivery.id}`);
    });
    if (attempt !== generation || cascan !== next) {
      stopWatching?.();
      stopWatching = null;
      next.close();
      return;
    }

    elements.watchStatus.textContent = 'Subscription active and restored after failover.';
    elements.status.textContent = 'Connected';
    setConnected(true);
    log(`Connected to ${next.pool.current} on chipnet`);
  } catch (error) {
    next?.close();
    if (attempt !== generation) return;
    closeSession();
    resetDisplay();
    elements.status.textContent = 'Connection failed';
    log(`Pilot failed: ${safeMessage(error)}`);
  } finally {
    if (attempt === generation) setConnecting(false);
  }
});

elements.failover.addEventListener('click', async () => {
  const active = cascan;
  const activeGeneration = generation;
  if (!active) return;
  elements.failover.disabled = true;
  try {
    await active.killCurrent('fundme chipnet pilot');
    await queueRefresh(active, activeGeneration, 'manual failover');
  } catch (error) {
    log(`Failover failed: ${safeMessage(error)}`);
  } finally {
    elements.failover.disabled = cascan !== active;
  }
});

elements.disconnect.addEventListener('click', () => {
  generation++;
  closeSession();
  resetDisplay();
  log('Disconnected');
});

function attachEvents(instance, attempt) {
  instance.on('failover-start', event => {
    if (!isCurrent(instance, attempt)) return;
    elements.status.textContent = 'Failing over…';
    elements.trustLabel.textContent = 'Unverified browser display — refreshing';
    log(`Lost ${event.from}: ${event.reason}`);
  });
  instance.on('failover', event => {
    if (!isCurrent(instance, attempt)) return;
    elements.status.textContent = 'Connected';
    log(`Failed over to ${event.to}`);
    queueRefresh(instance, attempt, 'automatic failover').catch(error => {
      log(`Refresh failed: ${safeMessage(error)}`);
    });
  });
  instance.on('handler-error', event => {
    if (!isCurrent(instance, attempt)) return;
    elements.trustLabel.textContent = 'Unverified browser display — stale, refresh retrying';
    elements.watchStatus.textContent = 'Refresh failed; cascan will retry this event.';
    log(`Refresh retry ${event.attempt}: ${event.error}`);
  });
  instance.on('exhausted', () => {
    if (!isCurrent(instance, attempt)) return;
    elements.status.textContent = 'All servers unavailable';
    elements.trustLabel.textContent = 'Unverified browser display — stale';
    elements.watchStatus.textContent = 'Subscription waiting for bounded pool recovery.';
    log('Every configured chipnet server is unavailable');
  });
  instance.on('recovered', event => {
    if (!isCurrent(instance, attempt)) return;
    elements.status.textContent = 'Connected';
    log(`Pool recovered on ${event.server}`);
  });
}

function queueRefresh(instance, attempt, source) {
  refreshChain = refreshChain
    .catch(() => {})
    .then(() => refresh(instance, attempt, source));
  return refreshChain;
}

async function refresh(instance, attempt, source) {
  if (!isCurrent(instance, attempt) || !campaign) return;
  const [balance, height] = await Promise.all([
    instance.balance(campaign.address),
    instance.height(),
  ]);
  if (!isCurrent(instance, attempt) || !campaign) return;

  const raised = BigInt(balance.totalSats);
  if (raised < 0n || raised > MAX_BCH_SATS) {
    throw new Error('server returned an impossible campaign total');
  }
  const snapshot = computeProgress(raised.toString(), campaign.goalSats);
  const barPercent = Math.max(0, Math.min(100, snapshot.percent ?? 0));

  elements.current.textContent = instance.pool.current ?? '—';
  elements.height.textContent = String(height);
  elements.raised.textContent = `${formatBch(snapshot.raisedSats)} BCH`;
  elements.goalOutput.textContent = `${formatBch(snapshot.goalSats)} BCH`;
  elements.percent.textContent = snapshot.reached && snapshot.percent > 100
    ? 'Goal reached (100%+)'
    : `${snapshot.percent ?? 0}%`;
  elements.progress.value = barPercent;
  elements.progress.textContent = `${barPercent}%`;
  elements.trustLabel.textContent = 'Unverified browser display — current snapshot';
  elements.watchStatus.textContent = 'Subscription active and restored after failover.';
  log(`Refreshed ${source}: ${formatBch(snapshot.raisedSats)} BCH displayed`);
}

function parsePilotGoal(value) {
  const goal = BigInt(parseGoalBch(value));
  if (goal <= 0n || goal > MAX_BCH_SATS) {
    throw new RangeError('goal must be greater than zero and no more than 21,000,000 BCH');
  }
  return goal.toString();
}

function parseServers(value) {
  return value
    .split(/\r?\n/)
    .map(server => server.trim())
    .filter(Boolean);
}

function isCurrent(instance, attempt) {
  return cascan === instance && generation === attempt;
}

function closeSession() {
  stopWatching?.();
  stopWatching = null;
  cascan?.close();
  cascan = null;
  campaign = null;
  refreshChain = Promise.resolve();
  setConnected(false);
}

function resetDisplay() {
  elements.status.textContent = 'Disconnected';
  elements.current.textContent = '—';
  elements.height.textContent = '—';
  elements.raised.textContent = '—';
  elements.goalOutput.textContent = '—';
  elements.percent.textContent = '—';
  elements.progress.value = 0;
  elements.progress.textContent = '0%';
  elements.trustLabel.textContent = 'Unverified browser display — no current snapshot';
  elements.watchStatus.textContent = 'No active subscription.';
}

function setConnecting(connecting) {
  elements.connect.disabled = connecting;
  if (connecting) elements.status.textContent = 'Connecting to chipnet…';
}

function setConnected(connected) {
  elements.failover.disabled = !connected;
  elements.disconnect.disabled = !connected;
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
