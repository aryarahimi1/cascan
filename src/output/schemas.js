/**
 * src/output/schemas.js
 *
 * Stable schema identifiers for every JSON / NDJSON document cascan emits.
 * Bump the trailing version (`/v1` -> `/v2`) only on breaking changes; new
 * optional fields are additive within a version.
 *
 * Lineage: ported from glnc's src/output/schemas.js, adapted for the
 * Fulcrum (Electrum protocol) data plane instead of EVM JSON-RPC.
 */

export const SCHEMA = Object.freeze({
  BALANCE:        'cascan.balance/v1',
  TX:             'cascan.tx/v1',
  // Raw upstream Fulcrum `blockchain.transaction.get` verbose response,
  // passed through the envelope without cascan-level reshaping. The
  // `data.raw` payload is the provider response shape and is therefore NOT
  // stable across server implementations. Callers that want a stable shape
  // should keep using cascan.tx/v1.
  TX_RAW:         'cascan.tx-raw/v1',
  GAS:            'cascan.gas/v1',
  // NDJSON payment/watch events: one envelope per status change.
  WATCH:          'cascan.watch/v1',
  // Offline address conversion/inspection (cascan addr).
  ADDR:           'cascan.addr/v1',
  // CashToken category metadata card (cascan tokens <category>).
  TOKENS:         'cascan.tokens/v1',
  // Fundraiser tracking (cascan campaign): one-shot doc or NDJSON stream.
  CAMPAIGN:       'cascan.campaign/v1',
  // Address history export (cascan history): rows + optional FIFO cost basis.
  HISTORY:        'cascan.history/v1',
  // Condition-DSL alerts (cascan alert): NDJSON evaluation events.
  ALERT:          'cascan.alert/v1',
  // Fleet health (cascan servers): discovered pool, scores, rejections.
  SERVERS:        'cascan.servers/v1',
});

export const ALL_SCHEMAS = Object.freeze(Object.values(SCHEMA));

/**
 * Aggregated Fulcrum quorum disagreement, surfaced on
 * `meta.sources.fulcrum.disagreements[]` whenever a command ran with
 * `--quorum=majority` and servers diverged. Empty under
 * `--quorum=any` since first-success-wins cannot produce a
 * disagreement record.
 *
 * `picked.server` always matches one of the entries in `servers[]` whose
 * `agreed: true` — it identifies the source whose value was returned.
 *
 * @typedef {{
 *   agreement: 'unanimous' | 'majority' | 'plurality' | 'single',
 *   servers: Array<{ server: string, value: any, agreed: boolean,
 *     operator?: string, infrastructure?: string, independent: boolean,
 *     duplicateOf?: string }>,
 *   picked: { server: string, value: any },
 * }} FulcrumDisagreement
 */

/**
 * Record emitted when --quorum=majority|all was requested but fewer servers
 * responded than the policy needs. Lets consumers detect silent downgrade
 * to single-server mode.
 *
 * @typedef {{
 *   requested: 'majority' | 'all',
 *   agreement: 'unanimous' | 'majority' | 'plurality' | 'single',
 *   fulfilledCount: number,
 *   totalCount: number,
 * }} FulcrumDegradation
 */

/**
 * @typedef {{
 *   sources?: {
 *     fulcrum?: {
 *       ok: boolean,
 *       answered?: string,
 *       answeredOperator?: string,
 *       agreement?: 'unanimous'|'majority'|'plurality'|'single'|null,
 *       agreementCount?: number,
 *       operators?: string[],
 *       voterCount?: number,
 *       height?: number,
 *       servers?: Array<{ server: string, status: 'ok'|'failed'|'not-tried',
 *         latencyMs?: number, error?: string, reason?: string,
 *         operator?: string, infrastructure?: string, independent?: boolean,
 *         duplicateOf?: string }>,
 *       disagreements?: FulcrumDisagreement[],
 *       degraded?: FulcrumDegradation[],
 *     },
 *     prices?: {
 *       ok: boolean,
 *       provider: 'coingecko',
 *       cacheAgeSec?: number,
 *       stale?: boolean,
 *       rateLimited?: boolean,
 *     },
 *   },
 *   partial?: boolean,
 *   warnings?: string[],
 * }} EnvelopeMeta
 */

/**
 * @typedef {{
 *   schema: string,
 *   ts: string,
 *   ok: boolean,
 *   data?: any,
 *   event?: string,
 *   error?: { code: string, message: string } | null,
 *   meta?: EnvelopeMeta,
 * }} Envelope
 */
