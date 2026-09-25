/**
 * @aryarh/cascan — Node entry point.
 *
 *   import { connect } from '@aryarh/cascan';
 *   const bch = await connect();
 */

import type {
  AddressCallback,
  Balance,
  BlockTip,
  CascanEventMap,
  Checkpoint,
  NetworkConfig,
  NetworkName,
  PoolTuningOptions,
  ServerHealth,
  ServerPorts,
  ServerRecord,
  TransactionCallback,
  Transport,
  Unsubscribe,
} from './common.js';

export type * from './common.js';

/** Node EventEmitter methods, typed to cascan's documented events. */
export interface CascanEmitter<Events> {
  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): this;
  once<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): this;
  off<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): this;
  addListener<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): this;
  removeListener<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): this;
  removeAllListeners(event?: keyof Events): this;
  listenerCount(event: keyof Events): number;
  emit<K extends keyof Events>(event: K, payload: Events[K]): boolean;
}

export interface PoolEventMap extends CascanEventMap {
  'block': { height: number; hex: string | null };
}

// ---------------------------------------------------------------------------
// connect() and the Cascan instance
// ---------------------------------------------------------------------------

interface ConnectOptionsBase extends PoolTuningOptions {
  /** Default `'mainnet'`. Selects the chain, pool, and checkpoints. */
  network?: NetworkName;
  /** Explicit pool; skips endpoint discovery (sockets are still verified). */
  servers?: ServerRecord[];
  /** Default `true`: cache → DNS seed + gossip + probing → curated fallback. */
  discover?: boolean;
  /** Discovery cache location. Default `~/.cascan/servers*.json`. */
  cachePath?: string;
  /** Discovery progress callback. */
  onLog?: (message: string) => void;
}

/**
 * `allowInsecureTransport` is a non-payment escape hatch and requires
 * `verify: false`; the type enforces the same rule `connect()` checks.
 */
export type ConnectOptions = ConnectOptionsBase & (
  | {
    /** Default `true`: strict quorum on `balance()`/`tx()`/`height()`. */
    verify?: boolean;
    allowInsecureTransport?: false;
  }
  | { verify: false; allowInsecureTransport: true }
);

/** Connect to Bitcoin Cash. Resolves connected, or throws `AllServersFailedError`. */
export declare function connect(opts?: ConnectOptions): Promise<Cascan>;

export type QuorumMode = 'any' | 'majority' | 'all';

export interface QuorumCallOptions {
  /** Default `'majority'`. */
  mode?: QuorumMode;
  /** Independent operators to ask. Default 4. */
  maxServers?: number;
  /** Matching operator votes required; never below 2. */
  minAgreement?: number;
  timeoutMs?: number;
}

export interface VerifiableOptions extends QuorumCallOptions {
  /** Override the instance default; `false` is a single-server trade-off. */
  verify?: boolean;
}

export interface TxOptions extends VerifiableOptions {
  /** Default `true`. */
  verbose?: boolean;
}

export type QuorumAgreement = 'unanimous' | 'majority' | 'plurality' | 'single' | null;

export interface QuorumServerStatus {
  server: string;
  status: 'ok' | 'failed' | 'not-tried';
  latencyMs?: number;
  error?: string;
  operator?: string;
  infrastructure?: string;
  independent?: boolean;
}

export interface QuorumDisagreement {
  agreement: QuorumAgreement;
  picked: { server: string; value: unknown };
  servers: Array<{
    server: string;
    value: unknown;
    agreed: boolean;
    operator?: string;
    infrastructure?: string;
    independent?: boolean;
    duplicateOf?: string;
  }>;
}

export interface QuorumDegradation {
  requested: QuorumMode;
  agreement?: 'single';
  reason?: 'shared-infrastructure';
  fulfilledCount: number;
  independentCount?: number;
  totalCount: number;
}

/** Who answered, agreed, disagreed, or was excluded. */
export interface QuorumReceipt {
  ok: true;
  answered: string;
  answeredOperator?: string;
  agreement: QuorumAgreement;
  agreementCount: number;
  operators?: string[];
  voterCount?: number;
  height?: number;
  servers: QuorumServerStatus[];
  disagreements: QuorumDisagreement[];
  degraded: QuorumDegradation[];
}

export interface VerifiedBalance extends Balance {
  /** Present when the call was quorum-verified (the default). */
  receipt?: QuorumReceipt;
}

/** Electrum verbose transaction (bitcoind-style JSON). */
export interface VerboseTransaction {
  txid: string;
  hash?: string;
  hex: string;
  size?: number;
  version?: number;
  locktime?: number;
  vin: Array<Record<string, unknown>>;
  vout: Array<Record<string, unknown>>;
  blockhash?: string;
  confirmations?: number;
  time?: number;
  blocktime?: number;
  [key: string]: unknown;
}

export interface TxResult<T> {
  tx: T;
  receipt?: QuorumReceipt;
}

/** A pool member's health, as returned by `Cascan#servers()`. */
export interface ServerSnapshot {
  host: string;
  ports: ServerPorts;
  source: string;
  operator: string | null;
  infrastructure: string | null;
  tlsStrict: boolean;
  software: string | null;
  protocol: string | null;
  height: number | null;
  latencyMs: number | null;
  failures: number;
  cooldownUntil: string | null;
  cooldownMs: number;
  score: number;
  connected: boolean;
}

export declare class Cascan {
  constructor(pool: ServerPool, opts?: { network?: NetworkName; verify?: boolean });
  readonly pool: ServerPool;
  readonly network: NetworkName;
  readonly defaults: { verify: boolean };

  /** Escape hatch: any Electrum method, with failover. */
  request<T = unknown>(method: string, params?: unknown[]): Promise<T>;

  /** Quorum-verified call; always requires at least two matching operators. */
  verify<T = unknown>(
    method: string,
    params?: unknown[],
    opts?: QuorumCallOptions,
  ): Promise<{ value: T; receipt: QuorumReceipt }>;

  /** Cashaddr or legacy address. Strict quorum by default. */
  balance(address: string, opts?: VerifiableOptions): Promise<VerifiedBalance>;

  tx(txid: string, opts: TxOptions & { verbose: false }): Promise<TxResult<string>>;
  tx(txid: string, opts?: TxOptions): Promise<TxResult<VerboseTransaction>>;

  /** Current chain height. Strict quorum by default. */
  height(opts?: VerifiableOptions): Promise<number>;

  /** Watch an address; restored on the replacement server after failover. */
  watch(address: string, callback: AddressCallback): Promise<Unsubscribe>;

  /** Health snapshot of the pool, best first. */
  servers(): ServerSnapshot[];

  close(): Promise<void>;
}
export interface Cascan extends CascanEmitter<CascanEventMap> {}

// ---------------------------------------------------------------------------
// Pool, discovery, and quorum toolbox
// ---------------------------------------------------------------------------

export interface ServerPoolOptions extends PoolTuningOptions {
  network?: NetworkName;
  allowInsecureTransport?: boolean;
  keepaliveMs?: number;
}

export interface RankedServer extends ServerRecord {
  health: ServerHealth;
}

export declare class ServerPool {
  constructor(servers: readonly ServerRecord[], opts?: ServerPoolOptions);
  readonly network: NetworkName;
  /** Name of the currently connected server, or `null`. */
  readonly current: string | null;
  /** Health-ranked snapshot; does not mutate pool order. */
  ranked(): RankedServer[];
  acquire(opts?: { exclude?: Set<string> }): Promise<FulcrumClient>;
  request<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  /** Resolves with the currently observed status. */
  subscribeAddress(address: string, callback: AddressCallback): Promise<string | null>;
  unsubscribeAddress(address: string, callback: AddressCallback): void;
  subscribeTransaction(txid: string, callback: TransactionCallback): Promise<number | null>;
  unsubscribeTransaction(txid: string, callback: TransactionCallback): void;
  /** Chaos hook: kill the live connection; resolves with the replacement. */
  killCurrent(reason?: string): Promise<string | null>;
  close(): void;
}
export interface ServerPool extends CascanEmitter<PoolEventMap> {}

export interface ResolvePoolOptions {
  network?: NetworkName;
  discover?: boolean;
  cachePath?: string;
  cacheTtlMs?: number;
  forceProbe?: boolean;
  allowInsecureTransport?: boolean;
  onLog?: (message: string) => void;
}

export interface ResolvedPool {
  servers: ServerRecord[];
  origin: 'cache' | 'discovery' | 'curated';
  discovery?: DiscoveryResult;
}

export declare function resolvePool(opts?: ResolvePoolOptions): Promise<ResolvedPool>;

export interface QuorumServerEntry {
  host: string;
  ports: ServerPorts;
  transport?: Transport;
  port?: number;
  rejectUnauthorized: boolean;
  network: NetworkName;
  operator?: string;
  infrastructure?: string;
  publicOnly?: boolean;
}

export declare function toQuorumEntry(record: ServerRecord): QuorumServerEntry;

export interface ConnectPoolOptions extends PoolTuningOptions {
  network?: NetworkName;
  servers?: ServerRecord[];
  allowInsecureTransport?: boolean;
  onLog?: (message: string) => void;
}

export declare function connectPool(
  opts?: ConnectPoolOptions,
): Promise<{ pool: ServerPool; server: string | null }>;

export interface DiscoverOptions {
  network?: NetworkName;
  seedHost?: string;
  curated?: ServerRecord[];
  probeTimeoutMs?: number;
  concurrency?: number;
  maxProbes?: number;
  gossipPerServer?: number;
  allowInsecureTransport?: boolean;
  dnsResolve?: (host: string) => Promise<string[]>;
  onLog?: (message: string) => void;
}

export interface DiscoveryResult {
  /** Verified, health-seeded records. */
  servers: ServerRecord[];
  rejected: Array<{ host: string; reason: string }>;
  meta: {
    seedIps: number;
    candidates: number;
    probed: number;
    sources: Record<string, unknown>;
  };
}

export declare function discoverServers(opts?: DiscoverOptions): Promise<DiscoveryResult>;

/** Mainnet Electrum DNS seed (Flowee). */
export declare const DNS_SEED: string;
/** Mainnet fork checkpoints (BTC split, BSV split). */
export declare const CHECKPOINTS: readonly Checkpoint[];

export declare function newHealth(): ServerHealth;
export declare function scoreServer(
  server: { health: ServerHealth; tlsStrict?: boolean; transport?: Transport },
  poolMaxHeight?: number | null,
  now?: number,
): number;
export declare function rankServers<T extends { health: ServerHealth }>(
  servers: readonly T[],
  now?: number,
): T[];

export interface QueryQuorumOptions {
  /** Default `'any'`. */
  mode?: QuorumMode;
  /** Default: the discovery-backed pool for `network`. */
  servers?: QuorumServerEntry[];
  network?: NetworkName;
  timeoutMs?: number;
  minAgreement?: number;
  /** Operators to ask (1–32). Default 4. */
  maxFanout?: number;
  allowInsecureTransport?: boolean;
  /** `true` counts only distinct trusted operators as security voters. */
  paymentMode?: boolean;
}

export interface QuorumResult<T = unknown> {
  value: T;
  answered: string;
  answeredOperator?: string;
  agreement: QuorumAgreement;
  agreementCount: number;
  operators: string[];
  voterCount: number;
  statuses: QuorumServerStatus[];
  disagreements: QuorumDisagreement[];
  degraded: QuorumDegradation[];
  partial: boolean;
}

export declare function queryQuorum<T = unknown>(
  method: string,
  params?: unknown[],
  opts?: QueryQuorumOptions,
): Promise<QuorumResult<T>>;

export declare function fulcrumMeta(
  result: QuorumResult,
  extra?: { height?: number },
): QuorumReceipt;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export declare class QuorumDisagreementError extends Error {
  constructor(message: string, record?: unknown);
  readonly name: 'QuorumDisagreementError';
  readonly code: 'QUORUM_DISAGREEMENT';
  readonly record: unknown;
}

export declare class AllServersFailedError extends Error {
  constructor(errors: unknown[]);
  readonly name: 'AllServersFailedError';
  readonly code: 'ALL_SERVERS_FAILED';
  readonly errors: unknown[];
}

export declare class ChainVerificationError extends Error {
  constructor(message: string, opts?: { code?: string; server?: string; network?: NetworkName; height?: number });
  readonly name: 'ChainVerificationError';
  readonly code: string;
  readonly kind: 'security';
  readonly server?: string;
  readonly method: 'blockchain.block.header';
  readonly network?: NetworkName;
  readonly height?: number;
}

export declare class InsecureTransportError extends Error {
  constructor(message: string, opts?: { server?: string });
  readonly name: 'InsecureTransportError';
  readonly code: 'INSECURE_TRANSPORT';
  readonly kind: 'configuration';
  readonly server?: string;
}

// ---------------------------------------------------------------------------
// Raw protocol client
// ---------------------------------------------------------------------------

export interface FulcrumClientOptions {
  host: string;
  port: number;
  tls?: boolean;
  /** Default `'ssl'` (or `'tcp'` when `tls: false`). */
  transport?: Transport;
  /** Default `true`. */
  rejectUnauthorized?: boolean;
  timeoutMs?: number;
  publicOnly?: boolean;
  name?: string;
}

/**
 * Raw Electrum protocol client. It does not apply pool/quorum transport,
 * checkpoint, or subscription-liveness policy; use `connect()` for those.
 */
export declare class FulcrumClient {
  static MAX_BUFFER_BYTES: number;
  constructor(opts: FulcrumClientOptions);
  readonly host: string;
  readonly port: number;
  readonly transport: Transport;
  readonly name: string;
  readonly connected: boolean;
  /** `[software, protocol]` after `connect()`. */
  readonly serverVersion: [string, string] | null;
  readonly chainVerified: NetworkName | null;
  connect(): Promise<this>;
  request<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  onNotification(handler: (method: string, params: unknown[]) => void): void;
  subscribeAddress(address: string, callback: (status: string | null) => void): Promise<string | null>;
  tip(): Promise<BlockTip>;
  close(): void;
}

export declare const DEFAULT_FULCRUM_SERVERS: ServerRecord[];

// ---------------------------------------------------------------------------
// Addresses and networks
// ---------------------------------------------------------------------------

export declare class AddressError extends Error {
  constructor(message: string);
  readonly name: 'AddressError';
}

export interface AddressRecord {
  input: string;
  type: 'p2pkh' | 'p2sh';
  hash: Uint8Array;
  network: NetworkName;
  tokenAware: boolean;
  cashaddr: string;
  /** `null` for P2SH32, which has no legacy form. */
  legacy: string | null;
  lockingScript: string;
  scripthash: string;
  format: 'cashaddr' | 'legacy';
  warnings: string[];
}

/** Parse cashaddr (prefixed or bare) or legacy input; throws `AddressError`. */
export declare function parseAddress(input: string, opts?: { network?: NetworkName }): AddressRecord;
/** Mainnet record with every representation derived. */
export declare function convertAddress(input: string): AddressRecord;

export declare const NETWORKS: Readonly<Record<NetworkName, NetworkConfig>>;
export declare const NETWORK_NAMES: readonly NetworkName[];
export declare function getNetwork(name?: NetworkName): NetworkConfig;

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

export interface TokenDetails {
  category: string;
  amount: bigint;
  nft?: {
    capability: 'none' | 'mutable' | 'minting';
    commitment: string;
  };
}

/** CashScript `Utxo`. */
export interface CashScriptUtxo {
  txid: string;
  vout: number;
  satoshis: bigint;
  token?: TokenDetails;
}

/** CashScript `NetworkProvider` backed by a cascan pool. */
export declare class CascanNetworkProvider {
  constructor(cascan: Cascan);
  readonly cascan: Cascan;
  readonly network: NetworkName;
  getUtxos(address: string): Promise<CashScriptUtxo[]>;
  getUtxosForLockingBytecode(lockingBytecode: string | Uint8Array): Promise<CashScriptUtxo[]>;
  getBlockHeight(): Promise<number>;
  /** Quorum-verified raw hex, hashed back to `txid`. */
  getRawTransaction(txid: string): Promise<string>;
  /** Resolves with the txid once two matching servers return the exact raw transaction. */
  sendRawTransaction(txHex: string): Promise<string>;
}

/** mainnet-js `Utxo`. */
export interface MainnetJsUtxo extends CashScriptUtxo {
  height: number;
  address: string;
}

/** mainnet-js `HeaderI`. */
export interface DecodedHeader {
  version: number;
  previousBlockHash: string;
  merkleRoot: string;
  timestamp: number;
  bits: number;
  nonce: number;
  height: number;
}

export interface HistoryEntry {
  tx_hash: string;
  height: number;
  fee?: number;
}

/** mainnet-js `NetworkProvider` backed by a cascan pool. */
export declare class CascanMainnetProvider {
  constructor(cascan: Cascan);
  readonly cascan: Cascan;
  readonly network: 'mainnet' | 'testnet';
  getUtxos(cashaddr: string): Promise<MainnetJsUtxo[]>;
  /** Confirmed + unconfirmed satoshis. */
  getBalance(cashaddr: string): Promise<bigint>;
  getHeader(height: number, verbose: true): Promise<DecodedHeader>;
  getHeader(height: number, verbose?: false): Promise<{ height: number; hex: string }>;
  getHeader(height: number, verbose?: boolean): Promise<DecodedHeader | { height: number; hex: string }>;
  getBlockHeight(): Promise<number>;
  /** Minimum relay fee in BCH/kB. */
  getRelayFee(): Promise<number>;
  getRawTransaction(txHash: string, verbose?: false, loadInputValues?: boolean): Promise<string>;
  getRawTransaction(txHash: string, verbose: true, loadInputValues?: boolean): Promise<VerboseTransaction>;
  getRawTransaction(txHash: string, verbose?: boolean, loadInputValues?: boolean): Promise<string | VerboseTransaction>;
  getRawTransactionObject(txHash: string, loadInputValues?: boolean): Promise<VerboseTransaction>;
  getRawTransactions(hashes: readonly string[]): Promise<Map<string, string>>;
  getHeaders(heights: readonly number[]): Promise<Map<number, DecodedHeader>>;
  /** Unverified fire-and-forget (`awaitPropagation: false`) is rejected. */
  sendRawTransaction(txHex: string, awaitPropagation?: true): Promise<string>;
  getHistory(cashaddr: string, fromHeight?: number, toHeight?: number): Promise<HistoryEntry[]>;
  waitForBlock(height?: number): Promise<{ height: number; hex: string | null }>;
  subscribeToAddress(cashaddr: string, callback: AddressCallback): Promise<() => Promise<void>>;
  subscribeToTransaction(txHash: string, callback: TransactionCallback): Promise<() => Promise<void>>;
  ready(timeout?: number): Promise<boolean>;
  connect(): Promise<void>;
  disconnect(): Promise<boolean>;
}
