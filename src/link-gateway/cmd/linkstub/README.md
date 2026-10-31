# linkstub: the link gateway's backends, stubbed

`linkstub` stands in for everything the link gateway calls in `MODE_LINK`, so that one gateway can be loaded past what a
staging stack's apiservers and database carry ([scripts/runner-link/gateway-limit.sh](../../../../scripts/runner-link/README.md#the-gateway-alone)).
It answers each call with the smallest answer its route gives that the gateway and a runner take as valid, a fixed delay
after the call arrived (`-delay`, 5 ms):

| Call | Who makes it | Answer |
| --- | --- | --- |
| `GET /api/runner/link-token/revocations` | the gateway, on `LINK_API_URL`, every 30 s | nothing revoked in the last 70 minutes |
| `GET /api/runner/link/mode` | the gateway, on `LINK_API_URL`, with `LINK_MODE=http` | `RUNNER_LINK_REQUIRED` on |
| `POST /api/runner/link/welcome` | the gateway, before each Welcome | each session asked about, in order: held, durable seq 0; no release |
| `POST /api/runner/heartbeat` | the gateway, for each heartbeat | the answer to a beat that reconciled nothing (`quietHeartbeatAnswer`), with empty link hints |
| `POST /api/runner/link/events` | the gateway, merged event calls | each batch stored through its last seq, none refused; `heldMs` 0 |
| `POST /api/runner/sessions/<id>/events` | the gateway, a batch alone | 202, stored through its last seq, none refused |
| any other `/api/runner/...` | the gateway, a tunnelled request | 200 `{}` |
| `POST /api/runner/link-token` | the loadgen | a link token for the runner its runner token names (below) |

Every call of the gateway must carry its `LINK_GATEWAY_TOKEN` (`-gateway-token-file`), as the apiserver requires; one
without is refused 401.

**Link tokens** are minted as the apiserver mints them (`signRunnerLinkToken`, runner-link-token.ts): a compact JWS,
EdDSA over Ed25519, with the key's RFC 7638 thumbprint as its `kid` and the same claims in the same order, valid for an
hour (`-token-ttl`). They are signed with `-key`, a PKCS #8 PEM key (`openssl genpkey -algorithm ed25519`), whose public
half the gateway is given in `LINK_PUBLIC_KEYS`. A runner token is `linkstub.<runnerId>.<ownerId>`: the stub reads the
runner and its owner from it and keeps nothing between calls, so it needs no database, and several stubs can run side by
side, one per backend address.

**What it says of itself**, at `GET /stub/stats` (and in `-stats-out` when it exits): its CPU time and peak memory, its
goroutines, the most calls it held at once, and for each route the calls it answered by status class, the bytes in and
out, and two histograms with their non-empty buckets: from a call's arrival to its answer being ready (its own work),
and to its answer written (what the gateway waited, the delay included). A stub that keeps up answers within its delay
and works well under it; `gateway-limit-report.mjs` checks both for every level.

```bash
linkstub serve -listen 127.0.0.1:62480 -key signing.pem -gateway-token-file gateway-token \
  -link-url wss://localhost:62443 -delay 5ms -stats-out stub-0.json
linkstub fleet -runners 65000 -seed 1 -out fleet.jsonl
```

**`linkstub fleet`** writes the loadgen's fleet file ([cmd/loadgen](../loadgen/README.md), `-fleet`) without a
database, in the shape `scripts/runner-link/loadgen-seed.sh` writes from the staging stack: runner, owner, session and
process ids drawn from `-seed`, the cell's planning numbers per owner (1.5 runners, 4 open sessions, 0.5 running) unless
`-sessions` and `-active` say otherwise. Sessions go to the runners in turn; the running ones are spread evenly, at most
one a runner, so any first N runners of the fleet, and every shard of them, carry their share.
