# Security policy

cascan is pre-release software that can influence blockchain reads and wallet
provider behavior. Treat suspected integrity failures, unsafe transaction or
UTXO handling, server-validation bypasses, subscription gaps, webhook SSRF,
and package-distribution compromise as security issues.

## Supported versions

No version is currently designated production-stable. Security fixes are made
on the latest development branch and will be documented with each release.

## Reporting a vulnerability

Do not open a public issue containing exploit details. Use GitHub's private
security-advisory form:

https://github.com/aryarahimi1/cascan/security/advisories/new

Include the affected API and version or commit, attacker-controlled input,
reproduction steps, observed impact, and any suggested mitigation. Remove
private keys, seed phrases, access tokens, personal addresses, and other
sensitive data from the report.

The initial target is acknowledgement within 72 hours and a severity/next-step
assessment within seven days. These are response targets, not a bug-bounty or
payment commitment.

## Security boundary

Browser mode provides checkpoint-verified server selection, automatic
failover, hostile-data validation, and subscription restoration. It does not
perform browser quorum or SPV and must not be the sole authorization source for
money movement. Node's strict quorum reduces single-server trust but is not a
Merkle-proof or independent proof that an output remains unspent. The complete
contract and residual risks are documented in `docs/dapp-security.md`.
