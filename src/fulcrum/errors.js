/**
 * src/fulcrum/errors.js
 *
 * Shared error types for the quorum and pool layers. Split out of
 * quorum.js so the pool can throw them without an import cycle
 * (pool → quorum → pool). quorum.js re-exports both, so existing
 * `import { … } from './quorum.js'` call sites are unchanged.
 */

export class QuorumDisagreementError extends Error {
  constructor(message, record) {
    super(message);
    this.name = 'QuorumDisagreementError';
    this.code = 'QUORUM_DISAGREEMENT';
    this.record = record;
  }
}

export class AllServersFailedError extends Error {
  constructor(errors) {
    super(`all Fulcrum servers failed (${errors.length} attempted)`);
    this.name = 'AllServersFailedError';
    this.code = 'ALL_SERVERS_FAILED';
    this.errors = errors;
  }
}

/** True when an error means the server did not provide an application answer. */
export function isTransportFailure(err) {
  if (err?.kind === 'transport') return true;
  if (err?.kind === 'application') return false;
  const msg = String(err?.message ?? err);
  return /timeout|connection closed|not connected|ECONN|EPIPE|ETIMEDOUT|socket/i.test(msg);
}
