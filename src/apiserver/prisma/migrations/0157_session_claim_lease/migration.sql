-- The claim lease: what makes a `PENDING -> RUNNING` handover something the server can take back.
--
-- WHAT WAS WRONG
-- --------------
-- `QueueService.trySessionClaim` commits `PENDING -> RUNNING` in one short transaction, and then
-- builds the payload the runner receives — `buildSession` — OUTSIDE it. That split is deliberate
-- and stays: the claim holds a global advisory lock, and resolving a provider, decrypting a
-- configured key and seeding the first turn have no business inside a critical section every
-- runner on the deployment queues behind.
--
-- But the commit is the whole of the transition. Once it lands, the row is RUNNING, it counts
-- against `runner.max_concurrent` — RUNNING is the runner-slot truth — and NOTHING in the database
-- records that the runner has not been told. Every statement between that commit and the runner
-- receiving the response can fail: the seed transaction, the provider row, the model
-- compare-and-set, the credential, the `runtime_session_id` write, or the response itself, which
-- can simply be lost. The row then holds a slot no process is using, and no sweep takes it back:
-- the reaper's liveness branch needs the RUNNER to be offline, and the runner is fine — it is the
-- handover that died.
--
-- Recovery today is entirely the CLIENT's: the runner reads its own error, calls
-- `sessions/reclaim`, and re-attaches anything RUNNING it does not know about. That works, and it
-- is not a gate. It needs a live, cooperating, current runner; and when the failure is
-- deterministic — a configured provider that cannot resolve — the reclaim resolves the same row
-- and fails the same way, at which point the runner stops itself and the machine goes dark over
-- one session.
--
-- WHAT THIS ADDS
-- --------------
-- Two nullable columns on `session`, and nothing else. No backfill, no default, no down migration
-- that drops them: an older API replica neither reads nor writes either one, so on the same
-- database it keeps claiming exactly as it does today.
--
--   `claim_token`            — the identity of ONE handover. Written with the `PENDING -> RUNNING`
--                              update, cleared when the runner activates its inbox generation.
--                              Non-null therefore means "claimed, not yet activated". It is what
--                              makes the compensation a compare-and-set instead of a status write:
--                              a claim may only be taken back by the claim that is still standing,
--                              so a cancel, a resume, a re-claim or an activation that landed in
--                              between all leave a row this token no longer matches.
--
--   `claim_lease_expires_at` — when an unactivated handover may be reclaimed by the watchdog, or
--                              NULL for one that may NEVER be. That NULL is the compatibility
--                              policy, stated in the row rather than remembered in a branch: the
--                              deadline is only written for a runner that advertised
--                              `session-claim-lease-v1`, i.e. one the control plane knows will
--                              activate. A runner that predates the capability gets a token (so
--                              the synchronous compensation still protects it — it happens before
--                              that runner is ever handed the job) and no deadline (so no sweep
--                              can pull a session out from under a turn it is really running).
--
-- Both are inert until the code that reads them ships, and both stay inert if it is rolled back:
-- the feature flag turns the writes off, and a token left on a row is read by nothing.
--
-- DEPLOYMENT ORDER — API server to completion, THEN runners.
-- ---------------------------------------------------------
-- A deadline is only armed when a runner advertises `session-claim-lease-v1`, and only a new
-- runner binary does. So no lease exists at all until runners are rolled, and every direction of
-- an API-server-only rollout is safe: an old replica writes neither column and claims as it always
-- has, and a new replica's sweep ignores a claim with no deadline.
--
-- The one window that is NOT safe is a new runner talking to a control plane that is still half
-- old: the new replica arms a deadline on the claim, and if that runner's `activate-leases` is
-- served by an OLD replica, the token is not retired and the sweep would eventually requeue a
-- session an engine is really driving. Rolling the server first closes it, and nothing else has
-- to be coordinated. (Today's reaper is single-replica by construction — see the note on
-- `ReaperService` — so this is a statement about the multi-replica future rather than about the
-- deployment that exists.)
--
-- ROLLING BACK — drain, then flip.
-- -------------------------------
-- `ORBIT_CLAIM_LEASE=off` returns the claim path to exactly what it was. Outstanding leases are
-- left inert rather than reclaimed, which is why the drain comes first: activation clears a token
-- unconditionally (it is not behind the flag), so letting the live claims activate leaves nothing
-- for a process that no longer maintains them to be responsible for. There is no down migration —
-- dropping either column would be destructive for no gain, since neither is read by the code the
-- rollback returns to.
ALTER TABLE "session"
  ADD COLUMN IF NOT EXISTS "claim_token" UUID,
  ADD COLUMN IF NOT EXISTS "claim_lease_expires_at" TIMESTAMP(3);

-- No index. Both readers already have the row: the compensation is by primary key inside the claim
-- that minted the token, and the watchdog checks the column on rows the reaper's existing sweep
-- has selected anyway. An index here would be a second thing to keep true for no query.

COMMENT ON COLUMN "session"."claim_token" IS
  'Identity of the PENDING->RUNNING handover in flight: set at claim, cleared at activation. Non-null means a runner was handed this session and has not confirmed it.';
COMMENT ON COLUMN "session"."claim_lease_expires_at" IS
  'When an unactivated claim may be reclaimed. NULL = never (the claiming runner cannot activate, so only the claim itself may take it back).';
