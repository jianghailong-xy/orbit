<!-- 2026-11-11 · the owner took every recommendation in §4 (D1 A, D2 A, D3 A, D4 A, D5 B2, D6 A). Board: docs/mocks/task-fork-from-session/01-architecture.html (+ PNGs). -->

# A task that starts from my session's work, and a task that leaves no empty branch

Two gaps in where a task's code starts and what it leaves behind:

- **Fork (A + C).** An agent creating a task cannot say "start from what I have". The task's session forks
  from the workspace's `workDir` HEAD. It does not see the creating session's branch, or the edits that session
  has not committed yet. Today the only workarounds are to commit and merge into the main checkout first, or
  to do the work inline.
- **Codeless (B).** A task declared `codeless` still gets a worktree **and a branch** whenever its workspace has
  worktrees on. The branch is left behind with nothing on it. Nothing in the runner deletes a session's branch
  (`worktree.go`, `restoreBranchOfAbsentCheckout`), so it reads as unfinished work.

An agent does **not** get a choice between "run in a new worktree" and "run in my worktree". Two sessions writing
one directory overwrite each other. `docs/project-source-contract.md` (SR1, SR33) removed every path that silently
fell back to a shared checkout, and a "shared" option would reopen them. A task that wants to continue someone's
work gets its own checkout that **starts from** that work.

## 1. Where things stand

| Question | Today | Where |
|---|---|---|
| Does a session get a worktree? | `workspace.enableWorktree`, default off. No per-task or per-session field. | `sessions.service.ts` `create()`, `branch = enableWorktree ? makeBranchName(title) : null` |
| Can an agent choose it? | No. `task_create` / `session_create` have no such field. `agent_update enableWorktree` changes every later session of that agent and needs the owner's card. | `mcp.go` `taskCreateProps`, `session_create` |
| Which commit does a non-project task start from? | `workDir` HEAD at claim (Legacy, SOURCE `UNBOUND`). | `session-source.ts` `decideSessionSource` → P0′ |
| Which commit does a project task start from? | Resolved and pinned by the SOURCE table (P1–P5). It must have its own worktree (`WORKTREE_REQUIRED`). | `project-source-contract.md` §4–§6, `worktree.go` `setupSourceWorktree` |
| Any per-session override? | Only `noWorktree` (no branch), and only for the conversation that a mention in a task opens. | `tasks.service.ts`, `sessions.service.ts` `opts.noWorktree` |

## 2. Fork: a task that starts from the calling session

### 2.1 What the agent writes

```
task_create { title, completionCriterion, ..., forkFromSession: true }
```

`forkFromSession` takes no id. It always means **the session making this call** (`ORBIT_SESSION_ID`), which is the
only checkout the MCP process can see (§2.2), and it keeps one session from forking another's private edits.
`task_create_batch` takes it per item. Every item that sets it shares one snapshot taken at the start of the call.

### 2.2 The snapshot (runner, inside the `task_create` call)

The `orbit mcp` process runs on the calling session's runner. Before it posts the task, it snapshots that
session's checkout (`worktreesDir()/<sessionId>`, or `workDir` for a session with no worktree) **without touching
it**:

1. Copy the session's own index byte for byte (`cp -p <index> <temp>`), then
   `GIT_OPTIONAL_LOCKS=0 GIT_INDEX_FILE=<temp> git add -A --sparse` → `git write-tree`. The session's own index,
   staged state and working files are unchanged. Untracked files are included, and `.gitignore`d ones are not.
   - **Not an empty index** (P0 F1, 2026-11-11): session checkouts are sparse. An empty index has no skip-worktree
     marks, so it stages the deletion of every left-out path (8,430 here), drops tracked files that match
     `.gitignore`, exits 1 on an untracked file under a left-out path, and on a clean checkout gives a tree that is
     not HEAD's. The copied index keeps all of that right and takes 0.1–0.5 s instead of 2–12 s.
   - **`GIT_OPTIONAL_LOCKS=0` is required** (P0 F2): without it, `add -A` refreshes and rewrites a racily clean
     submodule index, which touches the session's checkout.
   - Not the runner's `stagedLiveDiff` seeding (copy, then `read-tree -m HEAD`): it fails on a staged-then-edited
     file and during a merge.
2. `git commit-tree <tree> -p HEAD -m "Snapshot of session <id> for task <title>"` → snapshot SHA `S`. When the
   tree equals HEAD's tree (nothing uncommitted), `S` is simply `HEAD`, and no commit is made.
3. `git update-ref refs/orbit/fork/<snapshotId> S`, so `git gc` cannot drop `S` before the task runs.
4. Post the task with `fork: { sessionId, sha: S, baseHead: HEAD, includesUncommitted: S != HEAD }`.

Cases A and C are one mechanism. With a clean checkout the task starts from the session's branch tip. With
uncommitted edits it starts from those edits.

### 2.3 Server: a new SOURCE row

The task stores the fork as create-time facts (`task.forkSessionId`, `task.forkSha`, `task.forkIncludesUncommitted`).
The SOURCE table (`project-source-contract.md` §4.1) gains one row, ahead of P0′:

| Row | Predicate | `sourceKind` | Baseline | Selector |
|---|---|---|---|---|
| **PF** | `codebase == null` ∧ `task.forkSha != null` | `SESSION_FORK` | `task.forkSha` | SHA value, `refAuthority = RUNNER_LOCAL`, `authorityRunnerId` = the forking session's runner |

This keeps the contract's rules:

- **SR12 / SR19.** The pin never changes. A retry of the task starts from the same `S`, and if `S` is unreachable
  the run is refused. It never falls back to `workDir` HEAD.
- **SR17.** The resolver still reads no workspace or `workDir`. The fork is a fact on the task, written at
  creation.
- **SR18.** The reason reads "Forked from session «title» at abc1234 (includes uncommitted changes)". Clients show
  it wherever they show a run's SOURCE today.

### 2.4 Where it can run

- **Same machine only (v1).** The task is bound to the forking session's runner. At creation the server refuses an
  `assigneeId` whose workspace is on another runner (`FORK_SOURCE_NOT_REACHABLE`). At claim, `setupSourceWorktree`
  already refuses a pinned commit the repository lacks rather than fetching it. That covers a workspace on the same
  runner whose `workDir` is a different repository.
- **Always its own worktree.** A forked task gets a branch even when its workspace has worktrees off. A pinned
  run with no branch is refused today (`WORKTREE_REQUIRED`), and sharing a directory with the session it forked
  from is exactly what this design rules out.
- **Not inside a project with a code binding (v1).** A project task's baseline has to be on its project line
  (SR1). A fork from a coordinator's uncommitted edits would let work enter the line without being landed.
  Refused with `FORK_IN_BOUND_PROJECT`. D4 asks whether to allow it later.

### 2.5 Getting the work back

When the task is DONE, its branch is `S` + the task's commits, in the same repository as the forking session.
In v1 the **forking session merges it itself**:

- The `task_await` payload for a forked task carries `branch`, `forkSha` and the one command to run in the
  forking session's checkout: `git merge --no-ff <branch>`.
- If the forking session committed `S`'s edits in the meantime (its own turn-end commit, for example), git sees
  the same changes on both sides from `baseHead` and merges them without conflict. Conflicts happen only where the
  forking session kept editing the lines the task changed. That is a real conflict, and it is the forking agent's
  to resolve.
- `merge_receipt` records the merge as it does today for a by-hand landing. The task's work is then on record
  as landed in the forking session's branch.

Orbit does not merge into a live session's checkout for it in v1 (D3).

### 2.6 Cleanup

`refs/orbit/fork/<snapshotId>` is deleted when no task that names `S` remains open. The runner's existing gc pass
reads the task states it already receives.

### 2.7 Limits found by P0 (2026-11-11), and what v1 does

- **Submodules (F3).** `S` records a submodule only as its gitlink. A submodule's uncommitted edits are not in `S`,
  and a submodule commit that exists only in the session's clone cannot be fetched by the task's checkout. v1
  refuses the fork in `orbit mcp`, before anything is posted, when any submodule has uncommitted changes or its
  checked-out commit is not reachable from the workDir's copy of that submodule: `FORK_SUBMODULE_NOT_SHAREABLE`,
  naming the submodule. This repository has none.
- **An edit reverted after the snapshot comes back (F4).** If the forking session undoes an edit that `S` captured,
  then merges the task branch, git sees the edit only on the task's side and brings it back without a conflict.
  That is what a merge of `S` means, so v1 does not try to detect it. The `task_await` payload names the files `S`
  changed relative to `baseHead`, and the merge instruction says to read `git diff HEAD...<branch>` before merging.
- **Large untracked files (F5).** They are written into the shared object store, and the keep-alive ref holds them
  until §2.6 cleanup removes the ref. v1 sets no size limit. Cleanup is what bounds it.

## 3. Codeless: isolated, but no branch unless something changed

A `codeless` task declares that it produces no code. Two ways to stop it leaving an empty branch:

- **B1: no worktree.** Pass `noWorktree` for codeless task runs, as mention conversations do. The run happens in
  the shared `workDir`. If the agent writes a file anyway, it writes it into the main checkout, next to whatever
  else runs there.
- **B2 (recommended): detached worktree, branch made lazily.** The run still gets its own checkout
  (`git worktree add --detach <base>`). At finalize the runner checks for changes:
  - **No changes:** the checkout is removed, and no branch ever existed.
  - **Changes:** the runner creates `orbit/<name>` at that point, commits, and reports the branch with its
    changed files, as any run does today. Nothing is lost.

Neither option decides what a codeless task that did write code means for its criterion. Today
`task-codeless.ts` refuses only the *later* declaration on a task with commits; a task created codeless that
then commits is not flagged. That is unchanged by this design and noted as a follow-up.

B2 keeps isolation and leaves nothing behind in the common case. Its cost is that the server must accept a branch
first reported at finalize rather than named at creation, for this one kind of session.

## 4. Decisions (owner, 2026-11-11: every recommendation taken)

| # | Question | Options | Recommendation |
|---|---|---|---|
| D1 | How the uncommitted edits travel | A: snapshot commit on a side ref; the forking session is untouched · B: really commit them on the forking session's branch first | **A.** The forking agent may be mid-edit, or have sub-agents writing. A commit under it changes its index and history without its consent. |
| D2 | Where a forked task may run | A: the forking session's runner only · B: also other runners, by pushing `S` to the remote | **A** for v1. B needs a writable remote and leaks unfinished work to it. |
| D3 | Who merges the result back | A: the forking session, with the command in the `task_await` payload · B: Orbit merges into the forking session's branch when that session is idle | **A** for v1. B needs a new runner operation on a live checkout, and a conflict policy. |
| D4 | Forks inside a project with a code binding | A: refused in v1 · B: allowed, with the project line as a required ancestor of `S` | **A.** Revisit once the landing-back path has been used outside projects. |
| D5 | Codeless runs | B1: no worktree · B2: detached worktree, branch only if changes | **B2.** |
| D6 | Which session can be forked | A: only the calling session · B: any session of the owner by id | **A.** Its checkout is the only one the MCP process can read, and B would let one agent fork another's unfinished edits. |

## 5. Phases (each depends on the one before)

- **P0 probe.** On a real runner: snapshot a dirty worktree with a temporary index (untracked, ignored, staged and
  renamed files; a submodule; an index lock held by the session). `worktree add` the snapshot from a second checkout
  of the same repository. Merge the task branch back after the forking session's own commit of the same edits.
  **Done:** each case has a recorded transcript; the merge-back is clean except for a deliberate overlapping edit.
- **P1 server.** Columns and migration, `forkFromSession` on both create doors, the PF row with its contract
  section and tests (including PF ∩ retry, PF ∩ project refusal), placement refusals, and the reason string.
  **Done:** a pg spec creates a forked task, claims it and sees `SESSION_FORK` pinned to `S` on the right runner.
  A spec for each refusal.
- **P2 runner.** The snapshot in `orbit mcp`, the keep-alive ref and its gc, and a forced branch for forked runs.
  **Done:** a real-runner drill where a session with uncommitted edits forks a task, the task changes one more
  file, and the forking session merges it back. Both edits are on its branch, and the forking checkout was
  byte-identical before and after the fork.
- **P3 codeless and clients.** B2 in the runner and in the finalize report. The fork line in the task and session
  views on web, macOS/iOS and Android (copy in English). The `task_await` payload.
  **Done:** a codeless run with no changes leaves no branch; one that writes a file leaves a branch with its
  changed files. Each client shows the fork line.
