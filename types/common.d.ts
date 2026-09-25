/**
 * Types shared by the Node (`@aryarh/cascan`) and browser
 * (`@aryarh/cascan/browser`) entry points.
 *
 * These declarations deliberately avoid `@types/node` and the DOM lib so
 * they type-check in any TypeScript project.
 */

export type NetworkName = 'mainnet' | 'chipnet' | 'testnet4';

export type Transport = 'tcp' | 'ssl' | 'ws' | 'wss';

export interface Checkpoint {
  readonly height: number;
  readonly hash: string;
}

export interface ServerPorts {
  tcp?: number | null;
  ssl?: number | null;
  ws?: number | null;
  wss?: number | null;
}

/** A Fulcrum server as held by discovery, the cache, and the pool. */
export interface ServerRecord {
  host: string;
  ports: ServerPorts;
  /** Exact transport/port the record was verified on (discovery records). */
  transport?: Transport;
  port?: number;
  network?: NetworkName;
  /** Maintained operator identity; only curated voters carry one. */
  operator?: string;
  infrastructure?: string;
  /** `false` only for development endpoints with invalid certificates. */
  tlsStrict?: boolean;
  source?: string;
  software?: string | null;
  protocol?: string | null;
  publicOnly?: boolean;
  health?: ServerHealth;
}

export interface ServerHealth {
  latencyEmaMs: number | null;
  failures: number;
  lastOkAt: number;
  lastFailAt: number;
  height: number | null;
  heightAt: number;
  cooldownUntil: number;
}

export interface NetworkConfig {
  readonly name: NetworkName;
  readonly cashaddrPrefix: 'bitcoincash' | 'bchtest';
  readonly legacyP2PKH: number;
  readonly legacyP2SH: number;
  readonly dnsSeed: string | null;
  readonly cacheFile: string;
  readonly checkpoints: readonly Checkpoint[];
  readonly curated: readonly ServerRecord[];
}

/** Balance in satoshis. Strings keep money math exact (BigInt-safe). */
export interface Balance {
  address: string;
  confirmedSats: string;
  unconfirmedSats: string;
  totalSats: string;
}

export interface BlockTip {
  height: number;
  hex: string;
}

export type SubscriptionSource = 'notification' | 'resubscribe' | 'liveness-check';

/**
 * Frozen delivery metadata passed as the second callback argument.
 * `id` is stable across retries of the same observation in this
 * process/page, and changes after a restart.
 */
export interface SubscriptionEvent {
  readonly id: string;
  readonly type: 'address' | 'transaction';
  readonly key: string;
  readonly source: SubscriptionSource;
  readonly observedAt: string;
  readonly attempt: number;
}

/**
 * Address status change. Resolving acknowledges the attempt; a throw,
 * rejection, or timeout retries with the same `event.id`. Treat it as a
 * trigger to re-query current state, never as payment proof.
 */
export type AddressCallback = (
  status: string | null,
  event: SubscriptionEvent,
) => void | Promise<void>;

/** Transaction confirmation change: block height, or `null` while unconfirmed. */
export type TransactionCallback = (
  height: number | null,
  event: SubscriptionEvent,
) => void | Promise<void>;

export type Unsubscribe = () => void;

export interface FailoverEvent {
  from: string | null;
  to: string | null;
  reason: string;
}

export interface FailoverStartEvent {
  from: string | null;
  reason: string;
}

export interface ServerLostEvent {
  server: string;
  error: string;
}

export interface ExhaustedEvent {
  errors: string[];
}

export interface HandlerErrorEvent {
  eventId: string;
  type: 'address' | 'transaction';
  key: string;
  source: SubscriptionSource;
  observedAt: string;
  attempt: number;
  error: string;
  willRetry: boolean;
}

export interface RecoveryScheduledEvent {
  attempt: number;
  delayMs: number;
  retryAt: number;
}

export interface RecoveredEvent {
  server: string | null;
  outageMs: number;
}

export interface ServerStableEvent {
  server: string | null;
  uptimeMs: number;
}

/** Events a connected cascan instance forwards from its pool. */
export interface CascanEventMap {
  'failover': FailoverEvent;
  'failover-start': FailoverStartEvent;
  'server-lost': ServerLostEvent;
  'exhausted': ExhaustedEvent;
  'handler-error': HandlerErrorEvent;
  'recovery-scheduled': RecoveryScheduledEvent;
  'recovered': RecoveredEvent;
  'server-stable': ServerStableEvent;
}

/** Tuning shared by the Node and browser pools. */
export interface PoolTuningOptions {
  /** Per-request timeout. Default 10000. */
  timeoutMs?: number;
  /** Interval for round-robin subscription re-queries. Default 30000. */
  subscriptionCheckMs?: number;
  /** Subscriptions re-queried per interval (1–256). Default 32. */
  subscriptionCheckBatchSize?: number;
  handlerRetryBaseMs?: number;
  handlerRetryMaxMs?: number;
  handlerTimeoutMs?: number;
  failureBackoffBaseMs?: number;
  failureBackoffMaxMs?: number;
  minHealthyUptimeMs?: number;
  /** Global connection attempts per budget window (1–64). */
  retryBudgetAttempts?: number;
  retryBudgetWindowMs?: number;
  recoveryBackoffBaseMs?: number;
  recoveryBackoffMaxMs?: number;
}
