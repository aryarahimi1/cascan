/**
 * src/commands/servers.js
 *
 * cascan servers — fleet health for the public Fulcrum network. Who's up,
 * at what height, at what latency, over which transport — and who was
 * REJECTED (wrong chain, unreachable, protocol failure) and why.
 *
 * This view exists nowhere else today: the DNS seed gives addresses, but
 * nothing shows operators or integrators the live state of the fleet.
 * It doubles as the library's demo — the same discovery + scoring that
 * `connect()` runs is simply printed instead of consumed.
 *
 * Always probes live (a fleet-health check served from cache would be
 * theater) and refreshes ~/.cascan/servers.json as a side effect, so the
 * next pooled command starts warm.
 */

import { discoverServers } from '../pool/discovery.js';
import { saveServerCache } from '../pool/cache.js';
import { consensusHeight, rankServers, scoreServer } from '../pool/health.js';
import { SCHEMA } from '../output/schemas.js';
import { wrap } from '../output/envelope.js';
import { sanitize } from '../cli/render.js';
import { bold, dim, gray, green, red, yellow, cyan } from '../cli/theme.js';

export async function cmdServers(parsed) {
  const chatter = (m) => { if (!parsed.json) process.stderr.write(gray(`  ${m}\n`)); };
  chatter(`probing the ${parsed.network} fleet (DNS seed + gossip + curated) — ~10s`);

  const d = await discoverServers({ onLog: (m) => chatter(m), network: parsed.network });
  if (d.servers.length > 0) await saveServerCache(d.servers, { network: parsed.network, meta: d.meta });

  const ranked = rankServers(d.servers);
  const maxHeight = consensusHeight(ranked);

  const rows = ranked.map(s => ({
    host: s.host,
    ports: s.ports,
    source: s.source,
    transport: s.transport,
    tlsStrict: s.tlsStrict === true,
    software: s.software,
    protocol: s.protocol,
    height: s.health.height,
    lag: maxHeight != null && s.health.height != null ? maxHeight - s.health.height : null,
    latencyMs: s.health.latencyEmaMs,
    score: Math.round(scoreServer(s, maxHeight) * 10) / 10,
    aliases: s.aliases ?? [],
  }));

  const data = {
    fleet: rows,
    rejected: d.rejected,
    consensusHeight: maxHeight,
    counts: { verified: rows.length, rejected: d.rejected.length, ...d.meta.sources },
  };

  const meta = {
    sources: {
      discovery: {
        ok: rows.length > 0,
        seed: 'ec-seed.flowee.cash',
        seedIps: d.meta.seedIps,
        candidates: d.meta.candidates,
        note: 'verified = speaks Electrum protocol AND matches BCH fork checkpoints (478559 BTC-split, 556767 BSV-split)',
      },
    },
    partial: rows.length === 0,
    warnings: rows.length === 0 ? ['discovery found no live servers — curated fallback would be used for queries'] : [],
  };

  // Human table — pad plain text first, colorize the padded cell after,
  // so ANSI escape bytes never break column alignment.
  const cell = (s, w, color = null) => {
    const padded = String(s ?? '—').padEnd(w);
    return color ? color(padded) : padded;
  };
  const lines = [];
  lines.push('');
  lines.push(`  ${bold('FULCRUM FLEET')} ${dim(`(${parsed.network}) — ${rows.length} verified, ${d.rejected.length} rejected, consensus height ${maxHeight ?? '?'}`)}`);
  lines.push('');
  lines.push(gray(`  ${cell('SERVER', 34)}${cell('SRC', 9)}${cell('TLS', 11)}${cell('SOFTWARE', 16)}${cell('HEIGHT', 9)}${cell('MS', 6)}SCORE`));
  for (const r of rows) {
    const tlsLabel = r.transport === 'tcp' ? 'cleartext' : (r.tlsStrict ? 'verified' : 'unverif.');
    const tlsColor = r.transport === 'tcp' || !r.tlsStrict ? yellow : green;
    const sw = sanitize(String(r.software ?? '—')).slice(0, 15);
    lines.push(
      `  ${cell(sanitize(r.host).slice(0, 33), 34)}${cell(r.source, 9)}` +
      cell(tlsLabel, 11, tlsColor) + cell(sw, 16) +
      cell(r.height, 9, r.lag > 0 ? red : null) +
      cell(r.latencyMs, 6) + cyan(r.score)
    );
  }
  if (d.rejected.length > 0) {
    lines.push('');
    lines.push(gray(`  rejected (${d.rejected.length}):`));
    for (const rej of d.rejected) {
      lines.push(red(`  ✗ ${sanitize(rej.host)}`) + gray(` — ${sanitize(rej.reason)}`));
    }
  }
  lines.push('');
  lines.push(gray(`  sources: ${Object.entries(d.meta.sources).map(([k, v]) => `${v} ${k}`).join(' · ')} — pool cached for 24h (~/.cascan/servers.json)`));

  return { envelope: wrap(SCHEMA.SERVERS, data, meta), human: lines.join('\n'), meta };
}
