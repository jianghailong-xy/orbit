# First workspace from a conversation: server contract (v1)

**Status:** the server task of project `34pLjYBjU6ILsehatEjJs` ("A machine with no workspace: make its first
workspace in the conversation"). It turns the project's interface agreement 1–4 into the contract the runner
task and the client tasks (web P1, iOS/macOS P1b, Android P1b) build on. Design: board 04 of
`docs/mocks/first-workspace-in-conversation` (rules 2–8, the apiserver and runner change lists). A change to
anything below changes this file first.

| What | Where |
| --- | --- |
| Migration | `src/apiserver/prisma/migrations/0457_first_workspace_in_conversation` |
| Wire types | `src/shared/src/dto.ts`: `DirProbe`, `DirProbeCommand`, `RunnerDirProbeResult`, `DirProbeAnswer`, `NewWorkspaceRequest`, `RunnerHeartbeatResponse.dirProbeRequest`, `ClaimedSession.createWorkDir`, `ReclaimSession.createWorkDir`, `DIR_PROBE_CAPABILITY`, `CREATE_WORKDIR_CAPABILITY` |
| Register directory | `runners/runners.service.ts` `approveDeviceEnrollment`, `runner-api/runner-api.controller.ts` `register` |
| Directory probe relay | `runners/runners.service.ts` `requestDirProbe`, `getDirProbe`; `runner-api/runner-api.controller.ts` `drainDirProbeRequest`, `dirProbeResult` |
| Session with a new workspace | `sessions/sessions.service.ts` `create`, `newWorkspaceFor`, `createInNewWorkspace` |
| Claim | `queue/queue.service.ts` `buildSession`, `runner-api/runner-api.controller.ts` `reclaim` |
| Specs | `runners/first-workspace.pg.spec.ts`, `runner-api/dir-probe.spec.ts`, `runner-api/link-heartbeat.pg.spec.ts` |

Paths below are under `/api`. Every id in a response is a public id, as everywhere else.

## 1. Register directory

`runner.register_dir` (TEXT, nullable): the directory `orbit register` ran in, as the CLI reported it.

- **Written** by both registration doors, on the runner they mint or re-issue:
  - approving a device registration (`POST /runners/device/:userCode/approve`): `deviceEnrollment.workDir`;
  - token registration (`POST /runner/register`): the body's `workDir`.
  The value is trimmed. A registration that carries a non-empty one overwrites the column (registering
  again from another directory moves it); one that carries none leaves the column as it was. Nothing else
  writes it: not a heartbeat, not `PATCH /runners/:id`.
- **Read** by `GET /runners` and `GET /runners/:id`: every runner carries `registerDir: string | null`.
- **Meaning:** a suggestion, never a default (board 04, settled item 2). It is whatever the CLI sent: it can
  be `~`, `/`, a relative path or a directory that has since gone. A client probes it (§2) before offering
  it, and offers it only when the probe says it exists, is a directory, and is neither the home directory
  (`isHome`) nor `/` (board rule 2).

## 2. Directory probe relay

"What is at this path on this machine?", asked while a folder is being chosen, before any workspace row
exists. Only the runner can answer, so the question rides a heartbeat and the answer comes back on a POST
of its own: the same one-slot relay as the Claude history relay (`requestClaudeHistory`,
`getClaudeHistory`).

- **Capability:** a runner that answers declares `dir-probe/v1` (`DIR_PROBE_CAPABILITY`) in
  `x-orbit-runner-capabilities`; `GET /runners` shows it in `capabilities`. A client does not ask a runner
  that has not declared it: the setup card says that machine will update itself first. The server does not
  refuse such a request; a runner that does not know the field never answers it.
- **One slot per runner** (`runner.dir_probe_path`, `dir_probe_status`, `dir_probe_at`,
  `dir_probe_result`). A new question replaces the previous one. The previous answer stays in the row, but
  it is only ever returned for the path it answers.

| `dir_probe_status` | Meaning |
| --- | --- |
| NULL | Nobody has asked. |
| `pending` | Asked; the next heartbeat hands it over. |
| `probing` | Handed to one heartbeat; the runner is looking. Never handed out again. |
| `done` | `dir_probe_result` holds the answer for `dir_probe_path`. |

### 2.1 Ask: `POST /runners/:id/dir-probe`

Body `{ "path": string }`: the path as typed, `~` allowed. Trimmed.

| Answer | When |
| --- | --- |
| 201 `{ "path": string, "status": "pending" }` | Asked. The slot now names this path, `pending`. |
| 400 | `path` is missing, empty or longer than 4096 characters. |
| 400 `Runner is offline — it can only look while connected` | The runner is offline: what `GET /runners` reports as `online: false` (status OFFLINE, or no heartbeat within `RUNNER_OFFLINE_AFTER_MS`). |
| 404 `runner not found` | Not one of the caller's runners. |
| 403 | A personal access token (`RUNNER_CONTROL`, like every relay of a machine). |

The ask moves the runner's change count (`RealtimeService.markRunnerChanged`), so a runner on the link
reconciles in full on its next beat and is handed the question there.

### 2.2 Read: `GET /runners/:id/dir-probe?path=<path>`

200 `DirProbeAnswer`:

```json
{ "path": "~/code/app", "status": "idle" | "pending" | "done", "result": DirProbe | null }
```

- `path`: the query, trimmed.
- `status`: `pending` while the slot names this path and is `pending` or `probing`; `done` once its answer
  is stored; `idle` when the slot names another path or nobody has asked.
- `result`: only when the slot names this path **and** the stored answer is for this path. An answer to a
  path asked earlier is never returned for another one, so a late answer about a path that was retyped
  reads as nothing yet, not as the verdict on what is in the field now.
- 404 for a runner that is not the caller's; 403 for a personal access token. Not refused while offline:
  it reads what is stored.

A client polls this while `status` is `pending`. An unanswered question stays `pending` (the runner may
have restarted mid-probe); a client gives up after its own timeout and may ask again.

### 2.3 Heartbeat: `dirProbeRequest`

`RunnerHeartbeatResponse.dirProbeRequest?: DirProbeCommand`:

```ts
interface DirProbeCommand {
  path: string;          // as asked: `~` not expanded
  requestedAt?: string;  // when it was asked, for log correlation
}
```

- Present only on the heartbeat that claims a `pending` question: a compare-and-set from `pending` to
  `probing` on the path it read, so two API replicas draining at the same moment hand it to one runner
  process. Handed over **once**, never redelivered.
- Both heartbeat doors carry it: `POST /runner/heartbeat` over HTTPS, and a link heartbeat's full reconcile
  (`runner-api/link-heartbeat.ts`). While the slot is `pending` or `probing`, every link beat of that runner
  reconciles in full (`readLinkReconcilePending`), as with the Claude history relay. In
  `HEARTBEAT_DELIVERIES` it is `MARKED` by `runners/runners.service.ts#requestDirProbe`.
- A pending question also keeps a managed runner awake (`managed-runner-work.ts`, `RUNNER_OPERATION`).
- A runner that does not know the field ignores it.

### 2.4 Answer: `POST /runner/dir-probe-result` (RunnerAuthGuard)

Body `RunnerDirProbeResult`:

```ts
interface RunnerDirProbeResult {
  path: string;      // DirProbeCommand.path, echoed exactly: what the answer is matched on
  result: DirProbe;
}

interface DirProbe {
  path: string;              // what the runner looked at: `~` expanded, absolute
  exists: boolean;           // something is at that path
  isDir: boolean;            // it is a directory
  isGit: boolean;            // it is inside a git work tree (false when it is not a directory)
  branch: string | null;     // the checked-out branch when isGit; null otherwise, and on a detached HEAD
  isHome: boolean;           // it is the runner user's home directory
  freeBytes: number | null;  // free bytes on its filesystem for the runner user; null when unknown
  error?: string;            // why the runner could not look; absent on success, "does not exist" included
}
```

- Stored, and the slot set to `done`, only while the slot still names `path` (a compare-and-set on
  `dir_probe_path`). Answered 200 `{ "ok": true, "applied": boolean }`: `applied` is false when the person
  has since asked about another path, and the answer is dropped.
- A probe that could not look still answers, with `error`: the read then says `done` with that result,
  which is not the same thing as `exists: false`.
- The body crosses the runner boundary and is re-read rather than trusted: booleans must be booleans (else
  false), strings are trimmed and capped (`path` 4096, `branch` 255, `error` 500), `freeBytes` is a finite
  non-negative integer or null.
- 400 when `path` is missing, empty or longer than 4096 characters, or `result` is not an object.
- Over the link it is a daemon route like `claude-history-result`: `linkDaemonRoutes`
  (`src/runner-go/link_mode.go`) and `REFUSED_OVER_HTTPS` (`runner-link-required.spec.ts`) list it.

## 3. `POST /sessions` with a new workspace

A session on a machine with no workspace for it: the request names the machine and a folder, and the
workspace, the session and its first message are made together.

```ts
interface NewWorkspaceRequest {
  workDir?: string;    // a folder on the machine, already confirmed there through §2
  newFolder?: string;  // a new folder under the runner's reposRoot, made by the runner (§4)
}
// CreateSessionDto gains: newWorkspace?: NewWorkspaceRequest
```

The body names `assignedRunnerId` and `newWorkspace`, and no `workspaceId` (nor its old name `agentId`).
Everything else in the body means what it always has.

### 3.1 Refusals

Checked in this order. None of them writes anything.

| Answer | When |
| --- | --- |
| 400 | `newWorkspace` is not an object; it names both `workDir` and `newFolder`, or neither; the body also names `workspaceId` or `agentId`; it has no `assignedRunnerId`; `workDir` is not a non-empty string of at most 4096 characters; `newFolder` is not one path segment of 1–64 characters from `[A-Za-z0-9._-]`, or is `.` or `..`. |
| 403 `PAT_SCOPE_MISSING` | A personal access token without `workspaces:write`, the scope `POST /workspaces` asks for: `sessions:write` alone does not make a workspace. A token confined to workspaces is refused before this, since the route requires it to name one. |
| 403 `runner not found` | `assignedRunnerId` is not one of the caller's runners. |
| 409 `NEW_FOLDER_UNSUPPORTED` | `newFolder` on a runner that has not reported a `reposRoot`, or does not declare `create-workdir/v1` (`CREATE_WORKDIR_CAPABILITY`). The body is `{ code, message }`. |
| as before | Every other refusal of `POST /sessions`, judged as for a workspace with no settings of its own (no environment, Automatic accounts): 409 `EngineSignedOutConflict` for an engine signed out on that runner, the Cursor CLI and DeepSeek Harness runner refusals, the prompt size, the attachments, a mode the runner cannot run. A `folderId` is refused 400 (`folderId must be a folder of this workspace`): a new workspace has no folders. |

### 3.2 What is written, in one transaction

1. **The workspace**, owned by the caller:
   - `runnerId` = `assignedRunnerId`;
   - `workDir` = `newWorkspace.workDir` (trimmed), or `<reposRoot>/<newFolder>` (the runner's reported
     `reposRoot`, any trailing separator dropped, joined with the separator it uses);
   - `name` = the folder's name: `newFolder`, or the last segment of `workDir` (the whole of it for `/`).
     When the caller has a workspace that is not deleted with that name, ` 2`, ` 3`, … is added: the
     smallest number free. Picked under a per-account lock (`pg_advisory_xact_lock`), so two requests at
     the same moment never take the same name;
   - `enableWorktree` = false (isolation off, board 04 settled item 3);
   - `autoCreateWorkDir` = true for `newFolder`, false for `workDir`;
   - everything else as a new workspace's column defaults: enabled, no environment, Automatic accounts, no
     repository URL (the runner's directory probe fills it from `origin`, as for every workspace), no
     default merge target (the runner detects it).
2. **The session**, by the ordinary create path, with `workspaceId` = the new workspace and
   `createdWorkspace` = true.
3. **The first message**: the session's prompt, as the ordinary path writes it; its attachments are adopted
   by the session, and a shell-first or attachments-only opening has its opening turn row written, all in
   this transaction. An ordinary prompt becomes turn 1 when the runner claims the session, as for every
   session.

Any failure rolls all three back: no workspace is left without the session it was made for. After the
commit, as for any session: the claim queue is woken, `session.created` and the workspace change are
published; and the runner is marked changed, so its next heartbeat lists the new directory (`agentDirs`).

### 3.3 Answer and reads

- 201: the session, as `POST /sessions` always answers it, with `workspaceId` naming the new workspace and
  `createdWorkspace: true`.
- `session.created_workspace` (BOOLEAN NOT NULL DEFAULT false). `GET /sessions/:id` carries
  `createdWorkspace`: true only for a session that made its workspace this way, false for every other
  session, including every one from before migration 0457. List rows do not carry it.
- A client draws "Created workspace `<name>` on `<machine>` · `<path>`" as the conversation's first line
  from it, with Rename (`PATCH /workspaces/:id`) and Settings. The name and path are the workspace's
  (`GET /sessions/:id` includes it), the machine is the session's runner.

## 4. Claim: `createWorkDir`

`ClaimedSession.createWorkDir?: true` (`GET /runner/sessions/claim`) and `ReclaimSession.createWorkDir?: true`
(`GET /runner/sessions/reclaim`): present, and true, only when the session's workspace has
`autoCreateWorkDir` (a workspace made with `newFolder`). Absent otherwise, never false.

The runner (`create-workdir/v1`), before it spawns the engine: when `workDir` does not exist and
`createWorkDir` is true, `mkdir -p` it with mode 0755, but only when the path, resolved (symlinks
evaluated), lies inside its own resolved `reposRoot`. A path that resolves outside it, through a symlink or
otherwise, is not created, and the session fails to start with the error it fails with today. The control
plane never gives `newFolder` to a runner that does not declare `create-workdir/v1` (§3.1); a runner that
ignores the field starts the session as it always has.

## 5. Migration 0457

`0457_first_workspace_in_conversation`, catalog-only (`ADD COLUMN`; the two defaults are constants, so no
table rewrite):

| Table | Column | Type |
| --- | --- | --- |
| `runner` | `register_dir` | TEXT NULL |
| `runner` | `dir_probe_status`, `dir_probe_path` | TEXT NULL |
| `runner` | `dir_probe_at` | TIMESTAMP(3) NULL |
| `runner` | `dir_probe_result` | JSONB NULL (`RunnerDirProbeResult`) |
| `workspace` | `auto_create_work_dir` | BOOLEAN NOT NULL DEFAULT false |
| `session` | `created_workspace` | BOOLEAN NOT NULL DEFAULT false |

Nothing is backfilled: every runner registered before it reads no register directory, and every workspace
and session reads false.

## 6. Censuses

- `tenant-isolation-cases.ts`: `POST /runners/:id/dir-probe` and `GET /runners/:id/dir-probe`.
  `POST /runner/dir-probe-result` names no path parameter and no id field, so the runner gate needs no case.
- `db-write-inventory.ts`: `runners.service.ts#requestDirProbe`, `runner-api.controller.ts#drainDirProbeRequest`
  and `#dirProbeResult` (statements); `sessions.service.ts#createInNewWorkspace` (a retried transaction
  unit); the register directory rides the existing runner writes of `#register` and `#approveDeviceEnrollment`.
- `task-judgment-data-preserved.spec.ts`: the migration ledger.
- `link-heartbeat.ts` `HEARTBEAT_DELIVERIES`: `dirProbeRequest` (MARKED by `requestDirProbe`), and
  `createInNewWorkspace` among the writers of `agentDirs`.
- Route lists: `REFUSED_OVER_HTTPS` (`runner-link-required.spec.ts`, and the route counts its pg twin
  `runner-link-required.pg.spec.ts` drives) and `linkDaemonRoutes` (`src/runner-go/link_mode.go`, with its count in
  `link_mode_test.go`): 53 routes, 48 of them the daemon's.
