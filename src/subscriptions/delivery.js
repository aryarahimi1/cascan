/**
 * Acknowledged, at-least-once subscription callback delivery shared by the
 * Node and browser pools. Callback success is an explicit async boundary:
 * throws, rejected promises, and timeouts are retried with the same event id.
 *
 * Status notifications are state-change signals, not an append-only ledger.
 * While one event is awaiting acknowledgement, newer unstarted observations
 * are coalesced to the latest state. This bounds memory under a stuck handler;
 * consumers must re-query authoritative state and keep handlers idempotent.
 */

const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_RETRY_MAX_MS = 30_000;
const DEFAULT_HANDLER_TIMEOUT_MS = 30_000;
export const MAX_SUBSCRIPTION_TIMER_MS = 2_147_483_647;

let fallbackSession = 0;

function newSessionId() {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch { /* non-security identifier; deterministic fallback below */ }
  fallbackSession++;
  return `${Date.now().toString(36)}-${fallbackSession.toString(36)}`;
}

function errorMessage(error) {
  let raw;
  try {
    raw = error instanceof Error ? error.message : String(error);
  } catch {
    raw = 'handler failed with an unreadable error';
  }
  if (typeof raw !== 'string') raw = 'handler failed';
  // Handler failures may be logged by applications. Strip terminal controls
  // and cap the value so a local integration bug cannot forge or flood logs.
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 1024) || 'handler failed';
}

export function normalizeSubscriptionDeliveryOptions(opts = {}) {
  const normalized = {
    retryBaseMs: opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
    retryMaxMs: opts.retryMaxMs ?? DEFAULT_RETRY_MAX_MS,
    handlerTimeoutMs: opts.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS,
  };
  for (const [name, value] of Object.entries(normalized)) {
    if (!Number.isInteger(value) || value < 1 || value > MAX_SUBSCRIPTION_TIMER_MS) {
      throw new RangeError(`${name} must be an integer from 1 to ${MAX_SUBSCRIPTION_TIMER_MS}`);
    }
  }
  if (normalized.retryMaxMs < normalized.retryBaseMs) {
    throw new RangeError('retryMaxMs must be greater than or equal to retryBaseMs');
  }
  return normalized;
}

export class SubscriptionDelivery {
  constructor(opts = {}) {
    if (typeof opts.type !== 'string' || typeof opts.key !== 'string') {
      throw new TypeError('subscription delivery requires string type and key');
    }
    this.type = opts.type;
    this.key = opts.key;
    const delivery = normalizeSubscriptionDeliveryOptions(opts);
    this.retryBaseMs = delivery.retryBaseMs;
    this.retryMaxMs = delivery.retryMaxMs;
    this.handlerTimeoutMs = delivery.handlerTimeoutMs;

    this._onHandlerError = typeof opts.onHandlerError === 'function'
      ? opts.onHandlerError
      : () => {};
    this._onDelivered = typeof opts.onDelivered === 'function'
      ? opts.onDelivered
      : () => {};
    this._sessionId = opts.sessionId ?? newSessionId();
    this._nextEvent = 1;
    this._handlers = new Set();
    this._active = null;
    this._pending = null;
    this._closed = false;
    this.observedValue = undefined;
    this.deliveredValue = undefined;
  }

  get size() {
    return this._handlers.size;
  }

  add(handler) {
    if (typeof handler !== 'function') throw new TypeError('subscription callback must be a function');
    if (this._closed) throw new Error('subscription delivery closed');
    this._handlers.add(handler);
  }

  delete(handler) {
    this._handlers.delete(handler);
    const state = this._active?.targets.get(handler);
    if (state) {
      state.cancelled = true;
      if (state.retryTimer) clearTimeout(state.retryTimer);
      this._active.targets.delete(handler);
      this._maybeComplete(this._active);
    }
  }

  /** Establish the initial server state without firing a change callback. */
  setBaseline(value) {
    this.observedValue = value;
    this.deliveredValue = value;
    this._pending = null;
  }

  /**
   * Observe a new upstream state. Returns the active event id, or null when
   * this is a duplicate/baseline-only observation.
   */
  observe(value, source = 'notification') {
    if (this._closed) return null;
    this.observedValue = value;

    if (this._active) {
      if (Object.is(value, this._active.value)) {
        // The newest observation returned to the event currently in flight;
        // any queued later value is now stale.
        this._pending = null;
        return this._active.id;
      }
      this._pending = { value, source, observedAt: new Date().toISOString() };
      return null;
    }
    if (Object.is(value, this.deliveredValue)) return null;
    return this._begin({ value, source, observedAt: new Date().toISOString() });
  }

  close() {
    this._closed = true;
    this._pending = null;
    if (this._active) {
      for (const state of this._active.targets.values()) {
        state.cancelled = true;
        if (state.retryTimer) clearTimeout(state.retryTimer);
      }
    }
    this._active = null;
    this._handlers.clear();
  }

  _begin(observation) {
    const id = `${this._sessionId}:${this.type}:${this._nextEvent++}`;
    const event = {
      id,
      type: this.type,
      key: this.key,
      value: observation.value,
      source: observation.source,
      observedAt: observation.observedAt,
      targets: new Map(),
    };
    for (const handler of this._handlers) {
      event.targets.set(handler, { attempts: 0, retryTimer: null, cancelled: false });
    }
    this._active = event;

    if (event.targets.size === 0) {
      this._maybeComplete(event);
      return id;
    }
    for (const [handler, state] of event.targets) this._attempt(event, handler, state);
    return id;
  }

  async _attempt(event, handler, state) {
    if (this._closed || this._active !== event || state.cancelled) return;
    state.attempts++;
    const attempt = state.attempts;
    const metadata = Object.freeze({
      id: event.id,
      type: event.type,
      key: event.key,
      source: event.source,
      observedAt: event.observedAt,
      attempt,
    });

    let timeout;
    try {
      await Promise.race([
        Promise.resolve(handler(event.value, metadata)),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error(
            `subscription handler timed out after ${this.handlerTimeoutMs}ms`,
          )), this.handlerTimeoutMs);
          timeout.unref?.();
        }),
      ]);
    } catch (error) {
      if (this._closed || this._active !== event || state.cancelled) return;
      try {
        this._onHandlerError({
          eventId: event.id,
          type: event.type,
          key: event.key,
          source: event.source,
          observedAt: event.observedAt,
          attempt,
          error: errorMessage(error),
          willRetry: true,
        });
      } catch { /* an error reporter must not break delivery */ }

      // An error observer is allowed to unsubscribe or close the pool.
      if (this._closed || this._active !== event || state.cancelled) return;

      const delayMs = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** Math.min(attempt - 1, 16)));
      state.retryTimer = setTimeout(() => {
        state.retryTimer = null;
        this._attempt(event, handler, state);
      }, delayMs);
      state.retryTimer.unref?.();
      return;
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    if (this._closed || this._active !== event || state.cancelled) return;
    event.targets.delete(handler);
    this._maybeComplete(event);
  }

  _maybeComplete(event) {
    if (this._closed || this._active !== event || event.targets.size > 0) return;
    this.deliveredValue = event.value;
    try {
      this._onDelivered(event.value, {
        id: event.id,
        type: event.type,
        key: event.key,
        source: event.source,
        observedAt: event.observedAt,
      });
    } catch { /* delivery bookkeeping must not reopen an acknowledged event */ }
    this._active = null;

    const pending = this._pending;
    this._pending = null;
    if (pending && !Object.is(pending.value, this.deliveredValue)) this._begin(pending);
  }
}
