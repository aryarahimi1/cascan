import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRawTransaction, txidFromHex } from '../src/transaction/raw.js';
import { verifyFundingUtxos } from '../src/adapters/verification.js';
import { rawTransaction, outpointForRaw } from './helpers.js';

const SCRIPT = Buffer.from('76a914' + '11'.repeat(20) + '88ac', 'hex');
const CATEGORY = '0123456789abcdef'.repeat(4);

test('raw tx: decodes exact output values, scripts, and CashToken prefixes', () => {
  const raw = rawTransaction([
    { value: 546n, lockingBytecode: SCRIPT },
    {
      value: 800n,
      lockingBytecode: SCRIPT,
      token: {
        category: CATEGORY,
        amount: 253n,
        nft: { capability: 'minting', commitment: 'beef' },
      },
    },
  ]);
  const tx = parseRawTransaction(raw);
  assert.equal(tx.outputs[0].valueSatoshis, 546n);
  assert.equal(tx.outputs[0].token, null);
  assert.equal(tx.outputs[1].lockingBytecode.toString('hex'), SCRIPT.toString('hex'));
  assert.deepEqual(tx.outputs[1].token, {
    category: CATEGORY,
    amount: 253n,
    nft: { capability: 'minting', commitment: 'beef' },
  });
});

test('signing guard: omitted token_data is rejected before a UTXO reaches a wallet', async () => {
  const raw = rawTransaction([{
    value: 800n,
    lockingBytecode: SCRIPT,
    token: { category: CATEGORY, amount: 7n },
  }]);
  const txid = txidFromHex(raw);
  const cascan = {
    verify: async (_method, [requested], opts) => {
      assert.equal(requested, txid);
      assert.equal(opts.minAgreement, 2);
      return { value: raw };
    },
  };
  const liedAbout = [outpointForRaw(raw, 0, 800n)];
  await assert.rejects(
    () => verifyFundingUtxos(cascan, liedAbout),
    /CashToken data mismatch/
  );
});

test('signing guard: independently verified matching token UTXO is accepted', async () => {
  const tokenData = { category: CATEGORY, amount: '7' };
  const raw = rawTransaction([{
    value: 800n,
    lockingBytecode: SCRIPT,
    token: { category: CATEGORY, amount: 7n },
  }]);
  const utxos = [outpointForRaw(raw, 0, 800n, tokenData)];
  const cascan = { verify: async () => ({ value: raw }) };
  assert.equal(await verifyFundingUtxos(cascan, utxos, { lockingBytecode: SCRIPT }), utxos);
});
