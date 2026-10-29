# R29-13: landing observation end to end, on isolated stacks with real runners

Task R29-13 of project `34noHniU4wmCRkZJkR6df`, run 2026-10-29. Contract: `docs/project-integration-line-contract.md`
§10 (revision 29). Five scenarios, each driven through the real HTTP API and a real runner, with the runner's git work done
against local bare repositories. Each scenario directory holds the rows (`queries.txt`), the API reads (`*.json`), the
runner's log (`runner.log`), what the runner was handed and what it answered (`runner-wire.jsonl`), the fake agent's own
record (`fake-claude.jsonl`), the apiserver's log, and `transcript.md` + `checks.json` (every check, PASS or FAIL).

| # | Scenario | Stack | Result | Directory |
| --- | --- | --- | --- | --- |
| 1 | AGENT_PUSH: the agent pushes to main, its task branch is never published; DONE → observation → receipt → the dependent starts by itself | A | 13/13 checks | `s1-agent-push/` |
| 2 | AGENT_PUSH: the agent pushes a cherry-pick → LANDING_UNOBSERVED (APPLIED_AS_OTHER_COMMITS) for the coordinator → its doors → `merge_receipt` → RESOLVED / LANDED, the dependent starts | A | 14/14 | `s2-cherry-pick/` |
| 3 | PLATFORM on a MAIN line: candidates named by `delivered_sha`, checked and landed by commit without the branch ever being published; an agent that pushed first gets ALREADY_LANDED → receipt + LANDED_WITHOUT_CONFIRMATION, never BLOCKED | A | 22/22 | `s3-platform/` |
| 4 | Deploy-time pass on 10-28's shape: made by the 0.1.239 server and runner, then this branch's apiserver on the same database → identities frozen, one observation queued (DEPLOY) → with the runner upgraded: receipts, candidates retired, the dependent starts, one `UL:backfill:<projectId>`; a second start writes nothing | B | 30/30 (12 before, 5 deploy, 13 upgrade) | `s4-backfill/` |
| 5 | The 0.1.239 release runner on this branch's apiserver: never handed OBSERVE_LANDING nor a check named by its commit; its paths keep working | B | 18/18 (15 with the old runner, 3 after the upgrade) | `s5-old-runner/` |

## The two stacks

Both run on this host, on loopback only, from `kit/` (see "Reproduce").

- **Stack A** (scenarios 1–3): the apiserver built from this branch at `ec85cfe45` (the project line's tip: R29-0 to R29-9
  landed; `src/apiserver` tree `97abed23…`, `src/shared` `31b6de0a…`) and the runner built from the same commit (version
  `0.1.240`, declares `integration-job/v1` and `integration-observe/v1`). Postgres 16 on tmpfs, all migrations.
- **Stack B** (scenarios 4–5): first the **0.1.239** apiserver (`18dfe8f1c`, the release before any R29 code; trees
  `3020f1e1…` / `dfd77a3c…`) with the **0.1.239 release runner** (`/usr/local/bin/orbit` on this host, sha256
  `b5e7ce9a…cb11ae6c`, declares `integration-job/v1` only). Then the deploy, as R29-14 will do it: the apiserver stopped,
  `prisma migrate deploy` with this branch's migrations on the same database (0449–0451 and 0453–0455), this branch's
  apiserver started, **the 0.1.239 runner left running**. Last, the runner upgraded in place: stopped, and this branch's
  build started with the same `ORBIT_HOME`, registration, workspaces and worktrees, as a self-update does.

"The current release binary" in the task is read as 0.1.239. When the task was written, 0.1.239 was the release. 0.1.240
was published on main afterwards (`53857bf37`, 10-29 00:09Z) and already declares `integration-observe/v1`, so it cannot
play the old runner. Production's runners and this host's runner still run 0.1.239 until R29-14 deploys.

What is real and what is not:

- **Real:** the apiserver processes, Postgres, the migrations, the runner processes (heartbeats, claims, worktrees,
  integration jobs, `git fetch`/`merge-base`/`cherry`/rebase/push against the bare origins), the HTTP doors, and the MCP
  doors. The coordinator's calls go through `orbit mcp`, the server the runner itself puts in `--mcp-config`, run inside
  the coordinator's own session.
- **Not real:** the agent. `kit/fake-claude` stands in for Claude Code. It speaks Claude Code's stream-json protocol to
  the runner without a model, an account or the network. A task run commits a work file in its worktree, then follows
  the `E2E-DO:` lines in its task description:
  - push HEAD to the line, after a `fetch` + rebase when the line has moved;
  - push a `cherry-pick -x` of the work instead;
  - publish the task branch;
  - record its own `merge_receipt`.

  In an AGENT_PUSH project it takes the push target from the brief's own O-L3 sentence (`Push your commits to
  origin/main before you finish`), so that sentence reaching the run is checked too (scenario 1).
- **Isolation:** every process starts under `env -i`. The runner runs in a private mount namespace with `/root` hidden,
  and its PATH has no engine but the fake one. Secrets are random per stack and kept outside the repository. Nothing
  reaches production or the host's own runner.
- **The wire:** `kit/proxy.mjs` sits between each runner and its apiserver. It logs:
  - every heartbeat: the version, and whether `X-Orbit-Runner-Capabilities` carries `integration-observe/v1`;
  - every integration job a heartbeat answer handed out, in full;
  - every result the runner sent back, in full.

  Each scenario's `runner-wire.jsonl` keeps the job lines; `s5-old-runner/runner-wire.jsonl` keeps every heartbeat too.

## Scenario notes

**1, `s1-agent-push/`:** S1-A DONE at 01:19:53. Its identity was frozen when its session finished, at 01:20:06.571 (O-L4
3; `delivered_sha` = the pushed commit, `delivered_branch` = the task branch). OBSERVE_LANDING generation 1 was
claimed at 01:20:11.072 (`observeTasks` in the wire log) and answered `onUpstream: true, fullyApplied: true`. The
receipt was written at 01:20:11.147: `ALREADY_MERGED`, `target_branch main`, `target_sha_before` = U, `recorded_by
RUNNER`, `detail {observed: true, integrationJobId}`. S1-B's session was created at 01:20:11.195 by J10, then S1-B was
observed and received its own receipt (generation 2). No open item, no receipt other than the runner's, no retried job,
no promotion candidate (O-L2). The origin has only `main`.

**2, `s2-cherry-pick/`:** The task branch keeps `83212397`; main got the cherry-pick `2e33f82a`.

- The observation answered `onUpstream: false, fullyApplied: true` → LANDING_UNOBSERVED with reason
  `APPLIED_AS_OTHER_COMMITS`, assignee COORDINATOR, dedupe `LU:<task>:<sha>`, title `Not on main yet: …`.
- J9 refused S2-D with `A prerequisite is finished but its work is not on main yet — see “Not on main yet” in open
  items`.

The coordinator, through MCP:

- `open_item_resolve` was refused `OPEN_ITEM_HAS_ITS_OWN_DOOR`.
- `integration_observe` queued generation 2 and recorded the handling reason on the item (H1). It answered not seen
  again, and the item stayed the only one, OPEN.
- `merge_receipt` (ALREADY_MERGED, S2-C's session, `sourceSha` = the cherry-pick) resolved the item `RESOLVED / LANDED`
  at 01:23:12.456. S2-D's session was created at 01:23:12.495 (J10).

**3, `s3-platform/`:** Neither task branch was ever on the origin.

- **S3-F pushed to main first.** Its candidate carried `source_sha = delivered_sha` once the identity froze. The
  CHECK_PROMOTION was handed over with `sourceSha` and answered `ALREADY_LANDED`, giving:
  - a receipt with `detail {observed: true, integrationJobId: <the check>}`;
  - the candidate `SUPERSEDED`, not BLOCKED;
  - LANDED_WITHOUT_CONFIRMATION for the owner, titled `Reached main without your confirmation: …`, actions `ACCEPT`,
    `OPEN_TASK_SESSION`.

  S3-F2 started by itself.
- **S3-E only committed.** Its check by commit answered `READY` (no SOURCE_BRANCH_MISSING). The owner confirmed it.
  LAND_PROMOTION was handed over with `sourceSha` and answered `LANDED`, giving a `MERGED` receipt, and S3-E2 started
  by itself.

No candidate BLOCKED, no SOURCE_BRANCH_MISSING, and no fetch of a task branch in the runner log.

**4, `s4-backfill/`, prefixed by phase:** `a-` before the deploy (0.1.239 server and runner), `b-` the deploy, `c-` the
runner upgrade. `transcript.md` and `queries.txt` hold all three phases in order. The runner log and wire log of the
deploy phase are scenario 5's (`s5-old-runner/runner.log`, `runner-wire.jsonl`), because it is the same window.

- **The 10-28 shape, made by the old code itself:**
  - A MAIN line whose upstream is `feature/release-2`.
  - Agents that push HEAD there and never publish their branches.
  - Five TASK_BRANCH candidates BLOCKED: four `ERROR / SOURCE_BRANCH_MISSING`, and T4's (its agent also published the
    branch) `ALREADY_LANDED`.
  - One receipt in the whole project: T3's agent recorded it with `merge_receipt`, so T6, its dependent, could start.
  - T5, which depends on T1 and T2, refused by J9 although their commits are on the branch.
  - The coordinator's four INTEGRATION_ERROR items closed as `HANDLED`.
- **The deploy:** the apiserver log says `landing backfill: 1 project(s) with unfrozen finished work, 4 identities
  frozen, 1 observation(s) queued, 0 failed`.
  - T3 is not frozen: it is already landed by its own receipt, and §10.9 freezes only DONE, NOT_KNOWN code tasks.
  - The observation's enqueue fact carries `trigger: DEPLOY`.
  - It stays QUEUED while only the 0.1.239 runner is connected.
- **After the runner upgrade:**
  - The deploy round answered: four `ALREADY_MERGED` receipts (`detail.observed`), the four candidates `SUPERSEDED`.
  - One LANDED_WITHOUT_CONFIRMATION `UL:backfill:<projectId>` for the owner, titled `Reached feature/release-2 without
    your confirmation: 4 tasks`, with payload `{backfill: true, jobId, targetBranch, receipts[4]}`. No per-task item.
    The owner's Accept closed it `RESOLVED / ACCEPTED` by USER.
  - T5 started by itself.
  - A second apiserver start wrote nothing: the same number of observations, of `UL:backfill` items and of receipts.

**5, `s5-old-runner/`:** With this branch's apiserver and the 0.1.239 runner:

- Every heartbeat declares `integration-job/v1` without `integration-observe/v1`.
- The deploy round's OBSERVE_LANDING stayed QUEUED and unclaimed. No heartbeat answer ever carried an OBSERVE_LANDING
  or a CHECK_PROMOTION with `sourceSha`, while the candidate rows themselves carry `source_sha`.
- S5-H published its branch. Its check went over in the old shape (no `sourceSha`), the runner fetched the branch and
  answered `READY`. The owner confirmed, and LAND_PROMOTION answered `LANDED` with a `MERGED` receipt. S5-H2 started by
  itself. That LAND_PROMOTION does carry `sourceSha`: the confirmed commit, as before revision 29
  (`h-land-command.json`). Only the CHECK_PROMOTION is named by its commit since O-L5, and only for runners that
  declare the capability.
- The wire log holds 12 heartbeats, all `0.1.239`, none declaring `integration-observe/v1`. The 4 jobs they handed out
  were 3 CHECK_PROMOTIONs without `sourceSha` and 1 LAND_PROMOTION.
- S5-I did not publish its branch and still answers `SOURCE_BRANCH_MISSING` on that runner, exactly as today.

After the upgrade (`checks-after-upgrade.json`), the owner's retry of S5-I's BLOCKED candidate went to the new runner
with `sourceSha` and answered `READY`. This is the PLATFORM path §10.9 leaves to a project's own pipeline (`integration_retry`
re-checks by O-L5).

## Findings and what was done with them

No product defect was found, so this task changes no product code. What came up:

1. **Reported to the coordinating session, not fixed here: a BLOCKED candidate survives the deploy when the task
   recorded its own receipt before DONE (S4-T3).**
   - **How it arises.** The 0.1.239 server made T3's candidate at DONE, after T3's agent had already recorded its
     receipt, so M-T13 never retires it: it retires only candidates created before the receipt.
   - **Why the pass leaves it.** T3 is not NOT_KNOWN, so the pass neither freezes nor observes it. Its candidate stays
     `BLOCKED / ERROR` with no `source_sha`. A retry would fetch the never-published branch again and answer
     SOURCE_BRANCH_MISSING again.
   - **Impact.** No owner read on the stack surfaces it: no blocker, no withheld criterion, the criterion `LANDED`, and
     it is not the current promotion (`c-owner-reads.json`). Its INTEGRATION_ERROR item was already closed as handled
     before the deploy.
   - **Production.** 10-28's project probably holds one such row, the candidate of its task whose agent recorded the one
     receipt. R29-14's check counts only new SOURCE_BRANCH_MISSING candidates, so this one should not be read as a
     failure of the backfill.
   - **Decision left to the coordinator:** whether the pass should also retire BLOCKED candidates of tasks that already
     have an upstream receipt. That is a contract change.
2. **Artifacts of the kit, not of Orbit:**
   - The coordinator's `DELIVERY_REVIEW` "Changed files it didn’t declare" for S4-T5 comes from the declared-scope
     heuristic (`declaredPaths` in `blocker-disposition.ts`). It reads the kit's `E2E-UPSTREAM: origin/feature/release-2`
     line as a declared path.
   - The J9 refusals answer HTTP 400, as they did before revision 29. §10.9 rewrites only the sentence.
3. **Stopped by bugs in the kit, not in Orbit:**
   - Two earlier scenario 3 attempts on stack A. In the first, a read helper took psql's `(0 rows)` for a value. In the
     second, task titles were matched across projects. Their projects are still on stack A, untagged (`S3 PLATFORM:
     candidates named by their commit`, `S3 PLATFORM: each candidate is named by its commit`), and the run kept here is
     `(run 3)` on repository `s3c`. In both attempts the rows show the same product behaviour as run 3.
   - Two earlier stack-B passes. Two of their checks expected the wrong thing: T3 frozen, and an owner read taken before
     T5's own landing. Their start-runner also matched stack A's runner process, since fixed with a per-stack runner
     binary path. Stack B was wiped, and scenarios 4 and 5 kept here come from one clean pass.

## Not covered here

- **One runner per stack.** "Checked by the source runner" is trivially true. Claim routing between runners, and
  `WORK_COMMIT_MISSING` (a runner without the commit), are left to R29-8's pg spec and Go tests.
- **Paths not exercised:**
  - O-J4: observation errors, `IE:observe`.
  - O-T1's `IDENTITY_UNKNOWN`.
  - O-L7's `WORK_ELSEWHERE` and the other-repository rule.
  - `RUNNER_LOCAL` authority.
  - A PROJECT_BRANCH line (`onIntegrationLine`).
  - LAND_TASK with the old runner.
  - The multi-replica advisory lock of the deploy pass: one apiserver.
- **The agent is a stand-in.** No model read the O-L3 sentence. The fake engine parsed it.
- **Production data.** None was used, as instructed. The 10-28 shape was rebuilt by the 0.1.239 code itself, under made-up
  names.
- **Clients.** Web, iOS, Android and their copy were not exercised (R29-10 to R29-12).

## Reproduce

Requirements: root (for `unshare` and `mount`), docker, git, node, go, openssl, and a checkout with a plain `npm ci` of
this lockfile for `NM_SRC`.

```bash
K=docs/evidence/landing-observation/e2e/kit
export NM_SRC=<checkout with node_modules>                 # hard-linked into the server builds
bash $K/stack.sh old-runner                                # bin/orbit-0.1.239 from /usr/local/bin/orbit
bash $K/stack.sh build-runner new HEAD
bash $K/stack.sh build-server new HEAD
bash $K/stack.sh build-server old 18dfe8f1c
# stack A: scenarios 1-3
export R2913_STACK=a
bash $K/stack.sh db new && bash $K/stack.sh start-api new && bash $K/stack.sh start-proxy
node $K/bootstrap.mjs new s1 s2 s3c
node $K/s1-agent-push.mjs && node $K/s2-cherry-pick.mjs && node $K/s3-platform.mjs
# stack B: scenarios 4-5 (old world -> deploy -> runner upgrade)
export R2913_STACK=b
bash $K/stack.sh db old && bash $K/stack.sh start-api old && bash $K/stack.sh start-proxy
node $K/bootstrap.mjs 0.1.239 s4:feature/release-2 s5
node $K/s4a-old-world.mjs && node $K/s4b-deploy.mjs && node $K/s4c-upgrade.mjs
# teardown
R2913_STACK=a bash $K/stack.sh clean; R2913_STACK=b bash $K/stack.sh clean
```

Everything else lives under `R2913_DIR` (`/var/tmp/r29-13-e2e`), which must not be under `/root`. That directory holds
the server builds, the binaries and, per stack, the logs, the secrets, the runner's home and the bare origins.
