# Main checkout Git — contract

Project 34vZkpKmUuObg8kDVU4Lk. Design: [docs/mocks/main-checkout-git/](mocks/main-checkout-git/board.html)
(board 01–05, approved 11-11). This document fixes the shapes, codes and copy that the runner,
the apiserver and the four clients share; it does not describe how the runner implements them.

| Where | What |
|---|---|
| `src/shared/src/mainCheckoutGit.ts` | TypeScript DTOs, enums, constants and every English string below (exported from `@orbit/shared`) |
| `src/shared/src/main-checkout-git.fixture.json` | Examples of every shape, the fingerprint test vectors, and one result per code with its exact line |
| `src/shared/src/mainCheckoutGit.spec.ts` | Pins codes, kinds, capability, notice kinds, fingerprint and copy against the fixture |
| `src/runner-go/main_checkout_types.go` | Go mirror of the wire shapes and names (types only) |
| `src/runner-go/main_checkout_types_test.go` | Parses the same fixture into the Go types (unknown fields refused, exact round trip), recomputes the fingerprints |

The **main checkout** is the directory a workspace points at: worktree sessions fork from it and
merge back into it, and Shared sessions work in it directly. A person decides only who its
uncommitted changes belong to; the runner does the Git, leaves a recovery point first, and changes
nothing when it refuses.

## 1. Capability

A runner that implements this declares `main-checkout-git/v1` in `X-Orbit-Runner-Capabilities`
(`MAIN_CHECKOUT_GIT_CAPABILITY` / `mainCheckoutGitCapabilityV1`). That is the only negotiation.
Without the capability, clients still draw the card's text but show no action buttons, and the
apiserver refuses `POST …/main-checkout/actions` with HTTP 409.

## 2. Snapshot

`GET /workspaces/:id/main-checkout` returns a `MainCheckoutSnapshot`:

| Field | Meaning |
|---|---|
| `root` | realpath of the repo root (`git rev-parse --show-toplevel`, symlinks resolved). Locks and comparisons use this path. |
| `branch?` | Current branch; absent when HEAD is detached |
| `head?` | HEAD commit, full sha; absent before the first commit |
| `state` | `RunnerRepoHealth.state` vocabulary: `clean`, `dirty`, `unmerged`, `merge`, `rebase`, `cherry-pick`, `revert` |
| `upstream?` | Upstream ref, e.g. `origin/main`; absent when the branch has none |
| `ahead?` / `behind?` | Commits on the branch but not on upstream, and on upstream but not on the branch, as of the runner's last fetch |
| `files[]` | `MainCheckoutFile`, sorted by path in **UTF-8 byte order**, at most `MAIN_CHECKOUT_FILE_LIMIT` = 200 |
| `fileCount` | Files counted: `files.length`, or 200 when truncated |
| `truncated` | The runner stopped counting at 200; there are more |
| `fingerprint` | See §3 |
| `checkedAt` | ISO time of the scan |

`MainCheckoutFile`: `path` (repo-relative, `/`-separated); `status` `M` / `A` / `D` against HEAD,
working tree included, with no rename detection (a rename appears as D + A); `contentHash`, the
git blob id of the working-tree content (`git hash-object <path>`), or `-` when deleted;
`untracked?`; `binary?`; `additions?` / `deletions?` (absent for binary).

**Boundary.** Ignored files are never listed, moved, committed or cleaned. Untracked files are
included.

**Diff.** Patches are read per file on demand (`MainCheckoutFileDiff`: `path`, `binary`, `patch?`,
`patchTruncated?`), each capped at `MAIN_CHECKOUT_PATCH_MAX_BYTES` (256 KiB). Patches never travel
on the heartbeat, and file contents and credentials are never logged.

## 3. Fingerprint

```
canonical = "mc1\n" + "head " + (head || "-") + "\n"
          + for each changed file, sorted by path in UTF-8 byte order:
              status + " " + contentHash + " " + path + "\0"
fingerprint = "mc1:" + (head || "-") + ":" + hex(sha256(canonical))
```

- It covers **every** changed file, including those past the 200 limit.
- The index is not part of it, because Commit and Move act on working-tree content.
- HEAD is readable from the string, so Push can compare only the HEAD part.
- The runner recomputes the fingerprint before every action. Any difference refuses with
  `FINGERPRINT_STALE`, or `HEAD_MOVED` when only HEAD differs.
- Test vectors, including one where UTF-8 and UTF-16 order disagree, are in the fixture's
  `fingerprints`.

## 4. Heartbeat

Once a runner has the capability, each `repos[]` entry (`RunnerRepoHealth`) also carries
`MainCheckoutHeartbeatFields`: `head`, `upstream`, `ahead`, `behind`, `fileCount`, `truncated`,
`fingerprint`. These are **counts and the fingerprint only**: never file contents, never patches.
The existing `paths` list (capped) stays. The cadence stays 60 s (`repoHealthRefreshInterval`).
The bar reads these fields; the drawer fetches the full snapshot.

## 5. Actions

`POST /workspaces/:id/main-checkout/actions` takes a `MainCheckoutActionRequest`:

| Field | move | commit | push | rescue |
|---|---|---|---|---|
| `kind` | `move` | `commit` | `push` | `rescue` |
| `root` | ✓ | ✓ | ✓ | ✓ |
| `fingerprint` | ✓ | ✓ | ✓ (only the HEAD part is checked) | ✓ |
| `files` | chosen paths, ≥ 1 | chosen paths, ≥ 1 (default: all) | — | — (saves everything) |
| `message` | — | non-blank | — | — |
| `targetSessionId` | session receiving the files | — | — | — |
| `requestId` | ✓ | ✓ | ✓ | ✓ |

- `requestId` is generated by the client. A repeat with the same id returns the first request's
  outcome.
- A malformed request (wrong fields for the kind, or a path not in the snapshot) is HTTP 400 and
  writes no line.
- Only one request per main checkout may be in flight at a time; a second gets
  `ACTION_IN_FLIGHT`.
- The apiserver relays a `MainCheckoutActionCommand` to the runner: the request plus
  `targetBranch?`, `requestedAt` and `expiresAt`. The runner never starts a command after
  `expiresAt`.
- After `MAIN_CHECKOUT_ACTION_TIMEOUT_SECONDS` (300 s) without a result, the apiserver fails the
  request with `TIMEOUT`. A result that arrives later is still written as its own line.

On the runner, move, commit, push and rescue on one realpath share a single lock with the session
Merge (`mergeToMain`). What each action does:

- **move**: check fingerprint → save the checkout to `orbit/rescue-*` (`rescueWorkingTree`) →
  3-way apply to the target worktree, `--check` first → restore only those paths in the main
  checkout to HEAD and delete those untracked files. A target running a turn is refused with
  `TARGET_BUSY`.
- **commit**: check fingerprint → build a temporary index holding only the chosen files →
  `commit-tree` → `update-ref` with the expected old HEAD (CAS) → align the real index's chosen
  paths to the new HEAD; unchosen staged, unstaged and untracked content is untouched. A commit is
  not a session merge and does not count as a task landing.
- **push**: push the current branch to its upstream, or to `origin/<branch>` with `-u` when it has
  none. Plain `git push`, **never** `--force`, using the runner machine's git credentials.
- **rescue** (Save & clean): today's Clean up checkout, widened to accept `dirty`, plus the
  fingerprint check. Nothing is cleaned unless the rescue branch exists.

Before Commit and Push, if the branch is a project's integration line or landing target, clients
show `This skips project <title>'s landing check.` The warning informs; it never blocks.

Crash recovery: every step can be redone safely. An existing commit is not rebuilt, a ref that
already points to it is skipped, and the rescue branch name derives from a content hash.

## 6. Result

`MainCheckoutActionResult` fields:

- Always present: `requestId`, `kind`, `root`, `status`, `finishedAt`.
- Present when status is not `done`: `code`.
- Depending on kind and code: `branch`, `fileCount`, `remaining` (move: changed files left in the
  checkout), `rescueBranch`, `head`, `subject`, `upstream`, `remoteBefore`, `remoteAfter`,
  `targetSessionId`, `targetBranch`, `paths`, `state`, `ahead`, `behind`, `gitMessage`, `runnerName`,
  `minutes`.

`gitMessage` is git's own reason: one line, with credentials and URL userinfo removed.

`status`:

- `done`
- `partial`: `MOVE_SOURCE_CHANGED` only. The files were copied to the target but not cleared from
  the source.
- `refused`: nothing changed.
- `waiting`: `RUNNER_OFFLINE` only. The action has not run yet; a later result follows.

## 7. System events

Lines are written into the session that initiated the action:

| noticeKind | When | Payload |
|---|---|---|
| `main-checkout-changed` | A worktree turn ended and the main checkout has new or content-changed paths (compared by path + contentHash). It replaces `shared-checkout-dirty` and its old copy. A checkout that was already dirty when the session started gets no card, only the bar; one batch of changes produces one card. | `MainCheckoutChangedNotice`: `notice`, `root`, `branch?`, `files[]` (path, status, binary, +/−; same cap and order as the snapshot), `fileCount`, `truncated`, `fingerprint` |
| `main-checkout-action-result` | Every action outcome, including waiting, timeout and cancel | `MainCheckoutResultNotice`: `notice` (= the line's text), `result` |

Both are stored as a `system` run event whose payload is the notice object. How an action-result line gets into the
session is in §10.3: the control plane never writes a `run_event` that a live runner might be about to number.

## 8. Refusal codes and result lines

Each line comes from `mainCheckoutResultLine(result, view)`, which returns
`{tone, lead, text, link?}`. `lead` is the bold opening of `text`. Lines marked **board** are board
03's sentences character for character. The board shows only the Move variant of "Nothing …"; the
other kinds follow the same pattern (`Nothing committed / pushed / saved`,
`Can't move / commit / push / save right now`).

### Success

| Kind | Example line | Link |
|---|---|---|
| move | **board** Moved 3 files into this worktree. The main checkout is clean again. A copy of what it held is on orbit/rescue-5f2c1a9. | View changes |
| commit | **board** Committed 3 files to main in the main checkout as 8d41e0c “Add retry backoff”. Not pushed yet. This session's branch is unchanged. | Push to origin/main |
| push | **board** Pushed main to origin (62325fb..8d41e0c). | — |
| rescue | **board** Saved 3 files to orbit/rescue-5f2c1a9 and returned the main checkout to 62325fb. Ignored files were left alone. | Open in a new session |

Variants of the success lines:

- **Move into another session** reads `into the worktree of “<title>”`.
- **Move with unchosen files left behind** reads `The main checkout still has N other uncommitted files.`
- **Commit in a Shared session** drops the last sentence, because there is no session branch.
- **Push of a new branch** reads `Pushed b to origin as a new branch (8d41e0c).`

### Refusals

| Code | Status | Who sets it | Example line | Link |
|---|---|---|---|---|
| `FINGERPRINT_STALE` | refused | runner | **board** Nothing moved: the main checkout changed since you looked (src/api/retry.ts). | Review again |
| `HEAD_MOVED` | refused | runner | Nothing committed: main moved to 9a1b2c3 since you looked. | Review again |
| `MOVE_CONFLICT` | refused | runner | **board** Nothing moved: src/api/client.ts is also changed in this worktree, in the same lines. Commit it to main or save it to a rescue branch instead, or ask the agent to combine them. | ask the agent to combine them |
| `MOVE_SOURCE_CHANGED` | partial | runner | Copied 3 files into this worktree but left them in the main checkout: src/api/retry.ts changed while they were moving. A copy of what it held is on orbit/rescue-5f2c1a9. | Review main checkout |
| `TARGET_BUSY` | refused | runner | Nothing moved: that session is working on a turn. Move the files when it ends. | — |
| `CHECKOUT_BLOCKED` | refused | runner | **board** Can't commit right now: the main checkout is in the middle of a rebase. | Clean up checkout |
| `DETACHED` | refused | runner | Can't commit right now: the main checkout isn't on a branch (detached HEAD). | — |
| `NO_HEAD` | refused | runner | Can't commit right now: the main checkout has no commits yet. | — |
| `NOTHING_TO_PUSH` | refused | runner | Nothing to push: main is already on origin/main. | — |
| `NO_REMOTE` | refused | runner | Nothing pushed: main has no upstream and the main checkout has no remote named origin. | — |
| `PUSH_REJECTED` | refused | runner | **board** Push rejected: origin/main has 2 commits the main checkout doesn't. Nothing was changed, and Orbit never force-pushes. | Ask the agent to rebase and push |
| `PUSH_AUTH_FAILED` | refused | runner | **board** Push failed: the runner's git couldn't authenticate to origin (“Permission denied (publickey)”). Your commit is still in the main checkout. | — |
| `PUSH_FAILED` | refused | runner | Push failed: git couldn't push to origin (“Could not resolve host: github.com”). Your commit is still in the main checkout. | — |
| `RESCUE_FAILED` | refused | runner | Nothing saved: Orbit couldn't save the main checkout to a rescue branch first (“…”). The main checkout was left as it was. | — |
| `ACTION_IN_FLIGHT` | refused | apiserver | Nothing moved: another action on this main checkout is still running. Try again when it finishes. | — |
| `RUNNER_OFFLINE` | waiting | apiserver | **board** Waiting for the runner — orbit-hpc hasn't checked in for 3 min. Nothing has been changed; this runs when it's back, or you can cancel. | Cancel |
| `TIMEOUT` | refused | apiserver | Timed out: orbit-hpc didn't answer within 5 min, so Orbit stopped waiting. If it ran the action anyway, its result will appear here. | — |
| `CANCELLED` | refused | apiserver | Cancelled: nothing was changed. | — |

`CHECKOUT_BLOCKED` takes `state`:

- `merge`, `rebase`, `revert` and `cherry-pick` read "is in the middle of a …".
- `unmerged` reads "has unresolved conflicts".

Link actions (`MAIN_CHECKOUT_LINK_ACTIONS`): `view-changes`, `push`, `open-in-new-session`,
`review-again`, `ask-agent-combine`, `ask-agent-rebase-push`, `clean-up-checkout`, `cancel`.

## 9. Other shared copy

The same module holds these strings and builders:

- **Board 01 card.** `mainCheckoutCardTitle`: "3 files changed in the main checkout during this
  turn", or "At least 200 files …" when truncated. `mainCheckoutCardSubtitle`: "/root/orbit on
  main, outside this session's worktree. Orbit saw them appear; it can't tell who wrote them."
  Also "and N more" (the card shows `MAIN_CHECKOUT_CARD_VISIBLE_FILES` = 8),
  "Orbit stopped counting at 200 files.", the button labels and the Move hint, and the `⋯` menu
  items with their hints.
- **Board 01⑤ / 02④ bar.** "Main checkout", `3 uncommitted files`,
  `Clean · 1 commit not pushed`, `Push to origin/main`, `Review` / `Review and commit…`.
- **Board 02 drawer.** `Choose files to commit · 3 of 3`, `Commit 3 files to main`,
  `Commit message`, the ignored/untracked footnote, and the target-picker hints "The session you
  opened this from" and "Working now — available when this turn ends". Merge's `ffClash` line adds
  the link "Review main checkout".
- **Board 04 isolation dialogs.** Titles, the dirty / stuck / turn-off bodies,
  "Nothing in the checkout is changed. …", "Orbit can't see this checkout right now.", and the
  buttons.

All of it is English and passes `src/web/src/copyLanguage.test.ts`. The prompts behind
"Ask the agent …" are not on the board and are left to the client task that draws them.

## 10. Relay

How a read or an action gets to the runner, and how the answer comes back. This is the repo-cleanup relay made general.
Each request is a `main_checkout_request` row (migration 0534). The heartbeat hands it out **once**: a
compare-and-set from `pending` to `claimed`. The row is finished by whichever comes first: the runner's answer or the
deadline. The TypeScript shapes live in `mainCheckoutGit.ts`, under "The relay".

### 10.1 Heartbeat

`RunnerHeartbeatResponse.mainCheckoutRequests?: MainCheckoutRunnerRequest[]` goes only to a runner that declares
`main-checkout-git/v1`, and only while the runner is not draining. Each entry has one of two shapes:

- `{ id, op: 'snapshot', root, diffPaths?, requestedAt, expiresAt }` — `diffPaths` holds at most
  `MAIN_CHECKOUT_DIFF_PATHS_MAX` = 20 entries.
- `{ id, op: 'action', command: MainCheckoutActionCommand }`.

`id` is the row; the runner posts the answer under it. A runner never starts work after `expiresAt`. A snapshot read
waits `MAIN_CHECKOUT_SNAPSHOT_WAIT_SECONDS` = 20 s. An action waits `MAIN_CHECKOUT_ACTION_TIMEOUT_SECONDS`.

### 10.2 Answers (runner → control plane)

| Route | Body | Notes |
|---|---|---|
| `POST /runner/main-checkout/:id/snapshot` | `MainCheckoutSnapshotAnswer`: `{ snapshot, diffs? }` or `{ error }` | `{accepted:false}` once the read is finished |
| `POST /runner/main-checkout/:id/result` | `MainCheckoutActionResult` | `requestId` and `kind` must match the row. `status` is `done`, `partial` or `refused`. The runner never sends the four control-plane codes. |

Both routes find the row by `(id, the calling runner)`. Any other row is 404.

When a result arrives:

- **The first result** finishes the request and writes its line.
- **A second copy of the same result** is accepted with `{accepted:false}` and changes nothing.
- **A result after the control plane finished the request** (`TIMEOUT`, `CANCELLED`) never replaces that outcome.
  It is kept as `late_result` and written **once** as a line of its own. This is what the TIMEOUT line promises.

### 10.3 Result lines

The line goes into `initiatedFromSessionId` as a `system` event with no turn id, carrying a `MainCheckoutResultNotice`.
It is written in the same transaction as the compare-and-set that finished the request, so it is written once. The
write path depends on the session:

- **The session is live on a runner that declares the capability.** Live means `RUNNING`, `AWAITING_INPUT` or
  `INTERRUPTED`, with an assigned runner. The runner numbers that session's events itself and keeps the counter in
  memory. So the control plane queues an inbox turn of kind **`notice`**:
  - Its `content` is the `MainCheckoutResultNotice` as JSON.
  - Its `clientTurnId` is `main-checkout:v1:<row>:<result|waiting|late>`.
  - The inbox hands it out at once, whether or not a turn is running, and answers it as it hands it out.
  - The runner's inbox poller takes it before any engine sees it (`src/runner-go/main_checkout_notice.go`). It emits
    the payload through the session's own emitter, so the line takes the next seq like every other event.
  - It never reaches the agent, opens no turn and changes no session state.
- **Any other session.** The control plane writes the `run_event` itself at `max(seq)+1`, under the session row's
  lock. The next claim reads the maximum afresh.

A result line never writes a merge receipt, a session merge status or a project landing.

### 10.4 The person's routes

| Route | Answer |
|---|---|
| `GET /workspaces/:id/main-checkout?diff=<path>` (repeat `diff` for each file) | `MainCheckoutView`: `snapshot`, `diffs?`, `actionsSupported`, `managedBranch`, `inFlight` |
| `POST /workspaces/:id/main-checkout/actions` | `MainCheckoutActionAnswer`: `{ requestId, status: 'pending' }`, or `'finished'` with `result` |
| `POST /workspaces/:id/main-checkout/actions/:requestId/cancel` | The same, `CANCELLED`. Only before the runner was handed the action; 409 after. |

**GET errors.** 404 for a workspace that is not the caller's, or that has no reported checkout. 503 when its runner
is offline. 504 when the runner does not answer in time.

**GET without the capability.** The runner is not asked. The snapshot is built from its last heartbeat, with
`files: []` and `actionsSupported: false`.

**Action body.** The POST takes a `MainCheckoutActionPost`: the request plus `initiatedFromSessionId`.

**Action checks:**

- `initiatedFromSessionId` and a move's `targetSessionId` must be the caller's sessions of this workspace.
- The target must be on this workspace's runner and must have a worktree. That worktree's branch becomes the
  command's `targetBranch`.
- A runner without the capability is refused with HTTP 409 `{ code: 'MAIN_CHECKOUT_UNSUPPORTED' }`, and nothing is
  queued.
- A second action on the same runner and root while one is unfinished becomes `ACTION_IN_FLIGHT`. A partial unique
  index enforces this. The refusal is stored under its `requestId` and written as its line.
- When the runner has not checked in, a `waiting` `RUNNER_OFFLINE` line is written. The action stays queued until
  the runner returns, it is cancelled, or it times out.

**Workspace payload.** It carries `repoHealth` with §4's counts and fingerprint, for Shared and Worktree workspaces
alike. It also carries `mainCheckoutActions`: whether the runner declares the capability.

**`managedBranch`.** Set when an open project tied to the workspace lands on the checkout's branch. A project is tied
to the workspace when it coordinates there, has the workspace as a member, or has a task assigned there. The result
is `{ projectId, projectTitle, role }`:

- `role: 'integration-line'` when the branch is the primary codebase's `integrationRef`, on a project branch.
- `role: 'landing-target'` when the branch is its `upstreamRef`.

### 10.5 The timeout

Every read, action and heartbeat sweeps what is past its deadline, and so does a 30 s timer. A swept action finishes
`TIMEOUT` with its line, carrying `runnerName` and `minutes`. A swept read answers its waiter with 504. Nothing stays
`pending` or `claimed` past `expiresAt`.
