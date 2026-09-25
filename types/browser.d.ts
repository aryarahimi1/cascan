/**
 * @aryarh/cascan/browser — browser entry point.
 *
 *   import { connect } from '@aryarh/cascan/browser';
 *   const bch = await connect();
 *
 * Browser answers are one active server's claims: failover and
 * subscription restoration, but no quorum. See docs/dapp-security.md.
 */

import type {
  AddressCallback,
  Balance,
  BlockTip,
  CascanEventMap,
  NetworkConfig,
  NetworkName,
  PoolTuningOptions,
  ServerHealth,
  Unsubscribe,
} from './common.js';

export type * from './common.js';

export interface BrowserEventMap extends CascanEventMap {
  'block': BlockTip;
}

/** Limits that bound hostile server traffic; hard caps cannot be disabled. */
export interface BrowserClientLimitOptions {
  /** 350,000 bytes–8 MiB. Default 2 MiB. */
  maxMessageBytes?: number;
  /** 1–256. Default 256. */
  maxRecordsPerMessage?: number;
  /** 1–16. Default 16. */
  dispatchBatchSize?: number;
  /** 1–1,024. Default 256. */
  maxRecordsPerSecond?: number;
  /** 1–512. Default 128. */
  maxNotificationsPerSecond?: number;
  /** 1–50,000. Default 10,000. */
  maxResponseRecords?: number;
  /** 1–128. Default 64. */
  maxPendingRequests?: number;
}

export type BrowserServerInput = string | { url: string };

export interface BrowserConnectOptions extends PoolTuningOptions, BrowserClientLimitOptions {
  /** Default `'mainnet'`. */
  network?: NetworkName;
  /** `wss://` URLs; overrides the built-in bootstrap pool (max 32). */
  servers?: readonly BrowserServerInput[];
  /** 5,000–300,000. Default 45,000. */
  keepaliveMs?: number;
}

/** Connect to a checkpoint-verified pool of WSS Fulcrum servers. */
export declare function connect(opts?: BrowserConnectOptions): Promise<BrowserCascan>;

export interface BrowserServerSnapshot {
  url: string;
  connected: boolean;
  height: number | null;
  latencyMs: number | null;
  failures: number;
  cooldownUntil: string | null;
  cooldownMs: number;
  score: number;
}

export declare class BrowserCascan {
  constructor(pool: BrowserServerPool, opts?: { network?: NetworkName });
  readonly pool: BrowserServerPool;
  readonly network: NetworkConfig;
  on<K extends keyof BrowserEventMap>(event: K, callback: (payload: BrowserEventMap[K]) => void): this;
  off<K extends keyof BrowserEventMap>(event: K, callback: (payload: BrowserEventMap[K]) => void): this;
  /** Raw Electrum call with failover. */
  request<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  /** Validated height, but still one selected server's claim. */
  height(): Promise<number>;
  /** CashAddr only; impossible supply values are rejected. */
  balance(address: string): Promise<Balance>;
  watch(address: string, callback: AddressCallback): Promise<Unsubscribe>;
  servers(): BrowserServerSnapshot[];
  /** Demo/test hook for real failover; resolves with the replacement. */
  killCurrent(reason?: string): Promise<string | null>;
  close(): void;
}

export interface BrowserServerEntry {
  url: string;
  source: 'bootstrap' | 'user';
}

export interface RankedBrowserServer extends BrowserServerEntry {
  health: ServerHealth;
}

export declare const BROWSER_BOOTSTRAP_SERVERS: Readonly<Record<NetworkName, readonly string[]>>;
export declare function browserBootstrapServers(network?: NetworkName): BrowserServerEntry[];
export declare function normalizeBrowserServers(servers: readonly BrowserServerInput[]): BrowserServerEntry[];

export declare const BROWSER_CLIENT_LIMITS: Readonly<{
  messageBytes: number;
  hardMessageBytes: number;
  recordsPerMessage: number;
  queuedRecords: number;
  dispatchBatchSize: number;
  recordsPerSecond: number;
  notificationsPerSecond: number;
  responseRecords: number;
  pendingRequests: number;
  notificationHandlers: number;
  closeHandlers: number;
}>;

export declare class BrowserFulcrumError extends Error {
  constructor(message: string, opts?: { server?: string; method?: string; kind?: string; code?: string });
  readonly name: 'BrowserFulcrumError';
  readonly server?: string;
  readonly method?: string;
  readonly kind?: string;
  readonly code?: string;
}

export interface BrowserFulcrumClientOptions extends BrowserClientLimitOptions {
  /** `wss://` URL. */
  url: string;
  name?: string;
  timeoutMs?: number;
  network?: NetworkName;
  /** Default `true`: verify BCH fork checkpoints before answering. */
  verifyChain?: boolean;
}

export declare class BrowserFulcrumClient {
  static MAX_MESSAGE_BYTES: number;
  static HARD_MAX_MESSAGE_BYTES: number;
  constructor(opts: BrowserFulcrumClientOptions);
  readonly url: string;
  readonly name: string;
  readonly connected: boolean;
  connect(): Promise<this>;
  request<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  /** Returns a function that removes the handler. */
  onNotification(handler: (method: string, params: unknown[]) => void): () => boolean;
  onClose(handler: () => void): () => boolean;
  close(): void;
}

export interface BrowserServerPoolOptions extends PoolTuningOptions, BrowserClientLimitOptions {
  network?: NetworkName;
  keepaliveMs?: number;
}

export declare class BrowserServerPool {
  constructor(servers: readonly BrowserServerEntry[], opts?: BrowserServerPoolOptions);
  readonly current: string | null;
  ranked(): RankedBrowserServer[];
  on<K extends keyof BrowserEventMap>(event: K, callback: (payload: BrowserEventMap[K]) => void): this;
  off<K extends keyof BrowserEventMap>(event: K, callback: (payload: BrowserEventMap[K]) => void): this;
  acquire(): Promise<BrowserFulcrumClient>;
  request<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  subscribeAddress(address: string, callback: AddressCallback): Promise<string | null>;
  unsubscribeAddress(address: string, callback: AddressCallback): void;
  killCurrent(reason?: string): Promise<string | null>;
  close(): void;
}

export declare const MAX_BROWSER_SERVERS: number;
export declare const MAX_BROWSER_SUBSCRIPTIONS: number;
export declare const MAX_BROWSER_CALLBACKS_PER_SUBSCRIPTION: number;
export declare const MAX_BROWSER_CALLBACKS: number;
export declare const MAX_BROWSER_EVENT_HANDLERS_PER_EVENT: number;
export declare const MAX_BROWSER_EVENT_HANDLERS: number;
export declare const MAX_REASONABLE_BCH_HEIGHT: number;
