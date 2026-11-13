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

1. `COMMITTED_NEVER_RESENT`: if the effect is `COMMITTED`, the policy is `NEVER` and the action is
   never `RETRY` or `RETRY_SAME_REQUEST`.
2. `UNKNOWN_VERIFIES_FIRST`: if the effect is `UNKNOWN`, the policy stays `SAME_REQUEST_ID` only when
   it already was and there is a request id. Anything else (`SAFE`, `NEVER`, `AFTER_STATE_CHANGE`,
   or `SAME_REQUEST_ID` without an id) becomes `VERIFY_THEN_RETRY`. The action is the policy's own:
   `VERIFY_STATE` or `RETRY_SAME_REQUEST`. A `500` with `retryable: false` therefore says verify
   first, not `FIX_REQUEST`.
3. `SAME_REQUEST_ID_NEEDS_AN_ID`: with no request id, `SAME_REQUEST_ID` becomes `VERIFY_THEN_RETRY`.
4. `CONFIRMATION_BLOCKS_AUTOMATIC_RESEND`: if `userConfirmation` is `REQUIRED`, `SAFE` and
   `SAME_REQUEST_ID` become `AFTER_STATE_CHANGE` (or `VERIFY_THEN_RETRY` when the effect is
   `UNKNOWN`), and a resend action becomes `AWAIT_OWNER_DECISION`.
5. `RESEND_ACTION_MATCHES_POLICY`: a resend action that does not match the final policy is dropped.
   The policy's default then fills an empty action, except for `COMMITTED` and 2xx answers.
6. `NEVER_HAS_NO_WAIT`: if the policy is `NEVER`, `afterSeconds` is `null`.

As a result, `SAFE` survives only on effect `NONE`. Every envelope satisfies the checks in
`invariants.holdsOnEveryEnvelope`. Both test suites check them on every fixture, and on all 4,860
combinations a server block can state (effect × policy × action × confirmation × request id × status
× `retryable`).

## 4. Action codes: semantic, never a tool or a command

The server names *what* has to happen, for example `AWAIT_OWNER_DECISION` or `VERIFY_STATE`. It never
names *which* MCP tool or CLI command does it. Each client maps action codes to its own surface, so
the same refusal reads correctly over MCP and at a terminal, and renaming a tool never changes the
server. `TestRecoveryActionCodesAreNeverToolNamesOrCommands` checks that no action code is an MCP
tool name in any case.

The action code comes from the first of these that applies: `recovery.actionCode`, then
`legacyCodes`, then a token `requiredAction`, then the policy's default. The result is held to §3.1.
A 2xx response or a `COMMITTED` effect gets no default. The defaults are:

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

Not covered by v1: emitting the `recovery` block from the API and printing the envelope from MCP and
the CLI. Those belong to the follow-up tasks built on this contract.
