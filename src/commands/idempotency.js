import { createHash } from 'node:crypto';

/** Stable, header-safe key for one durable webhook business action. */
export function durableWebhookKey(kind, ...parts) {
  if (typeof kind !== 'string' || !/^[a-z0-9.]{1,40}$/i.test(kind)) {
    throw new TypeError('webhook idempotency kind must be safe ASCII');
  }
  const digest = createHash('sha256')
    .update(JSON.stringify(parts))
    .digest('hex');
  return `cascan.${kind}:${digest}`;
}
