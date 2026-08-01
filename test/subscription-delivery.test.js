import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SubscriptionDelivery } from '../src/subscriptions/delivery.js';

const waitFor = async (predicate, timeoutMs = 500) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for delivery state');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
};

test('delivery: timer options cannot overflow into hot-loop timeouts', () => {
  assert.throws(
    () => new SubscriptionDelivery({
      type: 'address-status',
      key: 'bitcoincash:qptest',
      handlerTimeoutMs: 2_147_483_648,
    }),
    /integer from 1 to 2147483647/,
  );
});

test('delivery: rejected promises retry with one stable event id until acknowledged', async () => {
  const errors = [];
  const delivered = [];
  const attempts = [];
  const queue = new SubscriptionDelivery({
    type: 'address-status',
    key: 'bitcoincash:qptest',
    sessionId: 'test-session',
    retryBaseMs: 2,
    retryMaxMs: 4,
    handlerTimeoutMs: 100,
    onHandlerError: error => errors.push(error),
    onDelivered: (value, event) => delivered.push([value, event.id]),
  });
  queue.setBaseline('a');
  queue.add(async (value, event) => {
    attempts.push([value, event.id, event.attempt]);
    if (attempts.length === 1) throw new Error('database temporarily unavailable');
  });

  const eventId = queue.observe('b', 'notification');
  assert.equal(queue.observedValue, 'b');
  assert.equal(queue.deliveredValue, 'a', 'observation is not acknowledgement');
  await waitFor(() => delivered.length === 1);

  assert.equal(attempts.length, 2);
  assert.equal(attempts[0][1], eventId);
  assert.equal(attempts[1][1], eventId, 'retry keeps the idempotency key stable');
  assert.deepEqual(attempts.map(attempt => attempt[2]), [1, 2]);
  assert.equal(errors[0].eventId, eventId);
  assert.equal(errors[0].willRetry, true);
  assert.equal(queue.deliveredValue, 'b');
  queue.close();
});

test('delivery: stuck handlers time out visibly and remain retryable', async () => {
  const errors = [];
  const queue = new SubscriptionDelivery({
    type: 'address-status',
    key: 'bitcoincash:qptest',
    sessionId: 'timeout-session',
    retryBaseMs: 50,
    retryMaxMs: 50,
    handlerTimeoutMs: 5,
    onHandlerError: error => errors.push(error),
  });
  queue.setBaseline('a');
  queue.add(() => new Promise(() => {}));
  const eventId = queue.observe('b');
  await waitFor(() => errors.length === 1);
  assert.equal(errors[0].eventId, eventId);
  assert.match(errors[0].error, /timed out/);
  assert.equal(queue.deliveredValue, 'a');
  queue.close();
});

test('delivery: backpressure keeps the active event and coalesces only unstarted state', async () => {
  let release;
  const first = new Promise(resolve => { release = resolve; });
  const seen = [];
  const queue = new SubscriptionDelivery({
    type: 'address-status',
    key: 'bitcoincash:qptest',
    sessionId: 'coalesce-session',
    retryBaseMs: 5,
    retryMaxMs: 5,
    handlerTimeoutMs: 100,
  });
  queue.setBaseline('a');
  queue.add(async (value, event) => {
    seen.push([value, event.id]);
    if (value === 'b') await first;
  });

  queue.observe('b');
  queue.observe('c');
  queue.observe('d');
  assert.deepEqual(seen.map(item => item[0]), ['b']);
  release();
  await waitFor(() => seen.length === 2);

  assert.deepEqual(seen.map(item => item[0]), ['b', 'd']);
  assert.notEqual(seen[0][1], seen[1][1]);
  await waitFor(() => queue.deliveredValue === 'd');
  queue.close();
});

test('delivery: handler errors are bounded and stripped of terminal controls', async () => {
  const errors = [];
  const queue = new SubscriptionDelivery({
    type: 'address-status',
    key: 'bitcoincash:qptest',
    sessionId: 'log-session',
    retryBaseMs: 50,
    retryMaxMs: 50,
    handlerTimeoutMs: 100,
    onHandlerError: error => errors.push(error),
  });
  queue.setBaseline('a');
  queue.add(() => { throw new Error(`bad\x1b]8;;https://evil.example\x07click${'x'.repeat(2_000)}`); });
  queue.observe('b');
  await waitFor(() => errors.length === 1);
  assert.doesNotMatch(errors[0].error, /\x1b|\x07/);
  assert.ok(errors[0].error.length <= 1024);
  queue.close();
});

test('delivery: an unreadable rejection reason cannot disable retries', async () => {
  const errors = [];
  let attempts = 0;
  const queue = new SubscriptionDelivery({
    type: 'address-status',
    key: 'bitcoincash:qptest',
    sessionId: 'hostile-error-session',
    retryBaseMs: 2,
    retryMaxMs: 2,
    handlerTimeoutMs: 100,
    onHandlerError: error => errors.push(error),
  });
  queue.setBaseline('a');
  queue.add(() => {
    attempts++;
    if (attempts === 1) {
      return Promise.reject({ toString() { throw new Error('second-order failure'); } });
    }
  });

  queue.observe('b');
  await waitFor(() => queue.deliveredValue === 'b');
  assert.equal(attempts, 2);
  assert.match(errors[0].error, /unreadable error/);
  queue.close();
});
