# Every signed-in account gets its managed runner (design, 2026-11-16)

Status: proposed, waiting for the owner's decisions D1–D4. Design only: no product code is changed.
It amends [managed-runner-design.md](managed-runner-design.md) ("Default disabled gate" and the sign-in hook record)
and [managed-runner-existing-account-entry-design.md](managed-runner-existing-account-entry-design.md) (D3).

## The ask

With `ORBIT_MANAGED_RUNNERS_ENABLED=true`, an account that is signed in and has no managed runner should get one
without anybody pressing anything. Today it does not, unless it signs in again after the switch went on.

## Today

A mapping (the managed runner, its runner row and its default workspace) is created in two places only:

| Entry point | Code | Who reaches it |
| --- | --- | --- |
| A sign-in | `AuthService.completeLogin` → `ManagedRunnerService.signedIn` (`managed-runner.service.ts`) | Password login, first-user bootstrap, Google ticket exchange |
| An explicit ensure | `POST /managed-runner/ensure` (session only, `@PatForbidden RUNNER_CONTROL`) | The Set up entry on Web, iPhone, Mac and Android (11-14 design) |

The design deliberately excludes everything else: "Refresh, logout, password change, and capability reads … Still no
implicit allocation" (managed-runner-design.md, "Default disabled gate"), and `GET /managed-runner` "allocates nothing".

The refresh token is sliding (`REFRESH_TTL_MS`, 30 days, renewed on every rotation), so an account that keeps using
Orbit is never asked to sign in again. Turning the switch on under a running deployment therefore reaches nobody who
is already signed in. That deployment case was not considered: the 10-17 decision was about new installs, where
every user signs in after the switch is on.

Production on 2026-11-16 (read-only queries on 10.66.0.4):

- the switch has been on since about 2026-11-15 23:30Z (the first and only mapping was created at 23:34:47Z);
- 12 accounts, none disabled, 1 mapping;
- 6 accounts have a live login session (an unrevoked, unexpired refresh token) and no mapping; 5 of them were active
  in the last 7 days. One of them last signed in on 11-09 and has only refreshed since, so it has no managed runner
  and would have to press Set up;
- the pool (`orbit-ws03/orbit-managed`) admits 3 active users and 4 Pods; 1 is in use. `lifecycle.idleSeconds` is
  86400, so an idle runner goes to sleep and frees its compute after a day.

## Proposal

**The rule:** with the switch on and the environment available, every eligible account with a live login session
has a mapping. A sign-in still creates one at once; a sweep in the apiserver creates the rest.

### The sweep

- **Where.** A new `managed-runner-sweep.ts`, driven by `ManagedRunnerService` next to the worker it already
  starts in `onModuleInit`. It is constructed and started only when `gate.enabled && runtime.available`, as the
  worker is; off, no timer exists, so the boot spec's tripwire (`managed-runner-boot.pg.spec.ts`) stays as it is.
- **When.** Once right after start, so turning the switch on reaches every signed-in account within one pass; then
  every `lifecycle.signedInSweepSeconds` (new profile field, default 300, 60–86400). A refresh-only user is reached
  at most five minutes after their next use.
- **Whom.** One query: accounts with `disabled_at IS NULL`, at least one `refresh_token` with `revoked_at IS NULL`
  and `expires_at > now()`, and no `managed_runner` row at all, oldest refresh activity first, at most
  `MANAGED_RUNNER_PASS_BATCH` (50) per pass. Each one is still asked the eligibility rule (`EVERY_ACCOUNT` today)
  through `enabledAccountsOnly`, as a sign-in is.
- **What.** The same `createMapping` a sign-in uses, with the request key `signed-in:<uuid>`, then one
  `worker.kick()` for the whole pass. Placement, capacity admission and provisioning are unchanged: a mapping beyond
  the pool's room waits in `WAITING_CAPACITY` and starts by itself when room frees up.
- **Several replicas.** Each replica may sweep. The owner's unique key on `managed_runner` makes a second create
  read the winner (the existing P2002 path), so two replicas never make two mappings. A transaction advisory lock
  around the pass keeps the duplicate work down to one replica; it is an optimization, not the guarantee.
- **What it never does.** It does not recreate a mapping that exists in any state, `DELETED` included (deleted
  data is not brought back, as `ensure` already refuses). It does not wake, retry or touch an existing mapping. It
  does not read or change anything on the refresh or login path.

### What does not change

- `GET /managed-runner` stays a read with no side effect; PATs with `runners:read` still cannot cause a write.
- Token refresh, logout and password change stay exactly as they are.
- `signedIn` stays: it is the immediate path, and the sweep is the one that catches everybody else.
- Turning the switch off freezes management as today: no sweep, no new mapping, nothing stopped or deleted.
- Clients need no change. A new mapping shows up as the "Managed runner" machine and its default workspace through
  the reads they already make; the Set up entry disappears because `display.ensure` turns false. The Set up page and
  its confirmation stay for an account the sweep has not reached yet.

### Copy

None new. The states a new mapping goes through (`Starting`, `Waiting for capacity`, …) already have their words in
`MANAGED_RUNNER_COPY`.

## Decisions

| | A (recommended) | B | Why A |
| --- | --- | --- | --- |
| **D1** What creates the mapping for an account already signed in | The server sweep of live login sessions above | The status read `GET /managed-runner` creates one for a session caller | A keeps every read free of writes and the auth path untouched. B turns a GET polled every 30 s on most Web screens into a write, and reaches an account only while one of its clients has a screen open that reads it (and an old client version may read it nowhere). |
| **D2** Which accounts count as signed in | Any live login session (unrevoked, unexpired refresh token): 6 accounts today | Only those whose session was used in the last 7 days: 5 today | The sliding 30-day token already expires dormant sessions; a narrower window is a second clock to explain. |
| **D3** Accounts that already have their own machines | Included: they get a managed runner and its workspace like everyone else | Only accounts with no runner at all | A sign-in already gives them one today, so A makes the two paths agree. It does reverse the spirit of the 11-14 D3 (an existing account confirms before a workspace appears in its sidebar); B keeps that, but leaves those accounts on the Set up button. |
| **D4** Capacity on production | Deploy as is: 2 of the 6 start at once, 4 wait in `Waiting for capacity` until a runner sleeps | Raise `capacity.maxActiveUsers` and the Pod limit in `profile.json` on 10.66.0.4 before the deploy | A changes nothing operational, and the wait is shown and resolves by itself. B is an operator change to the pool on orbit-ws03, which is the owner's to approve. |

## Changes

1. `src/apiserver/src/managed-runners/managed-runner-sweep.ts`: the query and the pass.
2. `managed-runner.service.ts`: starts and stops the sweep beside the worker; `createMapping` used as is.
3. `managed-runner-profile.ts`: `lifecycle.signedInSweepSeconds`, validated, default 300.
4. Docs: managed-runner-design.md ("Default disabled gate" rows and the sign-in hook record),
   `managed-runner-sign-in.ts`'s comment, the existing-account entry design (D3 note), configuration.md for the new
   field.

## Verification

- Unit: the query's predicates (disabled, revoked, expired, an existing mapping of any state, the batch order).
- pg spec, on a real PostgreSQL with a stub backend:
  1. switch on, an account with a live refresh token and no mapping → exactly one mapping, runner and workspace
     after one pass, with a `signed-in:` key;
  2. only revoked or expired refresh tokens → nothing;
  3. a disabled account, and one the eligibility rule refuses → nothing;
  4. a `DELETED` mapping → not recreated;
  5. two services sweeping the same database at once → one mapping per account;
  6. a full pool → the new mapping is `WAITING_CAPACITY`, and starts when a reservation is released;
  7. a refresh issues tokens and writes nothing managed (unchanged behaviour, now asserted).
- `managed-runner-boot.pg.spec.ts` unchanged and green: off, no timer and no managed write.
- Production, after the deploy and with the owner's go: the 6 accounts have mappings within one pass; their states
  match D4's expectation; the account that only refreshed since 11-09 shows its managed runner without pressing Set up.
