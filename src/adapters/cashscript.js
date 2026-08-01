/**
 * src/adapters/cashscript.js
 *
 * Drop-in CashScript NetworkProvider backed by cascan's reliability layer.
 * One-line swap:
 *
 *   // before — one hardcoded server; when it dies, your app dies:
 *   const provider = new ElectrumNetworkProvider('mainnet');
 *
 *   // after — discovered pool, health scoring, transparent failover:
 *   import { connect, CascanNetworkProvider } from '@aryarh/cascan';
 *   const provider = new CascanNetworkProvider(await connect());
 *
 * Implements the standardized interface from
 * https://cashscript.org/docs/sdk/network-provider (cashscript ≥ 0.10) BY
 * SHAPE — cascan never imports the cashscript package (zero-dependency
 * rule), so this class works with any cashscript version that honors the
 * documented duck-typed contract:
 *
 *   network                              — 'mainnet' (cascan is mainnet-only)
 *   getUtxos(address)                    — Utxo[] with bigint satoshis + token
 *   getUtxosForLockingBytecode(bytecode) — same, via Electrum scripthash
 *   getBlockHeight()
 *   getRawTransaction(txid)              — hex string
 *   sendRawTransaction(txHex)            — txid
 *
 * Addresses are passed to Fulcrum VERBATIM (blockchain.address.*): contract
 * addresses are p2sh32 and often token-aware cashaddrs, which Fulcrum
 * resolves natively — no local parsing that could reject them.
 *
 * Broadcast errors carry the error NAMES CashScript documents for custom
 * providers (NetworkProviderMissingInputsError etc.). They are name-matched,
 * not instanceof-matched, on the cashscript side per its provider docs.
 */

import { parseAddress, scriptToScripthash } from '../address.js';
import { txidFromHex } from '../transaction/raw.js';
import {
  broadcastAndVerify,
  independentlyVerifiedRaw,
  verifyFundingUtxos,
} from './verification.js';

export { txidFromHex };

/** Fulcrum/bitcoind broadcast failure → documented CashScript error name. */
const BROADCAST_ERROR_NAMES = [
  [/missing.inputs|missingorspent|bad-txns-inputs/i, 'NetworkProviderMissingInputsError'],
  [/mempool.conflict|txn-mempool-conflict/i, 'NetworkProviderMempoolConflictError'],
  [/already.in.(the.)?mempool|already known|already.in.block.?chain|ALREADY_EXISTS/i, 'NetworkProviderTransactionAlreadySubmittedError'],
  [/non-final|was not final/i, 'NetworkProviderAbsoluteTimelockError'],
  [/non-BIP68-final|sequence.lock/i, 'NetworkProviderRelativeTimelockError'],
];

function classifyBroadcastError(err) {
  const msg = String(err?.message ?? err);
  for (const [re, name] of BROADCAST_ERROR_NAMES) {
    if (re.test(msg)) {
      const e = new Error(msg);
      e.name = name;
      e.cause = err;
      return e;
    }
  }
  const e = new Error(msg);
  e.name = 'NetworkProviderError';
  e.cause = err;
  return e;
}

/** Fulcrum listunspent entry → CashScript Utxo (bigint money, per contract). */
export function toCashScriptUtxo(u) {
  const utxo = {
    txid: u.tx_hash,
    vout: u.tx_pos,
    satoshis: BigInt(u.value),
  };
  const td = u.token_data;
  if (td && typeof td === 'object') {
    utxo.token = {
      amount: BigInt(td.amount ?? 0),
      category: td.category,
      ...(td.nft && typeof td.nft === 'object' ? {
        nft: {
          capability: td.nft.capability ?? 'none',
          commitment: td.nft.commitment ?? '',
        },
      } : {}),
    };
  }
  return utxo;
}

export class CascanNetworkProvider {
  /**
   * @param {import('../index.js').Cascan} cascan — a connected instance
   *        from `connect()`; the provider rides its pool (discovery,
   *        health scoring, failover) and its lifecycle (`cascan.close()`).
   */
  constructor(cascan) {
    if (!cascan?.pool) {
      throw new Error('CascanNetworkProvider requires a connected cascan instance: new CascanNetworkProvider(await connect())');
    }
    this.cascan = cascan;
    // Mirrors the connect() network — 'mainnet', 'chipnet', and 'testnet4'
    // are all valid CashScript Network values, so contract development on
    // chipnet works with the same one-line swap.
    this.network = cascan.network ?? 'mainnet';
  }

  /**
   * @param {string} address — any cashaddr (p2pkh, p2sh20/32, token-aware)
   * @returns {Promise<Array>} CashScript Utxo[] (satoshis/amounts as BigInt)
   */
  async getUtxos(address) {
    // listunspent is an untrusted index response. Bind every returned outpoint
    // to the queried address's locking bytecode before exposing it for signing.
    // Keep the caller's CashAddr verbatim for Fulcrum so token-aware/P2SH32
    // address forms retain their semantics on the wire.
    const expected = parseAddress(address, { network: this.network });
    const utxos = await this.cascan.request('blockchain.address.listunspent', [address, 'include_tokens']);
    await verifyFundingUtxos(this.cascan, utxos ?? [], {
      lockingBytecode: Buffer.from(expected.lockingScript, 'hex'),
    });
    return utxos.map(toCashScriptUtxo);
  }

  /**
   * @param {Uint8Array|string} lockingBytecode — raw bytes or hex
   * @returns {Promise<Array>} CashScript Utxo[]
   */
  async getUtxosForLockingBytecode(lockingBytecode) {
    const script = typeof lockingBytecode === 'string'
      ? Buffer.from(lockingBytecode, 'hex')
      : Buffer.from(lockingBytecode);
    const scripthash = scriptToScripthash(script);
    const utxos = await this.cascan.request('blockchain.scripthash.listunspent', [scripthash, 'include_tokens']);
    await verifyFundingUtxos(this.cascan, utxos ?? [], { lockingBytecode: script });
    return utxos.map(toCashScriptUtxo);
  }

  /** @returns {Promise<number>} */
  async getBlockHeight() {
    return this.cascan.height();
  }

  /**
   * @param {string} txid
   * @returns {Promise<string>} raw transaction hex
   */
  async getRawTransaction(txid) {
    return independentlyVerifiedRaw(this.cascan, txid);
  }

  /**
   * @param {string} txHex
   * @returns {Promise<string>} txid
   *
   * A server response alone is not propagation evidence. Success (including
   * "already in mempool") is returned only after two matching servers can
   * retrieve the exact raw transaction.
   */
  async sendRawTransaction(txHex) {
    try {
      return await broadcastAndVerify(this.cascan, txHex);
    } catch (err) {
      throw classifyBroadcastError(err);
    }
  }
}
