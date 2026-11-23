# Routing and account health: design

**Status**: design proposal (2026-11-23). No code yet. The owner ruled on the open decisions on 2026-11-23; they are
recorded in §11, with three amendments accepted the same day, and the whole document follows them.

> **Words.** An **account** is whatever a run spends: a sign-in on one runner (runner × engine × account), a member of
> an account pool, or an API key. An **admission failure** is a run the provider turned away before it did any work.
> **Health** is what Orbit has learned about an account from the runs it sent there; it is separate from **quota**
> (what the provider reports is left) and from **paused** (what the owner set by hand). A **trip** is one time health
> blocks an account; a **trial** is the one ordinary run that tests it when the block ends. Tiers S / M / L / XL are
> those of [`model-routing-design.md`](./model-routing-design.md) §3.1; the SubAgent router and its filters are
> [`subagent-design.md`](./subagent-design.md) §4.2 and §4.3.

## 0. One-page summary

- **The incident.** From 2026-11-22 17:19 every XL run (five in a row) was routed to the owner's Cursor subscription.
  Cursor refused each at once with "Add a payment method to continue". Each run failed at $0 with no work done, and
  the router picked Cursor again, because nothing it reads had changed.
- **The cause is structural.** Orbit knows three reasons an account cannot run: signed out, quota spent, paused. "Signed
  in but cannot run" has no place in the model. A refusal of that kind is filed as an ordinary task failure, so it
  escalates the tier, spends the task's retry budget, triggers no fallback and leaves no memory.
- **Design, in four parts.**
  1. A **failure kind**: a small engine-agnostic enum that each runner engine adapter emits beside the error text
     (§4, §5). Text markers stay as a fallback for old runners only.
  2. An **account health** record the server writes from those kinds and the router reads beside quota and paused (§6).
     No block is open-ended. A provider's explicit refusal blocks the account for 1 hour; each consecutive refusal
     doubles that (2 h, 4 h, 8 h, 16 h) up to 24 hours. Every block ends with one trial: an ordinary routed run. At the
     cap that is one trial a day until one succeeds or the owner clears the account. Unclassified zero-cost admission
     failures run a ladder of the same shape that starts at 30 minutes and reaches the same 24-hour cap (the circuit
     breaker). A model at capacity is set aside on that account for 5 minutes.
  3. **Router changes** (§7): a blocked account is removed with a Why line that quotes the provider; a suspect one is
     ranked last; admission refusals are not counted for tier escalation or the failure budget; the refused run is
     replaced at once on the next candidate, for every task, auto-run or not; a task pinned to a blocked provider holds
     with a reason, or runs elsewhere and says so when the owner has turned that on (one account-level setting, off
     by default).
  4. **One owner alert** per problem: at the first classified refusal, or at the breaker's third consecutive trip.
     It is not repeated until the state changes. A "Check again" control sits on the account's row (§8).
- **A new engine** gets the breaker for free, and gets precise behaviour by declaring one mapping table in its adapter
  (§5.3, §9).
- **Rollout** (§10): health and structured kinds ship together as the first release; replacement and pin handling
  second; the owner surface third.

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

1. An account that is signed in but cannot run is set aside after the provider says so once, for a period that grows
   while it keeps refusing, and is tested again by one run at the end of each period.
2. A run the provider refused at admission is replaced on another candidate at once, and is never held against the task.
3. An engine nobody has mapped yet is still safe: repeated zero-cost admission failures stop the router by themselves.
4. One transient error never blacklists an account, and no account is ever set aside for good.
5. The owner hears about a persistent problem once, in the provider's words, and can clear it with one press.

**Non-goals**

- Replacing quota readings, the owner's pause, the sign-in report or the Claude region check. Health is a fourth
  input beside them; they keep their own sources and wording.
- Diagnosing *why* billing failed. Orbit quotes the provider and points at the account.
- Blocking an account the owner chooses by hand. Health governs what Orbit picks, not what the owner picks (§7.6).
- Retrying inside the same session. That stays with `AutoRetryService`
  ([`quota-limit-retry-design.md`](./quota-limit-retry-design.md)).
- Probing an account with a synthetic call. An account is tested only by an ordinary run (§6.5).

## 4. Failure taxonomy

One enum, `RunFailureKind`, engine-agnostic. A kind answers three questions: is it about the **task**, the
**account**, or neither; how long does it last; and does the run move.

| Kind | Meaning | Examples | The condition lasts |
|---|---|---|---|
| `USAGE_LIMIT` | The account's allowance is spent. | 5-hour, weekly, monthly windows; Cursor "Upgrade your plan to continue" | Until a reset the provider names, or can be read |
| `CAPACITY` | The provider is turning requests for a model away for now. | Codex "Selected model is at capacity"; an overloaded 529 | Minutes |
| `ACCOUNT_ACTION_REQUIRED` | Signed in, but the account must be changed by a person. | payment method missing, plan lapsed or downgraded, a setting to accept, balance empty on a prepaid key | Until a person changes the account |
| `CREDENTIAL_REFUSED` | The credential itself is not accepted. | OAuth session expired, key revoked, 401 | Until a new sign-in or key |
| `ACCESS_DENIED` | The credential is accepted but this use is not allowed. | organisation policy, region, model not in the plan, team switched | Until a person changes it; scope may be one model |
| `TRANSPORT` | The request did not get a real answer. | dropped socket, edge block page, DNS | Seconds to minutes; says nothing of the account |
| `REQUEST_REFUSED` | The provider refused *this* request. | content policy, context too long | About the request; repeats on a re-send |
| *(absent)* | Not classified. | everything else | Unknown |

Each kind carries a **scope**: `account` (default), `model` (one model on that account), `runner` (this machine,
for example a region) or `request`.

Orbit cannot see when a person fixes an account, so it never assumes the condition is permanent. What each kind
implies:

| Kind | Task: counts for escalation and failure budget? | Account: health effect | Ends by | Run: replaced now? |
|---|---|---|---|---|
| `USAGE_LIMIT` | No (as today) | None when a usage reading covers the account. When none does: a cool-down until the named reset, else 15 min (`QUOTA_BLIND_RETRY_BACKOFF_MS`). Not a trip. | The reset time; a fresh reading under the limit | Yes (as today for SubAgents; new for task runs) |
| `CAPACITY` | No (as today) | A cool-down of 5 minutes on **that model on that account** (§6.4). Not a trip. | The 5 minutes | Yes (as today) |
| `ACCOUNT_ACTION_REQUIRED` | **No** | **A trip** on the classified ladder: blocked 1 h, doubling per consecutive trip to a 24 h cap | A trial run that succeeds; the owner's Check again | **Yes** |
| `CREDENTIAL_REFUSED` | **No** | **A trip** on the classified ladder | The same; a fresh sign-in or a saved key makes the trial due at once | Yes (as today for SubAgents, unless the model was named) |
| `ACCESS_DENIED` | **No** | **A trip** on the classified ladder, at its scope (the account, or one model on it) | Same as `ACCOUNT_ACTION_REQUIRED` | Yes |
| `TRANSPORT` | No | None. Never a strike. | — | No: `AutoRetryService` re-sends in place, as today |
| `REQUEST_REFUSED` | Yes (unchanged) | None | — | No |
| *(absent)* | Yes, **unless** the run was a zero-cost admission failure (§6.4) | A breaker strike if it was a zero-cost admission failure: demoted, then **a trip** on the breaker ladder (30 min, doubling to a 24 h cap) | A trial run that succeeds; the owner's Check again | Only when the strike blocks or demotes the account |

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

### 6.1 The subject and its scope

Health is kept per account, at the grain a run actually spends:

| Subject | Key | Which runs name it |
|---|---|---|
| A sign-in on a runner | `runner:<runnerId>:<engine>:<account>` | built-in subscription runs; the account is the one `runAccount` resolves (`src/apiserver/src/providers/plan-usage-accounts.ts:99`), stored on the session |
| A key, or a Claude pool member | `provider:<providerId>` | key runs; pool runs through `poolMemberProviderId` |
| A Codex pool login | `pool-login:<poolId>:<accountId>` | pool runs through `poolCodexAccountId` |

**Health is per runner** (owner decision Q5). The same provider account signed in on two runners is two subjects.
The second runner pays one refused admission, which is replaced at once (§7.3), and then has its own row.

Under each subject there is a **scope**: the whole account, or one model on it. `scope_model` is the empty string for
the whole account and the model id otherwise. A subject can have one account-level row and any number of model-level
rows at the same time; they are independent. `CAPACITY` always writes a model-level row; `ACCESS_DENIED` writes one
when the adapter says the refusal is about one model; everything else writes the account-level row.

### 6.2 Where it lives

A new table, `account_health`, one live row per subject and scope:

| Column | Notes |
|---|---|
| `owner_id`, `subject_key`, `scope_model` | unique together while `cleared_at IS NULL`; `scope_model = ''` is the whole account |
| `runner_id`, `engine`, `account`, `provider_id`, `pool_id` | the parts of the key, for joins and cascade delete |
| `state` | `SUSPECT`, `BLOCKED` or `COOLDOWN` |
| `kind` | the `RunFailureKind`, or `UNCLASSIFIED_ADMISSION` for the breaker |
| `said` | the provider's words |
| `strikes` | consecutive unclassified admission failures while `SUSPECT` |
| `trips` | consecutive trips; picks the step of the ladder (§6.4). Zero for a cool-down. |
| `first_at`, `last_at`, `last_session_id` | evidence |
| `blocked_until` | always set for `BLOCKED` and `COOLDOWN`; there is no open-ended block |
| `trial_session_id`, `trial_claimed_at` | the one run testing the account now (§6.5) |
| `notified_at`, `notified_kind` | the alert (§8) |
| `cleared_at`, `cleared_by` | `SUCCESS`, `OWNER`, `EXPIRED` |

Why a table and not a JSON column on `runner` beside `account_pauses` (`schema.prisma:914`): keys and pool members
do not belong to a runner; strikes and the trial claim need atomic conditional writes from concurrent run ends; and
the owner surface lists across runners. Why not reuse the pause: the pause is the owner's intent, and the queue holds a
paused account's PENDING sessions with "Account paused until …". Writing it automatically would overwrite the owner's
own setting and lose the reason.

### 6.3 Who writes it

One service, `AccountHealthService`, called from the places that already see a run end:

| Event | Call site | Write |
|---|---|---|
| A run or turn ends FAILED | the turn-complete and finalize ingest in `runner-api` | `recordFailure(subject, kind, scope, admission, said)` |
| A SubAgent attempt fails | the fallback route and the run's end (`subagent-run.ts`) | the same, with the attempt's own account or pool member |
| A turn **was admitted**: it produced a reply, a tool call or usage, however the run ends later | the same ingest | `recordSuccess(subject, model)`: clears the account-level row and that model's row, `cleared_by = SUCCESS`, ladder reset |
| The owner presses Check again | new route (§8) | clears the row, `cleared_by = OWNER`, ladder reset |
| A heartbeat reports the account newly signed in; a usage reading whose plan differs from the last; a key is saved again | heartbeat path, providers service | makes the trial due now (`blocked_until = now`); the ladder is kept |
| A cool-down or a suspect period runs out | read time, no sweeper | the row reads as cleared; the next write stamps `cleared_by = EXPIRED` |

Success is defined by admission, not by the task's result: a run that did real work and then failed its acceptance
command proves the account can run. A classified failure in the middle of a run (a usage limit after an hour of work)
is a failure of that kind, not a success.

`recordFailure` is one upsert. It is idempotent per session: a retry of the same finalize carries the same
`last_session_id` and changes nothing.

### 6.4 The rules

There are two ladders and two cool-downs. Only the ladders count trips.

**The classified ladder** (`ACCOUNT_ACTION_REQUIRED`, `CREDENTIAL_REFUSED`, `ACCESS_DENIED`; owner decision Q1). The
first refusal is a trip: one is enough, because the kind comes only from an exact, recorded provider answer (§4).

**The breaker ladder** (unclassified zero-cost admission failures). The first such failure makes the account
`SUSPECT`: ranked after every healthy account (§7.2), still used if it is the only one, back to healthy after a
success or after 60 minutes without another strike. A second one in a row is a trip.

| Consecutive trip | Classified block | Breaker block |
|---|---|---|
| 1 | 1 h | 30 min |
| 2 | 2 h | 1 h |
| 3 | 4 h | 2 h |
| 4 | 8 h | 4 h |
| 5 | 16 h | 8 h |
| 6 | 24 h (cap) | 16 h |
| 7 and later | 24 h | 24 h (cap) |

How the two relate:

- They share one counter, `trips`, on the account-level row. The length of a block is read from the column of the
  kind that caused **this** trip, at the current count. An account that tripped the breaker three times and is then
  refused with a classified kind is at trip 4 of the classified column: 8 hours.
- At every count the breaker's block is at or below the classified one: half of it up to trip 5, two thirds at
  trip 6, equal from trip 7. So an unclassified failure never keeps an account out longer than an explicit refusal
  would, and a guess earns a shorter penalty than a statement until both reach the cap.
- Both ladders end at the same place: one trial every 24 hours. The breaker gets there one trip later.
- Every block of either ladder ends with a trial (§6.5). A refused trial is the next trip, at once: a trial does not
  need two strikes.
- Any success resets `strikes` and `trips` to zero and clears the row. So does the owner's Check again.

A breaker strike counts only when all of these hold: the run was an admission failure (§5.2); its kind is absent; it
is not `TRANSPORT` by the legacy markers; and the runner was online when it ended.

**The usage-limit cool-down.** `USAGE_LIMIT` with no reading that covers the account: `COOLDOWN` on the account until
`failure.until`, else 15 minutes. With a reading nothing is written: the reading is the better source and already
excludes the account at 90%.

**The capacity cool-down** (owner decision Q6). `CAPACITY` writes `COOLDOWN` on the row whose `scope_model` is the
model that was refused, until `failure.until` when the provider names one, else 5 minutes from the failure. The rest
of the account stays usable. A second capacity failure while the row is live moves `blocked_until` to 5 minutes from
that failure; it never grows beyond that.

A cool-down is not a trip: it does not move the ladder, has no trial, and never alerts. When it runs out the model
or account is simply a candidate again.

**This is what would have ended the incident.** With Cursor's sentence mapped, run 1 blocks the account for an hour
and is replaced on the next candidate. With no mapping at all, run 1 demotes Cursor so run 2 goes elsewhere; had
Cursor been the only candidate, run 2 would trip the breaker.

**Why a false positive is cheap.** A wrongly suspected account loses its rank, not its place. A wrongly blocked one
is out for 30 minutes or an hour and is then tried by an ordinary run, whose success erases everything. A failure
that is really about one repository (a broken project config, say) can strike an account twice; the cost is that the
router prefers another account for half an hour.

### 6.5 Trials: how a block ends

**What a trial is.** An ordinary routed run: a task run or a SubAgent, doing the work it was going to do anyway. It
is not a probe, sends no synthetic request, and no adapter needs to offer anything for it (owner decision Q2).

**When one is due.** When `blocked_until` has passed and no trial is in flight. From then on the account is a
candidate again and is ranked as a healthy one. Nothing happens until some run's ordinary ranking picks it; an
account nobody would pick anyway stays due at no cost.

**One at a time.** When a dispatch is about to start a run on an account whose trial is due, it claims the trial
with one conditional update (`trial_session_id` set where it is null and `blocked_until <= now`). A dispatch that
loses the claim routes again with that account excluded. While the trial is in flight every other run sees the
account as blocked (`being tried now`). The claim is released by the trial's end, or after 15 minutes if the session
never started.

**How it ends.**

| The trial run | Health | The run |
|---|---|---|
| is admitted (does any work) | Row cleared, ladder reset. The account is healthy. | Carries on as any run. |
| is refused, classified or zero-cost unclassified | Next trip at once: the next step of that kind's column. | Replaced at once on the next candidate (§7.3). |
| ends some other way before admission (cancelled, runner lost, `TRANSPORT`) | Unchanged: the trial is due again. | As today. |

**At the cap.** Once the classified ladder reaches 24 hours, the account gets exactly one trial every 24 hours, for
as long as it keeps refusing. It stops when a trial succeeds or the owner presses Check again. The breaker's ladder
has the same cap, so an unmapped failure ends at the same one trial a day.

**What a refused trial costs the task that got it.**

- Time: the seconds the provider took to refuse (0.6 s in the measured Cursor case), plus one dispatch for the
  replacement.
- Money: nothing. A refusal is an admission failure by definition.
- Its record: one extra failed run in the task's history, marked `Trial of <account> — refused, not counted`. It is
  not counted for tier escalation or the failure budget (§7.4), and not against the replacement cap of §7.3 or a
  SubAgent's two moves: the task did not choose to be the test.
- If the tried account was its only candidate, the task waits for the next period instead of being replaced (§7.5).

What the owner sees over time, for an account that stays broken: after a classified refusal, refused trials at about
1, 3, 7, 15 and 31 hours, then one a day; after the breaker's first trip, at about 0.5, 1.5, 3.5, 7.5, 15.5 and 31.5
hours, then one a day.

## 7. Router changes

### 7.1 A new exclusion in `engineVerdict`

Routing input gains one field beside `paused` and `refused`, on `SubagentProvider.account` and on `SubagentPoolMember`
(`model-routing.ts:577`, `:548`), and on `ModelRoutingEngineState` (`:176`):

```ts
/** What account health says of this account: at most one entry for the whole account, and one per model. */
health?: Array<{
  state: 'blocked' | 'suspect' | 'cooldown' | 'trial-due' | 'trial-running';
  /** Null: the whole account. Otherwise the one model the entry is about. */
  model: string | null;
  kind: string; said?: string; since: number; until: number; trips: number;
}>;
```

`engineState` (`task-route-decision.ts:311`) and `readConfiguredProviders` (`subagent-route.ts`) fill it from one
batched read of `account_health` for the owner. The router reads it in two places:

- **The account entry** (`model: null`) in `engineVerdict`, after `paused`, and **also on the metered-key path**
  (closing G8). `blocked`, `cooldown` and `trial-running` remove the provider × engine; `suspect` and `trial-due` do
  not. In `bestPoolMember` a member in one of the three removing states is filtered with the refused and paused ones.
- **The model entries** where candidates are built from tier rows, the way the Opus weekly window removes Opus rows
  today: a row whose model has a `blocked` or `cooldown` entry is removed, and every other model of that account
  stays. On an engine whose tiers are one model at several efforts (Codex), a model entry therefore removes every
  tier of that account; that is what the provider's refusal means there.

Why lines (the reason recorded on a removed candidate):

| Case | Wording |
|---|---|
| `ACCOUNT_ACTION_REQUIRED` | `The account needs your action: Cursor said "Add a payment method to continue" (since Nov 22, 17:19; tried again at 21:19)` |
| `CREDENTIAL_REFUSED` | `The provider refused the account's credential (since Nov 22, 17:19; tried again at 21:19)` |
| `ACCESS_DENIED` | `The provider does not allow this account to run: "<said>" (since …; tried again at …)` |
| `ACCESS_DENIED`, one model | `<model> is not available on this account: "<said>" (tried again at …)` |
| `CAPACITY`, one model | `<model> was at capacity on this account at 17:42; used again from 17:47` |
| `USAGE_LIMIT`, no reading | `The account hit its usage limit; used again from 18:05` |
| breaker | `The account failed to start 2 runs in a row at no cost; tried again at 18:05` |
| trial in flight | `The account is being tried now by another run` |
| pool, every member out | existing sentence, with `<label> needs action` among the per-member reasons |

The product name comes from the engine's label; `said` is quoted as the provider wrote it. "Tried again at" is the end
of the current block.

### 7.2 Ranking a suspect account

`compareAccounts` (`:814`) gets one key in front of the others, for subscriptions and keys alike: healthy before
suspect. `accountStep` (`:976`) gains the matching clause: `<next> failed to start its last run`. Nothing else in the
order changes. This alone fixes G3 for the unmapped case: headroom no longer outranks a failure the router just saw.

An account whose trial is due is ranked as healthy, so that a trial actually happens. When it is the pick, the Why
line adds `Trying <provider> again: it last refused a run at 17:19`.

Both policy versions are bumped (`SUBAGENT_ROUTING_POLICY_VERSION`, `MODEL_ROUTING_POLICY_VERSION`), so recorded
decisions say which rule made them.

### 7.3 Replacing the refused run

**SubAgents.** `movableFailure` is rewritten over the kind: a run moves on `USAGE_LIMIT`, `CAPACITY`,
`CREDENTIAL_REFUSED`, `ACCOUNT_ACTION_REQUIRED`, `ACCESS_DENIED`, and on an unclassified admission failure. The
existing bounds stay: two moves per delegate call, no move when the caller named the model, each attempt recorded.
New attempt outcomes `ACCOUNT_ACTION_REQUIRED`, `ACCESS_DENIED`, `ADMISSION_FAILED`; Why line
`Moved to <model> after <model>'s account needed action` (or `… could not start`). The runner's
`subagentLimitFailure` asks the adapter's `engineFailure` first and its text markers second. A refused trial is not
one of the two moves.

**Task runs.** A session cannot change engine, so the replacement is a new run of the task:

1. The refused run is released FAILED with its kind, as today, and health is written in the same transaction.
2. If its failure is not counted (§7.4), the task gets a new run at once, with no backoff. This holds for **every
   task, whether or not it auto-runs** (owner decision Q3): the owner asked for the task to run, the run did no work,
   and it was the router's choice that failed. It is a fresh dispatch, so the router runs again and now reads the
   health row. The new run's Route Decision carries `Run N was refused by its account before it started — not
   counted` and the removed candidate's Why line.
3. A bound: at most 3 replacement runs per task per hour, refused trials excepted (§6.5). Past it an auto-run task
   waits for the normal backoff and any other task stops with the last refusal shown. This is the brake that the
   comment above `SCHEDULED_DISPATCH_MAX_PER_SWEEP` (`tasks.service.ts:1687`) warns must exist whenever a failure is
   exempt from the budget.

**The re-arm path, traced (phase 2).** Before phase 2 an auto-run task's next run after a refusal came from
`rearmEndedAutoRuns`, called first in every `reconcileReadyTasks` pass (once a minute): it reads each auto-run task
whose current dispatch moment's run has ended, asks `autoRunRetryDecisions` (how the run ended, an armed
`AutoRetryService` retry, the quota gate, then `autoRunHoldOff`), and on RETRY advances `task_dispatch_epoch` by a
compare-and-set so the candidate scans dispatch a new moment. An uncounted refusal spends no budget, so it was
re-armed on the next pass, up to a minute later and with no bound; a task that does not auto-run was never re-armed.
Phase 2 replaces at once from the runner API (`TasksService.replaceRefusedRun`, after the run's health is written),
under a request named after the refused run (`replace:<task>:<session>`, `replace-trial:` for a refused trial), and
`autoRunRetryDecisions` holds an auto-run task whose bound is spent until the hour has room.

A replacement is a continuation of the start the owner or the sweep already made, not a new decision to start. For a
task that does not auto-run it is recorded as such on the task (`Replaced run N, which its account refused`), so the
history shows why a second run exists that nobody pressed for.

### 7.4 Run history

`ModelRoutingRun` (`model-routing.ts:217`) replaces `quotaFailure` and `capacityFailure` with one field,
`notCounted?: 'usage-limit' | 'capacity' | 'account' | 'transport' | 'admission'`, set from `runFailureKind` and the
admission flag. The loop at `:356` skips any run that has it. Wording of the skip lines:

| Value | Line |
|---|---|
| `usage-limit` | `Run 3 hit a usage limit — not counted` (unchanged) |
| `capacity` | `Run 3 found the model at capacity — not counted` (unchanged) |
| `account` | `Run 3 was refused by its account before it started — not counted` |
| `account`, a trial | `Run 3 was a trial of <provider>, which refused it — not counted` |
| `transport` | `Run 3 lost its connection — not counted` |
| `admission` | `Run 3 failed to start at no cost — not counted` |

`autoRunHoldOff` excludes the same set from the failure budget, so the two stay one definition, as
[`model-routing-design.md`](./model-routing-design.md) §3.3 requires.

`admission` (unclassified, zero-cost) is not counted **only while the breaker is acting on it**: a strike, a trip or
a refused trial on that account. If a task keeps failing at admission on accounts that are otherwise healthy, the
failures count again, because then the evidence points at the task.

### 7.5 A pin on a blocked provider, and when nothing can run

A task can pin an engine (`Task.engine`), a provider (`Task.provider`) and a model (`Task.model`). `taskRunPool`
applies the first two as filters (`model-routing.ts:459`); a model pin skips routing altogether (`:352`).

**The switch** (owner decision Q7, as amended). Whether a pin may be relaxed is the owner's choice, made once for the
account:

| | |
|---|---|
| Where | `UserPreferences.relaxBlockedPins`, a boolean beside `subagentBlockedProviders`. Read and changed like any other preference, `settings_get` / `settings_propose` included. The dispatch passes it to the router as one input field. |
| Label | `Run pinned tasks elsewhere when their account can't run`, in the model routing settings. |
| Default | **Off.** |
| Per task | **No override.** A task has no field for it. A pin means what the account says pins mean. |

One account-level setting is enough because the question it answers is about the owner, not the task: "may my work
go to a provider I did not name?" A per-task override would make each pin carry a second meaning that every reader
of a task has to check. An owner who wants one task free to move while the switch is off removes that task's pin; an
owner who wants one task never to move while the switch is on has no way to say so, and that is the accepted limit
of the smallest switch.

**Off (the default): the task holds.** A task whose pinned account health has blocked is not moved. It gets the
`ACCOUNT_NEEDS_ACTION` hold described at the end of this section, with the pin named: `Pinned to <provider>, which
can't run now (<its health line>). Next try at 21:19.` The hold lifts when the pinned account's trial is due, and the
held task takes that trial. The settings row is linked from the hold so the owner can turn relaxation on.

**On: the pin is relaxed for that run.** The pin on the task is not changed: each run decides again, and the task
returns to its pin as soon as the account passes a trial. A pinned task is also the natural taker of that trial,
since the pinned account ranks first for it once the trial is due. The rest of this section, up to "When nothing else
can run", describes the switch on.

Relaxation applies only to health (`blocked`, `cooldown`, `trial-running`). A pinned account that is paused, signed
out or at its quota behaves as it does today.

The pool is widened one step at a time, and the first step with a runnable candidate wins:

| Step | Kept | Dropped | Example |
|---|---|---|---|
| 0 | engine, provider | — | the pin as written |
| 1 | engine | provider | pinned to a Claude pool whose members are all blocked → another Claude account or key on Claude Code |
| 2 | — | engine and provider | pinned to `cursor`, no other Cursor credential → the router's ordinary pick across engines |

What is kept in every step:

- **The tier.** It is the task's size, not part of the pin. The ordinary fit order applies inside the widened pool
  (the tier itself, then a higher one, an untiered default, a lower one).
- **A model pin, exactly.** A task that names a model runs that same model id on another provider × engine that lists
  it and passes the §4.2 filters, in the owner's provider order. If none lists it, the task waits; a named model is
  never swapped for a different one.
- **The owner's limits.** Providers blocked in the SubAgents settings and shared providers out of scope stay out. A
  relaxed pin never reaches a provider the owner excluded.

Why lines, on the Route Decision of the run:

| Step taken | Line |
|---|---|
| 1 | `Pinned to <provider>, which can't run now (<its health line>); runs on <other provider> instead, on the same engine, at tier XL` |
| 2 | `Pinned to <provider> on <engine>, where no account can run now (<its health line>); runs on <model> on <other provider> instead, at tier XL` |
| model pin | `Pinned to <model> on <provider>, which can't run now (<its health line>); runs the same model on <other provider>` |

The task's row shows the same sentence while its newest run is a relaxed one.

**When nothing else can run**: no candidate for an unpinned task (this closes G7), none after relaxation, or a pinned
task with the switch off. `routeTaskRun` no longer falls back to the
Agent's own model when that model's account is blocked. The dispatch holds the task, the way it holds one whose engine
is signed out (`TaskSignInHold`, `src/shared/src/project-progress.ts:1376`). The hold type gains a second kind,
`ACCOUNT_NEEDS_ACTION`, which names each account that could have run it, the provider's words for it, and the
earliest `blocked_until` among them. The hold lifts by itself at that moment: the held task then takes the trial. So
a held task waits at most one block, never indefinitely. The line: `Waiting for an account: <health line>. Next try
at 21:19.`

### 7.6 What the owner chose by hand

- **An interactive session the owner starts by hand** on a blocked account is not refused. It shows the health line on
  the account in the picker. If it is admitted, that success clears the row. This is the cheapest "the owner fixed it"
  signal there is, and it keeps health from ever locking the owner out of their own account.
- **Automatic account choice inside one engine** (`automaticAccount`, `plan-usage-accounts.ts:163`, and the retry's
  account move) treats a blocked account as it treats a paused one, so a runner with two Cursor accounts moves to the
  second. Confirmed in phase 2: the Automatic choice in `switchAccount` (`sessions.service.ts`, the block the design
  pointed at), session create, the move before a turn and `moveOffRemovedAccount` in the same file, the move at claim
  and both pool resolvers in `queue.service.ts`, the two "can it go elsewhere" checks in `auto-retry.service.ts`, and
  the router's `engineState` with the quota and sign-in gates in `tasks.service.ts`. All of them read the runner
  through `withAccountHealth` / `runnerWithHealth` (`providers/account-health-blocked.ts`), which folds a blocked
  account in as a pause until its block ends; nothing is written as a pause, and with every account out the pick is
  as before.

## 8. Owner surface

Kept to three things.

1. **One push**, kind `account-needs-action` (owner decision Q4, as amended). When it is sent depends on how sure
   Orbit is:

   | What happened | Push |
   |---|---|
   | A classified refusal (`ACCOUNT_ACTION_REQUIRED`, `CREDENTIAL_REFUSED`, `ACCESS_DENIED`) | At its **first** occurrence. The provider said so in its own words; there is nothing to wait for. |
   | The unclassified breaker | At its **third consecutive trip**: about 1.5 hours after the first one, with runs flowing. Earlier trips are a guess and often heal by themselves. |

   Title: the runner's name (or the provider's label for a key). Body: `Cursor can't run on this account: "Add a
   payment method to continue". Orbit is using your other accounts and tries this one again from time to time.` For
   the breaker: `Cursor failed to start 4 runs on this account. Orbit is using your other accounts.` Same shape as
   `notifyEngineSignedOut` (`push.service.ts:470`): no badge, no session id, thread `runner-<id>`. The Android client
   must list the new kind or it drops the push.

   **Not again until the state changes.** The row stores `notified_at` and `notified_kind`. After an alert, a further
   one is sent only when one of two things has happened:

   | Change | Then |
   |---|---|
   | The row was cleared (a success, or Check again) and a **new** streak reaches its own alert point: its first classified refusal, or its third breaker trip | one alert for the new streak |
   | The account, still blocked, is refused with a **different classified kind** than `notified_kind` (the breaker's guess became a classified refusal; a payment problem became a credential one) | one alert for the new kind |

   Nothing else alerts: not a later trip of the same kind, not a refused trial, not the daily trial at the cap, not
   different wording inside the same kind, not a classified streak turning unclassified, not a cool-down, and not the
   same account on another model. An owner who presses Check again on an account that is still broken gets one alert
   for it: that is the answer to the press.

2. **The account's row** (runner page and Providers page, where `pausedUntil` is already shown through
   `namedRunnerEngines`, `src/apiserver/src/common/runner-engines.ts:414`), from the **first** trip: `Needs action ·
   Cursor said "Add a payment method to continue" · since Nov 22, 17:19 · tried again at 21:19`, and a **Check again**
   button. A breaker block reads `Not used until 18:05 · failed to start 2 runs`. A suspect account and a cool-down
   show nothing.
3. **Held tasks** show the line of §7.5; in a project this is one Needs you row, as sign-in waits are
   (`ProjectSignInWait`). Runs that went elsewhere because of a pin show the Why line of §7.5.

**Clearing.** Check again calls `POST /account-health/:id/check` (owner only). It clears the row and resets the
ladder: the owner is saying the account is fixed. The next routed run uses it as a healthy account. If the provider
refuses again, that is trip 1 of a new streak (one hour), shown on the row. Everything else ends by itself (§6.3).
There is no "ignore" setting; an owner who wants an account never used already has the SubAgents block list and the
pause.

## 9. Extensibility check

| Engine / credential | Subject | What its adapter can map today | Notes |
|---|---|---|---|
| **Cursor** | runner sign-in; a Cursor API key is a `provider` | §5.3, from the fixed sentences | The incident's sentence becomes `ACCOUNT_ACTION_REQUIRED`. "Your team has switched to …" (contract §12) is a candidate for `ACCESS_DENIED`; map it when the session-level error is routed through the same table. |
| **Codex** | runner sign-in | "hit your usage limit" with its reset time → `USAGE_LIMIT` + `until`; "at capacity" → `CAPACITY` (`src/runner-go/codex.go:57`); "Not logged in" / "OAuth session expired" → `CREDENTIAL_REFUSED` | Codex replays a capacity refusal in place for up to 4.5 minutes before failing the turn (`codex.go:52`); the 5-minute cool-down starts at that failure. Its tiers are one model at several efforts, so the cool-down sets aside every tier of that account. A deactivated workspace or a plan without Codex has no recorded sample yet, so it stays unclassified and the breaker covers it. |
| **Claude** | runner sign-in; subscription-token key | limit sentences → `USAGE_LIMIT`; "Failed to authenticate" → `CREDENTIAL_REFUSED`, except `isConnectionFailure` (`src/runner-go/claude.go:261`) → `TRANSPORT`; `API Error` with an overloaded status → `CAPACITY`, with the model of the turn | The region check stays as it is: it is known before a run and is runner-scoped ([`claude-region-check-contract.md`](./claude-region-check-contract.md)). It is the `runner` scope of `ACCESS_DENIED` in the taxonomy, with its own source. The `TRANSPORT` carve-out matters: on 2026-11-13 two dozen sessions failed with an edge block wrapped as an auth failure; none of them may strike an account. A capacity cool-down on Opus leaves Sonnet on the same account in the pool. |
| **Kimi** | runner sign-in | Kimi reports error **names** (`kimi_acp.go:1538`): the usage-limit name → `USAGE_LIMIT`, `APIProviderOverloadedError` → `CAPACITY`, `APIConnectionError` → `TRANSPORT` | Matched by `Code`, not by text. Names without a recorded sample stay unmapped. |
| **Antigravity** | runner sign-in | the error report carries a numeric code and a status (`antigravity.go:54`): 401 / `UNAUTHENTICATED` → `CREDENTIAL_REFUSED` (already detected, `:674`) | 403 and 429 statuses are natural rows for `ACCESS_DENIED` and `USAGE_LIMIT`; add them from recorded reports. Its quota is already per bucket; a model-level health row sits beside that without touching it. |
| **Claude pool** | `provider:<member>` | as Claude | `KEY_REFUSED` from the usage endpoint keeps feeding `refused`; health adds what only a run reveals. A blocked member is skipped by `bestPoolMember` and by claim-time member choice; each member has its own ladder and its own trial. |
| **Codex pool** | `pool-login:<pool>:<accountId>` | as Codex, plus the gateway's own `spentUntil` / `throttledUntil` | Those two stay where they are (they are gateway-owned). Health adds the refusals the gateway has no column for. |
| **API keys** (any preset, custom endpoints, OpenCode, DSH) | `provider:<id>` | HTTP status where the engine surfaces it: 401 → `CREDENTIAL_REFUSED`; 402 or an "insufficient balance" body → `ACCOUNT_ACTION_REQUIRED`, once recorded; 429 / 529 on one model → `CAPACITY` | Keys are the least mapped and gain the most from the breaker: today a dead key has no exclusion at all (G8). A key is not tied to a runner, so its health is one row for the owner; the per-runner rule of Q5 concerns sign-ins. |
| **A future engine** | whichever of the three it spends | an empty table on day one | Safe through the breaker; precise once its table has rows. The census test (§5.3) makes the empty table a visible decision. |

Every row uses the same two ladders, the same trial and the same alert rule. Nothing in §6 to §8 names an engine.

## 10. Rollout

Three phases. The first is one release that carries both the health model and the structured kinds (owner decision
Q8): health is not shipped on text markers alone.

| Phase | Content | Tests |
|---|---|---|
| **1. Health and structured kinds** (server and runner, one release) | **Runner:** `engineFailure`, the rule tables for Cursor, Codex, Claude, Kimi and Antigravity, `failure` and `admission` on turn-complete, finalize and the SubAgent fallback request, the census test. **Server:** the four session columns; `runFailureKind` in place of the six text call sites; `account_health` and `AccountHealthService` with both ladders, both cool-downs and the trial claim; `health` in routing input; the account and model exclusions and suspect ranking; `notCounted` in run history and in `autoRunHoldOff`; the hold when nothing can run. | **Go:** table tests per engine with recorded fixtures; census; `admission` set and unset. **Shared:** `runFailureKind` prefers the structured kind, falls back to markers. **Unit:** `engineVerdict` reasons per kind; a model entry removes only that model's rows; `compareAccounts` with a suspect; `routeTaskRun` skips and does not escalate; the ladder table of §6.4 row by row to both 24 h caps, including a breaker-then-classified streak; reset on success; idempotent per session; `TRANSPORT` never strikes; a capacity cool-down never trips or alerts. **pg spec:** five refused runs on one account → run 2 routes elsewhere, tier unchanged, budget unspent; two dispatches racing for one due trial → one claims, one routes elsewhere; a refused trial takes the next step; a blocked only-candidate holds the task and the hold lifts at `blocked_until`. **Cross-version:** an old runner against the new server and the reverse. |
| **2. Replace, relax, move** | Immediate replacement run for every task with its bound; SubAgent moves on the new kinds; the `relaxBlockedPins` preference, pin relaxation when it is on (§7.5) and its Why lines; Automatic account choice skips blocked accounts; pool member choice at claim. | **Unit:** switch off holds a pinned task with the pin named; switch on: each relaxation step; tier kept; model pin kept or held; owner's blocked providers never reached. **pg spec:** a refused run of a task that does not auto-run is followed by one replacement, at most 3 per hour, refused trials excepted; SubAgent attempts record `ACCOUNT_ACTION_REQUIRED`; a named model does not move; a pinned task returns to its pin after a successful trial. |
| **3. Owner surface** | Push kind (server, iOS/macOS, Android), the account row line, the Check again route, the hold kind in project open items. | **Unit:** a classified refusal pushes at trip 1 and not at later trips or daily trials; the breaker pushes at trip 3 only; a new streak alerts again at its own alert point; a changed classified kind alerts once; a classified streak turning unclassified does not. **pg spec:** Check again clears and resets the ladder; a refusal after it is trip 1. Client tests for the row and the push kind on each platform. |

Between phases 1 and 2 two things are weaker than the final design, by construction: a refused run is replaced by
the next ordinary dispatch of an auto-run task rather than at once, and a task pinned to a blocked provider always
holds until the trial is due, because the setting that lets it run elsewhere arrives in phase 2. Between phases 1 and
3 the owner sees blocks in Why lines and hold reasons only; there is no push yet.

**Migration.** One new table (`account_health`, with its partial unique index on `owner_id, subject_key,
scope_model`) and four nullable columns on `session`. No backfill: history before the change is read through the
legacy markers, which is what it is read through today. Both are additive, so old and new server replicas can run side
by side; an old replica simply ignores the fields.

**Mixed versions.** Phase 1 is released as one version, but runners update on their own schedule. A runner that has
not updated sends no `failure`: its usage-limit, capacity, auth and connection errors classify through the markers as
today, and anything else, the incident's Cursor sentence included, is handled by the breaker using the
server-derived admission flag (§5.2). No temporary text rule is added for it. A new runner against an old server: the
server ignores the new fields and the sentences still match. Neither direction needs a gate.

**Risks**

| Risk | Mitigation |
|---|---|
| A provider rewords a sentence and a rule stops matching. | The failure becomes unclassified and the breaker still acts. Fixed sentences are already pinned per CLI build and regressed on upgrade (Cursor contract §12). |
| A rule is too broad and blocks healthy accounts. | Rules are exact matches with a recorded fixture; the first block is one hour and ends in a trial; a hand-started session clears it. |
| The breaker blames an account for a repository's fault. | Demote first, block for 30 minutes, clear on any success (§6.4). |
| Exempting refusals from the budget creates a respawn loop. | The health row removes the account; the replacement bound (3 per hour) caps the rest; no candidate → hold, not run. |
| Trials are noise: an account that stays broken refuses about five runs in the first 31 hours and one a day after that, on either ladder. | Each is free, replaced at once and marked as a trial in the task's history. Fixing the account, pausing it or blocking the provider stops them. |
| The owner pays and Orbit still avoids the account. | At most one block's wait, then a trial succeeds; Check again ends it at once; any hand-started session ends it. |
| An unmapped failure is reported late: the breaker does not push before its third trip, and trips advance only when a run is routed to the account. | A classified refusal pushes at once, so the delay applies only to failures no adapter has mapped; the account row and the Why lines show those from the first trip. Mapping the sentence removes the delay. |
| A relaxed pin sends work to a provider the task was pinned away from on purpose. | It cannot happen unless the owner turned `relaxBlockedPins` on; it is off by default. When on, the owner's blocked providers and scope are still kept (§7.5), and the Why line and the task row say where it ran. |
| With the switch off, pinned tasks stand still while their account is blocked. | The hold names the pin, the provider's words and the next try, and links the setting; the classified refusal has already pushed. |
| Every account ends up blocked and nothing runs. | That is the correct outcome when nothing can run; the hold names each account's reason and lifts at the first trial. |
| Many tasks rush a just-expired block. | The trial claim admits one run; the rest see the account as being tried. |

## 11. Owner decisions (2026-11-23)

The owner ruled on all eight questions. Each ruling is stated with what it changed in this document.

| # | Question | Ruling | Effect |
|---|---|---|---|
| Q1 | How long does a classified refusal block an account? | Not open-ended. A progressive delay: 1 h for the first block, doubling per consecutive one (2 h, 4 h, 8 h, 16 h), capped at 24 h. Any success resets it. The unclassified breaker keeps its design. **Amended (A2):** the breaker's ladder is raised to the same 24 h cap. | §6.4 has two ladders on one `trips` counter: classified 1, 2, 4, 8, 16, 24 h; breaker 30 min, 1, 2, 4, 8, 16, 24 h. The breaker is at or below the classified ladder at every step and reaches the cap one trip later. `blocked_until` is always set (§6.2). |
| Q2 | Is a blocked account ever tried again by itself? | Yes. Once the ladder is at its cap, one trial every 24 hours until one succeeds or the owner clears the account. | §6.5: every block ends with one trial, which is an ordinary routed run claimed by one dispatch, not a probe. A refused trial costs its task seconds and no money, is replaced at once and is not counted. There are no adapter probes in the design. |
| Q3 | Does a task that does not auto-run get a replacement run by itself? | Yes. The per-hour cap stays. | §7.3: every task is replaced at once after an uncounted admission refusal, at most 3 times an hour, and the replacement is recorded on the task. |
| Q4 | When is the owner alerted? | From the third consecutive trip on an account, then not again until the state changes. **Amended (A1):** a classified refusal alerts at its first occurrence; the third-trip rule applies to the unclassified breaker only. | §8: one push at the first classified refusal, or at the breaker's third trip. "Changes" means the row was cleared and a new streak reaches its own alert point, or the account is refused with a different classified kind. Later trips and daily trials do not alert. The account row shows every block from the first trip. |
| Q5 | Is health per runner or shared across runners? | Per runner (runner × engine × account). | §6.1: unchanged from the proposal. A second runner on the same provider account learns by one refused, replaced run. |
| Q6 | Does `CAPACITY` write health? | Yes: a 5-minute cool-down per model, scoped to that model on that account. | §6.1 and §6.2: `scope_model` is part of the row's key. §6.4: the capacity cool-down, which is not a trip. §7.1: `health` is a list with a `model` field; a model entry removes only that model's rows. |
| Q7 | What does a task pinned to a blocked provider do? | It runs elsewhere. **Amended (A3):** only when the owner allows it. | §7.5: one account-level preference, `relaxBlockedPins`, off by default, with no per-task override. Off: the task holds with the pin named and takes the pinned account's next trial. On: the pin is relaxed for that run only, provider first and engine second; the tier is kept; a model pin is kept exactly; the owner's blocked providers stay out; the Why line says where it ran and why. |
| Q8 | Does the server-only part ship first? | No. Health and structured kinds ship together. | §10: three phases; phase 1 is one release of server and runner. The temporary text rule for Cursor's sentence is gone; a runner that has not updated is covered by the breaker. |

**Amendments accepted by the owner the same day (2026-11-23).**

| # | Amends | Amendment | Why |
|---|---|---|---|
| A1 | Q4 | A classified refusal pushes at its first occurrence. The third-consecutive-trip rule stays for the unclassified breaker. The no-repeat rule is unchanged. | Waiting for a third trip delayed a certain, provider-stated problem by about three hours, and for ever on an account few runs reach. |
| A2 | Q1, Q2 | The breaker's ladder is 30 min, 1 h, 2 h, 4 h, 8 h, 16 h, 24 h. | With a 6 h cap an unmapped failure was tried four times a day, more often than a mapped one. Both now end at one trial every 24 hours. |
| A3 | Q7 | A pin is relaxed only when `relaxBlockedPins` is on. It is off by default, account-level, with no per-task override. | A pin can exist to keep work away from other providers. Moving it must be the owner's choice. |

Three definitions in this document go beyond the wording of the rulings and are stated here so that they can be
corrected:

1. **Check again resets the ladder** (§8). The owner's press is treated as "it is fixed": the account is used as
   healthy and a new refusal starts at one hour. A sign-in, a saved key or a changed plan reading only makes the trial
   due now and keeps the ladder (§6.3).
2. **A model pin is never swapped** (§7.5). With the switch on, Q7 is applied to provider and engine pins. A task that names a model keeps
   that model on another provider, or waits.
3. **Pins are relaxed for health only** (§7.5), and only with the switch on. A pinned account that is paused, signed out or at its quota behaves as
   it does today.
