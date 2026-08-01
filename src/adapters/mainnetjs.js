/**
 * src/adapters/mainnetjs.js
 *
 * Drop-in mainnet-js NetworkProvider backed by cascan's reliability layer.
 *
 *   import { Wallet } from 'mainnet-js';
 *   import { connect, CascanMainnetProvider } from 'cascan';
 *
 *   const provider = new CascanMainnetProvider(await connect());
 *   // pass wherever mainnet-js accepts a NetworkProvider
 *
 * Implements the interface from mainnet-js
 * packages/mainnet-js/src/network/NetworkProvider.ts (fetched 2026-07-29)
 * BY SHAPE — cascan never imports the mainnet-js package (zero-dependency
 * rule). Money is bigint end-to-end where the interface says bigint.
 *
 * Subscriptions (address + transaction) ride the pool, so they inherit the
 * failover + resurrection guarantees — which mainnet-js's own single-client
 * ElectrumNetworkProvider does not have.
 */

import { broadcastAndVerify, verifyFundingUtxos } from './verification.js';
import { parseAddress } from '../address.js';
import { isValidBchHeight, parseBchSatoshis } from '../validation.js';

/** mainnet-js Network enum values are 'mainnet' | 'testnet' | 'regtest'. */
function toMainnetJsNetwork(cascanNetwork) {
  return cascanNetwork === 'mainnet' ? 'mainnet' : 'testnet';
}

/** Decode an 80-byte block header hex → mainnet-js HeaderI (sans height). */
export function decodeHeader(hex, height) {
  const b = Buffer.from(hex, 'hex');
  if (b.length !== 80) throw new Error(`block header must be 80 bytes, got ${b.length}`);
  return {
    version: b.readUInt32LE(0),
    previousBlockHash: Buffer.from(b.subarray(4, 36)).reverse().toString('hex'),
    merkleRoot: Buffer.from(b.subarray(36, 68)).reverse().toString('hex'),
    timestamp: b.readUInt32LE(68),
    bits: b.readUInt32LE(72),
    nonce: b.readUInt32LE(76),
    height,
  };
}

/** Fulcrum listunspent entry → mainnet-js Utxo (bigint satoshis, address attached). */
export function toMainnetJsUtxo(u, cashaddr) {
  const utxo = {
    txid: u.tx_hash,
    vout: u.tx_pos,
    satoshis: BigInt(u.value),
    height: u.height ?? 0,
    address: cashaddr,
  };
  const td = u.token_data;
  if (td && typeof td === 'object') {
    utxo.token = {
      amount: BigInt(td.amount ?? 0),
      category: td.category,
      ...(td.nft && typeof td.nft === 'object' ? {
        nft: { capability: td.nft.capability ?? 'none', commitment: td.nft.commitment ?? '' },
      } : {}),
    };
  }
  return utxo;
}

/** Bounded-concurrency batch helper (shared shape with history command). */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }));
  return results;
}

export class CascanMainnetProvider {
  /** @param {import('../index.js').Cascan} cascan — from `connect()` */
  constructor(cascan) {
    if (!cascan?.pool) {
      throw new Error('CascanMainnetProvider requires a connected cascan instance: new CascanMainnetProvider(await connect())');
    }
    this.cascan = cascan;
    this.network = toMainnetJsNetwork(cascan.network);
  }

  async getUtxos(cashaddr) {
    // listunspent is an untrusted index response. Bind every returned outpoint
    // to the queried address's locking bytecode before exposing it for signing.
    const expected = parseAddress(cashaddr, { network: this.cascan.network ?? 'mainnet' });
    const utxos = await this.cascan.request('blockchain.address.listunspent', [cashaddr, 'include_tokens']);
    await verifyFundingUtxos(this.cascan, utxos ?? [], {
      lockingBytecode: Buffer.from(expected.lockingScript, 'hex'),
    });
    return utxos.map(u => toMainnetJsUtxo(u, cashaddr));
  }

  /** @returns {Promise<bigint>} confirmed + unconfirmed, satoshis */
  async getBalance(cashaddr) {
    const { value: bal } = await this.cascan.verify(
      'blockchain.address.get_balance',
      [cashaddr],
    );
    return parseBchSatoshis(bal?.confirmed, { field: 'confirmed' }) +
      parseBchSatoshis(bal?.unconfirmed, { allowNegative: true, field: 'unconfirmed' });
  }

  async getHeader(height, verbose = false) {
    const hex = await this.cascan.request('blockchain.block.header', [height]);
    return verbose ? decodeHeader(hex, height) : { height, hex };
  }

  async getBlockHeight() {
    return this.cascan.height();
  }

  /** @returns {Promise<number>} minimum relay fee in BCH/kB (upstream unit) */
  async getRelayFee() {
    return this.cascan.request('blockchain.relayfee');
  }

  /**
   * @param {string} txHash
   * @param {boolean} [verbose]
   * @param {boolean} [loadInputValues] — enrich each vin with value/address/
   *        tokenData from its parent output (requires verbose)
   */
  async getRawTransaction(txHash, verbose = false, loadInputValues = false) {
    const tx = await this.cascan.request('blockchain.transaction.get', [txHash, Boolean(verbose)]);
    if (!verbose || !loadInputValues) return tx;

    // Enrich vins from parent outputs — deduped parent fetches, bounded.
    const parents = new Map();
    for (const vin of tx.vin ?? []) {
      if (vin.txid && !parents.has(vin.txid)) parents.set(vin.txid, null);
    }
    const ids = [...parents.keys()];
    const fetched = await mapLimit(ids, 8,
      id => this.cascan.request('blockchain.transaction.get', [id, true]).catch(() => null));
    ids.forEach((id, i) => parents.set(id, fetched[i]));

    tx.vin = (tx.vin ?? []).map(vin => {
      const parentOut = parents.get(vin.txid)?.vout?.[vin.vout];
      return parentOut
        ? { ...vin, value: parentOut.value, ...(parentOut.scriptPubKey ? { scriptPubKey: parentOut.scriptPubKey } : {}), ...(parentOut.tokenData ? { tokenData: parentOut.tokenData } : {}) }
        : vin;
    });
    return tx;
  }

  async getRawTransactionObject(txHash, loadInputValues = false) {
    return this.getRawTransaction(txHash, true, loadInputValues);
  }

  /** @returns {Promise<Map<string, string>>} hash → raw hex */
  async getRawTransactions(hashes) {
    const out = new Map();
    const results = await mapLimit(hashes ?? [], 8,
      h => this.cascan.request('blockchain.transaction.get', [h, false]).catch(() => null));
    (hashes ?? []).forEach((h, i) => { if (results[i] != null) out.set(h, results[i]); });
    return out;
  }

  /** @returns {Promise<Map<number, object>>} height → decoded header */
  async getHeaders(heights) {
    const out = new Map();
    const results = await mapLimit(heights ?? [], 8,
      h => this.cascan.request('blockchain.block.header', [h]).catch(() => null));
    (heights ?? []).forEach((h, i) => { if (results[i] != null) out.set(h, decodeHeader(results[i], h)); });
    return out;
  }

  /**
   * Broadcast. By default, success requires independent retrieval of the
   * exact raw transaction from two matching servers.
   * @param {string} txHex
   * @param {boolean} [awaitPropagation=true] — unverified fire-and-forget
   *        broadcasting is rejected because it cannot provide safe success
   *        semantics.
   */
  async sendRawTransaction(txHex, awaitPropagation = true) {
    if (awaitPropagation === false) {
      throw new Error('awaitPropagation=false is unsafe and unsupported: broadcast success must be independently verified');
    }
    return broadcastAndVerify(this.cascan, txHex);
  }

  /** @returns {Promise<Array<{tx_hash: string, height: number, fee?: number}>>} */
  async getHistory(cashaddr, fromHeight, toHeight) {
    const hist = await this.cascan.request('blockchain.address.get_history', [cashaddr]) ?? [];
    return hist.filter(h =>
      (fromHeight == null || h.height >= fromHeight || h.height <= 0) &&
      (toHeight == null || h.height <= toHeight)
    );
  }

  /**
   * Wait for the next block (or a specific height). Rides the pool's header
   * subscription — and therefore survives failover while waiting.
   * @param {number} [height]
   * @returns {Promise<{height: number, hex: string|null}>}
   */
  async waitForBlock(height) {
    if (height != null && !isValidBchHeight(height)) {
      throw new RangeError('height must be a valid BCH block height');
    }
    const currentHeight = await this.cascan.height();
    if (height != null && currentHeight >= height) {
      return { height: currentHeight, hex: null };
    }
    return new Promise((resolve, reject) => {
      const target = height ?? currentHeight + 1;
      const onBlock = async () => {
        try {
          const verifiedHeight = await this.cascan.height();
          if (verifiedHeight < target) return;
          this.cascan.pool.removeListener('block', onBlock);
          resolve({ height: verifiedHeight, hex: null });
        } catch (err) {
          this.cascan.pool.removeListener('block', onBlock);
          reject(err);
        }
      };
      this.cascan.pool.on('block', onBlock);
    });
  }

  /** @returns {Promise<() => Promise<void>>} cancel function */
  async subscribeToAddress(cashaddr, callback) {
    await this.cascan.pool.subscribeAddress(cashaddr, callback);
    return async () => this.cascan.pool.unsubscribeAddress(cashaddr, callback);
  }

  /** @returns {Promise<() => Promise<void>>} cancel function */
  async subscribeToTransaction(txHash, callback) {
    await this.cascan.pool.subscribeTransaction(txHash, callback);
    return async () => this.cascan.pool.unsubscribeTransaction(txHash, callback);
  }

  async ready(_timeout) {
    await this.cascan.pool.acquire();
    return true;
  }

  async connect() {
    await this.cascan.pool.acquire();
  }

  async disconnect() {
    this.cascan.pool.close();
    return true;
  }
}
