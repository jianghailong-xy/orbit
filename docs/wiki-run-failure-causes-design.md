# Wiki run failures: a cause, not the upstream's words

Status: decided 2026-11-16 — the owner chose A1, B1, C1 (§6). Board: `docs/mocks/wiki/48-run-failure-causes.html`.

## 1. The problem

Activity's Runs card shows a failed run's reason, and its call log shows each failed call's reason. Both are the
text the worker stored, so whatever the System model's server said reaches the page:

```
Failed · extract: stream error internal_error: 2 validation errors for ChatCompletionStreamResponse model
Field required [type=missing, input_value={'error': {'message': 'En...am': None, 'code': 500}}, …
https://errors.pydantic.dev/2.13/v/missing choices Field required …
```

This one came from production on 2026-11-16. vLLM's engine died (`EngineDeadError`), and its Anthropic adapter
then failed to parse its own error chunk. The reader learns nothing they can act on, and they see the
deployment's internals: the server stack, the library and its version.

The same text also goes out through:
- the Feishu "maintenance failing" push ("Last error: …"),
- the documents plan card (`wiki_plan_job.error`),
- the import read,
- health's `lastFailure.reason`.

Today the only rule on this text is "names neither the model's address nor its key" (`systemModel.status.lastError`).
The shared fixture pins pass-through: a row shows the first line of `job.error` (`wiki-server-execution.fixture.json`).

There is a second defect behind it, a misclassification. A call that fails with an SSE `error` event whose type the
client does not know (`internal_error`) is classed `other`. The executor turns every `other` call failure into a
`WikiJobContentError` (`wiki-job-executor.ts` `ask()`). So the engine dying mid-answer ends the run as **content**,
and it is not retried as infra. Production, last 7 days: 8 maintenance runs ended `content` with exactly this
error, and some with no retry scheduled.

## 2. The rule

> A client never shows text an upstream wrote. A failure reaches a client as a **cause** from a closed set, and each
> cause has one fixed English sentence. The upstream's words stay on the server, in the row and the worker's log,
> for whoever operates the deployment.

### 2.1 Causes (`WIKI_FAILURE_CAUSES`, shared, closed)

| cause | when (classified where the failure is written) | sentence | failure kind |
|---|---|---|---|
| `model_unavailable` | HTTP 5xx; connection failed, dropped or idle; the stream closed before `message_stop`; an SSE `error` event whose type is not one of the named ones below; a non-SSE answer | The System model stopped answering. | infra |
| `model_busy` | HTTP 429; SSE `overloaded_error` / `rate_limit_error` | The System model is busy. | infra |
| `model_queue_wait` | the request waited past its step's limit | The System model's queue was too long to wait. | infra |
| `model_key_refused` | 401 / `authentication_error` | The System model refused the key. | infra |
| `model_call_budget` | the call ran out of its budget | The call ran past its N-minute budget. | content |
| `model_answer_unusable` | the answer could not be parsed or was refused (HTTP 4xx other than 401/429) | The model's answer could not be used. | content |
| `repo_unavailable` | `REPO_OP_*`, `REPO_NOT_READY`, runner offline | The repository could not be read. | infra |
| `interrupted` | `LEASE_EXPIRED`, `WIKI_JOB_HANDED_BACK` | The run was interrupted. | infra |
| `internal` | anything else, including errors this build did not expect | Something went wrong on Orbit's side. | infra |

A failure stays a failure of one step. Keep the step: the row reads `extract: The System model stopped answering.`,
because the step is Orbit's own word, not the upstream's. At the retry limit it reads
`Ended after 10 attempts: <sentence>`.

### 2.2 Classification fix

`model_unavailable` covers an unknown SSE error type. That makes it `retryable` at the call and `infra` at the job.
So a model that died mid-answer is retried with the existing backoff (calls 0/10/30 s, jobs per `jobs.retry`), and
the run waits instead of failing as content.

The executor maps a failed call to infra or content **by its cause**, no longer by `errorKind === 'other'`.

## 3. Wire and storage

- **New columns.**
  - `wiki_model_request.cause text`, `wiki_job.cause text` and `wiki_maintenance_run.cause text`, each checked
    against the closed set. Nullable: a row from before this change has none.
  - Each row keeps its `error`, the upstream text after `scrub()` and `redactSecrets`, for operators.
- **Reads.** `jobs.read`, health `lastFailure`, the plan read and the import read gain `cause`. Their `error` /
  `reason` field keeps its name but now carries the sentence built from step + cause, never the stored text.
  So an older iOS, macOS or Android build that still renders `error` shows the clean sentence without an update.
- **Push.** The Feishu "Last error" line uses the same sentence.
- **Old rows.** A migration backfills `cause` from the stored `error` with the same classifier the worker uses
  (prefix codes, `HTTP <n>`, `stream error <type>`, the wait-limit and budget wordings). What it cannot place
  becomes `internal`.
- **Contract.** `contracts/wiki.contract.json`:
  - `jobs.read.never` gains "upstream error text".
  - `jobs.retry.limit` and `maintenance.health.lastFailure` are reworded to the sentence.
  - New `jobs.failureCauses`, which pins the closed set like the other closed sets (Swift and Kotlin parity).

## 4. Clients

Web (`lib/wikiRuns.ts`), OrbitKit (`WikiRunsLogic.swift`) and Android (`WikiRunsLogic.kt`) render the sentence
from `cause` when it is present, and fall back to `error`, which is already clean after §3. The shared fixture's
failure cases are rewritten from raw text to causes. The three parity tests follow.

**B1 (chosen).** While a run is being retried for an infra cause, it is queued with `nextAttemptAt`. Its row shows
the cause, so the reader sees why it waits:
`Queued · The System model stopped answering · retrying in 25 s`.
Only a run that has used up its attempts, or failed for a content cause, is red.

## 5. Where the upstream's words go (decision A: A1 chosen)

The stored `error` is the operator's evidence. Three options:

- **A1 (recommended).** Stays on the server: the row, and the worker's log line with the request id. The call
  log already shows each call's short id (`extract · d2253b14`), so an operator can find the row.
  No client shows it.
- **A2.** As A1, plus a "Technical details" disclosure on a failed call, shown only to a deployment ADMIN
  (`User.role`), through the existing `admin/wiki` route. It is never in the owner reads.
- **A3.** Not stored at all. Rejected: the 11-16 diagnosis needed it to tell an engine death from a bad answer.

## 6. Decisions (owner, 2026-11-16)

| | Options | Chosen |
|---|---|---|
| A | Where upstream text is visible: A1 server only / A2 also ADMIN disclosure | **A1**: no client shows it, ADMIN included |
| B | An infra failure being retried: B1 amber, queued with its cause / B2 as today, no cause | **B1** |
| C | Old rows: C1 backfill causes by migration / C2 show "Something went wrong on Orbit's side." | **C1** |

## 7. Landing, by cost

1. Shared: the cause set, the sentences, the classifier and its tests; contract and fixture.
2. Worker: write `cause`; classify an unknown SSE error type as `model_unavailable` (retryable); executor maps by
   cause. This step alone stops the false content failures.
3. Reads and push serve the sentence; migration with backfill.
4. Web, OrbitKit and Android render `cause` (B1); parity tests.

Not in scope: the vLLM engine hangs themselves. HPC task 34ySzdtZHuKxBGyiXTCBg handles those.
