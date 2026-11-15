# Recovery contract (v1)

One envelope that tells any client what happened to a failed (or advised) call and what may be done
next. The MCP server, the CLI and the web read the same stable fields and reach the same branch.

- Authority: [`contracts/recovery.contract.json`](../contracts/recovery.contract.json): fields, enums,
  action codes, the legacy code table and the status rules.
- Vectors: [`contracts/recovery.fixtures.json`](../contracts/recovery.fixtures.json). Both parsers
  are tested against every vector.
- TypeScript: `src/shared/src/recovery.ts` (`parseRecovery`, `legacyRefusalText`), tested in
  `recovery.spec.ts`.
- Go (runner, `orbit mcp`, CLI): `src/runner-go/recovery.go` (`parseRecovery`, `recoveryOf`), tested
  in `recovery_test.go`.

## 1. Inventory: the shapes in use before v1

| Surface | Shape today | Where |
| --- | --- | --- |
| API refusal | Nest `HttpException` body `{statusCode, error, code, message, owner?, requiredAction?, ...ids}`. `requiredAction` can be a token (`FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF`) or a sentence. `owner` is `USER`, `COORDINATOR` or `SYSTEM`. | e.g. `tasks/task-run-receipt.ts`, `projects/*` |
| API advisory | Refused write (409) with `kind: 'ADVISORY', advisory: true`, answered by changing the request or sending it again with an override. | `tasks/task-criterion-shape-advice.ts` |
| API validation | `ValidationPipe` 400 with `message: string[]`, no `code`. | Nest default |
| Transient DB | 503 `TRANSIENT_DB_CONFLICT`, `retryable: true`, `retryAfterSeconds`, plus a `Retry-After` header. | `@orbit/shared` `dbConflict.ts` |
| Runner link | Every error carries `code`, `retryable`, `retryAfterMs?` and the `Retry-After-Ms` header. | `common/runner-link-error.filter.ts` |
| Runner transport (Go) | `transportHTTPError{status, body, retryAfter}`. `Error()` prints the `refused`/`advice`, `what`, `owner`, `do` block above the raw body. Retry is decided by status (`isRetryableTransportError`) or by code (`isResendableRunFailure`). | `src/runner-go/transport.go` |
| MCP | `toolResult(err.Error(), true)`: the same text as a terminal, inside `content[0].text`. | `src/runner-go/mcp.go` |
| CLI | Prints `err.Error()` and exits non-zero. | `src/runner-go/*_cli.go` |
| Local validation | Plain `errors.New("... is required")` before anything is sent. | MCP and CLI argument checks |

What went wrong with these shapes: every reader re-derived "may I resend this?" its own way, from
the status, from a code it knew about, or from the wording. Nothing told a reader whether a write
had happened. And remedies were written either as prose or as a client-side guess keyed on a code.

## 2. The envelope

| Field | Meaning |
| --- | --- |
| `contractVersion` | `1`. |
| `code` | Stable UPPER_SNAKE code. The server's own code, otherwise `HTTP_<status>`, `LOCAL_*` (local validation), `TRANSPORT_NO_ANSWER` or `UNKNOWN_ERROR`. |
| `message` | For people. **Never branched on.** |
| `kind` | `REFUSAL`, `ADVISORY`, `VALIDATION`, `TRANSPORT` or `UNKNOWN`. |
| `status` | HTTP status when an answer arrived, otherwise `null`. |
| `effect` | What the request did to stored state: `NONE`, `COMMITTED` or `UNKNOWN`. |
| `retry.policy` | `SAFE`, `SAME_REQUEST_ID`, `VERIFY_THEN_RETRY`, `AFTER_STATE_CHANGE` or `NEVER` (see §3). |
| `retry.afterSeconds` | Whole seconds to wait, or `null`. Always `null` when the policy is `NEVER`. |
| `actor` | Who has to act to clear it: `CALLER`, `COORDINATOR`, `USER` or `SYSTEM`. |
| `owner` | The legacy `owner` field, verbatim. |
| `actionCode` | The semantic recovery action (§4), or `null`. |
| `requiredAction` | The legacy `requiredAction`, verbatim (a token or a sentence). |
| `userConfirmation` | `REQUIRED` when a person has to confirm before the request can pass, otherwise `NOT_REQUIRED`. |
| `resources` | `[{type, id}]`: the rows this failure is about. |
| `disposition` | What kind of next step is left: `AUTOMATIC`, `WAIT`, `CONFIRM_THEN_RUN`, `HUMAN` or `STOP` (§3.2). |

A server states what it knows in a `recovery` block next to the legacy flat fields:
`{effect, retryPolicy, retryAfterSeconds, actionCode, actor, userConfirmation, resources, disposition}`. Every
field is optional. A stated value beats an inferred one, but the result is then held to the
cross-field invariants (§3.1), so no combination of stated fields can advise an unsafe resend. A
value outside its enum, or an action code that is not a token, is ignored. Older clients ignore the block, so adding it changes
nothing for them.

## 3. Decision rules

The parser reads only these fields: `code`, the status, the `recovery` block, `retryable`,
`advisory`/`kind`, `owner`, `retryAfterSeconds`/`retryAfterMs`, the `Retry-After-Ms` and
`Retry-After` headers (whole seconds only, never an HTTP date), and whether the request carried a
request id. A token `requiredAction` (matching `^[A-Z][A-Z0-9_]*$`) also counts as stable. A prose
`message` or `requiredAction` is never read: the "prose rewording" tests replace every sentence and
check that the branch stays the same.

Each field below is first resolved on its own. The policy and action code that come out are only
candidates: §3.1 decides what the envelope finally carries.

**Retry policy.** The first rule that matches wins:

1. `recovery.retryPolicy`.
2. The contract's `legacyCodes[code]`, for codes served before the block existed. For example,
   `TASK_RUN_REQUEST_IN_PROGRESS` maps to `SAME_REQUEST_ID` and `TASK_RUN_REQUEST_MISMATCH` maps to
   `NEVER`.
3. A 2xx response maps to `NEVER`: the write stands, so resending it would apply it twice.
4. `retryable: true` maps to `SAFE`.
5. An advisory maps to `NEVER`: the advice is answered by changing the request.
6. 408 and 429 map to `SAFE`.
7. 401, 403, 409, 412, 423, 424 and 428 map to `AFTER_STATE_CHANGE`.
8. Any other 4xx maps to `NEVER`.
9. A 5xx with `retryable: false` maps to `NEVER`.
10. Anything else (an uncoded 5xx, a gateway page, no answer at all, an unknown error) maps to
    `SAME_REQUEST_ID` when the request carried a request id, otherwise to `VERIFY_THEN_RETRY`.

Local validation always maps to `NEVER`.

What each policy lets a client do:

- `SAFE`: send the identical request again, after `afterSeconds` when one is given. Nothing was
  written.
- `SAME_REQUEST_ID`: resend only under the same request id. The server then reads back the first
  answer instead of applying the request twice.
- `VERIFY_THEN_RETRY`: the outcome is unknown and no id protects a resend. Read the resource first,
  and resend only if the write is not there.
- `AFTER_STATE_CHANGE`: the same answer comes back until something outside the request changes: a
  person decides, a credential is renewed, or a dependency lands.
- `NEVER`: the request is never accepted as sent (or it was already accepted). Change it instead of
  resending it.

**Effect.** The first rule that matches wins:

1. `recovery.effect`.
2. `legacyCodes[code]`.
3. A 2xx response maps to `COMMITTED`.
4. `retryable: true`, or any status below 500, maps to `NONE`.
5. Otherwise the effect is `UNKNOWN`.

No answer and unknown errors are `UNKNOWN`. Local validation is `NONE`.

**Kind.** An advisory, or a 2xx carrying a `recovery` block, is `ADVISORY`. Any other response with a
code is `REFUSAL`. A 400 or 422 JSON body with no code is `VALIDATION`. Any other answer with no code
is `TRANSPORT`. No answer is `TRANSPORT`, local validation is `VALIDATION`, and anything else is
`UNKNOWN`.

**Actor.** The first rule that matches wins: `recovery.actor`, then `legacyCodes`, then the legacy
`owner` (`USER`, `COORDINATOR` or `SYSTEM`), then `CALLER`.

**User confirmation.** The first rule that matches wins: `recovery.userConfirmation`, then
`legacyCodes` (crossings waiting on the account owner), then `NOT_REQUIRED`.

**Resources.** `recovery.resources` when present. Otherwise the legacy id keys, in this order:
`taskId`→`TASK`, `sessionId`→`SESSION`, `projectId`→`PROJECT`, `crossingId`→`CROSSING` and
`triggerId`→`REQUEST`.

### 3.1 Cross-field invariants

Both parsers apply the same normalization (`normalizeRecovery`) after every field is resolved. The
steps run in this order, and the contract lists them under `invariants.rules`. *Has a request id*
means the client sent one, or the answer names one (a `REQUEST` resource).

1. `UNKNOWN_VERIFIES_FIRST`: if the effect is `UNKNOWN`, the policy stays `SAME_REQUEST_ID` only when
   it already was and there is a request id. Anything else (`SAFE`, `NEVER`, `AFTER_STATE_CHANGE`,
   or `SAME_REQUEST_ID` without an id) becomes `VERIFY_THEN_RETRY`. The action is the policy's own:
   `VERIFY_STATE` or `RETRY_SAME_REQUEST`. A `500` with `retryable: false` therefore says verify
   first, not `FIX_REQUEST`.
2. `SAME_REQUEST_ID_NEEDS_AN_ID`: with no request id, `SAME_REQUEST_ID` becomes `VERIFY_THEN_RETRY`.
3. `CONFIRMATION_BLOCKS_AUTOMATIC_RETRY`: if `userConfirmation` is `REQUIRED`, `SAFE` and
   `SAME_REQUEST_ID` become `AFTER_STATE_CHANGE` (or `VERIFY_THEN_RETRY` when the effect is
   `UNKNOWN`), and an automatic-retry action becomes `AWAIT_OWNER_DECISION`.
4. `AUTOMATIC_RETRY_MATCHES_POLICY`: an automatic-retry action that does not match the final policy
   is dropped. The policy's default then fills an empty action, except on 2xx answers.
5. `NEVER_HAS_NO_WAIT`: if the policy is `NEVER`, `afterSeconds` is `null`.
6. `COMMITTED_IS_FINAL`: this step runs last and overrides every step before it. If the effect is
   `COMMITTED`, the policy is `NEVER`, there is no wait, and the action survives only if it is
   read-only (`VERIFY_STATE`). Any action that may lead to another write is removed, whether it was
   stated, came from the legacy code table, was a token `requiredAction`, or was produced by step 3.

As a result, `SAFE` survives only on effect `NONE`, and a committed write never advises another
write.

### 3.2 Disposition

After §3.1, both parsers (`dispositionOf`, `recoveryDispositionOf`) resolve one disposition from the
final fields, by the first rule that matches (contract `disposition.rules`):

1. `COMMITTED_STOPS`: effect `COMMITTED` → `STOP`.
2. `CONFIRMATION_FIRST`: `userConfirmation` `REQUIRED` → `CONFIRM_THEN_RUN`.
3. `STATED`: `recovery.disposition`, when it is a value of the enum.
4. `STAND_DOWN_STOPS`: action `STAND_DOWN` → `STOP`.
5. `LOOP_OR_DEPTH_STOPS`: action `STOP_LOOP` or `RETURN_TO_PARENT` → `STOP`.
6. `THE_STATE_MOVES`: action `WAIT_FOR_SESSIONS`, `POLL_STATE` or `AWAIT_SYSTEM_FIX` → `WAIT`.
7. `RESEND_OR_VERIFY_IS_AUTOMATIC`: policy `SAFE`, `SAME_REQUEST_ID` or `VERIFY_THEN_RETRY` → `AUTOMATIC`.
8. `A_PERSON_DECIDES`: action `AWAIT_OWNER_DECISION` or `AWAIT_USER_FIX`, or actor `USER` → `HUMAN`.
9. `THE_SYSTEM_MOVES`: actor `SYSTEM` → `WAIT`.
10. `STATE_CHANGE_WITH_NO_ACTION`: policy `AFTER_STATE_CHANGE` and no action → `WAIT`.
11. `OTHERWISE` → `AUTOMATIC`.

What each one tells an agent:

| Disposition | The agent |
| --- | --- |
| `AUTOMATIC` | Carries out the step itself: a resend the policy allows, a read, or a changed request. |
| `WAIT` | Waits for the system (a prerequisite lands, a runner comes back), then asks again. |
| `CONFIRM_THEN_RUN` | Asks the user to confirm. The confirmation applies the change, or lets the caller send it. |
| `HUMAN` | Hands it to a person. Nothing it sends changes the answer until they have acted. |
| `STOP` | Sends nothing more for this request. |

Rules 1 and 2 come before a stated value, so no server can state its way past a required confirmation
or a write that already went through.

**Action semantics.** Each action in the registry declares two flags:

- `automaticRetry`: carrying it out resends the identical request with nobody in between. This is
  true for `RETRY` and `RETRY_SAME_REQUEST` only.
- `mayWrite`: carrying it out can end in another write. That covers a resend, a changed request
  (`FIX_REQUEST`), a request under a new id (`USE_NEW_REQUEST_ID`), answering advice
  (`ANSWER_ADVICE`), writing again after a decision (`AWAIT_OWNER_DECISION`), or a handoff
  (`FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF`).

`VERIFY_STATE`, `STAND_DOWN`, `POLL_STATE`, `RETURN_TO_PARENT` and `STOP_LOOP` have `mayWrite: false`: they read
or stop, and none of them sends this request again (§11). A token the registry does not list counts as
`mayWrite: true`. The contract derives `automaticRetryActionCodes` and `readOnlyActionCodes` from
these flags. Steps 3 and 4 use the first list, and step 6 uses the second.

Every envelope satisfies the checks in `invariants.holdsOnEveryEnvelope`. Both test suites check
them on every fixture, and on all 11,880 combinations a server block can state (effect × policy ×
action, including one unregistered token, × confirmation × request id × status × `retryable`).
The check reads `mayWrite` and `automaticRetry` from the contract file itself rather than from the
parser's tables, so if the parser misclassifies an action, the check still catches it.

## 4. Action codes: semantic, never a tool or a command

The server names *what* has to happen, for example `AWAIT_OWNER_DECISION` or `VERIFY_STATE`. It never
names *which* MCP tool or CLI command does it. Each client maps action codes to its own surface, so
the same refusal reads correctly over MCP and at a terminal, and renaming a tool never changes the
server. `TestRecoveryActionCodesAreNeverToolNamesOrCommands` checks that no action code is an MCP
tool name in any case.

The action code comes from the first of these that applies: `recovery.actionCode`, then
`legacyCodes`, then a token `requiredAction`, then the policy's default. The result is held to §3.1.
A 2xx response gets no default, and a `COMMITTED` effect keeps only a read-only action. The defaults are:

| Policy | Default action |
| --- | --- |
| `SAFE` | `RETRY` |
| `SAME_REQUEST_ID` | `RETRY_SAME_REQUEST` |
| `VERIFY_THEN_RETRY` | `VERIFY_STATE` |
| `AFTER_STATE_CHANGE` | none |
| `NEVER` | `FIX_REQUEST` |

Four actions read first or stop, and a server states them itself:

| Action | Meaning |
| --- | --- |
| `REREAD_AND_DECIDE` | Read the first resource that has a reader, decide again against what it says now, then write a changed request or none. The identical request is refused again. |
| `READ_GRAPH_AND_REPLAN` | Read the dependency graph around the first `TASK`, then write only the edges that are still missing and close no cycle. |
| `ASSIGN_AGENT` | Give the task an agent bound to a runner, then send the request again. |
| `STAND_DOWN` | Stop. Read the resources it names to see where the work went. |

The registry is in the contract. An unknown token passes through, and a client with no mapping for
it falls back to the prose.

## 5. Backward compatibility

The Go transport's text is unchanged byte for byte. That covers the `refused:` or `advice:` line, the
`what:`, `owner:` and `do:` lines, the raw body underneath, and the `METHOD PATH -> STATUS` line.
`TestRecoveryLegacyRefusalTextIsUnchanged` runs the existing `transportHTTPError.refusal()` and
`Error()` against every HTTP vector. `legacyRefusalText` in TypeScript produces the same block from
the same vectors. Legacy flat fields stay on every body, and `owner` and `requiredAction` are copied
into the envelope verbatim.

The API emits the `recovery` block for the Project and Task refusals in §10 and for the session
lifecycle and spawn backpressure refusals in §11. Other refusals are still read by inference.

## 6. Replaying under the same request id (`SAME_REQUEST_ID`)

These doors key their receipt on an id. The server returns the first delivery's answer to a later
delivery under the same id, and refuses the same id with a different payload with a 409. Callers
can only use this if they know the id, so the runner (`src/runner-go/call_identity.go`) does the
following for each one:

| Door | Id | MCP | CLI |
| --- | --- | --- | --- |
| task start | `triggerId` | `task_start {taskId, triggerId?}` | `orbit task start ID [--trigger-id ID]` |
| session message | `clientTurnId` | `session_send {sessionId, message, clientTurnId?}` | `orbit session send ID --message … [--client-turn-id ID]` |
| interrupt with a follow-up | `clientTurnId` | `session_interrupt {sessionId, message, clientTurnId?}` | `orbit session interrupt ID --message … [--client-turn-id ID]` |
| project coordinator message | `clientTurnId` | `project_send {projectId, message, clientTurnId?}` | `orbit project send ID --message … [--client-turn-id ID]` |

- **One id per logical call.** If the caller gave no id, the runner draws one, sends every attempt
  under it, and adds it to the answer. A new call without an id gets a new id. A plain interrupt
  (no message) has no key.
- **Bounded resend.** A delivery is sent again only while the request is unanswered. For task
  start that means no answer, or `TASK_RUN_REQUEST_IN_PROGRESS`. For session messages and
  interrupts it means no answer, or 502, 503 or 504. Each wait is the backoff (250 ms, 500 ms, 1 s)
  or the server's `retryAfterSeconds`, whichever is longer, capped at 5 s. There are at most 4
  deliveries in total. `project_send` is not resent automatically, because the coordinator it
  resolves to can change between deliveries.
- **What the error says next is the contract's decision, not the resend rule's.** The error keeps
  the server's text first, then adds `  triggerId: "ID"` (or `  clientTurnId: "ID"`). The ID is a
  JSON string, so a caller-chosen key with a space, a quote or a newline in it reads back exactly
  and cannot forge a line of its own. The next step is
  read from `recoveryOf(err, true)`, the envelope normalized with the request id present:
  - The effect is not `NONE` (no answer, a gateway page, a plain 5xx, or an explicit `UNKNOWN`), or
    the policy is `SAME_REQUEST_ID` or `SAFE`: a `replay:` line with the exact call under the
    **same** id.
  - The policy is `VERIFY_THEN_RETRY`: check whether the write took effect, and if it did not,
    replay under the same id.
  - The effect is `COMMITTED`: do not send it again.
  - Otherwise, the server answered and nothing was written (a mismatch, or a refusal that holds
    until something changes): a `next:` line saying to make a new request without the id once
    that has changed.

  So a failure that may have written is never answered with "make a new request". The server's
  mismatch check still stops one id from naming two payloads.
- **The replay is the request that was sent.** It is built from the body actually sent, so it
  keeps every field that shapes the request: `resumeIfEnded`, `expectReply`, `replyOptions` and
  `replyWithinSeconds` as MCP arguments, or as `--resume-if-ended`, `--expect-reply`,
  `--reply-options` and `--reply-within-seconds` in the CLI argv. The server fingerprints a request,
  so a replay that dropped one of them would be refused as a different request.
- **The replay is data, not a command line.** The MCP form is the tool name and its arguments as
  JSON. The CLI form is `argv [...]`: a JSON array whose argv[0] is this binary's own path, run as
  written with no shell. Messages are read from stdin (`--message-file -`), so neither the message
  nor any id or target the caller supplied is ever pasted into shell text.
- `TASK_RUN_REQUEST_IN_PROGRESS` carries `retryAfterSeconds` (2) next to its `triggerId`.

Tests: `src/runner-go/call_identity_test.go` covers a lost answer, concurrent deliveries,
IN_PROGRESS, mismatch, an exhausted bound, a failure that may have written (gateway 5xx, plain
500, explicit `UNKNOWN`), and an agent replaying the id read from the error, over MCP and the CLI.
`src/apiserver/src/sessions/client-turn-id-replay.pg.spec.ts` holds the server's half on
PostgreSQL: racing deliveries and replays of one clientTurnId leave one turn (one interrupt and one
follow-up), and a different payload under the same key writes nothing.

## 7. How MCP and the CLI report a failure

`src/runner-go/recovery_render.go` turns every failed call into one report, on both surfaces:

```json
{
  "ok": false,
  "error": { "contractVersion": 1, "code": "TRANSIENT_DB_CONFLICT", "effect": "NONE",
             "retry": { "policy": "SAFE", "afterSeconds": 2 }, "actionCode": "RETRY", "...": "..." },
  "next":  { "type": "invoke", "actionCode": "RETRY", "afterSeconds": 2, "reason": "...",
             "argv": ["/usr/local/bin/orbit", "task", "create", "--title", "x", "--description-file", "-", "--json"],
             "stdin": "the description, verbatim\n" },
  "text":  "orbit task: POST /runner/tasks -> 503 ..."
}
```

- **`error`** is the §2 envelope from `recoveryOf`. The same server answer gives the same `error` over
  MCP and at the CLI. That includes `code`, `effect`, `retry`, `actionCode`, `actor`,
  `userConfirmation` and `resources`.
- **The error is read from what the call really did.** If the error value carries an HTTP answer or a
  transport failure, it is read directly. Otherwise the renderer takes the newest failure this process
  recorded during the call whose text appears in the printed message. If the call sent nothing at
  all, the failure is local: `LOCAL_INVALID_REQUEST`, effect `NONE`. Anything else is
  `UNKNOWN_ERROR`. If a write in the same call went through before the failure, an effect of `NONE`
  becomes `UNKNOWN`, so the call is verified before anything is sent again.
- **A request id** counts as sent when the call carried `idempotencyKey`, `clientTurnId` or
  `triggerId`, or the matching CLI flags `--idempotency-key`, `--client-turn-id` or `--trigger-id`.
  A `project_create` or `session_create` sends its id in `X-Orbit-Request-Id` (§8), so it counts as
  `requestId` / `--request-id`. It is read from that header only, because other bodies use a
  `requestId` field for something else.
- **`next`** is the one step this surface can take now. `type` is one of the following:
  - `invoke`: over MCP it carries `tool` and `input`. At the CLI it carries `argv`, an array whose
    first element is the absolute path of this executable, and `stdin`, the exact bytes to write to
    standard input (absent when the command reads none). A CLI step is never a shell string: user
    text stays one argv element or stays in stdin, exactly as it was given.
  - `ask_user`: a person has to decide (`AWAIT_OWNER_DECISION`, a required confirmation, or actor
    `USER`).
  - `wait`: wait `afterSeconds`, or until the system changes the state.
  - `manual`: change the request, or check the state by hand.
  - `stop`: send nothing more of this kind (`STAND_DOWN`, `STOP_LOOP`, `RETURN_TO_PARENT`).

  How each action code maps to a step:

  | actionCode | Step |
  | --- | --- |
  | `RETRY`, `RETRY_SAME_REQUEST` | `invoke` the same call, only if this surface exposes it. `RETRY_SAME_REQUEST` also needs the call to have carried its request id. Otherwise `wait` (when there is an `afterSeconds`) or `manual`. |
  | `VERIFY_STATE` | `invoke` the reader of the first resource that has one: `TASK` → `task_get`, `SESSION` → `session_get`, `PROJECT` → `project_get`, or `orbit <type> get ID --json`. Only an id that is one safe path segment and does not start with `-` is handed on. With no reader, `manual`. |
  | `AWAIT_OWNER_DECISION` | `ask_user`. |
  | `REREAD_AND_DECIDE` | `invoke` the reader of the first resource that has one (as `VERIFY_STATE`). `ask_user` when a confirmation is required, `manual` with no reader. |
  | `READ_GRAPH_AND_REPLAN` | `invoke` `task_dependency_graph` (`orbit task dependency-graph ID --json`) on the first `TASK`. `ask_user` when a confirmation is required, `manual` without the capability. |
  | `STAND_DOWN` | `stop`. |
  | `POLL_STATE` | `wait` `afterSeconds`, then read the resource in `error.resources`. Never an `invoke`, so every surface gives the same step. |
  | `WAIT_FOR_SESSIONS`, `AWAIT_SYSTEM_FIX` | `wait`. |
  | `AWAIT_USER_FIX` | `ask_user`. |
  | `RETURN_TO_PARENT`, `STOP_LOOP` | `stop`. |
  | `CREATE_REPLACEMENT` | `manual`. |
  | none | `ask_user` when a confirmation is required or the actor is `USER`. `manual` on a `COMMITTED` write. `wait` when the actor is `SYSTEM` or there is an `afterSeconds`. Otherwise `manual`. |
  | anything else | `ask_user` when a confirmation is required, otherwise `manual`. |

  "Exposes" means the tool appears in this server's `tools/list` (orchestration, watch, wiki and
  `ORBIT_MCP_TOOLS` gating included), or the command is an `available` entry of
  `orbit capabilities --json`. When the capability is missing, the step degrades: it is never an
  invoke that cannot run. `available` follows the credential in effect: under an invalid or expired
  service token, or on a machine with no runner credential, the entries that send with it are
  `available: false`, with the `unavailableCode` in `unavailableCapabilities`
  (docs/orbit-agent-contract.md §2.5). A recovery step therefore never names them.

**MCP.** `content[0].text` and `isError` are byte for byte what they were, so a client that reads
only the text sees no change. The report is added as `structuredContent`, including for tools that declare an
`outputSchema` and refusals before dispatch. `tools/list` advertises an object schema with `anyOf`
branches for the original success schema and the recovery report, so schema-validating clients can
read both. The original first text block and `isError` are unchanged; no second block is appended.

**CLI.** A successful `--json` call prints what it always printed. A failed `--json` call exits `1`
and prints the report as exactly one JSON document on **stdout**, so a single
`JSON.parse` of stdout reads it. JSON-mode stdout is spooled to a private temporary file until the
command succeeds, then copied unchanged. If a later page fails (`task list --all` or `api --paginate`),
the partial output is discarded before the failure report is written. Successful NDJSON stays NDJSON.
Diagnostic stderr is separate from the machine-readable stdout document. `text` is the line a person would have read. Without `--json`, a failure prints
that same `orbit <command>: <error>` line on stderr, exactly as before. The stdin of `orbit provider`
and `orbit token` may hold a credential, so it is never echoed back, and those commands are not
offered again. Neither is a command whose stdin exceeded 256 KiB or was not UTF-8.

Revision 2 also routes `whoami`, `api` and other flag-parsed command failures through the shared CLI
boundary. API status errors retain their original human text while exposing the transport cause to
the renderer. Commands without a `--json` mode and child-process passthrough commands are outside
this JSON contract. The API states its own `recovery` block for the refusals in §10.

The recovery tests include serialized MCP initialize/list/call responses validated with Ajv against
the advertised output schema, pre-dispatch capability refusals, and real CLI subprocess failures
across command families, partial task/API pagination, and `whoami` after it has written identity data.

Revision 3 derives request identity from the failed outbound request body, including generated IDs;
empty or whitespace-only IDs do not protect a retry. MCP and CLI use that same metadata. A same-ID
replay is offered only if the suggested input/argv preserves the actual sent ID. In particular, an
`orbit task start` trigger generated after parsing is recognized, but replaying argv that would draw
a new trigger stays manual. JSON-mode detection uses the selected command's option value boundaries
and Go boolean forms, including the last repeated value. String flag values such as `--json` and
`--client-turn-id=x` remain literal user text. A source-based test checks the boundary grammar against
typed flag registrations; real subprocess tests cover literal values, boolean forms, empty IDs,
explicit IDs and generated triggers while retaining the revision 2 regression suite.

## 8. `project_create` and `session_create`: request ids and receipts

**Identity.** Every create invocation is sent under a request id in `X-Orbit-Request-Id`
(`src/runner-go/create_request.go`). The runner draws one per MCP tool call or CLI invocation, and keeps
it for that invocation. A caller repeating a create whose answer it never saw passes the id back as
`requestId` (MCP) or `--request-id` (CLI). Ids are 1 to 200 characters of letters, digits, `.`, `_`, `:`
or `-`.

**Receipt.** The control plane keeps one row per (owner, kind, request id) in `create_request_receipt`
(migration 0645, `src/apiserver/src/runner-api/create-request-receipts.ts`). The first delivery claims
the row before it creates anything, then stores the answer on it. The answer carries
`requestReceipt: {requestId, kind, resourceId, receivedAt, replayed}`.

| A delivery under an id that... | Answer |
| --- | --- |
| is the first | Creates, keeps the answer, `replayed: false`. |
| repeats a COMPLETED request (same payload and calling session) | The kept answer, the same `resourceId` and `receivedAt`, `replayed: true`. Nothing is created. |
| arrives while the first is still creating | Waits up to 10 s for the first answer and returns it; otherwise `409 CREATE_REQUEST_IN_PROGRESS` (effect `UNKNOWN`, `SAME_REQUEST_ID`). |
| carries a different payload or calling session | `409 REQUEST_ID_REUSED` (effect `NONE`, `NEVER`, `USE_NEW_REQUEST_ID`). |
| follows a first delivery that failed with a 4xx | The id is free again: a 4xx wrote nothing. |
| follows a first delivery that failed otherwise, or died holding the row (lease 120 s) | `409 CREATE_REQUEST_OUTCOME_UNKNOWN` (effect `UNKNOWN`, `VERIFY_THEN_RETRY`): look first, and create again only under a new id. |

A different request id is a different request, with one reconciliation (§9): a `project_create` refused
`ALREADY_COORDINATING` whose payload and calling session match a COMPLETED receipt for the very project
the session coordinates is that receipt's answer, marked `replayOf: {requestId, kind, resourceId,
receivedAt, replayed: true}`. A request with no id writes no receipt and behaves as before.

**Unknown outcomes.** No answer, a body cut off after the status line, an unparsable body and an uncoded
5xx are effect `UNKNOWN`. The runner never resends a create on its own. It fails with a partial receipt
`{outcome, requestId, recovery, next}`: with a request id the next step is the same call under that id
(`RETRY_SAME_REQUEST`), and without one (the user API, which keeps no receipts) it is to look first
(`VERIFY_STATE`).

**`session_create` with `wait`.** Once the child exists the call never fails. A read of the child that
fails, or a wait that runs out, is an outcome of the wait. The answer keeps the child's id and adds
`wait: {outcome: GET_FAILED | TIMEOUT, sessionId, created: true, error?, next: {tool: "session_get",
command: "orbit session get <id>", arguments: {sessionId}}}`. The next step reads the child. It never
creates it again.

## 9. `ALREADY_COORDINATING`: the child-session recovery chain

A session coordinates at most one project (`project.coordinator_session_id` is unique). A
`project_create` from a session that already coordinates one is refused `409 ALREADY_COORDINATING`
(`ProjectsService.alreadyCoordinatingRefusal`), and creates nothing. The body carries:

| Field | Meaning |
| --- | --- |
| `coordinatingProject` | `{id, title}` of the project this session coordinates, `id` in base62. |
| `sessionId` | The calling session, base62. |
| `childSessionPrompt` | The self-contained first prompt of the child that records the new project: the parent session and its project, the exact `project_create` arguments (`title`, `goal`, `instructions`, structured `acceptanceCriteriaItems`) as JSON, and the success receipt the child replies with (`PROJECT_CREATED projectId=… coordinatorSessionId=…`). |
| `requiredAction` | `CREATE_PROJECT_IN_CHILD_SESSION`. |
| `recovery` | effect `NONE`, policy `NEVER`, action `CREATE_PROJECT_IN_CHILD_SESSION`, actor `CALLER`, `userConfirmation: REQUIRED`, resources `PROJECT` (the bound one) and `SESSION`. |

The chain, in order:

1. **Reconcile.** The runner door (`RunnerProjectsController.createInSessionOrReplay`) first looks for
   a COMPLETED `PROJECT_CREATE` receipt with the same payload and calling session whose resource is
   `coordinatingProject`. If there is one, the first answer was lost and the caller asked again under
   a new id: the answer is the receipt's, with `replayOf`, and nothing is refused or created. Without
   a receipt (no request id was sent), the Agent compares `coordinatingProject` with what it was
   creating.
2. **Ask.** A project that really is a second one is the user's decision. The Agent says that this
   session stays bound to `coordinatingProject` and asks whether to open a child session. On a no,
   nothing is created.
3. **One child.** On a yes, and with `session_create` exposed (orchestration on), the Agent calls
   `session_create` once with `childSessionPrompt` as its `prompt`. The server records the caller as
   the child's `parentSessionId`. The Agent does not follow it with `session_send`: the prompt is
   already the child's first turn.
4. **The child records it.** The child's own `project_create` binds the child as the new project's
   coordinator. The parent's binding is untouched. The child's reply names the project id and its own
   session id, and the parent reports both.
5. **Manual fallback.** Without `session_create` (the tool is not listed, orchestration is off, or the
   call is refused), the user starts a new session in the workspace and sends `childSessionPrompt` as
   its first message.

`renderRecoveryNext` maps `CREATE_PROJECT_IN_CHILD_SESSION` to `ask_user` on every surface. Its
reason names `session_create` when this surface exposes it, and the manual fallback when it does not.

### Agent interaction regression

`node --test test/already-coordinating-eval.test.mjs` runs the interaction contract in CI. The
evaluator in `scripts/already-coordinating-eval.mjs` gives an adapter the conversation and exposed
tools, records calls through its own callback, supplies the user's decision as a second turn, and
checks the actual replies and calls. Each case runs over MCP `structuredContent` (with the raw
refusal in legacy content), CLI JSON recovery, and legacy text. Cases include reconciliation with
the same project, no decision, refusal, confirmation, missing capability, orchestration disabled,
outstanding-child backpressure, depth limit, invalid permission, and a switch disabled after discovery.
Negative controls reject premature or duplicate children, an immediate `session_send`, missing
parameters, manual-only conclusions while creation is available, and CLI permission bypasses.

The CI adapter is a reference implementation that tests the evaluator; it is not a live model
evaluation. To drive a candidate, export `createAgent()` from an adapter module and run:

```sh
node scripts/already-coordinating-eval.mjs /absolute/path/to/adapter.mjs
```

An adapter returns an async function accepting `{messages, tools, call, ...observation}`. It returns
the assistant's text and invokes `await call(toolName, input)` for tool actions. Create a fresh
candidate context for each case. The evaluator does not expose real Orbit mutations. The supplied
`scripts/already-coordinating-claude-adapter.mjs` drives Claude Code with its native tools disabled
and dispatches its JSON tool decisions through that callback. It requires an already authorized
Claude installation. Configure its scratch/auth location externally; the adapter never copies
credentials. Candidate failures fail the run; missing authentication does not turn into a skip.

The real database binding check remains
`src/apiserver/src/runner-api/already-coordinating-child-chain.pg.spec.ts`, run by the PostgreSQL CI
matrix. For a local run constrained to a scratch filesystem, use an isolated checkout on that
filesystem, set `TMPDIR`, cache variables, and `RUN_PG_SPEC_PGDATA_ROOT` there, and run
`scripts/run-pg-spec.sh` with the fixture's absolute path in that checkout. The PGDATA override
bind-mounts a unique temporary directory and removes it during cleanup, including confirmation runs.

## 10. Project and Task refusals

The API states the `recovery` block itself for the Project and Task refusals an agent most often meets.
The wire contract is [`contracts/project-task-refusals.contract.json`](../contracts/project-task-refusals.contract.json),
transcribed from `src/apiserver/src/common/refusal-recovery.ts`, which serves it. Each entry gives the
code, its status, the doors that serve it, the stated block, and the body fields whose ids become
`resources`. Where one code answers several rules, a legacy `requiredAction` token narrows the entry
(`PROJECT_SCOPE_MISMATCH` re-reads the scope on `RE_DERIVE_SCOPE`, stops on `YIELD_TO_CURRENT_SCOPE`,
and is filed at home on `FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF`).

The block is attached once, at the exception boundary (`PublicIdExceptionFilter`), to any body whose
code the table covers and that states no block of its own. Every message stays word for word what the
door served before, so a client that matches on it keeps matching.

| Code | Status | Disposition | Next step |
| --- | --- | --- | --- |
| `STALE_CONFIG_REVISION` | 409 | `AUTOMATIC` | `REREAD_AND_DECIDE`: `project_get`, then decide again. |
| `PROJECT_SCOPE_MISMATCH` | 403 | `AUTOMATIC` / `STOP` | By rule, as above. |
| `COORDINATOR_GENERATION_MOVED` | 409 | `STOP` | `STAND_DOWN`: a newer coordinator holds the scope. |
| `UNMAPPED_PROJECT_WORK` | 403 | `HUMAN` | A person names the owning project. |
| `PROJECT_REOPEN_REQUIRED`, `MOVE_TASK_SERVES_SETTLED_CRITERION` | 403 | `HUMAN` | The owner reopens the project. |
| `CROSS_PROJECT_APPROVAL_REQUIRED`, `APPROVAL_PENDING`, `APPROVAL_EXPIRED` | 409 | `CONFIRM_THEN_RUN` | The owner confirms the crossing, which applies it. |
| `APPROVAL_DENIED` | 409 | `AUTOMATIC` | File the work in the caller's own project. |
| `APPROVAL_TARGET_MISMATCH` | 409 | `AUTOMATIC` | `FIX_REQUEST`. |
| `PROJECT_NOT_EMPTY` | 409 | `CONFIRM_THEN_RUN` | The owner decides where the tasks go; the body names `taskCount`. |
| `DEPENDENCY_SELF` | 400 | `AUTOMATIC` | `FIX_REQUEST`. |
| `DEPENDENCY_CYCLE`, `DEPENDENCY_DUPLICATE` | 400, 409 | `AUTOMATIC` | `READ_GRAPH_AND_REPLAN`: `task_dependency_graph`, then recompute. |
| `TASK_RETIRED` | 409 | `STOP` | `STAND_DOWN`; the successor is the first resource. |
| `TASK_AGGREGATE_ONLY` | 409 | `STOP` | `STAND_DOWN`: its subtasks or verifier complete it. |
| `TASK_PREREQUISITES_INCOMPLETE`, `TASK_PREREQUISITE_NOT_LANDED` | 400 | `WAIT` | Wait for the prerequisite. |
| `TASK_PREREQUISITE_FAILED` | 400 | `AUTOMATIC` | `READ_GRAPH_AND_REPLAN`: a cancelled or failed prerequisite does not lift by waiting. |
| `TASK_LIST_PAUSED`, `TASK_ASSIGNEE_NO_RUNNER`, `PROJECT_PAUSED` | 400, 409 | `HUMAN` | The owner resumes the list or project, or binds a runner. |
| `PROJECT_NOT_STARTED` | 409 | `HUMAN` | The owner starts the project, asked by its coordinator. |
| `TASK_NO_ASSIGNEE` | 400 | `AUTOMATIC` | `ASSIGN_AGENT`. |
| `PROJECT_CANCELLED` | 409 | `STOP` | `STAND_DOWN`. |

**Plan preflight.** `PLAN_PREFLIGHT_FAILED` (400, `POST /tasks/batch-create` and `POST /runner/tasks/batch-create`)
answers the whole plan once. `findings` holds every refusing finding and `warnings` every warning,
each with its own block. `summary` counts them (`refusing`, `warnings`, `byDisposition`, `byCode`). The
top-level `recovery` is `FIX_REQUEST`, with the disposition of its most stuck finding
(`STOP` > `HUMAN` > `CONFIRM_THEN_RUN` > `WAIT` > `AUTOMATIC`). It requires a confirmation only when that
disposition is `CONFIRM_THEN_RUN`.

**What a block never says.** `resources` are read only from id fields the throw site already put in
the body, so no block names a row the body did not. A 404, a cross-tenant id and an authentication
refusal have no entry: they are served exactly as before, and the same for another account's id as
for an id that names nothing.

Tests: `refusal-recovery.spec.ts` holds the table to the JSON, reads every entry back through the
client parser as stated, and checks every scope rule against its entry. `recovery_refusals_test.go`
renders every entry over the Go surface: a re-read is a `project_get` or `task_get`, a dependency
refusal is `task_dependency_graph`, a delete or crossing is `ask_user`, a retired task is `stop`, a
prerequisite is `wait`. `refusal-recovery.pg.spec.ts` serves the reachable ones from the production
apiserver over PostgreSQL. It also shows that another account's ids, ids that name nothing and no
credential at all get byte-identical answers, with no block and no id of the other account.

## 11. Session lifecycle and spawn backpressure

`src/apiserver/src/sessions/session-recovery.ts` holds one table, `SESSION_RECOVERY_RULES`. Each
refusal keeps its status and message as before. It adds `code`, `owner`, `requiredAction` (the
action code), `retryable`, `retryAfterSeconds` when there is a wait, and the `recovery` block with
the blockers in `resources`. A resume refusal also keeps the session-state reason
(`deriveSessionCapabilities`, `session-state.ts`) as `resumeBlockedReason`, and its code is
`SESSION_<reason>`. The shared vectors named `session recovery: <code>` are these bodies exactly.

### 11.1 Codes

| Code | Status | Actor / owner | Policy | Action | Wait | Blockers | Where |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ORCHESTRATION_DISABLED` | 403 | USER | AFTER_STATE_CHANGE | `AWAIT_USER_FIX` | | calling session | authorizer, spawn |
| `CALLER_SESSION_NOT_LIVE` | 403 | CALLER | NEVER | `STOP_LOOP` | | calling session | authorizer |
| `SPAWN_DEPTH_LIMIT` | 403 | CALLER | NEVER | `RETURN_TO_PARENT` | | parent, tree root | spawn |
| `SPAWN_TREE_OUTSTANDING_LIMIT` | 429 | CALLER | AFTER_STATE_CHANGE | `WAIT_FOR_SESSIONS` | | the tree's unsettled sessions (up to 20) | spawn |
| `SPAWN_TREE_RATE_LIMIT` | 429 | CALLER | AFTER_STATE_CHANGE | `STOP_LOOP` | until the window admits one | tree root | spawn |
| `WORKSPACE_NAME_AMBIGUOUS` | 400 | CALLER | NEVER | `FIX_REQUEST` | | the matching workspaces | spawn |
| `WORKSPACE_NAME_NOT_FOUND` | 400 | CALLER | NEVER | `FIX_REQUEST` | | | spawn |
| `ENGINE_SIGNED_OUT` | 409 | USER | AFTER_STATE_CHANGE | `AWAIT_USER_FIX` | | runner | create |
| `MANAGED_RUNNER_FAILED` | 409 | USER | AFTER_STATE_CHANGE | `AWAIT_USER_FIX` | | named workspace or session, runner | spawn (before any child), resume |
| `SESSION_TRASHED` | 409 | USER | AFTER_STATE_CHANGE | `AWAIT_USER_FIX` | | session | resume, send, interrupt with a message |
| `SESSION_ENDING` | 409 | SYSTEM | AFTER_STATE_CHANGE | `POLL_STATE` | 5 s | session | resume |
| `SESSION_NOT_TERMINAL` | 409 | SYSTEM | AFTER_STATE_CHANGE | `POLL_STATE` | 5 s | session | resume |
| `SESSION_NOT_STARTED`, `SESSION_MISSING_CONTEXT`, `SESSION_NO_RUNNER` | 409 | CALLER | NEVER | `CREATE_REPLACEMENT` | | session | resume |
| `SESSION_RUNNER_OFFLINE` | 409 | SYSTEM | AFTER_STATE_CHANGE | `AWAIT_SYSTEM_FIX` | 60 s | session, runner | resume |
| `SESSION_ENDED` | 409 | CALLER | NEVER | `FIX_REQUEST` (send with `resumeIfEnded`, or to a new session) | | session | send, interrupt |
| `SESSION_NEXT_TURN_STARTING` | 409 | SYSTEM | SAFE | `RETRY` | 2 s | session | interrupt |

The rules behind the table:

- **Backpressure is never retried on a timer.** No spawn refusal is `retryable` or carries an
  automatic-retry action. A bare 429 would read as `SAFE` (§3 rule 6), so the policy is stated
  outright. `WAIT_FOR_SESSIONS` names the sessions to wait on. The rate limit's `retryAfterSeconds`
  says when the window admits another spawn, but its action is `STOP_LOOP`.
- **The depth limit stops the descent.** Policy `NEVER` and `RETURN_TO_PARENT`: the same spawn is
  never offered again, and nothing below this depth is started.
- **A person's boundary stays a person's.** Trash, the orchestration switch, an engine sign-in and a
  failed managed runner have actor `USER` and `AWAIT_USER_FIX`. They are the only codes with actor `USER`, and they render
  as `ask_user`, never as a call.
- **Only the next-turn race is resent as is**, after its 2 s wait.

The agent tells these apart as: wait (`WAIT_FOR_SESSIONS`), poll (`POLL_STATE`), go back to the parent
session (`RETURN_TO_PARENT`), create a replacement (`CREATE_REPLACEMENT`), a user or system fix
(`AWAIT_USER_FIX`, `AWAIT_SYSTEM_FIX`), and stop the loop (`STOP_LOOP`).

### 11.2 Disposition and rendered step

The server states each code's disposition in its block, and §3.2's rules derive the same one from the
fields alone (`LOOP_OR_DEPTH_STOPS`, `THE_STATE_MOVES`, and `AWAIT_USER_FIX` under `A_PERSON_DECIDES`).
§7's table gives the step:

| Code | Disposition | `next.type` |
| --- | --- | --- |
| `ORCHESTRATION_DISABLED`, `ENGINE_SIGNED_OUT`, `MANAGED_RUNNER_FAILED`, `SESSION_TRASHED` | `HUMAN` | `ask_user` |
| `CALLER_SESSION_NOT_LIVE`, `SPAWN_DEPTH_LIMIT`, `SPAWN_TREE_RATE_LIMIT` | `STOP` | `stop` |
| `SPAWN_TREE_OUTSTANDING_LIMIT`, `SESSION_ENDING`, `SESSION_NOT_TERMINAL`, `SESSION_RUNNER_OFFLINE` | `WAIT` | `wait` |
| `WORKSPACE_NAME_*`, `SESSION_NOT_STARTED`, `SESSION_MISSING_CONTEXT`, `SESSION_NO_RUNNER`, `SESSION_ENDED` | `AUTOMATIC` | `manual` (the caller changes its request or makes a new session; never the same one again) |
| `SESSION_NEXT_TURN_STARTING` | `AUTOMATIC` | `invoke` (the same call) |

`CONFIRM_THEN_RUN` belongs to `AWAIT_OWNER_DECISION` and to required confirmations (§2). None of
these codes uses it.

### 11.3 Asynchronous merge

`session_merge` without `waitSeconds` used to answer the agent's door with `{ok: true}`, which reads as
"merged". It now answers:

```json
{ "ok": true, "outcome": "PENDING", "sessionId": "…", "operationId": "…", "mergeStatus": "pending",
  "receipt": null, "receiptAbsentReason": "MERGE_STILL_RUNNING",
  "next": { "actionCode": "POLL_STATE", "afterSeconds": 30, "resources": [{ "type": "SESSION", "id": "…" }] } }
```

A wait that runs out (`TIMED_OUT`) carries the same `next`. The runner (`merge_pending.go`) adds the
read for its surface beside the server's fields: `tool: "session_get"`, `command: "orbit session get
<id>"` and `arguments: {sessionId}`, the shape `session_create(wait)` uses. The owner's Merge button
still gets `{ ok: true }` byte for byte.

Tests: `runner-api/session-lifecycle-recovery-wire.spec.ts` covers every code above over HTTP (real
guard, authorizer, pipes, interceptors and filters). `sessions/session-recovery.spec.ts` holds the
table to the shared vectors. `recovery_session_test.go` covers each vector's disposition and rendered
step, and `merge_pending_test.go` covers the merge `next`.

### 11.4 A workspace whose machine is coming up or has failed

The designed workspace `cloneState` (`PENDING | CLONING | READY | FAILED`,
`docs/github-workspace-design.md`) has not been built. Production does have the equivalent states, on
the managed runner a workspace runs on (`ManagedRunner.managementState`,
`docs/managed-runner-design.md`). The managed-runner demand hook reads them (`demandAnswer`):

- **Coming up** (`REQUESTED`, `WAITING_CAPACITY`, `PROVISIONING`, `STARTING`; `DRAINING` and
  `SLEEPING` wake too): the platform brings it up by itself. A spawn into that workspace is accepted,
  and the child waits for the machine. Unless the runner is `READY`, the answer adds
  `runnerState: {code: "MANAGED_RUNNER_STARTING", owner: "SYSTEM", runnerId, managementState,
  retryAfterSeconds}` and `next: {actionCode: "POLL_STATE", afterSeconds, resources: [child session,
  runner]}`. `afterSeconds` is the manager's `nextAttemptAt`, and never less than 30.
- **Failed** (`FAILED`, `FENCING`, deletion): it does not come back by itself. A spawn is refused with
  `MANAGED_RUNNER_FAILED` before any child is written. A resume, which used to be refused as
  `SESSION_RUNNER_OFFLINE` ("the system recovers it"), is refused with `MANAGED_RUNNER_FAILED`. Both
  carry `managementState` and the manager's `managedReason`. The owner repairs the runner from its
  machine page, or an operator does.
