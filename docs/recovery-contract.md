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

A server states what it knows in a `recovery` block next to the legacy flat fields:
`{effect, retryPolicy, retryAfterSeconds, actionCode, actor, userConfirmation, resources}`. Every
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

**Action semantics.** Each action in the registry declares two flags:

- `automaticRetry`: carrying it out resends the identical request with nobody in between. This is
  true for `RETRY` and `RETRY_SAME_REQUEST` only.
- `mayWrite`: carrying it out can end in another write. That covers a resend, a changed request
  (`FIX_REQUEST`), a request under a new id (`USE_NEW_REQUEST_ID`), answering advice
  (`ANSWER_ADVICE`), writing again after a decision (`AWAIT_OWNER_DECISION`), or a handoff
  (`FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF`).

Only `VERIFY_STATE` has `mayWrite: false`. A token the registry does not list counts as
`mayWrite: true`. The contract derives `automaticRetryActionCodes` and `readOnlyActionCodes` from
these flags. Steps 3 and 4 use the first list, and step 6 uses the second.

Every envelope satisfies the checks in `invariants.holdsOnEveryEnvelope`. Both test suites check
them on every fixture, and on all 5,400 combinations a server block can state (effect × policy ×
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

The registry is in the contract. An unknown token passes through, and a client with no mapping for
it falls back to the prose.

## 5. Backward compatibility

The Go transport's text is unchanged byte for byte. That covers the `refused:` or `advice:` line, the
`what:`, `owner:` and `do:` lines, the raw body underneath, and the `METHOD PATH -> STATUS` line.
`TestRecoveryLegacyRefusalTextIsUnchanged` runs the existing `transportHTTPError.refusal()` and
`Error()` against every HTTP vector. `legacyRefusalText` in TypeScript produces the same block from
the same vectors. Legacy flat fields stay on every body, and `owner` and `requiredAction` are copied
into the envelope verbatim.

Not covered by v1: emitting the `recovery` block from the API. That belongs to the follow-up tasks
built on this contract.

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

  How each action code maps to a step:

  | actionCode | Step |
  | --- | --- |
  | `RETRY`, `RETRY_SAME_REQUEST` | `invoke` the same call, only if this surface exposes it. `RETRY_SAME_REQUEST` also needs the call to have carried its request id. Otherwise `wait` (when there is an `afterSeconds`) or `manual`. |
  | `VERIFY_STATE` | `invoke` the reader of the first resource that has one: `TASK` → `task_get`, `SESSION` → `session_get`, `PROJECT` → `project_get`, or `orbit <type> get ID --json`. Only an id that is one safe path segment and does not start with `-` is handed on. With no reader, `manual`. |
  | `AWAIT_OWNER_DECISION` | `ask_user`. |
  | none | `ask_user` when a confirmation is required or the actor is `USER`. `manual` on a `COMMITTED` write. `wait` when the actor is `SYSTEM` or there is an `afterSeconds`. Otherwise `manual`. |
  | anything else | `ask_user` when a confirmation is required, otherwise `manual`. |

  "Exposes" means the tool appears in this server's `tools/list` (orchestration, watch, wiki and
  `ORBIT_MCP_TOOLS` gating included), or the command is an `available` entry of
  `orbit capabilities --json`. When the capability is missing, the step degrades: it is never an
  invoke that cannot run.

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
this JSON contract. Native API `recovery` production remains separate work.

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

A different request id is a different request. A second project created from the same session still
gets its own coordinator conversation (one session coordinates one project). A request with no id writes
no receipt and behaves as before.

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
