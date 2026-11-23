# Landing on protected GitHub branches: pull request by default, Push as me on request

> Status: draft for the owner's review (task `3521xdraWnphpIOwOdJrk`, project `3521vwqnFuax4FvYLRUXL`). Nothing here
> is built. §15 lists the decisions that need your ruling; your rulings are recorded there.
> Code baseline: main `3566f7d76a`. Line numbers refer to that commit.
> Previews: the coordinator's mockups of the workspace setting (options A and B, attachment `352Sth5yNcWquLuQxS7to`) and
> of the landing card's states (attachment `352Sti0nvUtq94aoDHebt`). The design board task (`3521xdsf8WFT3GSUtyf5P`)
> turns them into the final board.
> Builds on `docs/github-workspace-design.md` (GitHub workspaces, the App and its tokens) and
> `docs/project-integration-line-contract.md` (integration jobs, promotions, landing sessions; "the contract" below).

## 0. Summary

**What happens today.** Orbit lands work by pushing the tested commit straight to the target branch. On Orbit Cloud the
push carries the GitHub App's installation token, and GitHub refuses it on a branch that requires a pull request:
`GH006: Protected branch update failed for refs/heads/main. Changes must be made through a pull request.` The same
landing from the owner's own runner succeeds, because there the push carries the machine's Git credential, which is the
owner's, and the orbit repository does not hold admins to its rules (`enforce_admins: false`). Sessions
`6mAw1MdeHyAmaaCB4Lcg08` and `350lqy4jxAxcfax2dMtRu` show the refusal.

**Recommendation.**

1. **Pull request, the default for every GitHub workspace.** Where Orbit would push to the target, it pushes the same
   tested commit to a branch of its own, `orbit/land/<id>`, opens a pull request from it and merges it when GitHub
   allows. The wait is one new state, `PULL_REQUEST`, of the integration job that already runs every landing. A merged
   pull request is that job's `LANDED`. A failing required check is its `CHECK_FAILED`, sent back to the session that
   wrote the work, as revision 42 already does for Orbit's own checks. A target that moved is its `TARGET_MOVED`: the
   next generation rebuilds on the new tip and updates the same pull request. A required review leaves the job waiting,
   and the owner sees "Waiting for review" with a link. A session's Merge outside a project takes the same path.
2. **Push as me, opt-in per workspace.** At the same point, Orbit moves the target to the tested commit with the owner's
   own GitHub authorization, so GitHub applies the owner's rights. When GitHub refuses, the landing carries on as a pull
   request from the branch it already pushed, and says why in GitHub's words. Recommended: Orbit's server makes that one
   API call itself, so the owner's token never leaves the server (D1).
3. **App permissions.** Pull requests: write, Checks: read, Commit statuses: read, Actions: read (for the failing job's
   log) and Workflows: write (D4). Until an installation accepts them, its landings work as they do today, and Orbit
   shows who still has to accept.
4. **Clients.** A "Landing" section in the workspace's settings (preview option A). The landing card, the task's
   landing row and the session's merge row show the pull request's state.

**Open question.** Nobody has tested yet whether GitHub lets a user token push past a protected branch's rules for a
user who may bypass them: task `3521xdqK4aYeUggJ7YW15` is waiting on the owner for a token. Push as me is designed to
be right whichever way that comes out (§5.4).

**Your rulings are needed on five decisions (§15):** how Push as me uses your token (D1), whether unprotected branches
also get a pull request (D2), webhook or polling (D3), which App permissions to ask for (D4), and what happens when a
check fails on a session outside a project (D5).

## 1. Constraints from the code today

| Fact | Where | Consequence |
|---|---|---|
| Every landing push names the target. A task's or a promotion's landing pushes `<tested>:<target>`, a session's Merge pushes `HEAD:refs/heads/<target>`, and a merge recovery's Apply pushes `<candidate>:refs/heads/<target>` | `src/runner-go/integrate.go:1172`, `worktree.go:2166`, `merge_recovery.go:281` | Three call sites learn a second destination. |
| A network git command tries the machine's own credential first, and Orbit's App token only after an authentication failure | `src/runner-go/network_git.go:75` | On a self-hosted runner a push goes as whoever owns the machine's credential. On a managed runner it goes as the App. That is the whole difference the owner noticed. |
| GH006 is read neither as an authentication failure nor as a race. An integration job answers `PUSH_REJECTED`; a session merge answers `could not push <target> to origin: …` | `network_git.go:160`, `integrate.go:719`, `worktree.go:2087`; `isNonFastForward` (`worktree.go:2187`) matches `[rejected]`, not `[remote rejected]` | Nothing retries the refusal, and a session merge writes no receipt for it (`runner-api.controller.ts:11136`). The refusal is already isolated; it only needs a name. |
| The App's installation token is minted for one repository with `contents: write, metadata: read` | `src/apiserver/src/github/github-api.client.ts:197` | It can push a branch. It cannot open or merge a pull request. |
| Any process holding the runner's credential can get that token from `POST /runner/git-credential`, for any GitHub workspace on that runner | `src/apiserver/src/github/github-workspace.service.ts:94` | On a managed runner the agent runs as the runner's OS user (github-workspace-design §7). A token the runner can fetch is a token the agent can probably fetch. |
| The owner's user-to-server token is stored encrypted and refreshed when used. It lasts 8 hours; its refresh token lasts months | `github-connection.service.ts:352`, `:368`; github-workspace-design §3 | The server can act as the owner while the connection is live, with no runner involved. |
| The admin's setup steps say "Webhook: turn it off. Orbit doesn't need one." and list only Contents and Metadata. The stored App config has no webhook secret | `src/web/src/pages/AdminGithubPage.tsx:269`, `:272`; `schema.prisma:766` | Every deployment has new setup to do: webhook, secret and permissions. |
| No code in Orbit opens a pull request. The merge recovery's "Prepare PR candidate" only changes a repair agent's prompt | `src/shared/src/mergeRecovery.ts:140`; `src/web/src/components/MergeRecoveryPanel.tsx:282` | The pull request path is new, not an extension. |
| A landing attempt is one `project_integration_job` row, `QUEUED` → `RUNNING` → final. The receipt, the exception item or the next generation is written in the same transaction as the final state | contract §2.1, §2.2; `src/apiserver/src/runner-api/integration-job-relay.ts:1982` | The pull request wait has to be a state of this row, not a second machine beside it (§4.2). |
| One job per repository and target runs at a time: `serial_key` is unique while `RUNNING` | contract J1 | A wait held in `RUNNING` would stop every other landing into that branch for as long as a review takes. |
| The tree that lands must be the tree that was checked | contract J2 | A merge GitHub makes must be checked the same way (§4.4). |
| A promotion whose push loses a race ends its claim. An owner-confirmed one is queued again under the same confirmation, an Automatic one is checked again, and the third in a row blocks it | `integrate.go:62`; contract J-T13; `project-promotion.ts:232` | "Target moved" already has a path. A pull request wait only reaches it more often (§4.5). |
| A failed landing check goes first to the session that wrote the work, as the platform turn `landing-fix:v1:<jobId>`, at most twice | contract §12 W1–W8 (decided 2026-11-20, not yet built) | A failing GitHub check is routed by the same rule (§4.5). |
| Clocks may only escalate to people, lease and re-deliver, or display | contract §0.2 G3 | Re-reading GitHub on a timer is a new kind of clock and needs your ruling (D3). |
| A task outside a project gets no integration job; it lands only through its session's Merge | `src/apiserver/src/projects/project-integration-job.ts:1722`; `src/apiserver/src/sessions/sessions.service.ts:9372` | The session merge needs the pull request path too (§4.6). |
| `session.merge_status` is free text, read as `pending`, `merged`, `conflict` or `error` | `schema.prisma:2420`; `src/web/src/api.ts:2199` | Adding `pull_request` changes the readers, not the column. |
| A merge receipt's `recorded_by` is `RUNNER`, `AGENT` or `USER`, held by a CHECK | migration `0128_task_supersession_merge_receipt` | A receipt the server writes from GitHub's answer needs a value of its own. |
| No workspace settings page on any client has a landing row. An agent's workspace write needs a card for six fields only | `src/web/src/components/settings/WorkspaceSettingsPage.tsx:406`, `:473`; `src/apiserver/src/runner-api/runner-workspace-approval.ts:55` | The setting is new on every client. Agents are kept away from it (§12). |

## 2. Goals and non-goals

**Goals**

1. A landing from any runner reaches a GitHub branch that requires a pull request, status checks or a review, without
   anyone weakening that protection. Orbit opens a pull request, waits for GitHub's rules, merges, and records the
   landing.
2. A pull request landing's failures go where they can be fixed. A failing required check goes to the session that
   wrote the work, with its log. A target that moved is caught up by Orbit. A required review is shown to the owner
   with a link.
3. A workspace can opt in to Push as me. Orbit lands with the owner's GitHub authorization, so GitHub applies the
   owner's rights. A refusal falls back to a pull request and says why.
4. The owner's GitHub token never reaches the agent.
5. Every client shows the setting and the pull request's states, in English.

**Non-goals (v1)**

- Asking anyone to change branch protection or to add Orbit to a bypass list (project instruction).
- Approving pull requests, requesting reviewers, or acting on review comments. GitHub's own CODEOWNERS rules still
  request their reviewers.
- Merge queues (§4.3 says what Orbit shows instead), forks, draft pull requests.
- Re-running failed checks from Orbit (needs Actions: write).
- Pull requests into Orbit's own branches (`project/*`, `orbit/*`). A task landing onto a project branch keeps pushing
  directly.
- Workspaces Orbit did not clone from GitHub. They have no App binding and keep pushing with the machine's credential
  (§6).
- The SSH key plan (`docs/design/orbit-ssh-keys.md`). It is separate and is not the fix for this.

## 3. Which pushes change

| Push | Target | Pull request | Push as me |
|---|---|---|---|
| `LAND_TASK` onto a project branch | `project/<id>`, Orbit's own | unchanged: direct push | unchanged |
| `LAND_PROMOTION` (project branch or task branch into main) | the upstream | pull request | the server moves the target as the owner; pull request when refused |
| A session's Merge (tasks outside projects, chat sessions) | `mergeTarget`, main by default | pull request | as above |
| A merge recovery's Apply | `mergeTarget` | pull request, from the same landing branch | as above |
| Push in the main checkout (a person's own push from the machine page, `main_checkout_push.go:44`) | the checkout's branch | unchanged | unchanged |
| An agent's own `git push` (the `AGENT_PUSH` delivery mode, or any shell push on a self-hosted runner) | anything | unchanged | unchanged |
| `CHECK_PROMOTION`, `OBSERVE_LANDING` | — | push nothing | — |

The setting governs pushes to branches Orbit does not own. A target under `refs/heads/project/` or `refs/heads/orbit/`
is Orbit's own and is pushed directly, as today.

**How a landing's mode is chosen.** The server decides when it hands a job or a merge to the runner, and records the
answer on the attempt (`land_via`):

1. The target is Orbit's own branch: `PUSH`.
2. The workspace was not cloned from GitHub (`githubRepoId` is NULL): `PUSH`, with the machine's credential, as today.
3. The installation has not accepted the new permissions (§10), or the claiming runner has not declared the new
   capability (§9): `PUSH`, as today. A GH006 refusal then names which of the two to fix.
4. The workspace's landing mode is `PUSH_AS_ME` and the owner's GitHub connection is live: `PUSH_AS_ME`.
5. Otherwise: `PULL_REQUEST`.

A landing subject that already has an open Orbit pull request finishes through it, whatever the rules above say now.

The setting read is that of the workspace the job runs in, which is the workspace of the session the job is claimed
through (`integration-job-relay.ts:632`). For a task's landing that is the task's session. For a promotion it is the
source session's.

## 4. Pull request landing

### 4.1 The flow

A promotion into main, step by step. A session's Merge goes the same way from step 3 on, through its own merge path
(§4.6).

1. As today, `CHECK_PROMOTION` checks the combination and the owner confirms it, or Automatic does. M7 is unchanged:
   Orbit's yes still comes before anything reaches main.
2. A runner claims the `LAND_PROMOTION` with `landVia: PULL_REQUEST` and `landingRef: refs/heads/orbit/land/<id>`,
   where `<id>` is the landing session's id. Fetch, merge or rebase, and checks run exactly as today (M-S1 to M-S3).
3. At M-S4 the runner pushes the tested commit to the landing branch instead of main:
   `git push --force-with-lease=<landingRef>:<last pushed> origin <tested>:<landingRef>`, through `networkGit` with
   today's credential order. It reads the branch back and answers `PULL_REQUEST`.
4. The result transaction moves the job to `PULL_REQUEST` and writes the subject's `github_pull_request` row: a new one
   in `OPENING`, or the open one with its new head. After the commit, the server opens the pull request with a
   server-only installation token (§10): head `orbit/land/<id>`, base `main`, a title from the task or the project and
   a body that links the landing. If one is already open for that head, it uses that one.
5. GitHub runs the repository's checks. Workflows on `pull_request` run for a pull request a GitHub App opens.
6. Each webhook delivery about the pull request, and each slow re-read (§4.7), makes the server read the pull request
   again from GitHub and act on what GitHub says (§4.3).
7. When GitHub allows the merge and main is still where the head was built, the server merges:
   `PUT /repos/{owner}/{repo}/pulls/{n}/merge` with `sha` = the tested commit, using the method of §4.4.
8. It reads the result back. If the tree is the tested tree, the job is `LANDED` with `landed_sha` = GitHub's commit:
   the receipt is written and downstream is released (J-T5, J8 to J11). The landing branch is deleted.

```
runner                     Orbit server                          GitHub                     owner
  │ claim LAND_PROMOTION       │                                     │                         │
  │ merge + Orbit's checks     │                                     │                         │
  │ push orbit/land/<id> ─────────────────────────────────────────▶ │                         │
  │ result PULL_REQUEST ─────▶ │ job → PULL_REQUEST                  │                         │
  │                            │ open pull request ────────────────▶ │ runs CI                 │
  │                            │ ◀──────────── webhook / re-read ─── │                         │
  │                            │  checks pending / review required   │ ◀──── approves ──────── │
  │                            │ merge (sha = tested) ─────────────▶ │                         │
  │                            │ verify tree → LANDED, receipt       │                         │
```

### 4.2 The integration job's new state

`PULL_REQUEST` means: the attempt's tested commit is on its landing branch, and the attempt is waiting for GitHub.

- It is not final, so J4 still guards only the final states.
- It is not `RUNNING`: no runner, no lease and no J1 slot. Other landings into the same branch keep running while a
  pull request waits, as two people's pull requests would.
- It counts as in flight: J3's one-attempt-per-task index, `readInFlightJobs`, a criterion's `IN_FLIGHT` and the
  landing view all include it. Today about 20 places in 11 apiserver files spell `QUEUED, RUNNING` themselves. One
  constant, `IN_FLIGHT_JOB_STATES`, replaces them, and a census spec fails on any reader that spells the pair again.

| # | from | committed fact | to | in the same transaction |
|---|---|---|---|---|
| J-T14 | `RUNNING` | Runner result `PULL_REQUEST`: the landing branch was pushed and read back | `PULL_REQUEST` | Create or update the subject's pull request row. Job event "Pushed `<sha7>` for a pull request". |
| J-T15 | `PULL_REQUEST` | The pull request was read as merged (by Orbit or by a person on GitHub) and the result checked (§4.4); or Push as me's update was accepted (§5.3) | `LANDED` | As J-T5: receipt (`recorded_by = SERVER`), items resolved, J9 to J11 after the commit. Pull request row `MERGED`. |
| J-T16 | `PULL_REQUEST` | A required check on the head failed | `CHECK_FAILED` | As J-T7: `checks` gains the GitHub check (name, conclusion, link, log tail), the item opens, W4 to W6 hand it off. The pull request stays open. |
| J-T17 | `PULL_REQUEST` | The base moved: GitHub says the pull request is behind or conflicting, or the base tip is not the head's base when the pull request could otherwise merge, or the merge call was refused for it | `ERROR` / `TARGET_MOVED` | The next generation, as J-T13 (a promotion) or J-T1b (a task). It pushes to the same landing branch. |
| J-T18 | `PULL_REQUEST` | A stop fact (J-T8): the task reopened or cancelled, the candidate superseded or retired, the owner's Cancel | `CANCELLED` | The pull request stays open for the subject's next attempt. Orbit closes it when the subject settles without it (§4.8). |
| J-T19 | `PULL_REQUEST` | The pull request was closed on GitHub without being merged | `ERROR` / `PULL_REQUEST_CLOSED` | Item naming who closed it, with the link. Retry reopens it. |
| J-T20 | `PULL_REQUEST` | The pull request's head is not the commit Orbit pushed | `ERROR` / `PULL_REQUEST_HEAD_CHANGED` | Item. Orbit does not merge commits it did not check. |

Waiting for checks, for a review, or for GitHub to work out whether the pull request can merge are not transitions.
They are the pull request row's `condition`, and clients read it from there.

Appendix A says why the wait is neither kept in `RUNNING` nor moved to a machine of its own.

### 4.3 What one re-read decides

Orbit acts on GitHub's answer, read in full each time. A webhook's payload is only a doorbell: Orbit never acts on what
the payload says.

| GitHub says | Orbit does |
|---|---|
| The head is not Orbit's last push | J-T20 |
| Merged | Checks the result, then J-T15 |
| Closed | J-T19 |
| A required check failed: conclusion `failure`, `timed_out`, `cancelled`, `action_required` or `startup_failure`, or a required commit status `error` or `failure` | J-T16 |
| Required checks still running | Waits: "Waiting for the required checks · 2 of 6" |
| Review required, or changes requested | Waits: "Waiting for review", with the link. The owner is told once (§11.3) |
| Behind (the repository requires branches to be up to date), or conflicting | J-T17 |
| Can merge (`clean`, `unstable` or `has_hooks`) | Reads the base tip. If it is the head's base, merges; if not, J-T17 |
| The branch merges through a merge queue | Waits: "main merges through a merge queue: add pull request #214 to it on GitHub" (not supported in v1) |
| Not worked out yet (`unknown`) | Waits for the next read |

Checks GitHub does not require do not hold the merge. A repository that wants a check to gate landings marks it
required. Orbit's own checks have already passed before the push, as they do today.

### 4.4 Merging

**Method.** Orbit uses the method that gives what its direct push would have given:

- a project branch's promotion: a merge commit, which keeps the branch's commits as ancestors of main (M6);
- a task branch's promotion or a session's merge: rebase, which keeps main linear, as `rebaseFastForward` does today.

If the repository does not allow that method, either in its settings or through a rule requiring linear history,
Orbit picks another one it allows, and the card names it. Every method gives the tested tree when the base is still
where the head was built, because the head is a descendant of that tip.

**Checking the result.** Orbit reads the commit GitHub answered with, and its tree.

- The tree is the tested tree: J-T15.
- It is not: this can only happen when the repository does not require up-to-date branches and main moved in the
  second between Orbit's read and GitHub's merge. The work is on main, so the job is still `LANDED`, with the real
  tree. The same transaction opens an `INTEGRATION_ERROR` item asking for the project's check to run on main. J2 gains
  this one exception, recorded rather than hidden (§14).

**Approvals.** The App is the pull request's author, so the owner can approve it: GitHub does not let authors approve
their own pull requests. A fallback from Push as me is opened by the App too, for the same reason. Orbit never approves
a pull request and never uses a bypass. When the repository dismisses stale approvals, a catch-up asks for a new
approval. That is GitHub's rule, and the card says so.

### 4.5 Failure paths

**A required check fails (J-T16).**

- *The log.* For a GitHub Actions check, Orbit fetches the log of the job behind the check run (Actions: read). For any
  other check, it uses the check's summary and its link. The text is clipped and redacted as a runner check's output is
  (the 16 KB tail plus the failure lines, `integrate.go:1452`; `src/apiserver/src/common/secret-redaction.ts:19`) and
  stored in the job's log, so the hand-off text comes from rows that do not change (G6).
- *Who gets it.* Revision 42's W4 decides. A task's landing and a task branch's promotion go to the task's session,
  through `landing-fix:v1:<jobId>`. A project branch's promotion goes to the coordinator.
- *What the session reads.* W6's text gets a pull request variant:

  ```text
  Orbit could not land your work for "<task title>" on main.

  The required check "PostgreSQL specs" failed on pull request #214 (3a9f1c2):
  <failure lines>
  Full log: <link>

  Nothing was merged. main is unchanged, and pull request #214 stays open.

  Fix it on your own branch, in this checkout:
  1. Run what failed until it passes.
  2. Commit, then end your turn.

  Orbit updates pull request #214 with your commit, and GitHub runs the checks again. Do not push main.
  If this is not yours to fix, end your turn without committing and say why; the project's coordinator takes it from there.
  The full record: landing <landingSessionId>.
  ```

- *The fix.* It lands as the next generation (W7). That generation pushes to the same landing branch, so the same pull
  request updates.
- *A check that passes when somebody re-runs it on GitHub.* Landing again goes through the usual door: the
  coordinator's or the owner's retry for a project, a new Merge press for a session. The new attempt finds the landing
  branch already holding the tested tree on the same base, pushes nothing (§9), and GitHub's CI is not restarted.

**The target moved (J-T17).**

- The next generation rebuilds on the new tip, runs Orbit's checks again (M5), and pushes to the same landing branch.
  GitHub runs CI again, and the card says "Catching up with main".
- When: as soon as GitHub reports the pull request behind, in a repository that requires up-to-date branches. In other
  repositories, only once the pull request could merge. A pull request waiting for review is therefore not rebuilt each
  time main moves.
- A catch-up does not count toward J-T13's three, nor toward Automatic's `AUTOMATIC_MERGE_ATTEMPTS`. A merge that
  GitHub refuses because main moved does count.
- A conflict on the new tip is the runner's `CONFLICT` result, as today (J-T7, routed by W4).

**Review required.** This is not a transition; the pull request row's condition is `REVIEW_REQUIRED`.

- The task's landing row reads "Waiting for review", with "Review on GitHub ↗".
- The project gets an attention reason, and the owner gets one push notification.
- Automatic does not change this: Automatic is Orbit's yes, and the review is GitHub's.

**Other failures.** Closed on GitHub: J-T19. Head changed: J-T20. The App uninstalled: today's
`GITHUB_APP_NOT_INSTALLED` message (`github-workspace.service.ts:150`). A missing permission: §10.

### 4.6 Sessions outside a project

1. A Merge press or `session_merge` goes through `queueMerge` (`sessions.service.ts:9493`), which now also chooses the
   mode (§3).
2. In `PULL_REQUEST` mode, `rebaseFastForward` (`worktree.go:2022`) pushes the replayed tip to
   `orbit/land/<session id>`, not to the target. It does not move the local target branch, and answers `pull_request`.
3. The server records `merge_status = 'pull_request'` and a pull request row with `session_id` set. The same pull
   request door (§4.3) takes it from there.
4. What each outcome writes:
   - Merged: `merge_status = 'merged'` and a `MERGED` receipt (`recorded_by = SERVER`), whose `target_sha_after` is
     GitHub's commit.
   - A required check failed: `merge_status = 'error'`, with `merge_error` naming the check. Under D5, the log is also
     sent to the session as a platform turn, and its next commit re-runs the merge into the same pull request, at most
     twice.
   - The target moved: the merge is queued again (`pending`), into the same landing branch.
   - Closed on GitHub: `error`, with the reason.
5. Pressing Merge again while the pull request is open updates that pull request.

### 4.7 Watching GitHub: webhook or polling

| | Webhook | Polling |
|---|---|---|
| Latency | Seconds | The interval |
| Reach | GitHub has to reach the server. A deployment on a private network gets nothing | Works wherever Orbit can call GitHub |
| A lost delivery | GitHub does not redeliver a failed delivery by itself. A lost one stalls the landing until something else wakes it | Nothing to lose |
| Cost | One delivery per event. Orbit re-reads the pull request once per delivery | Every open pull request, each interval (an installation has 5,000 requests an hour or more) |
| Setup | The App's webhook URL, secret and events, set once by whoever owns the App, plus the secret on the admin page | None |
| Fit with the contract | A delivery is a committed fact (G2) | A timer that re-reads: a fourth clock use, outside G3 |

**Recommendation (D3): both.** The webhook is the doorbell. A slow re-read of each open pull request is the floor:
every 10 minutes while deliveries are arriving, and every minute when none has arrived in the last hour. That covers
lost deliveries and deployments GitHub cannot reach.

The re-read only reads. Time decides when Orbit looks; GitHub's answer decides what changes. G3 needs that sentence
added (§14).

Deliveries are stored by GitHub's delivery id, so a redelivery is a no-op. Orbit checks the signature
(`X-Hub-Signature-256`) and drops deliveries about installations or repositories it does not know.

### 4.8 Branches and pull requests Orbit leaves behind

- **Merged.** The server deletes `orbit/land/<id>`, unless GitHub's "delete head branches" setting already did.
- **The subject settled without the pull request.** This covers a task cancelled, deleted or moved, a round declined or
  cancelled, and an item handled by a fix task. Orbit closes the pull request with a comment
  ("Closed by Orbit: <reason>") and deletes the branch.
- **Title and body.** The title is the task's title, `Merge project/<name> into main: <project title>`, or the session's
  title. The body names the task and the checks Orbit ran, links the landing, and says: "Orbit updates this branch.
  Make changes on the task's own branch instead."

## 5. Push as me

### 5.1 What GitHub decides

A user-to-server token acts as the user through the App: it can do what both the App and the user may do. The App has
Contents: write. The user brings their role in the repository. GitHub then applies the branch's rules to the user,
as it does to the owner's own machine today. Whether GitHub also gives such a token the bypass an admin has (classic
protection with `enforce_admins` off, or a ruleset that lists the admin role) is the open question in §16.

### 5.2 Two ways to use the token

| | A. The server moves the target (recommended) | B. The runner's git push carries the token |
|---|---|---|
| How | The runner pushes the tested commit to `orbit/land/<id>`, as for a pull request. The server then calls `PATCH /repos/{owner}/{repo}/git/refs/heads/<target>` with `sha` = the tested commit, `force: false`, and the owner's token | The runner asks `POST /runner/git-credential` for the owner's token, bound to the claimed job and its push boundary, and pushes the target with it. Only that git command sees it, as with the App token today |
| Where the token goes | Nowhere: it stays in the apiserver, for one HTTPS call | To the runner, into one git command's environment for the push |
| If the agent reads the runner's credential (§1) | It can get the App's token for one repository, as today, and nothing more | During a landing's push it can also get a token that acts as the owner, with whatever bypass GitHub gives the owner, in every repository the App is installed on and the owner can reach, for up to 8 hours |
| Falling back | The commit is already on `orbit/land/<id>`, so the pull request opens from it at once | The runner pushes the landing branch with the App token after the refusal, then answers |
| What a refusal looks like | `422`, with GitHub's message naming the protection or the rule | `GH006` (classic protection) or `GH013` (rulesets) on stderr |
| The landed commit | The tested commit itself, with no merge commit, so J2 holds exactly | Same |
| Criterion 4's wording ("used only by the runner's own git command") | Needs an edit to "never leaves Orbit's server" | Holds as written |

Recommendation (D1): **A**. It is the stronger form of criterion 4's purpose: the token cannot reach the agent because
it never reaches the machine the agent runs on.

### 5.3 The flow (option A)

1. The server hands the job or the merge out as `PUSH_AS_ME`. The runner does exactly what it does for a pull request:
   it pushes the landing branch, reads it back and answers `PULL_REQUEST`.
2. In the post-commit edge of J-T14, the server reads the owner's token (refreshing it if needed,
   `github-connection.service.ts:352`) and asks GitHub to fast-forward the target to the tested commit.
3. **Accepted:** the server reads the target back. If it holds the tested commit, J-T15 records `LANDED` with
   `landed_sha` = the tested commit. The receipt's detail says it was pushed as the owner. The landing branch is deleted.
4. **Not a fast-forward** (main moved): J-T17, as for a pull request.
5. **Refused for any other reason** (protection, a rule, missing permission, the repository not reachable, the token
   revoked): the landing carries on as a pull request from the branch already pushed. The pull request row records the
   refusal (`fallback`, GitHub's own message), the workspace keeps it as its last refusal, and the card says "Push
   refused · Opened a pull request instead".
6. **GitHub failing** (5xx, timeout): the next re-read tries again. It never falls back on a guess.

### 5.4 Right whichever way the bypass test comes out

- **If GitHub gives the token the bypass:** an owner who may bypass the rules lands directly. The commit shows as the
  owner's push, made through the App.
- **If it does not:** every Push as me landing on a protected branch is refused once and goes on as a pull request. The
  setting shows why (§11.1). Push as me still saves the pull request wherever GitHub would accept the owner's push,
  such as an unprotected branch.
- **The copy promises nothing GitHub decides.** It says Push as me *can* be faster, that it needs the right to push,
  and that a refusal turns into a pull request. That stays true either way.
- **A direct push is never retried with another credential.** The refusal is the answer.

### 5.5 Saying why

- **On the landing.** GitHub's words, quoted: `GitHub refused the push to main: "Changes must be made through a pull
  request." Landing through pull request #214.`
- **In the setting.** The last refusal stays on the workspace until a Push as me landing is accepted (§11.1).
- **When the owner picks Push as me.** Orbit reads, with the owner's token, the owner's role in the repository and
  whether the branch is protected or has rules (`GET /repos/{owner}/{repo}/rules/branches/{branch}`). The App cannot
  read the bypass lists or `enforce_admins`, which need the Administration permission. So this is a hint, never a
  promise:
  - "You can push to main on owner/repo." (no protection, and the owner may push)
  - "main on owner/repo is protected. At each landing, GitHub decides whether your account may push past its rules;
    when it refuses, Orbit opens a pull request instead." (protected, and the owner is an admin)
  - "Your GitHub account can't push to owner/repo, so landings here will open pull requests." (no push right)

## 6. Self-hosted runners with machine credentials

| Workspace on a self-hosted runner | Pull request | Push as me |
|---|---|---|
| Not cloned from GitHub (the machine's own checkout, such as the owner's workstation) | Not offered. Landings push with the machine's credential, as today. A refusal is named `PUSH_PROTECTED` and quotes GitHub | Not offered |
| Cloned from GitHub, and the machine's credential can push | The landing branch push uses the machine's credential first, as every network git command does (github-workspace-design §6 step 4), and the App's token after an authentication failure. The server opens and merges the pull request as the App. Nothing pushes to the target | The server moves the target with the owner's token (D1 option A). The machine's credential pushes only the landing branch |
| Cloned from GitHub, and the machine has no credential | The App's token, as on a managed runner | Same |

This is a change for a GitHub workspace on a self-hosted runner whose credential can push to main. Today it pushes
there directly. After this it lands through pull requests unless the owner picks Push as me, because Pull request is the
default for every workspace, new or existing (project instruction). With option B of D1, Push as me on such a machine
would skip the machine's helpers for the target push: "as me" means the Orbit owner's GitHub account, and Orbit cannot
tell whose the machine's credential is.

## 7. Data model

One migration; take the number at landing time, scanning main, `project/*` and pushed `orbit/*` as usual.

```prisma
// Workspace: two columns; both NULL for a workspace not cloned from GitHub.
landingMode      String? @map("landing_mode")        // NULL = PULL_REQUEST; CHECK IN ('PULL_REQUEST', 'PUSH_AS_ME')
pushAsMeRefusal  Json?   @map("push_as_me_refusal")  // { at, branch, message }: the last refusal, GitHub's words;
                                                     // cleared by the next accepted Push as me

// ProjectIntegrationJob
//   state:       + 'PULL_REQUEST'        (CHECK; not final; in J3's index and IN_FLIGHT_JOB_STATES)
//   error_code:  + 'PUSH_PROTECTED'      (a direct push refused with GH006 / GH013, replacing PUSH_REJECTED for it)
//                + 'PULL_REQUEST_CLOSED', 'PULL_REQUEST_HEAD_CHANGED'
landVia        String? @map("land_via")         // PUSH | PULL_REQUEST | PUSH_AS_ME, fixed at hand-out; NULL = PUSH
landingRef     String? @map("landing_ref")      // refs/heads/orbit/land/<id>
pullRequestId  String? @map("pull_request_id") @db.Uuid   // history reference, no foreign key (contract §2.1)

// Session: merge_status gains 'pull_request'; plus
mergePullRequestId String? @map("merge_pull_request_id") @db.Uuid

// SessionMergeReceipt.recordedBy: + 'SERVER' (the server wrote it from GitHub's answer: a merged pull request or an
// accepted Push as me)

// GithubAppConfig: + webhookSecretEnc String @default("") (write-only, as the client secret is)

/// One pull request Orbit opened to land work. Exactly one of landingId and sessionId.
model GithubPullRequest {
  id             String    @id @default(uuid(7)) @db.Uuid
  ownerId        String    @map("owner_id") @db.Uuid
  workspaceId    String    @map("workspace_id") @db.Uuid
  githubRepoId   BigInt    @map("github_repo_id")
  installationId BigInt    @map("installation_id")
  landingId      String?   @map("landing_id") @db.Uuid    // project_landing: a task segment or a promotion round
  sessionId      String?   @map("session_id") @db.Uuid    // a session's own Merge outside a project
  baseRef        String    @map("base_ref")               // refs/heads/main
  headRef        String    @map("head_ref")               // refs/heads/orbit/land/<id>
  number         Int?                                     // NULL while OPENING
  url            String?
  state          String                                   // OPENING | OPEN | MERGED | CLOSED
  headSha        String?   @map("head_sha") @db.Char(40)  // what Orbit last pushed
  baseSha        String?   @map("base_sha") @db.Char(40)  // the base tip the head was built and checked on
  testedTreeSha  String?   @map("tested_tree_sha") @db.Char(40)
  mergeMethod    String?   @map("merge_method")           // merge | rebase | squash
  condition      String?                                  // CHECKS_PENDING | CHECK_FAILED | REVIEW_REQUIRED |
                                                          // CHANGES_REQUESTED | BEHIND | CONFLICTING | MERGEABLE |
                                                          // MERGE_QUEUE | UNKNOWN (GitHub's answer at the last read)
  checks         Json      @default("[]")                 // [{ name, required, state, url }]
  fallback       Json?                                    // { reason, at }: Push as me was refused
  mergedSha      String?   @map("merged_sha") @db.Char(40)
  mergedBy       String?   @map("merged_by")              // GitHub login
  closedBy       String?   @map("closed_by")
  observedAt     DateTime? @map("observed_at") @db.Timestamptz(3)
  createdAt      DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt      DateTime  @updatedAt @map("updated_at") @db.Timestamptz(3)
  mergedAt       DateTime? @map("merged_at") @db.Timestamptz(3)
  closedAt       DateTime? @map("closed_at") @db.Timestamptz(3)
  @@unique([githubRepoId, number])
  // Partial unique indexes (SQL): one OPENING/OPEN row per landing_id, per session_id and per (github_repo_id, head_ref).
  @@map("github_pull_request")
}

/// GitHub's deliveries, kept only to de-duplicate them and as the committed fact a re-read follows. No payload.
model GithubWebhookDelivery {
  id             String    @id                             // X-GitHub-Delivery
  event          String
  action         String?
  installationId BigInt?   @map("installation_id")
  githubRepoId   BigInt?   @map("github_repo_id")
  pullNumber     Int?      @map("pull_number")
  receivedAt     DateTime  @default(now()) @map("received_at") @db.Timestamptz(3)
  appliedAt      DateTime? @map("applied_at") @db.Timestamptz(3)
  @@map("github_webhook_delivery")
}
```

Each new table and trigger goes into `db-write-inventory` and the tenant-isolation census, as the contract requires of
every write.

## 8. API

**The owner's clients**

| Route | What changes |
|---|---|
| `PATCH /workspaces/:id` `{ landingMode }` | The owner's clients only. `PUSH_AS_ME` needs a GitHub workspace (409 `WORKSPACE_NOT_FROM_GITHUB`) and a live connection (409 `GITHUB_NOT_CONNECTED`). MCP `agent_update` does not take it, as with the other GitHub columns (github-workspace-design §9). |
| `GET /workspaces/:id`, the settings read | `landing: { mode, pushAsMe: { available, reason? }, pullRequest: { available, reason? }, lastRefusal?, hint? }`. `hint` is §5.5's rights hint, read when the owner opens the choice |
| `GET /integrations/github` | Each installation gains `permissionsPending: string[]` and `reviewUrl` (§10) |
| `GET /admin/integrations/github` | `webhookUrl` (with a copy button), `webhookSecretSaved`, `lastDeliveryAt`, and the App's permissions and events as GitHub reports them (`GET /app`), with what is missing |
| `PUT /admin/integrations/github` | `webhookSecret`, write-only; left out, the saved one stays |
| `POST /api/integrations/github/webhook` | GitHub's deliveries. No session; the signature is checked against the saved secret. Answers 202 at once; the re-read happens after |

**Read models.** The landing view (`landing-view.ts:33`), `LandTaskIntegrationView` (`src/shared/src/project-progress.ts:868`),
`ProjectIntegrationView.inFlight` and the session detail gain one optional block:

```ts
pullRequest?: {
  number: number; url: string;
  state: 'OPENING' | 'OPEN' | 'MERGED' | 'CLOSED';
  condition: PullRequestCondition | null;
  checks: { passed: number; required: number; failed: Array<{ name: string; url: string | null }> };
  mergeMethod: 'merge' | 'rebase' | 'squash' | null;
  mergedSha: string | null;
  fallback: { reason: string } | null;       // Push as me was refused
}
```

`LandTaskBlockingReasonCode` (`project-progress.ts:853`) gains `WAITING_FOR_CHECKS` and `WAITING_FOR_REVIEW`. MCP
needs no new tool: `task_get`, `session_get` and `project_integration_get` carry the block, and `integration_retry`
works on a pull request attempt as on any other.

**Runner**

| Route or field | What changes |
|---|---|
| Integration job command | `landVia`, `landingRef`, `landingRefSha` (the branch's last pushed commit, for the lease). Sent only to a runner that declared `integration-pull-request/v1` |
| Integration job result | State `PULL_REQUEST` with `landingRefSha`. Error code `PUSH_PROTECTED` |
| `MergeCommand` / `MergeResultRequest` (`src/runner-go/types.go:1214`, `:1338`) | `landVia`, `landingRef`, `landingRefSha`; status `pull_request` with `pushedSha`. Sent only to a runner that declared `session-merge-pull-request/v1` |
| `POST /runner/git-credential` | Unchanged: one repository, `contents: write`, `metadata: read`. The server's pull request token is never answered here (§12) |

## 9. Runner changes

1. **`integrate.go`.** At J-S6 and M-S4, when `landVia` is not `PUSH`, push `tested` to `landingRef` with
   `--force-with-lease=<landingRef>:<landingRefSha>`, through `networkGit`. VERIFY reads `landingRef` back with
   `ls-remote`. No `advanceLocalRef`, because the target did not move. Answer `PULL_REQUEST`.
   - Reuse: when the landing branch already holds a commit with the tested tree whose first parent is the upstream tip
     this job fetched, answer that commit and push nothing. A retry after a flaky check then does not restart CI.
   - Everything before the push is unchanged: fetch, absorb, rebase or merge, Orbit's checks, the tree check (J-S6a),
     the synchronous PUSH report and the secret refusal (`secretPushRefusalOf`).
2. **`worktree.go`.** In `rebaseFastForward`, the same push to `landingRef`. It does not touch the local target or the
   root checkout, and answers `pull_request`. The machine's own `main` catches up at its next fetch instead of at the
   merge.
3. **`merge_recovery.go`.** Apply pushes its candidate to the session's landing branch when the mode is not `PUSH`.
4. **Naming the refusal.** A direct push refused with `GH006`, `GH013` or `protected branch hook declined` answers
   `PUSH_PROTECTED` (integration) or keeps GitHub's words in `mergeError`, never `TARGET_MOVED`. This covers rules 1 to
   3 of §3.
5. **Capabilities.** `integration-pull-request/v1` and `session-merge-pull-request/v1`, declared by the release that
   carries this. Managed runners get it with the release; a self-hosted runner that has not updated keeps today's
   behaviour (§3 rule 3).
6. **Credentials.** None new with D1 option A. The landing branch push is an ordinary `networkGit` push.

## 10. GitHub App permissions and existing installations

| Permission | Today | Needed | Why |
|---|---|---|---|
| Contents | Read and write | Read and write | Push the landing branch; merging needs it; delete the landing branch |
| Metadata | Read-only | Read-only | GitHub requires it |
| Pull requests | — | **Read and write** | Open, update, merge and close Orbit's pull request; read its reviews |
| Checks | — | **Read-only** | Read the head's check runs and suites, and which are required; `check_run` and `check_suite` events |
| Commit statuses | — | **Read-only** | Read the statuses some CI posts instead of check runs; `status` events |
| Actions | — | **Read-only** | Download the failing Actions job's log, which the check run does not carry, to send it to the session |
| Workflows | — | **Read and write** (D4) | GitHub refuses an App's push that adds or changes a file under `.github/workflows/` unless the App has it. By that rule, such a landing from Orbit Cloud is refused today (Orbit's records show no case yet), and the landing branch push would be refused the same way |
| Actions: write | — | Not requested | It would only re-run checks or start workflows from Orbit. GitHub runs a pull request's workflows by itself |
| Administration | — | Not requested | It would read protection in full (bypass lists, `enforce_admins`). Orbit uses GitHub's answers instead |

**Webhook events:** Pull request, Pull request review, Check run, Check suite, Status, Push (to see the base move), and
the Installation events GitHub always sends (`new_permissions_accepted`).

**Push as me** needs nothing more. The owner's token can do only what the App may do, so it needs Contents: write
(already granted) and, for a change to a workflow file, Workflows: write.

**How existing installations accept**

1. Whoever owns the App changes its permissions, events and webhook on GitHub, once. For Orbit Cloud that is the
   `orbitd-cloud` App (task `3521xdtdRcxvbQtuchAcl`). A self-hosting admin follows the new steps on the admin page
   (`AdminGithubPage.tsx:255`), which change from "Webhook: turn it off" to the webhook URL, a secret, the events and
   the permission list above.
2. GitHub asks each installation's owner (the user, or an owner of the organization) to review the new permissions,
   by email and on the installation's settings page. Until they accept, the installation keeps its old permissions,
   and a token Orbit mints for it carries only those.
3. Orbit reads each installation's granted permissions with the App's own credential
   (`GET /app/installations/{id}`), caches the answer, and reads it again on `new_permissions_accepted`.
4. Until an installation accepts, its workspaces land as today (§3 rule 3). Settings → Integrations → GitHub lists it
   with "Accept Orbit's new permissions on GitHub ↗", linking `github.com/settings/installations/<id>` for a user or
   `github.com/organizations/<org>/settings/installations/<id>` for an organization. A workspace's Landing section
   says: "Landing through pull requests starts once <account> accepts Orbit's updated GitHub permissions." A GH006
   refusal adds the same link.
5. The admin page reads the App's permissions back from GitHub (`GET /app`) and says what is missing. That read is
   also the evidence criterion 6 asks for.

## 11. What clients show

All copy is English (CLAUDE.md §5; `src/web/src/copyLanguage.test.ts`). The words below are drafts for the board task to
refine.

### 11.1 The workspace's landing setting

The setting is a "Landing" section in the workspace's settings, with both choices visible. This is preview option A,
the one the preview recommends; option B is a single menu row under Sessions. The board settles it.

- **Section heading:** "Landing". Under it: "How finished work reaches main on GitHub."
- **Pull request · Default:** "Orbit opens a pull request and merges it once the branch's rules pass: required checks,
  and a review if one is required. Works on any protected branch."
- **Push as me · Faster:** "Orbit pushes to main with your GitHub account, so a landing doesn't wait for a pull
  request. Needs the right to push to main. If GitHub refuses, Orbit opens a pull request instead."
- **GitHub not connected:** Push as me is disabled, with "Connect GitHub to push as yourself." and a link.
- **Installation has not accepted the new permissions:** "Landing through pull requests starts once <account> accepts
  Orbit's updated GitHub permissions. Review on GitHub ↗"
- **After a refusal (preview A, second panel):** "GitHub refused your last push to main on owner/repo: "<GitHub's
  words>". Landings here open a pull request until GitHub accepts your push. Connect GitHub again if your rights have
  changed."
- **A workspace not cloned from GitHub:** no choice, one line: "Landings push with this machine's Git credential."

`main` in this copy is the workspace's target branch, whatever it is called.

### 11.2 The landing's pull request states

These are drawn on the existing card (`session-project-landing` with `landing-head`, `ProjectLandingCard.tsx:44`,
`LandingHead` at `ProjectPanoramaHeader.tsx:1011`) and on the task's landing row (`LandTaskStatus.tsx:44`).

| State (preview letter) | Head | Detail | Actions |
|---|---|---|---|
| Opened, checks running (a) | "Pull request open" · "2 of 6" | "Waiting for the required checks" | View on GitHub ↗ |
| Waiting for review (b) | "Waiting for review" · "6 of 6 ✓" | "Checks passed. main requires an approving review." | Review on GitHub ↗; the one-line tip "Faster next time: with Push as me, landings go straight to main when you may push there, without waiting for a pull request. Landing settings ›", which the user can hide and which is not shown once Push as me is on |
| A required check failed (c) | "Check failed: PostgreSQL specs" (red ✕) | "Sent back to the session with the log. Fixes update this pull request." For a project branch: "Sent to the project's coordinator with the log." | Open session; View log ↗ |
| main moved (d) | "Catching up with main" · "0 of 6" | "main moved since the pull request opened. Orbit is checking the branch again on the new main." | View on GitHub ↗ |
| Merged (e) | "Landed by pull request #214" · "1 min ago" | "Merged into main · 3a9f1c2" | View on GitHub ↗ |
| Push as me refused (f) | "Opened a pull request instead" · "Push refused" (amber) | "GitHub refused the push to main: "Changes must be made through a pull request." Landing through pull request #214." | View on GitHub ↗; Landing settings |
| Closed on GitHub | "Pull request closed" (red ✕) | "@<login> closed pull request #214 without merging it." | Retry; View on GitHub ↗ |

- When a Push as me landing is accepted, it reads like today's direct landing, with the commit, and adds "Pushed as
  you".
- The review state says "review", not "your review": the reviewer GitHub wants may be someone else, such as a code
  owner.
- A session's merge row (`MergeButton`, `SessionOutputs.tsx:738`; the failure strip at `:438`) shows the same states in
  one line.

### 11.3 Where, and what notifies

| Platform | Setting | Landing states |
|---|---|---|
| Web | `src/web/src/components/settings/WorkspaceSettingsPage.tsx`: a new section between Location (`:406`) and Sessions (`:473`) | `ProjectLandingCard.tsx`, `LandTaskStatus.tsx`, `SessionOutputs.tsx` (all in `src/web/src/components/`) |
| iOS and macOS (one codebase, `src/macos/OrbitApp/Sources/OrbitApp/Views/`) | `AgentSettingsSheet` (`AgentsView.swift:1226`, form `AgentFormContent` at `:2068`) | `ProjectLandingCardView` (`ProjectLandingCard.swift:22`), the worktree bar's merge row (`WorktreeBar.swift`) |
| Android (`src/android/app/src/main/kotlin/io/orbitd/android/`) | `WorkspaceSettings` (`management/WorkspaceSettings.kt:63`) | `ProjectLandingCardView` (`projects/ProjectLanding.kt:97`), the worktree bar |

One push notification when a pull request starts waiting for review ("Pull request #214 is waiting for review"), and
one the first time Push as me is refused on a workspace. Nothing for the other states: they are visible where the
landing is.

## 12. Security

- **The runner's token is no stronger than today.** `POST /runner/git-credential` still answers one repository with
  `contents: write`. The pull request calls use a second installation token that the server mints with Pull requests,
  Checks, Commit statuses and Actions, keeps in memory, and never answers to any runner route. An agent that reads the
  runner's credential still cannot open, approve or merge a pull request.
- **An agent with the runner's token can push to `orbit/land/*`,** as it can push any branch today. J-T20 catches it:
  Orbit merges only the commit it pushed (`sha` guard on the merge call).
- **The owner's token (D1 option A)** stays in the apiserver, decrypted for one call per landing, never logged
  (`github-api.client.ts:278` logs status and message only), and never in a session event. The redaction pattern
  already covers `ghu_` (`secret-redaction.ts:19`). With option B, §5.2 lists what reaches the runner.
- **Only the owner chooses Push as me,** in a client. No MCP tool takes the field, so an agent cannot lend itself the
  owner's identity. If a tool ever offers it, it joins `WORKSPACE_WRITE_CARD_FIELDS` (`runner-workspace-approval.ts:55`).
- **Webhooks:** the signature is compared in constant time against the saved secret. Deliveries are de-duplicated by
  id, capped in size, and never trusted for state (§4.3). An unknown installation or repository is dropped.
- **GitHub's rules stay GitHub's.** Orbit never approves its own pull request, never uses a bypass, never asks anyone
  to weaken protection, and opens every pull request as the App, so the owner's approval counts.
- **Logs sent to sessions** are redacted before they are stored, as runner check output is.

## 13. Tests

- **apiserver pg specs, one per transition**:
  - J-T14 to J-T20;
  - each mode-resolution rule of §3;
  - J3 and `IN_FLIGHT_JOB_STATES` (the census over every reader);
  - the merge method chosen and refused;
  - verify mismatch → `LANDED` plus the item;
  - the W4 hand-off of a GitHub check failure, with the stored log;
  - a catch-up not counted toward J-T13 or `AUTOMATIC_MERGE_ATTEMPTS`, and a refused merge counted;
  - Push as me accepted, refused, not connected and token revoked;
  - webhook signature, de-duplication and an unknown repository;
  - the re-read cadence, with a fake clock;
  - installation permissions pending → `PUSH`;
  - the session merge path;
  - tenant isolation for each new route and table;
  - `db-write-inventory` for each new write.

  GitHub is faked through `GithubClient`'s injected `fetch` (`github-api.client.ts:88`), as the GitHub specs already
  do.
- **Runner Go tests**:
  - the landing branch push with its lease, and no push to the target in pull request mode;
  - reuse of an identical tree on the same base;
  - `GH006`, `GH013` and `protected branch hook declined` → `PUSH_PROTECTED`;
  - the capability gate;
  - the session merge in pull request mode, the local target unchanged.
- **The token never reaches the agent (criterion 4).**
  - Option A: a runner test that no runner route ever answers anything but an installation token. Then, after a real
    Push as me landing on a fake connection holding a canary token, a search of the runner's log, spool, session
    events and run events for the canary.
  - Option B: also a case in the style of `TestAgentEnvironmentsWithholdUserCredentials`
    (`src/runner-go/user_credential_env_test.go:251`) for the push command's environment.
- **Real runs on a test repository, never on the orbit repository's main.** The branch requires a pull request, the
  status checks and one review. Six runs:
  1. a pull request end to end;
  2. a failing check, fixed by the session, updating the same pull request;
  3. main moved, caught up;
  4. a review wait;
  5. Push as me accepted;
  6. Push as me refused, landing through a pull request.
- **Clients:** screenshots of each state on each platform against a real stack, and the copy guard green.

## 14. Contract changes this needs

The implementation tasks write these as revisions of `docs/project-integration-line-contract.md` (appendix B) before
the code, as the contract requires:

- **§0.2 G3** gains a fourth use: re-reading the state of a pull request Orbit opened, while it is open. Time decides
  when to read, never what changes.
- **§0.2 G2:** a stored webhook delivery is a committed fact.
- **§2.1:** the state, column and error-code additions of §7. J2 gains §4.4's recorded exception. J3 includes
  `PULL_REQUEST`.
- **§2.2:** J-T14 to J-T20. J-T8 applies to `PULL_REQUEST` attempts. J-T13 does not count catch-ups.
- **§2.4:** the landing branch variant of J-S6, J-S7 and M-S4.
- **§2.7, §2.7a, §7:** the `pullRequest` block and the two blocking reasons. **§2.9:** the landing timeline gains rows
  for the pull request (opened, checks, waiting for review, caught up, merged, refused).
- **§12:** W4's scope table includes GitHub's required checks. W6 gains the pull request text of §4.5.

M7, O2, J1 and W0 do not change.

## 15. Decisions for the owner

Each decision lists the recommended choice first. Rulings are recorded under each one.

**D1. How Push as me uses your GitHub token.**
- *A (recommended):* Orbit's server moves the branch through GitHub's API, one call per landing. The token never leaves
  the server, and the runner pushes only Orbit's own landing branch.
- *B:* the runner's git push carries the token, as the task first described. Only that command sees it.

A is the stronger form of criterion 4: the token cannot reach the agent because it never reaches the agent's machine.
It needs criterion 4 to read "never leaves Orbit's server", and the bypass test to try the API call as well as `git
push` (§16).
*Ruling:* pending.

**D2. Pull request mode on a branch GitHub does not protect.**
- *A (recommended):* a pull request every time. One rule everywhere, and it merges within seconds when nothing is
  required.
- *B:* push directly when GitHub accepts the push, and open a pull request only when it refuses. That is today's speed
  on unprotected repositories, but it gives two behaviours, and the copy "Orbit opens a pull request" would no longer
  always hold.

*Ruling:* pending.

**D3. How Orbit learns what happened on GitHub.**
- *A (recommended):* the webhook as the doorbell, plus a slow re-read of open pull requests: every 10 minutes while
  deliveries arrive, and every minute when none has arrived in an hour. Needs G3 amended (§14).
- *B:* webhook only. A lost delivery stalls a landing, and deployments GitHub cannot reach get nothing.
- *C:* polling only. No setup, but up to a minute's delay and more API calls.

*Ruling:* pending.

**D4. The App's new permissions.**
- *A (recommended):* Pull requests: write; Checks: read; Commit statuses: read; Actions: read; Workflows: write.
- *B:* the same without Workflows. A landing that changes `.github/workflows/` is then refused, as GitHub's rule
  already refuses it from Orbit Cloud today.
- *C:* the same as A without Actions: read. The session then gets the check's summary and link, not its log.

*Ruling:* pending.

**D5. A required check fails on a session outside a project.**
- *A (recommended):* the same as a project task's landing. The log goes to the session as a turn, and its next commit
  updates the same pull request, at most twice.
- *B:* show "Fix in session" on the merge row, and send nothing until it is pressed.

*Ruling:* pending.

## 16. Open questions

1. **Does a user token get the admin bypass?** This is task `3521xdqK4aYeUggJ7YW15`. It has not run: it waits on the
   owner for a device-flow code (ruling of 2026-11-23). Push as me is correct either way (§5.4). With D1 option A, the
   test should also run `PATCH /repos/{owner}/{repo}/git/refs/heads/main` with the token in each of its four cases, not
   only `git push`, since that is the call Orbit would make.
2. **Merge queues.** v1 waits and says so (§4.3). Adding the pull request to the queue is a later step.
3. **Review comments.** v1 shows "Changes requested" and waits. Handing the comments to the session, as a failing check
   is handed, is a later step.
4. **Two confirmations.** On a repository that requires a review, the owner confirms the promotion in Orbit and then
   approves the pull request on GitHub. Opening the pull request at `CHECK_PROMOTION` and counting the approval as
   Orbit's confirmation would need M7 changed, so it is not part of this design.

## 17. Phased rollout

| Phase | Content | Task | Depends on |
|---|---|---|---|
| P0 | The App's permissions, events and webhook; the admin page steps; reading granted permissions | `3521xdtdRcxvbQtuchAcl` (owner-confirmed) | this doc |
| P1 | Migration; `PULL_REQUEST` state and J-T14, J-T15; pull request door, webhook route, re-read; runner capabilities and landing branch push; session merge path; one real end-to-end run | `3521xduVqwmXO68Z6Fzwk` | P0 for real runs |
| P2 | J-T16 to J-T20, the W hand-off with the log, catch-up, review wait; real runs for a failing check and a review wait | `3521xdvIBQ9mlLrFSCztZ` | P1 |
| P3 | Push as me (§5), after the bypass test answers, then the token proof | `3521xdwAZYZxGaCznpWKJ`, `3521xdwkppfCeIUtd2Qyz`; test `3521xdqK4aYeUggJ7YW15` | P1 |
| P4 | Board, then web, iOS and macOS, Android | `3521xdsf8WFT3GSUtyf5P`, `3521xdxR8r5OT74eEKkWJ`, `3521xdy7ToiIa2BHtBEoI`, `3521xdytrtO1aynAhOIxs` | the board before any client code |

Pull request mode switches on for a workspace by itself, once both are true: its installation has accepted the
permissions, and its runner declares the capability. Until then landings behave exactly as today.

## Appendix A. Alternatives considered

- **Add Orbit's App to the branch's bypass list.** Rejected: the project's instruction rules it out. It is all or
  nothing (any session on the repository could then push to main), and it asks teams to undo the protection they set.
- **Keep the job `RUNNING` while the pull request waits.** Rejected. It holds J1's slot, so every other landing into
  that branch would wait for the review. The runner lease rules (J-T3, J-T9) would also read a waiting pull request as
  a lost runner.
- **End the job when the pull request opens, and track the rest in a machine of its own.** Rejected. The receipt
  (J-T5), the exception item and the hand-off to the session (J-T7, W5) and the next generation (J-T13) would all have
  to be written a second time for the new machine.
- **GitHub's auto-merge.** Not chosen. It needs "Allow auto-merge" turned on in each repository (off by default), and
  it merges at a moment Orbit does not see, without the base check that keeps J2. It may be an optimisation later.
- **GitHub's "Update branch" for a moved target.** Not chosen. Orbit's own checks would not run on the new combination
  (M5).
- **SSH keys for Orbit.** A separate, later plan (`docs/design/orbit-ssh-keys.md`). It does not change what GitHub
  allows a push to a protected branch.
