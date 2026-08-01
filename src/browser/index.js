import { decodeCashAddr } from '../cashaddr.js';
import { getNetwork } from '../networks.js';
import { consensusHeight, scoreServer } from '../pool/health.js';
import { BrowserFulcrumClient, BrowserFulcrumError } from './client.js';
import {
  BrowserServerPool,
  MAX_BROWSER_SERVERS,
  MAX_BROWSER_SUBSCRIPTIONS,
  MAX_REASONABLE_BCH_HEIGHT,
} from './pool.js';

const MAX_SERVER_URL_LENGTH = 2_048;
const MAX_BCH_SATS = 2_100_000_000_000_000n;

/**
 * Browsers cannot resolve Electrum DNS seeds or open raw TCP/TLS sockets.
 * These WSS entry points let browser consumers bootstrap automatically;
 * every endpoint is still checkpoint-verified before use.
 */
export const BROWSER_BOOTSTRAP_SERVERS = Object.freeze({
  mainnet: Object.freeze([
    'wss://electrum.imaginary.cash:50004/',
    'wss://bch.loping.net:50004/',
  ]),
  chipnet: Object.freeze([
    'wss://chipnet.imaginary.cash:50004/',
    'wss://cbch.loping.net:62104/',
  ]),
  testnet4: Object.freeze([]),
});

export class BrowserCascan {
  constructor(pool, opts = {}) {
    this.pool = pool;
    this.network = getNetwork(opts.network ?? 'mainnet');
  }

  on(event, callback) {
    this.pool.on(event, callback);
    return this;
  }

  off(event, callback) {
    this.pool.off(event, callback);
    return this;
  }

  request(method, params = []) {
    return this.pool.request(method, params);
  }

  async height() {
    const tip = await this.pool.request('blockchain.headers.subscribe');
    if (
      !Number.isSafeInteger(tip?.height)
      || tip.height < 0
      || tip.height > MAX_REASONABLE_BCH_HEIGHT
    ) {
      throw new BrowserFulcrumError('server returned an invalid BCH height', {
        server: this.pool.current,
        method: 'blockchain.headers.subscribe',
        kind: 'application',
      });
    }
    return tip.height;
  }

  async balance(address) {
    const cashaddr = browserCashaddr(address, this.network);
    const value = await this.pool.request('blockchain.address.get_balance', [cashaddr]);
    const confirmed = sats(value?.confirmed, 'confirmed');
    const unconfirmed = sats(value?.unconfirmed, 'unconfirmed');
    if (
      confirmed < 0n
      || confirmed > MAX_BCH_SATS
      || unconfirmed < -MAX_BCH_SATS
      || unconfirmed > MAX_BCH_SATS
    ) {
      throw new BrowserFulcrumError('server returned an impossible BCH balance', {
        server: this.pool.current,
        method: 'blockchain.address.get_balance',
        kind: 'application',
      });
    }
    return {
      address: cashaddr,
      confirmedSats: confirmed.toString(),
      unconfirmedSats: unconfirmed.toString(),
      totalSats: (confirmed + unconfirmed).toString(),
    };
  }

  async watch(address, callback) {
    const cashaddr = browserCashaddr(address, this.network);
    await this.pool.subscribeAddress(cashaddr, callback);
    return () => this.pool.unsubscribeAddress(cashaddr, callback);
  }

  servers() {
    const ranked = this.pool.ranked();
    const maxHeight = consensusHeight(ranked);
    return ranked.map(server => ({
      url: server.url,
      connected: this.pool.current === server.url,
      height: server.health.height,
      latencyMs: server.health.latencyEmaMs,
      failures: server.health.failures,
      score: Math.round(scoreServer(server, maxHeight) * 10) / 10,
    }));
  }

  killCurrent(reason) {
    return this.pool.killCurrent(reason);
  }

  close() {
    this.pool.close();
  }
}

/**
 * Connect from a browser to a checkpoint-verified pool of WSS Fulcrum
 * servers. A caller may override the built-in bootstrap pool.
 */
export async function connect(opts = {}) {
  const network = getNetwork(opts.network ?? 'mainnet');
  const servers = opts.servers === undefined
    ? browserBootstrapServers(network.name)
    : normalizeBrowserServers(opts.servers);
  const timeoutMs = boundedMs(opts.timeoutMs, 10_000, 500, 120_000, 'timeoutMs');
  const keepaliveMs = boundedMs(opts.keepaliveMs, 45_000, 5_000, 300_000, 'keepaliveMs');
  const pool = new BrowserServerPool(servers, {
    network: network.name,
    timeoutMs,
    keepaliveMs,
    subscriptionCheckMs: opts.subscriptionCheckMs,
    subscriptionCheckBatchSize: opts.subscriptionCheckBatchSize,
    handlerRetryBaseMs: opts.handlerRetryBaseMs,
    handlerRetryMaxMs: opts.handlerRetryMaxMs,
    handlerTimeoutMs: opts.handlerTimeoutMs,
  });
  const cascan = new BrowserCascan(pool, { network: network.name });
  await pool.acquire();
  return cascan;
}

export function browserBootstrapServers(network = 'mainnet') {
  const name = getNetwork(network).name;
  const urls = BROWSER_BOOTSTRAP_SERVERS[name];
  if (!urls?.length) {
    throw new TypeError(
      `no built-in browser WSS bootstrap servers for ${name}; supply a non-empty servers array`,
    );
  }
  return normalizeServerList(urls, 'bootstrap');
}

export function normalizeBrowserServers(servers) {
  return normalizeServerList(servers, 'user');
}

function normalizeServerList(servers, source) {
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new TypeError('browser connect() requires a non-empty servers array of wss:// URLs');
  }
  if (servers.length > MAX_BROWSER_SERVERS) {
    throw new RangeError(`browser Fulcrum pool is limited to ${MAX_BROWSER_SERVERS} servers`);
  }

  const normalized = [];
  const seen = new Set();
  for (const item of servers) {
    const value = typeof item === 'string' ? item : item?.url;
    if (typeof value !== 'string' || value.length > MAX_SERVER_URL_LENGTH) {
      throw new TypeError(`browser Fulcrum server URLs must be at most ${MAX_SERVER_URL_LENGTH} characters`);
    }
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new TypeError('each browser Fulcrum server must be an absolute wss:// URL');
    }
    if (url.protocol !== 'wss:') throw new TypeError('browser Fulcrum servers must use wss://');
    if (url.username || url.password || url.hash) {
      throw new TypeError('browser Fulcrum server URLs must not contain credentials or fragments');
    }
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    normalized.push({ url: url.href, source });
  }
  if (normalized.length === 0) throw new TypeError('at least one unique browser Fulcrum server is required');
  return normalized;
}

function browserCashaddr(address, network) {
  if (typeof address !== 'string' || address.length > 256) {
    throw new TypeError('address must be a CashAddr string');
  }
  const decoded = decodeCashAddr(address.trim(), { defaultPrefix: network.cashaddrPrefix });
  if (!decoded) throw new TypeError(`invalid ${network.name} CashAddr`);
  if (decoded.prefix !== network.cashaddrPrefix) {
    throw new TypeError(`CashAddr belongs to ${decoded.prefix}, not ${network.name}`);
  }
  return decoded.cashaddr;
}

function sats(value, field) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d{1,32}$/.test(value)) return BigInt(value);
  throw new BrowserFulcrumError(`server returned invalid ${field} satoshis`, {
    method: 'blockchain.address.get_balance',
    kind: 'application',
  });
}

function boundedMs(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export {
  BrowserFulcrumClient,
  BrowserFulcrumError,
  BrowserServerPool,
  MAX_BROWSER_SERVERS,
  MAX_BROWSER_SUBSCRIPTIONS,
  MAX_REASONABLE_BCH_HEIGHT,
};
