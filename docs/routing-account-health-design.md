# Routing and account health: design

**Status**: design proposal (2026-11-23). No code yet. The open decisions are in §11, each with a recommended default.

> **Words.** An **account** is whatever a run spends: a sign-in on one runner (runner × engine × account), a member of
> an account pool, or an API key. An **admission failure** is a run the provider turned away before it did any work.
> **Health** is what Orbit has learned about an account from the runs it sent there; it is separate from **quota**
> (what the provider reports is left) and from **paused** (what the owner set by hand). Tiers S / M / L / XL are those
> of [`model-routing-design.md`](./model-routing-design.md) §3.1; the SubAgent router and its filters are
> [`subagent-design.md`](./subagent-design.md) §4.2 and §4.3.

## 0. One-page summary

- **The incident.** From 2026-11-22 17:19 every XL run (five in a row) was routed to the owner's Cursor subscription.
  Cursor refused each at once with "Add a payment method to continue". Each run failed at $0 with no work done, and
  the router picked Cursor again, because nothing it reads had changed.
- **The cause is structural.** Orbit knows three reasons an account cannot run: signed out, quota spent, paused. "Signed
  in but cannot run" has no place in the model. A refusal of that kind is filed as an ordinary task failure, so it
  escalates the tier, spends the task's retry budget, triggers no fallback and leaves no memory.
- **Proposal, in four parts.**
  1. A **failure kind**: a small engine-agnostic enum that each runner engine adapter emits beside the error text
     (§4, §5). Text markers stay as a fallback for old runners only.
  2. An **account health** record the server writes from those kinds and the router reads beside quota and paused (§6).
     A provider's explicit refusal blocks the account until something shows it is fixed. Unclassified zero-cost
     admission failures trip a circuit breaker: the first one demotes the account, the second blocks it for a short,
     growing period.
  3. **Router changes** (§7): a blocked account is removed with a Why line that quotes the provider; a suspect one is
     ranked last; admission refusals are not counted for tier escalation or the auto-run failure budget; the refused
     run is replaced at once on the next candidate.
  4. **One owner alert** per account that needs action, and a "Check again" control on the account's row (§8).
- **A new engine** gets the breaker for free, and gets precise behaviour by declaring one mapping table in its adapter
  (§5.3, §9).

## 1. The incident

| Fact | Value |
|---|---|
| First refused run | 2026-11-22 17:19 |
| Refused runs | 5, all tier XL, all on the built-in `cursor` subscription |
| Provider's words | `Add a payment method to continue` |
| Cost and work | $0, no tool call, no reply |
| What the session error said | `Cursor said: "Add a payment method to continue." The Cursor account needs this before the session can go on.` (`src/runner-go/cursor_events.go:575`) |

Why Cursor kept winning: at XL the candidates were ranked by `compareAccounts`
(`src/apiserver/src/tasks/model-routing.ts:814`): subscriptions before metered keys, then known quota, then expiry,
then headroom. A Cursor account that cannot spend reports almost all of its quota left, so it ranks first on headroom
for as long as it cannot run. The better the account's quota looks, the more firmly the router holds on to it.

Why the tier was XL: each refusal counted as a failed run, and a failed run raises the tier by one, capped at XL
(`model-routing.ts:379`–`392`). The refusals themselves pushed the task to the most expensive tier.

## 2. Today's logic and its gaps

### 2.1 What rules a candidate out

`engineVerdict` (`model-routing.ts:1059`) and `providerRefusal` (`:1049`) are the whole list:

| Reason | Source | Line |
|---|---|---|
| Provider blocked in SubAgents settings; shared provider out of scope | owner settings | `:1050`–`1051` |
| Engine not installed on the runner | runner report | `:1071` |
| Claude region blocked, for an Anthropic-bound credential | region check | `:1073` |
| Signed out, for a login credential | runner report | `:1089` |
| Quota utilization ≥ `ENGINE_QUOTA_LIMIT` (90, `:173`) | usage reading | `:1090` |
| `account.paused` | owner's pause, `runnerAccountPausedUntil` (`src/apiserver/src/common/account-pause.ts:22`) read in `engineState` (`src/apiserver/src/tasks/task-route-decision.ts:347`) | `:1093` |
| `account.refused` (usage endpoint answered 401, `KEY_REFUSED`) | `src/apiserver/src/providers/plan-usage.ts:90` | `:1094` |
| Pool: no member that is not refused, not paused and under the limit | `bestPoolMember` (`:1031`); member states from `src/apiserver/src/runner-api/subagent-route.ts:320`–`342` (`spentUntil`, `pausedUntil`, `throttledUntil`, `KEY_REFUSED`) | `:1078` |

Every one of these is known **before** a run: a report, a reading or a setting. None is learned **from** a run.

### 2.2 How a failed run is read

- `readRunHistory` marks a run `quotaFailure` or `capacityFailure` by substring match on `session.error`
  (`task-route-decision.ts:372`, `:381`, `:432`), using `USAGE_LIMIT_ERROR_MARKERS` (`src/shared/src/events.ts:254`)
  and `MODEL_AT_CAPACITY_ERROR_MARKER` (`model-routing.ts:215`).
- `routeTaskRun` skips those two when it looks for the last run (`model-routing.ts:356`–`365`). Any other failed run
  escalates.
- The auto-run failure budget (`autoRunHoldOff`, `src/apiserver/src/tasks/tasks.service.ts:13110`) excludes only
  usage-limit errors, by the same markers as a SQL `contains`. Five counted failures retire the task to a human
  (`MAX_AUTO_RUN_FAILURES`, `src/apiserver/src/tasks/task-retry-policy.ts:16`).
- A SubAgent moves to the next candidate only on a usage limit, capacity or a failed login (`movableFailure`,
  `src/apiserver/src/runner-api/subagent-run.ts:217`; the runner's twin is `subagentLimitFailure`,
  `src/runner-go/subagent_fallback.go:64`). Anything else returns `SUBAGENT_NOT_A_LIMIT_FAILURE`.

### 2.3 Where the class is decided today

By English substrings, in at least six places that must be kept identical by hand:

| Place | What it decides |
|---|---|
| `src/shared/src/events.ts:254`, `:289`, `:241`, `:444` | usage limit, auth, connection, `classifyFailure` |
| `src/apiserver/src/tasks/task-route-decision.ts:372`, `:381` | not counted for escalation |
| `src/apiserver/src/tasks/tasks.service.ts:13118` | not counted for the retry budget (SQL) |
| `src/apiserver/src/runner-api/subagent-run.ts:197`, `:210` | SubAgent may move |
| `src/runner-go/subagent_fallback.go:19`, `:44` | the same, in Go |
| `src/apiserver/src/sessions/auto-retry.service.ts:1158` | a session is stopped on a retryable failure |

The adapters already know more than they say. `cursorTurnFailure` (`src/runner-go/cursor_events.go:560`) matches
Cursor's fixed sentences exactly and then **re-encodes** the class as English: a usage limit is rewritten to open with
"You've hit your usage limit" (`src/runner-go/planusage_error_text.go:21`) purely so that the server's substring match
fires. `kimiFailureSentence` (`src/runner-go/kimi_acp.go:1538`) has the engine's own error *names* and flattens them
to a sentence. `antigravityErrorText` (`src/runner-go/antigravity.go:665`) has a numeric code and a status and
prefixes "Failed to authenticate". The class is known at the adapter, encoded as prose, and guessed back on the server.

### 2.4 The gaps

| # | Gap | Effect in the incident |
|---|---|---|
| G1 | No failure class for "the account needs a change". `cursorTurnFailure` gives "Add a payment method to continue" and "Check your settings to continue" a generic sentence (`cursor_events.go:575`). | Read as an ordinary task failure. |
| G2 | No account state learned from runs. Nothing automatic writes `paused`; the pause is the owner's. | The sixth run would have made the same pick. |
| G3 | Ranking rewards an account that cannot spend (`compareAccounts`, headroom). | Cursor ranked first every time. |
| G4 | An admission refusal escalates the tier. | The task climbed to XL on refusals alone. |
| G5 | An admission refusal spends the auto-run failure budget. | Five refusals retire a healthy task. |
| G6 | No fallback for the current run: SubAgents move only on limit, capacity or login; a task run has no fallback at all. | Each run simply failed. |
| G7 | When no candidate can run, `routeTaskRun` keeps the Agent's own model (`model-routing.ts:428`) without asking whether that account can run. | Not hit this time; it would be once Cursor is excluded and it is the Agent's own engine. |
| G8 | A metered key passes `engineVerdict` with no account check at all (`model-routing.ts:1103`). | A revoked or unfunded key behaves as Cursor did. |
| G9 | The owner is told nothing. There is a push for a sign-out and for a region block (`src/apiserver/src/push/push.service.ts:470`, `:545`), none for this. | Found by reading failed runs. |
| G10 | Classification is prose (§2.3). | Each new sentence needs edits in six places, two languages. |

## 3. Goals and non-goals

**Goals**

1. An account that is signed in but cannot run is excluded after the provider says so once, and stays excluded until
   there is a reason to think it is fixed.
2. A run the provider refused at admission is replaced on another candidate at once, and is never held against the task.
3. An engine nobody has mapped yet is still safe: repeated zero-cost admission failures stop the router by themselves.
4. One transient error never blacklists an account.
5. The owner hears about it once, in the provider's words, and can clear it with one press.

**Non-goals**

- Replacing quota readings, the owner's pause, the sign-in report or the Claude region check. Health is a fourth
  input beside them; they keep their own sources and wording.
- Diagnosing *why* billing failed. Orbit quotes the provider and points at the account.
- Blocking an account the owner chooses by hand. Health governs what Orbit picks, not what the owner picks (§7.5).
- Retrying inside the same session. That stays with `AutoRetryService`
  ([`quota-limit-retry-design.md`](./quota-limit-retry-design.md)).

## 4. Failure taxonomy

One enum, `RunFailureKind`, engine-agnostic. A kind answers three questions: is it about the **task**, the
**account**, or neither; how long does it last; and does the run move.

| Kind | Meaning | Examples | Lasts |
|---|---|---|---|
| `USAGE_LIMIT` | The account's allowance is spent. | 5-hour, weekly, monthly windows; Cursor "Upgrade your plan to continue" | Until a reset the provider names, or can be read |
| `CAPACITY` | The provider is turning requests away for now. | Codex "Selected model is at capacity"; an overloaded 529 | Minutes |
| `ACCOUNT_ACTION_REQUIRED` | Signed in, but the account must be changed by a person. | payment method missing, plan lapsed or downgraded, a setting to accept, balance empty on a prepaid key | Unbounded, until the owner acts |
| `CREDENTIAL_REFUSED` | The credential itself is not accepted. | OAuth session expired, key revoked, 401 | Unbounded, until a new sign-in or key |
| `ACCESS_DENIED` | The credential is accepted but this use is not allowed. | organisation policy, region, model not in the plan, team switched | Unbounded; scope may be one model |
| `TRANSPORT` | The request did not get a real answer. | dropped socket, edge block page, DNS | Seconds to minutes; says nothing of the account |
| `REQUEST_REFUSED` | The provider refused *this* request. | content policy, context too long | About the request; repeats on a re-send |
| *(absent)* | Not classified. | everything else | Unknown |

Each kind carries a **scope**: `account` (default), `model` (one model on that account), `runner` (this machine,
for example a region) or `request`.

What each kind implies:

| Kind | Task: counts for escalation and retry budget? | Account: health effect | Clears by | Run: replaced now? |
|---|---|---|---|---|
| `USAGE_LIMIT` | No (as today) | None when a usage reading covers the account. When none does: blocked until the named reset, else 15 min (`QUOTA_BLIND_RETRY_BACKOFF_MS`). | The reset time; a fresh reading under the limit | Yes (as today for SubAgents; new for task runs) |
| `CAPACITY` | No (as today) | None in the first version (§11 Q6) | — | Yes (as today) |
| `ACCOUNT_ACTION_REQUIRED` | **No** | **Blocked**, no expiry | Owner's "Check again"; a successful run on it; a fresh sign-in; a changed plan reading | **Yes** |
| `CREDENTIAL_REFUSED` | **No** | **Blocked**, no expiry | A fresh sign-in or a saved key; a successful run | Yes (as today for SubAgents, unless the model was named) |
| `ACCESS_DENIED` | **No** | **Blocked** at its scope, no expiry | Same as `ACCOUNT_ACTION_REQUIRED` | Yes |
| `TRANSPORT` | No | None. Never a strike. | — | No: `AutoRetryService` re-sends in place, as today |
| `REQUEST_REFUSED` | Yes (unchanged) | None | — | No |
| *(absent)* | Yes, **unless** the run was a zero-cost admission failure (§6.4) | Breaker strike if zero-cost admission failure | §6.4 | Only when the strike blocks or demotes the account |

Two rules keep the table honest:

- **A kind is a claim by the provider, not a guess by Orbit.** An adapter emits a kind only for an error shape it has
  been shown (a recorded sentence, a status code, an error name). The standing rule of `USAGE_LIMIT_ERROR_MARKERS`
  ("only messages actually observed … are listed", `events.ts:248`) carries over unchanged.
- **Absent is the safe default.** An unclassified failure keeps today's behaviour for the task. The only new thing
  that can happen to it is the breaker of §6.4, which needs the failure to be free, immediate and repeated.

## 5. How the kind is produced

### 5.1 On the wire

Two optional fields on `TurnCompleteRequest` and `RunFinalizeRequest` (`src/shared/src/dto.ts:4050`, `:4246`), and on
the SubAgent fallback request:

```ts
/** What a FAILED turn failed with, as the engine adapter classified it. Absent: not classified, or an older runner. */
failure?: {
  kind: RunFailureKind;
  scope?: 'account' | 'model' | 'runner' | 'request';   // default 'account'
  /** When the provider says it can run again (ISO); only with USAGE_LIMIT or CAPACITY. */
  until?: string;
  /** The provider's own words, unedited, at most 300 characters: what the owner is shown. */
  said?: string;
};
/** True when the turn ended before the engine produced any reply, tool call or billed token. */
admission?: boolean;
```

`error` stays exactly as it is: it is what people read, and what an older server reads. `subtype` already carries
runner-decided completions of this kind (`region_refused`, `dto.ts:1944`); `failure` is the general form, and the
region subtypes keep working.

The server stores them on the session: `failure_kind`, `failure_scope`, `failure_said`, `admission_failure`
(migration, §10). They are written with the release that ends the run, in the same statement as `error`.

### 5.2 `admission` is measured, not inferred

The runner sets `admission: true` when, in this turn, it saw no assistant text other than the failure itself, no tool
call, and no usage. Every adapter already tracks these to build the turn. For a runner too old to send it, the server
derives the same answer from what it has: the turn is the run's first, its cost is zero or absent, it has no
`TOOL_USE` event, and it ended within 60 seconds of starting. The derived answer feeds the breaker only; it never
produces a kind.

### 5.3 In the runner: one result type, one table per engine

Today each adapter returns a sentence. It returns a classified failure instead:

```go
// engineFailure is a turn failure as an adapter classified it. The zero Kind is "not classified".
type engineFailure struct {
    Kind  string    // failureUsageLimit, failureAccountAction, ... ; "" when unknown
    Scope string    // "" means account
    Until time.Time // zero when the provider named none
    Said  string    // the provider's words, unedited
    Text  string    // the sentence Orbit shows, as today
}

// A rule matches one error shape of one engine. Exactly one of the matchers is set.
type failureRule struct {
    Equals   string   // the whole sentence
    Prefix   string
    Code     string   // an error name, status or code the engine reports as data
    Kind     string
    Scope    string
    Text     func(said string) string // the sentence Orbit shows
}
```

Cursor's table is the body of `cursorTurnFailure` turned into data:

| Match | Kind | Today |
|---|---|---|
| `Equals "Upgrade your plan to continue"` | `USAGE_LIMIT` | rewritten to the usage-limit words |
| `Equals "Please sign in to continue"`, `Prefix "Error: [unauthenticated]"` | `CREDENTIAL_REFUSED` | "Failed to authenticate: …" |
| `Equals "Add a payment method to continue"` | `ACCOUNT_ACTION_REQUIRED` | generic sentence |
| `Equals "Check your settings to continue"` | `ACCOUNT_ACTION_REQUIRED` | generic sentence |
| `Prefix "Request blocked "` + "usage guidelines" | `REQUEST_REFUSED` | unchanged |
| `Prefix "Error: RetriableError:"` | `TRANSPORT` | "Cursor CLI failed this turn" (the contract already recommends this, [`cursor-runtime-contract.md`](./cursor-runtime-contract.md) §12) |
| `Prefix "Error: "` | *(absent)* | unchanged |

The sentences keep their text during the transition, so an older server still matches the usage-limit and auth words.

**Adding an engine** is three things, all in its adapter package:

1. a `[]failureRule` table;
2. a table-driven test with one recorded sample per rule (the fixture is the evidence that the shape was observed);
3. a row in the cross-engine census test, which fails when an engine in `AgentProvider` has no table. An empty table
   is allowed and is an explicit statement: "nothing mapped; the breaker covers it".

**Unknown errors stay safe** because the zero kind changes nothing for the task, and because the default arm of a
table is never a guess: there is no rule of the form "contains `billing`".

### 5.4 On the server: one reader

A single function replaces the six places of §2.3:

```ts
/** The failure kind of a released run: the runner's, else what the legacy markers say of its error text. */
export function runFailureKind(run: { failureKind: string | null; error: string | null }): RunFailureKind | null
```

It lives in `@orbit/shared`. The legacy branch maps `isUsageLimitErrorText` → `USAGE_LIMIT`,
`MODEL_AT_CAPACITY_ERROR_MARKER` → `CAPACITY`, `isAuthErrorText` / `isLoginFailureText` → `CREDENTIAL_REFUSED`,
`isConnectionFailureText` → `TRANSPORT`. It adds **no new markers**: a class that has no structured kind and no
existing marker is unclassified, and the breaker handles it. The SQL filter in `autoRunHoldOff` becomes
`failure_kind IN (…) OR (failure_kind IS NULL AND <today's marker clauses>)`.

The clients keep their text classifiers for now (they draw cards from them); moving them to the kind is a follow-up
and is not needed for routing.

## 6. Account health

### 6.1 The subject

Health is kept per account, at the grain a run actually spends:

| Subject | Key | Which runs name it |
|---|---|---|
| A sign-in on a runner | `runner:<runnerId>:<engine>:<account>` | built-in subscription runs; the account is the one `runAccount` resolves (`src/apiserver/src/providers/plan-usage-accounts.ts:99`), stored on the session |
| A key, or a Claude pool member | `provider:<providerId>` | key runs; pool runs through `poolMemberProviderId` |
| A Codex pool login | `pool-login:<poolId>:<accountId>` | pool runs through `poolCodexAccountId` |

The same provider account signed in on two runners is two subjects. The second runner pays one refused admission,
which is replaced at once (§7.3), and then has its own row. Joining them by identity is left out (§11 Q5).

### 6.2 Where it lives

A new table, `account_health`, one live row per subject:

| Column | Notes |
|---|---|
| `owner_id`, `subject_key` | unique together while `cleared_at IS NULL` |
| `runner_id`, `engine`, `account`, `provider_id`, `pool_id` | the parts of the key, for joins and cascade delete |
| `state` | `SUSPECT` or `BLOCKED` |
| `kind` | the `RunFailureKind`, or `UNCLASSIFIED_ADMISSION` for the breaker |
| `scope_model` | null for the whole account |
| `said` | the provider's words |
| `strikes`, `trips` | consecutive failures; how many times the breaker has blocked it in a row |
| `first_at`, `last_at`, `last_session_id` | evidence |
| `blocked_until` | null means until cleared |
| `notified_at` | the one alert (§8) |
| `cleared_at`, `cleared_by` | `OWNER`, `SUCCESS`, `SIGN_IN`, `READING`, `EXPIRED` |

Why a table and not a JSON column on `runner` beside `account_pauses` (`schema.prisma:914`): keys and pool members
do not belong to a runner; strikes need an atomic increment from concurrent run ends; and the owner surface lists
across runners. Why not reuse the pause: the pause is the owner's intent, capped at seven days, and the queue holds a
paused account's PENDING sessions with "Account paused until …". Writing it automatically would overwrite the owner's
own setting and lose the reason.

### 6.3 Who writes it

One service, `AccountHealthService`, called from the places that already see a run end:

| Event | Call site | Write |
|---|---|---|
| A run or turn ends FAILED | the turn-complete and finalize ingest in `runner-api` | `recordFailure(subject, kind, admission, said)` |
| A SubAgent attempt fails | the fallback route and the run's end (`subagent-run.ts`) | the same, with the attempt's own account or pool member |
| A run or turn ends SUCCEEDED | the same ingest | `recordSuccess(subject)`: clears the row, `cleared_by = SUCCESS` |
| A heartbeat reports the account newly signed in, or a usage reading whose plan differs from the last | the runner heartbeat path | clears to a trial (§6.5), `SIGN_IN` / `READING` |
| The owner presses Check again | new route (§8) | clears to a trial, `OWNER` |
| A key is saved again | providers service | clears, `SIGN_IN` |

`recordFailure` is one upsert. It is idempotent per session: a retry of the same finalize carries the same
`last_session_id` and does not add a strike.

### 6.4 The rules

**Classified, account-level, unbounded** (`ACCOUNT_ACTION_REQUIRED`, `CREDENTIAL_REFUSED`, `ACCESS_DENIED`):
`BLOCKED` on the first occurrence, `blocked_until = null`. One occurrence is enough because the kind comes only from
an exact, recorded provider answer (§4). These are not transient by their own wording.

**`USAGE_LIMIT` with no reading that covers the account**: `BLOCKED` until `failure.until`, else 15 minutes. With a
reading, nothing is written: the reading is the better source and already excludes the account at 90%.

**Unclassified zero-cost admission failures: the circuit breaker.**

| Strike | State | Router | Lasts |
|---|---|---|---|
| 1 | `SUSPECT` | Ranked after every healthy account (§7.2). Still runs if it is the only one. | Until a success, or 60 minutes without another strike |
| 2 in a row | `BLOCKED` | Removed | 30 minutes |
| each later trip in a row | `BLOCKED` | Removed | doubles: 1 h, 2 h, 4 h, capped at 6 h |

A strike counts only when all of these hold: the run was an admission failure (§5.2); its kind is absent; it is not
`TRANSPORT` by the legacy markers; and the runner was online when it ended. Any success on the account resets
`strikes` and `trips` to zero. A strike from the same session never counts twice.

This is what would have ended the incident with no mapping at all: run 1 demotes Cursor, so run 2 goes elsewhere; had
Cursor been the only candidate, run 2 would block it and the task would hold with a reason instead of running three
more times.

**Why a false positive is cheap.** A wrongly suspected account loses its rank, not its place. A wrongly blocked one is
out for 30 minutes and is then tried again by an ordinary run. A failure that is really about one repository (a
broken project config, say) can strike an account twice; the cost is that the router prefers another account for half
an hour, and the first success anywhere on that account erases it.

### 6.5 Trials: how a block ends

A block that has expired, or that was cleared by the owner, a sign-in or a reading, is not trusted yet. The row moves
to `SUSPECT` with `strikes = 1`: the next run may use it (ranked last, or first if the owner pressed Check again
— see below), a success clears the row, and a failure blocks it again at once with the next longer period.

- **Check again** by the owner is the one case where the trial is wanted now. If the engine's adapter declares a
  probe, the server asks the runner to run it and reports the answer on the row within seconds. If it declares none,
  the row is cleared outright and the next routed run is the test; a refusal blocks it again and says so, without a
  second alert (§8).
- **A probe is optional and per engine.** It is a cheap call that fails the same way a run would. No engine has a
  proven one today: Cursor's usage endpoints answer for a Free account
  ([`cursor-runtime-contract.md`](./cursor-runtime-contract.md) §11) and it is not measured whether any field reflects
  a missing payment method. The design does not depend on probes; they only make Check again answer faster.
- **Unbounded blocks are never retried on a timer.** A billing problem does not fix itself, and each automatic trial
  is a failed run in the owner's history. They end only by the events of §6.3 (§11 Q2 offers a slow timer as an option).

## 7. Router changes

### 7.1 A new exclusion in `engineVerdict`

Routing input gains one field beside `paused` and `refused`, on `SubagentProvider.account` and on `SubagentPoolMember`
(`model-routing.ts:577`, `:548`), and on `ModelRoutingEngineState` (`:176`):

```ts
health?: { state: 'blocked' | 'suspect'; kind: string; said?: string; since: number; until?: number | null; model?: string | null };
```

`engineState` (`task-route-decision.ts:311`) and `readConfiguredProviders` (`subagent-route.ts`) fill it from one
batched read of `account_health` for the owner. The check sits after `paused` in `engineVerdict`, and **also on the
metered-key path** (closing G8). In `bestPoolMember`, a blocked member is filtered with the refused and paused ones.
A block scoped to one model removes that model's rows only, the way the Opus weekly window does.

Why lines (the reason recorded on a removed candidate):

| Case | Wording |
|---|---|
| `ACCOUNT_ACTION_REQUIRED` | `The account needs your action: Cursor said "Add a payment method to continue" (since Nov 22, 17:19)` |
| `CREDENTIAL_REFUSED` | `The provider refused the account's credential (since Nov 22, 17:19)` |
| `ACCESS_DENIED` | `The provider does not allow this account to run: "<said>" (since …)` |
| `ACCESS_DENIED`, one model | `<model> is not available on this account: "<said>"` |
| `USAGE_LIMIT`, no reading | `The account hit its usage limit; tried again at 18:05` |
| breaker | `The account failed to start 2 runs in a row at no cost; tried again at 18:05` |
| pool, every member out | existing sentence, with `<label> needs action` among the per-member reasons |

The product name comes from the engine's label; `said` is quoted as the provider wrote it.

### 7.2 Ranking a suspect account

`compareAccounts` (`:814`) gets one key in front of the others, for subscriptions and keys alike: healthy before
suspect. `accountStep` (`:976`) gains the matching clause: `<next> failed to start its last run`. Nothing else in the
order changes. This alone fixes G3 for the unmapped case: headroom no longer outranks a failure the router just saw.

Both policy versions are bumped (`SUBAGENT_ROUTING_POLICY_VERSION`, `MODEL_ROUTING_POLICY_VERSION`), so recorded
decisions say which rule made them.

### 7.3 Replacing the refused run

**SubAgents.** `movableFailure` is rewritten over the kind: a run moves on `USAGE_LIMIT`, `CAPACITY`,
`CREDENTIAL_REFUSED`, `ACCOUNT_ACTION_REQUIRED`, `ACCESS_DENIED`, and on an unclassified admission failure. The
existing bounds stay: two moves per delegate call, no move when the caller named the model, each attempt recorded.
New attempt outcomes `ACCOUNT_ACTION_REQUIRED`, `ACCESS_DENIED`, `ADMISSION_FAILED`; Why line
`Moved to <model> after <model>'s account needed action` (or `… could not start`). The runner's
`subagentLimitFailure` asks the adapter's `engineFailure` first and its text markers second.

**Task runs.** A session cannot change engine, so the replacement is a new run of the task:

1. The refused run is released FAILED with its kind, as today, and health is written in the same transaction.
2. If the run was routed and its failure is not counted (§7.4), the task is re-armed at once through the retry
   policy's existing door, with no backoff. It is a fresh dispatch, so the router runs again and now reads the health
   row. The Route Decision of the new run carries `Run N was refused by its account before it started — not counted`
   and the removed candidate's Why line.
3. A bound: at most 3 replacement runs per task per hour. Past it the task waits for the normal backoff. This is the
   brake that the comment above `SCHEDULED_DISPATCH_MAX_PER_SWEEP` (`tasks.service.ts:1687`) warns must exist whenever
   a failure is exempt from the budget.

For a task that is not auto-run (the owner pressed Run), see §11 Q3.

### 7.4 Run history

`ModelRoutingRun` (`model-routing.ts:217`) replaces `quotaFailure` and `capacityFailure` with one field,
`notCounted?: 'usage-limit' | 'capacity' | 'account' | 'transport' | 'admission'`, set from `runFailureKind` and the
admission flag. The loop at `:356` skips any run that has it. Wording of the skip lines:

| Value | Line |
|---|---|
| `usage-limit` | `Run 3 hit a usage limit — not counted` (unchanged) |
| `capacity` | `Run 3 found the model at capacity — not counted` (unchanged) |
| `account` | `Run 3 was refused by its account before it started — not counted` |
| `transport` | `Run 3 lost its connection — not counted` |
| `admission` | `Run 3 failed to start at no cost — not counted` |

`autoRunHoldOff` excludes the same set from the failure budget, so the two stay one definition, as
[`model-routing-design.md`](./model-routing-design.md) §3.3 requires.

`admission` (unclassified, zero-cost) is not counted **only while the breaker is acting on it**: the first two
strikes on an account. If a task keeps failing at admission on accounts that are otherwise healthy, the failures count
again, because then the evidence points at the task.

### 7.5 When nothing can run, and what the owner chose by hand

- **No candidate left** (G7). `routeTaskRun` no longer falls back to the Agent's own model when that model's account is
  blocked. The dispatch holds the task instead, the way it holds one whose engine is signed out
  (`TaskSignInHold`, `src/shared/src/project-progress.ts:1376`). The hold type gains a second kind,
  `ACCOUNT_NEEDS_ACTION`, with the provider's words; it lifts on the read after the row clears.
- **A task pinned to a blocked provider** holds the same way. It is not moved: a pin is the owner's instruction.
- **An interactive session the owner starts by hand** on a blocked account is not refused. It shows the health line on
  the account in the picker. If it runs, its success clears the row. This is the cheapest "the owner fixed it" signal
  there is, and it keeps health from ever locking the owner out of their own account.
- **Automatic account choice inside one engine** (`automaticAccount`, `plan-usage-accounts.ts:163`, and the retry's
  account move) treats a blocked account as it treats a paused one, so a runner with two Cursor accounts moves to the
  second. The exact call sites that read `runnerAccountPausedUntil` for this (`sessions.service.ts:12572`–`12586`) are
  to be confirmed during phase 3.

## 8. Owner surface

Kept to three things.

1. **One push**, kind `account-needs-action`, sent when a row first becomes `BLOCKED` with an unbounded kind, or when
   the breaker trips for the third time in a row. Title: the runner's name (or the provider's label for a key). Body:
   `Cursor can't run on this account: "Add a payment method to continue". Orbit is using your other accounts until
   you fix it.` Guarded by `notified_at`: one alert per row, and a row re-blocked by a failed trial keeps its
   `notified_at`, so Check again never produces a second alert for the same problem. Same shape as
   `notifyEngineSignedOut` (`push.service.ts:470`): no badge, no session id, thread `runner-<id>`. The Android client
   must list the new kind or it drops the push.
2. **The account's row** (runner page and Providers page, where `pausedUntil` is already shown through
   `namedRunnerEngines`, `src/apiserver/src/common/runner-engines.ts:414`): a line `Needs action · Cursor said "Add a
   payment method to continue" · since Nov 22, 17:19`, and a **Check again** button. A breaker block reads
   `Not used until 18:05 · failed to start 2 runs`. A suspect account shows nothing.
3. **Held tasks** show `Waiting for an account: <same line>` through the hold of §7.5; in a project this is one Needs
   you row, as sign-in waits are (`ProjectSignInWait`).

**Clearing.** Check again calls `POST /account-health/:id/check` (owner only). Everything else clears by itself (§6.3).
There is no "ignore" setting; an owner who wants an account never used already has the SubAgents block list and the
pause.

## 9. Extensibility check

| Engine / credential | Subject | What its adapter can map today | Notes |
|---|---|---|---|
| **Cursor** | runner sign-in; a Cursor API key is a `provider` | §5.3, from the fixed sentences | The incident's sentence becomes `ACCOUNT_ACTION_REQUIRED`. "Your team has switched to …" (contract §12) is a candidate for `ACCESS_DENIED`; map it when the session-level error is routed through the same table. |
| **Codex** | runner sign-in | "hit your usage limit" with its reset time → `USAGE_LIMIT` + `until`; "at capacity" → `CAPACITY` (`src/runner-go/codex.go:57`); "Not logged in" / "OAuth session expired" → `CREDENTIAL_REFUSED` | The app-server reports errors as data; a deactivated workspace or a plan without Codex has no recorded sample yet, so it stays unclassified and the breaker covers it until one is recorded. |
| **Claude** | runner sign-in; subscription-token key | limit sentences → `USAGE_LIMIT`; "Failed to authenticate" → `CREDENTIAL_REFUSED`, except `isConnectionFailure` (`src/runner-go/claude.go:261`) → `TRANSPORT`; `API Error` with a retryable status → `CAPACITY` or `TRANSPORT` | The region check stays as it is: it is known before a run and is runner-scoped ([`claude-region-check-contract.md`](./claude-region-check-contract.md)). It is the `runner` scope of `ACCESS_DENIED` in the taxonomy, with its own source. The `TRANSPORT` carve-out matters: on 2026-11-13 two dozen sessions failed with an edge block wrapped as an auth failure; none of them may strike an account. |
| **Kimi** | runner sign-in | Kimi reports error **names** (`kimi_acp.go:1538`): the usage-limit name → `USAGE_LIMIT`, `APIProviderOverloadedError` → `CAPACITY`, `APIConnectionError` → `TRANSPORT` | Matched by `Code`, not by text. Names without a recorded sample stay unmapped. |
| **Antigravity** | runner sign-in | the error report carries a numeric code and a status (`antigravity.go:54`): 401 / `UNAUTHENTICATED` → `CREDENTIAL_REFUSED` (already detected, `:674`) | 403 and 429 statuses are natural rows for `ACCESS_DENIED` and `USAGE_LIMIT`; add them from recorded reports. |
| **Claude pool** | `provider:<member>` | as Claude | `KEY_REFUSED` from the usage endpoint keeps feeding `refused`; health adds what only a run reveals. A blocked member is skipped by `bestPoolMember` and by claim-time member choice. |
| **Codex pool** | `pool-login:<pool>:<account>` | as Codex, plus the gateway's own `spentUntil` / `throttledUntil` | Those two stay where they are (they are time-bounded and gateway-owned). Health covers the unbounded cases the gateway has no column for. |
| **API keys** (any preset, custom endpoints, OpenCode, DSH) | `provider:<id>` | HTTP status where the engine surfaces it: 401 → `CREDENTIAL_REFUSED`; 402 or an "insufficient balance" body → `ACCOUNT_ACTION_REQUIRED`, once recorded | Keys are the least mapped and gain the most from the breaker: today a dead key has no exclusion at all (G8). |
| **A future engine** | whichever of the three it spends | an empty table on day one | Safe through the breaker; precise once its table has rows. The census test (§5.3) makes the empty table a visible decision. |

## 10. Rollout

Each phase ships alone and leaves the system better than before it.

| Phase | Content | Tests |
|---|---|---|
| **P1. Stop the bleeding** (server only, no runner release) | `account_health` table and service; breaker on server-derived admission (§5.2); `health` in routing input; exclusion and suspect ranking; `notCounted` for `account` and `admission` in history and in `autoRunHoldOff`; hold instead of own-model fallback. One temporary legacy row: Cursor's generic sentence (`The Cursor account needs this before the session can go on`) → `ACCOUNT_ACTION_REQUIRED`, removed in P2. | Unit: `engineVerdict` reasons per kind; `compareAccounts` with a suspect; `routeTaskRun` skips and does not escalate; breaker state machine (strike, block, doubling, reset on success, idempotent per session, `TRANSPORT` never strikes). pg spec: five refused runs on one account → run 2 routes elsewhere, task tier unchanged, budget unspent; concurrent finalizes add one strike each; a blocked only-candidate holds the task. |
| **P2. Structured kinds** | `failure` and `admission` on the wire and on the session; `engineFailure` and rule tables for Cursor, Codex, Claude, Kimi, Antigravity; `runFailureKind` replaces the six text call sites; census test. | Go: table tests per engine with recorded fixtures; census. Shared: `runFailureKind` prefers the structured kind and falls back to markers. Cross-version: an old runner against a new server and the reverse (the sentence still matches). |
| **P3. Replace and move** | Immediate replacement run with its bound; SubAgent moves on the new kinds; Automatic account choice skips blocked accounts; pool member choice at claim. | pg spec: a refused task run is followed by a run on the next candidate within one dispatch, at most 3 per hour; SubAgent attempts record `ACCOUNT_ACTION_REQUIRED`; named model does not move. |
| **P4. Owner surface** | Push kind (server, iOS/macOS, Android), account row line, Check again route, hold kind in project open items, optional adapter probes. | Unit: one push per row; no push on re-block after Check again. pg spec: Check again clears to a trial; a failed trial re-blocks with the next period. Client tests for the row and the push kind on each platform. |

**Migration.** One new table (`account_health`, with its partial unique index) and four nullable columns on `session`.
No backfill: history before the change is read through the legacy markers, which is what it is read through today.
Both are additive, so old and new server replicas can run side by side; an old replica simply ignores the fields.

**Mixed versions.** A new runner with an old server: the server ignores `failure`; the sentence still classifies. An
old runner with a new server: no `failure`; markers and the breaker apply. Neither direction needs a gate.

**Risks**

| Risk | Mitigation |
|---|---|
| A provider rewords a sentence and a rule stops matching. | The failure becomes unclassified and the breaker still acts. Fixed sentences are already pinned per CLI build and regressed on upgrade (Cursor contract §12). |
| A rule is too broad and blocks healthy accounts. | Rules are exact matches with a recorded fixture; unbounded blocks alert the owner at once; a hand-started session clears it. |
| The breaker blames an account for a repository's fault. | Demote first, block for 30 minutes, clear on any success (§6.4). |
| Exempting refusals from the budget creates a respawn loop. | The health row removes the account; the replacement bound (3 per hour) caps the rest; no candidate → hold, not run. |
| Health and the provider's own state drift (the owner pays, Orbit still blocks). | Check again; success of any run; sign-in and plan-reading changes. The alert says how to clear it. |
| Every account ends up blocked and nothing runs. | That is the correct outcome when nothing can run; the hold names each account's reason. Breaker blocks expire by themselves. |
| A thundering trial: many tasks try a just-expired block at once. | A suspect account is ranked last, so only tasks with no other candidate use it; the first failure re-blocks it. |

## 11. Open questions for the owner

**Q1. Block on the first classified refusal, or the second?**
- **A (recommended).** The first. The kind exists only for an exact provider answer, and each extra refusal is a
  wasted run.
- B. The second. Safer against a provider that says "add a payment method" transiently; costs one more failed run
  per account each time.

**Q2. Should an unbounded block (billing, credential, policy) ever be retried on a timer?**
- **A (recommended).** No. It ends by Check again, a successful run, a sign-in or a changed reading.
- B. Yes, one trial every 24 hours. Recovers by itself if the owner fixes billing and forgets to press; costs one
  failed run a day per broken account, for ever.

**Q3. Does a refused run of a task that is not auto-run get a replacement run by itself?**
- **A (recommended).** Yes, once. The owner asked for the task to run, the run did no work, and the router made the
  choice that failed.
- B. No. The run fails with the reason; the next Run goes elsewhere. Simplest, and keeps "nothing starts unless I
  press" literally true.

**Q4. When the breaker (unclassified failures) blocks an account, tell the owner?**
- **A (recommended).** Only from the third trip in a row (about 3.5 hours of failing). Earlier ones heal by
  themselves and are visible on the account's row.
- B. On the first trip. Earlier notice, more noise.
- C. Never. Only the row shows it.

**Q5. Is health per runner, or shared by every runner signed in to the same provider account?**
- **A (recommended).** Per runner. Simple, and the second runner costs one replaced run.
- B. Shared by account identity. Needs a reliable identity (the email or id each runner reports) for every engine,
  which not every engine gives.

**Q6. Should `CAPACITY` write health (a short, model-scoped cool-down)?**
- **A (recommended).** Not in this project. Today's handling (in-place replay on Codex, fallback, not counted) works,
  and capacity is about the provider's model, not the account.
- B. Yes, 5 minutes per provider × model, so parallel runs stop queueing on a model that is turning requests away.

**Q7. A task pinned to a provider whose account is blocked: hold, or run on another?**
- **A (recommended).** Hold with the reason. A pin is an instruction.
- B. Run elsewhere and say so in the Why line. Keeps work moving; overrides the pin.

**Q8. Ship P1 alone, ahead of the rest?**
- **A (recommended).** Yes. It is server-only, ends this incident class through the breaker, and needs no runner or
  client release.
- B. Wait for P2 so that the first release already has structured kinds.
