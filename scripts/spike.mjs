/**
 * scripts/spike.mjs
 *
 * Probe the public Fulcrum landscape and record transport capabilities.
 * Throwaway-grade diagnostics, kept in-repo so results are reproducible.
 *
 * Probes per server: SSL 50002, TCP 50001, WS 50003, WSS 50004.
 * On the first healthy SSL server: protocol version, address-method support
 * (legacy + cashaddr cross-check on the genesis address), CashTokens param
 * variants, address subscription, fee methods.
 *
 *   node scripts/spike.mjs
 */

import { DEFAULT_FULCRUM_SERVERS } from '../src/fulcrum/servers.js';
import { FulcrumClient } from '../src/fulcrum/client.js';
import { parseAddress } from '../src/address.js';

const GENESIS_LEGACY = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const TIMEOUT = 8_000;

const findings = {
  ts: new Date().toISOString(),
  servers: {},
  capabilities: {},
};

function probeWs(url, timeoutMs = TIMEOUT) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (res) => { if (!settled) { settled = true; clearTimeout(timer); resolve(res); } };
    const timer = setTimeout(() => { try { ws.close(); } catch {} done({ ok: false, error: 'timeout' }); }, timeoutMs);
    let ws;
    try { ws = new WebSocket(url); } catch (e) { return done({ ok: false, error: e.message }); }
    ws.onopen = () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server.version', params: ['cascan-spike/0.1', ['1.4', '1.6']] }));
    };
    ws.onmessage = (m) => {
      try {
        const msg = JSON.parse(m.data);
        if (msg.id === 1) { try { ws.close(); } catch {} done({ ok: true, version: msg.result ?? msg.error }); }
      } catch { /* keep waiting */ }
    };
    ws.onerror = (e) => done({ ok: false, error: e.message ?? 'ws error' });
    ws.onclose = (e) => done({ ok: false, error: `closed (${e.code})` });
  });
}

async function probeServer(entry) {
  const name = entry.host;
  const rec = {};

  // SSL
  const started = Date.now();
  try {
    const c = new FulcrumClient({ host: name, port: entry.ports.ssl, tls: true, timeoutMs: TIMEOUT });
    await c.connect();
    rec.ssl = { ok: true, latencyMs: Date.now() - started, version: c.serverVersion };
    findings._firstOk ??= { name };
    c.close();
  } catch (e) {
    rec.ssl = { ok: false, error: e.message };
  }

  // TCP
  try {
    const c = new FulcrumClient({ host: name, port: entry.ports.tcp, tls: false, timeoutMs: TIMEOUT });
    await c.connect();
    rec.tcp = { ok: true };
    c.close();
  } catch (e) {
    rec.tcp = { ok: false, error: e.message };
  }

  // WS / WSS (the no-backend dapp question)
  rec.ws = await probeWs(`ws://${name}:${entry.ports.ws}`);
  rec.wss = await probeWs(`wss://${name}:${entry.ports.wss}`);

  findings.servers[name] = rec;
  console.log(
    `${rec.ssl.ok ? '✓' : '✗'} ${name}  ssl=${rec.ssl.ok ? rec.ssl.latencyMs + 'ms' : 'FAIL'}  tcp=${rec.tcp.ok ? 'ok' : 'FAIL'}  ws=${rec.ws.ok ? 'ok' : 'FAIL'}  wss=${rec.wss.ok ? 'ok' : 'FAIL'}`
  );
}

async function capabilityProbes() {
  const first = findings._firstOk;
  if (!first) {
    console.log('\nNo healthy SSL server — capability probes skipped.');
    return;
  }
  // The idle-timeout finding: the originally-probed connection got dropped
  // by the server while other hosts were being probed. Reconnect fresh.
  const { name } = first;
  const entry = DEFAULT_FULCRUM_SERVERS.find(e => e.host === name);
  const client = new FulcrumClient({ host: name, port: entry.ports.ssl, tls: true, timeoutMs: TIMEOUT });
  await client.connect();
  const caps = findings.capabilities;
  console.log(`\nCapability probes against ${name} (${JSON.stringify(client.serverVersion)}):`);

  const rec = parseAddress(GENESIS_LEGACY);

  // 1) Tip
  try {
    caps.tip = await client.tip();
    console.log(`  ✓ headers.subscribe → height ${caps.tip.height}`);
  } catch (e) { console.log(`  ✗ headers.subscribe: ${e.message}`); }

  // 2) Balance via legacy vs cashaddr — live codec cross-validation
  try {
    const viaLegacy = await client.request('blockchain.address.get_balance', [rec.legacy]);
    const viaCashaddr = await client.request('blockchain.address.get_balance', [rec.cashaddr]);
    caps.balanceViaLegacy = viaLegacy;
    caps.balanceViaCashaddr = viaCashaddr;
    const equal = JSON.stringify(viaLegacy) === JSON.stringify(viaCashaddr);
    console.log(`  ${equal ? '✓' : '✗'} get_balance legacy == cashaddr: ${JSON.stringify(viaLegacy)}`);
  } catch (e) { console.log(`  ✗ get_balance: ${e.message}`); }

  // 3) CashTokens param variants — THE load-bearing question
  for (const variant of [
    ['get_balance(addr, true)', 'blockchain.address.get_balance', [rec.cashaddr, true]],
    ['get_history(addr, true)', 'blockchain.address.get_history', [rec.cashaddr, true]],
  ]) {
    try {
      const r = await client.request(variant[1], variant[2]);
      caps[variant[0]] = { ok: true, sample: JSON.stringify(r).slice(0, 400) };
      console.log(`  ✓ ${variant[0]} → ${JSON.stringify(r).slice(0, 160)}`);
    } catch (e) {
      caps[variant[0]] = { ok: false, error: e.message };
      console.log(`  ✗ ${variant[0]}: ${e.message}`);
    }
  }

  // 4) Address subscription — THE payments primitive
  try {
    const status = await client.request('blockchain.address.subscribe', [rec.cashaddr]);
    caps.subscription = { ok: true, initialStatus: status };
    console.log(`  ✓ address.subscribe registered, initial status: ${status?.slice(0, 32) ?? status}…`);
  } catch (e) {
    caps.subscription = { ok: false, error: e.message };
    console.log(`  ✗ address.subscribe: ${e.message}`);
  }

  // 5) Fees + mempool
  try {
    caps.fees = {
      estimate1: await client.request('blockchain.estimatefee', [1]),
      relay: await client.request('blockchain.relayfee'),
      histogram: (await client.request('blockchain.mempool.get_fee_histogram')).slice(0, 5),
    };
    console.log(`  ✓ estimatefee(1)=${caps.fees.estimate1} relayfee=${caps.fees.relay} histogram bins≥${caps.fees.histogram.length}`);
  } catch (e) { console.log(`  ✗ fee probes: ${e.message}`); }

  client.close();
}

console.log('cascan network probe — checking public Fulcrum servers\n');
for (const entry of DEFAULT_FULCRUM_SERVERS) {
  await probeServer(entry);
}
await capabilityProbes();

delete findings._firstOk;
const out = `spike-results.${Date.now()}.json`;
const { writeFileSync } = await import('node:fs');
writeFileSync(out, JSON.stringify(findings, null, 2));
console.log(`\nFindings written to ${out}`);
