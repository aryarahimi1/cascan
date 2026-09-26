# BCH Fulcrum network status data

`status.json` is regenerated every 30 minutes by the
[`Network status`](https://github.com/aryarahimi1/cascan/actions/workflows/network-status.yml)
workflow, which probes every public server the Flowee DNS seed, cascan's
curated registry, and peer gossip advertise, using cascan's own discovery.
This branch is force-pushed as a single commit; it has no history.

Each server's `samples` string holds one state per run, oldest first,
covering the last 7 days:

| state | meaning |
|---|---|
| `A` | up; certificate-authenticated TLS; BCH checkpoints verified |
| `S` | up; self-signed TLS; BCH checkpoints verified |
| `C` | up; cleartext TCP only; BCH checkpoints verified |
| `W` | answered on the wrong chain (checkpoint mismatch) |
| `X` | answered but failed the protocol/verification handshake |
| `D` | unreachable (timeout, refused, reset) |
| `-` | not probed in that run |

Measurements come from GitHub-hosted runners, so they show what a
datacenter client sees rather than every user's network path.
