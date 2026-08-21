# 25C — Task supersession, blocker history, and the Orbit merge receipt

Contract clauses: **§13.6** (supersession, SU1–SU5) and **§13.7** (merge receipt, MR1–MR5), added by
this unit; **§2.4** and **§14** re-count; **§12.1 step 6k** creates them.

This unit closes three governance gaps that were all the same shape: a fact the system *had* but
could not be *asked* about, so the answer lived in prose somebody wrote afterwards.

---

## 1. A cancelled attempt and a replaced attempt stopped looking the same

**What was wrong.** This project's own history is the evidence. Three fresh reviews — `04R`, `04R2`,
`04R3` — were each re-run from scratch and each left `CANCELLED`, with "superseded by the fresh
review" written in a task comment. `TaskStatus` has no way to say the difference, so:

- a list of the project's history showed a column of identical grey *Cancelled* chips over work that
  had in fact been finished by its successor;
- "so who ended up doing this" had **no query** that answered it;
- project acceptance counted three abandoned tasks where there was one completed line of work.

**What replaced it.** Three columns on `task` and one trigger:

| column | meaning |
|---|---|
| `superseded_by_task_id` | the later attempt that took this one's place (self FK, `ON DELETE SET NULL`) |
| `superseded_at` | when it took over |
| `terminal_reason` | `SUPERSEDED` or `ABANDONED` — closed set, frozen by a `CHECK` |

Deliberately **not** a new `TaskStatus` value. Status says how the attempt *ended*; supersession says
whether somebody else is doing it. Folding the second into the first would rewrite "it failed" into
"it was replaced", and the failure is the thing being preserved.

`task_supersession_guard` enforces SU2–SU5 in the database, for the reason §7.7 D5/D6 gives about
every other guard here: a check that lives in a service exists only in the binary that has it.

- **SU2 same tenant** — the FK alone would happily point one user's task at another's.
- **SU3 same project** — a successor in another project is work towards a different goal, and no
  acceptance read could count it. "Both in no project" counts as the same project.
- **SU4 the original outcome is preserved** — only `CANCELLED`/`FAILED` may name a successor, and
  linking writes nothing to `status`. The reverse also holds: a task still naming a successor cannot
  be reopened or marked DONE.
- **SU5 acyclic** — walking forward from the successor and reaching this row is refused. A self-link
  is that walk's zero-hop case, which is why there is no separate self-reference rule: a `BEFORE`
  trigger runs before table constraints, so a second `CHECK` could never be the thing that refused,
  and two spellings of one rule is how the two come to disagree.

**The ordering that is not a style choice.** One PATCH routinely cancels *and* supersedes. Each half
is refused on its own in the wrong order, so `TasksService.update` writes the supersession columns
**after** the status write when linking, and **before** it when unlinking. Either order used for
both cases leaves one legal request failing on an intermediate state no committed row would hold.

**Why the three columns are written by one raw statement.** `CHECK` constraints are evaluated per
statement, and Prisma issues `supersededBy: { disconnect: true }` as a *second* statement after the
scalar update — so unlinking cleared the reason while the successor id was still set, which is
exactly the state the CHECK refuses. One `$executeRaw` writes all three together. It still passes
through the trigger, so nothing about the guards is bypassed.

### The three historical rows

Migration `0128`'s backfill is scoped **by shape, not by id**. A `CANCELLED` task qualifies only if
it carries the `fresh-review` label, sits under a parent inside a project, and has a strictly later
sibling — same parent, same project, same owner, same label — that reached `DONE`. On this
deployment that is exactly `04R`, `04R2`, `04R3` → `04R4`; on a deployment without that shape it
writes zero rows.

It writes **nothing** to `status` and **nothing** to any session. `superseded_at` is read from the
row's own `updated_at`, not from `now()`: the migration is recording history, not making it. The
failed and cancelled runs behind those tasks keep their real `runStatus`, which is the point — the
audit is *about* them.

Every row the backfill writes passes through `task_supersession_guard`, so the backfill is proved by
the same door that will police every future link rather than by being trusted.

---

## 2. Blocker history was already durable — the gap was reading it

`project_blocker` rows have never been deleted on resolution (§11.3 BE1 allocates the next
lifecycle generation from them), and `GET /projects/:id/blockers?history=1` plus
`project status`'s `blockers.open` / `blockers.resolved` already serve both halves; the web panel
already renders resolved episodes greyed with who resolved them and when.

What this unit adds is the terminal door, so a headless auditor is not the one caller who cannot
ask: `orbit project blockers [--history]`. See §3 below for the parity rule that made this required
rather than optional.

Project acceptance failures are likewise already structured rather than commentary —
`project_acceptance_audit` records `done_refused` with its refusal code, and
`GET /projects/:id/acceptance` serves it.

---

## 3. `merge_status` was never a record of anything

**What was wrong.** `session.merge_status` is the state of the Merge button: written when a merge is
queued, and deliberately **cleared** when the session resumes. It also has exactly one writer —
Orbit's own merge path. These branches actually land a different way: an agent runs
`git merge --ff-only` in its own worktree. That leaves `merge_status` `NULL` and `branch_merged`
`false` **permanently**, so the control plane's honest answer to "did this task's work land" was
"no idea", forever, about every branch that landed.

25B's own session is the exhibit: `SUCCEEDED`, `endReason: task_done`, its work merged into
`feat/project` at `97a10ae7` — and `mergeStatus: null, branchMerged: false, mergedAt: null`.

§13.4 AE9's `project_merge_evidence` answers a different question (what the target branch's
*content* was observed to be) and knows nothing about sessions or tasks.

**What replaced it.** `session_merge_receipt`: append-only, one row per merge, naming every address
the audit joins on (session, task, project) and every SHA the claim can be re-checked against.

| field | why it is there |
|---|---|
| `result` | `MERGED` / `ALREADY_MERGED` / `CONFLICT` / `ERROR` |
| `source_branch`, `source_sha` | what was merged |
| `target_branch`, `target_sha_before`, `target_sha_after` | where it went and what moved |
| `rebase_base_sha` | the base the source was rebased onto — the field people skip and the one that decides whether "the tests passed" was about this tree |
| `conflicts` | the paths git stopped on |
| `recorded_by` | `RUNNER` / `AGENT` / `USER`, chosen by which door the request came through |

`ALREADY_MERGED` is a **result, not a no-op**: it is the answer in the external fast-forward case and
in every re-run, and folding it into `MERGED` would erase the only fact that tells "this merge moved
the target" from "the target already contained it".

**Idempotence (MR4)** keys on `(session, sourceSha, targetBranch, result)` — deliberately not the
target tip, because a merge re-reported after the target moved on is still the same merge, and
keying on a moving value would grow one row per question. The same key is derived identically in
`merge-receipt.ts` and by the CLI, because two writers that disagreed about it would not collide;
they would each insert, quietly.

**Unverifiable claims are refused rather than stored.** An abbreviated SHA is rejected (it resolves
against a repository that has since gained objects, so today's verification can silently name a
different commit later), and a `MERGED` receipt that cannot say where the target ended up is
refused by a `CHECK` — that is a claim, not a receipt.

**Append-only, with exactly one exemption.** `session_merge_receipt_immutable_guard` refuses UPDATE,
except the one its own foreign key performs: `task_id` going to `NULL` because the task was deleted,
with every other column identical. Refusing that would not make the receipt more immutable; it would
make deleting a task impossible.

**MR5 — why the two columns stop being blank.** Recording a receipt projects
`merge_status` / `mergedAt` / `branchMerged` / `mergedSourceSha` / `mergeTarget` onto the session, so
every existing client (web, iOS, macOS, the API) starts telling the truth without a line of change.
The one skip is `merge_status = 'pending'`: that carries the operation fence the runner echoes back,
and a receipt must not cancel a merge still running — **but the receipt is written either way**. The
durable half never depends on whether the transient half could be updated.

**Orbit's own merge writes one too**, inside the same transaction that reports the outcome, so a
recorded merge and the session state it produced commit together. The runner now reports
`targetBranch`, `targetShaBefore`, `rebaseBaseSha` and the conflicting paths alongside the outcome;
an older runner omits them and the receipt names what it knows.

---

## 4. Doors

| surface | supersession | merge receipt |
|---|---|---|
| user API | `PATCH /tasks/:id` `supersededByTaskId` / `terminalReason`; `GET /tasks/:id` returns `outcome`, `supersedes`, `successorChain`, `supersededByTaskIdAbsentReason` | `POST` / `GET /sessions/:id/merge-receipts` |
| runner API | `PATCH /runner/tasks/:id`, same fields | `POST` / `GET /runner/sessions/:id/merge-receipts` |
| MCP | `task_update` `supersededByTaskId`, `terminalReason` | `merge_receipt`, `merge_receipts` — ungated |
| CLI | `orbit task update --superseded-by-task-id ID \| --clear-superseded`, `--terminal-reason SUPERSEDED\|ABANDONED` | `orbit session merge-receipt`, `orbit session merge-receipts` |
| web | the header chip reads **Superseded** in amber, with "Superseded by X" / "Replaces N earlier attempts" underneath | `project status` carries `mergeReceipts` |

`supersededByTaskId` is classified in `PUBLIC_ID_FIELDS`, so it goes out in both spellings like every
other address; a receipt's `id`, `sessionId`, `taskId` and `projectId` are all already classified.

The blocker read gained a machine door as well: `GET /runner/projects/:id/blockers?history=1`,
`orbit project blockers [--history]`, and the MCP tool `project_blockers`.

The CLI↔MCP parity test (`cli_mcp_parity_test.go`) is what forces the third and fourth rows to stay
in step: a parameter added to an MCP tool must be documented in that command's CLI arguments, or the
build fails — which is how `--rebase-base` became `--rebase-base-sha` and `conflicts` was registered
as the repeatable `--conflict`.

All three new verbs are **ungated**, advertised beside the project reads rather than behind the
orchestration gate, on the argument the code already makes for `notify` and `project_*`: recording
that your own branch was merged, and reading why your own project is stopped, are not powers over
somebody else's session. Gating them would mean the deployments that most need the audit — the
ordinary ones, with orchestration switched off — are exactly the ones that cannot produce it. That
is also why `merge_receipt` is not called `session_merge_receipt`: the `session_*` prefix IS the
orchestration gate in this codebase, and a name that implies a gate it does not sit behind is a
name that will eventually be moved behind it by somebody tidying up.

---

## 5. Evidence

| suite | result |
|---|---|
| apiserver unit (`node --test build/*/*.spec.js`) | 2259 tests / 2028 pass / **0 fail** / 231 skipped (baseline 25B: 2232 / 2003 / 0) |
| apiserver PG matrix (`scripts/project-pg-matrix.sh`) | 350 tests / **0 fail**, including `task-supersession.pg` 13/13 and `merge-receipt.pg` 11/11 |
| web (`vitest run`) | 58 files / 838 pass (baseline 829) |
| runner-go (`go test ./...`) | `ok orbit` — 0 fail |
| contract (`coordinator-contract.spec`) | 58 pass — §2.4's table and column counts, §14's totals and §12.1 step 6k all agree |

Two defects in this unit's own first draft were found by its pg specs and fixed:

1. the immutability trigger refused the `task_id` `ON DELETE SET NULL` its own foreign key performs,
   so deleting a task with receipts failed — a guard that turns into a referential deadlock;
2. `supersededBy: { disconnect: true }` left the FK set while clearing its two companions, so every
   unlink failed on the link `CHECK` (see §1).
