# CURRENT_WORK routing rollout and rollback

`intent` is additive. Omitted intent keeps the actual N-1 server-side auto-routing behaviour:
while a supported engine turn is live it may become a legacy steer, otherwise it queues as a
message. This remains true while the feature gate is off, so mixed new/N-1 API replicas do not
randomly disagree about the same old-client request. New Web uses the versioned mutation route,
requires response `placement`, and never infers delivery from local session state.

The write gate is `ORBIT_SESSION_CURRENT_WORK_ROUTING_ENABLED` (default `0`). At `0`, explicit
`CURRENT_WORK` and explicit `NEXT_TURN` return `503 SESSION_TURN_PROTOCOL_DISABLED` before writing;
legacy omission remains available. All API replicas must use the same value.

## Forward order

1. Upgrade runners first. Confirm live heartbeat capability snapshots contain
   `session-current-work-routing-v1` (and Codex also contains `session-codex-steer-v1`). An omitted
   capability header clears the stored snapshot; capabilities are rechecked on each inbox poll.
2. Apply migration `0210_session_current_work_routing`. Its new columns are additive. Table CHECKs
   and attachment/FK validation use the low-lock `NOT VALID` then `VALIDATE` pattern where
   PostgreSQL permits it.
3. Upgrade **every** API replica with the gate still `0`. Do not mix an old API into the pool after
   writes are enabled: it cannot merge startup fragments or preserve explicit NEXT_TURN.
4. Restart/reconfigure every API replica with the gate `1`, then verify placement responses and
   runner capability admission.
5. Deploy the new Web. A missing placement is a protocol error; there is no client-side fallback
   that guesses from `response.kind` or idle state.

CURRENT_WORK startup is accepted only for Claude and Codex runners that provide a durable
engine-read acknowledgement. Live CURRENT_WORK additionally carries its exact `targetTurnId`.
Claude fences that id against its active Orbit turn and replaces the provider generation if the
target result wins before replay ACK; Codex addresses the native `turn/steer` target. Unsupported
runtimes return a structured 409 and never create an ordinary queued message. Legacy Claude steer
rows (`send_intent IS NULL`) keep their pre-v1 dequeue behaviour.

## Rollback order

1. Set the gate to `0` on every API replica so no new explicit receipt can be accepted. Roll Web
   back so no client requires placement.
2. Keep routing-aware API and runner versions deployed while
   `scripts/session-current-work-rollback-check.sh` reports unsafe CURRENT_WORK steer receipts.
   Every historical steer must have either a durable engine-read ACK or a complete FAILED receipt.
   `UNCONFIRMED` (the runner vanished after lease/write but before durable ACK), `delivered_at`, row
   status and USER(enqueued/written) are not proof and continue to block rollback. A late strict
   engine-read ACK may resolve UNCONFIRMED to ACKNOWLEDGED; it never coexists with failure fields.
3. **Any startup fragment permanently blocks application rollback to N-1.** N-1 idempotency only
   knows `conversation_turn`; after a new API commits a fragment and loses its response, retrying
   the same key against N-1 would create an ordinary executable message (and may charge again).
   ACK/FAILED does not repair that cross-version fence. Keep the routing-aware API deployed once
   startup routing has been used; do not delete audit rows to force the gate green.
4. Migration 0210 may remain during an application rollback that the gate actually permits. A
   schema rollback is a separate maintenance operation after audit-retention requirements.

Failures live in the authored receipt (`conversation_turn` for steer,
`conversation_turn_startup_fragment` for startup). The server never allocates a synthetic
`run_event.seq`; that namespace remains runner-owned. The Web client merges a durable FAILED or
UNCONFIRMED receipt onto the matching USER(enqueued/written) bubble by `turnId`, preserving its
original transcript position; only a receipt with no USER at all is rendered as a tail fallback.
Thus reload/reseed converges to one “Not delivered” or “Delivery could not be confirmed” bubble
without an invented durable transcript event.
