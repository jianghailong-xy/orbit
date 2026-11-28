# Syncing a directory to Documents in the background (MCP and CLI)

Status: **design, decisions settled** (owner, 2026-11-24). Builds on the drive tools of
`docs/orbit-files-drive-design.md` (D20) and the runner-hosted background jobs (`src/runner-go/background_job.go`).

## Problem

`drive_put` / `orbit drive put` copies **one file**, and the agent's turn waits until every byte is up. To hand the
owner a folder of output (a report with its images, a build's artifacts, a dataset) an agent has to call it once per
file, in the foreground, with no way to skip files that are already there.

## Decisions (owner, 2026-11-24)

| # | Question | Decision |
|---|---|---|
| S1 | One-shot or continuous | **One-shot.** The sync copies the directory once, in the background, then ends and tells the agent. Nothing keeps watching the directory. |
| S2 | Direction | **One-way, local → Documents.** The local directory is the source. Nothing comes down. |
| S3 | Local deletions | **Kept by default; `--delete` opts in.** With `--delete`, a Documents file under the destination that the local directory no longer has goes to Trash, where the owner can restore it. |
| S4 | Owner's view | **The Documents page shows each running sync in the upload tray in the bottom-right corner**, next to the owner's own uploads (2026-11-24). |

## What the agent sees

```
orbit documents sync <local-dir> <path> [--delete] [--wait] [--json]
```

MCP: `documents_sync { localPath, path, delete? }`.

- It answers at once with a **background job id** and returns the turn to the agent. The sync runs as a
  runner-hosted job, so it survives the engine being recycled.
- When it ends, the job's normal wake tells the agent, and the last line of its output is the summary:

  ```json
  {"path":"/Reports/out","link":"orbit-drive:<folder id>","uploaded":12,"unchanged":30,"deleted":0,
   "bytes":94371840,"failed":[{"path":"big.bin","error":"…"}]}
  ```

- While it runs, `bg_output <jobId>` shows progress, one line every few seconds, for example
  `Synced 12 of 42 files, 90 of 900 MB`. `bg_kill <jobId>` stops it. Files already committed stay in Documents.
- `--wait` (CLI only) runs the same sync in the foreground and prints the summary. It is what the background job
  itself runs, and it is useful in a script.

They shipped after the Files → Documents rename, so the names are `documents_sync` and `orbit documents sync`
(`orbit drive sync` too, as `orbit drive` is the same command). There is no `drive_sync` tool: no released runner had it.
The runner routes are `/runner/documents/syncs`, with `/runner/drive/syncs` as their alias like every runner Documents
route, and the owner's is `GET /documents/syncs` (and `/drive/syncs`).

```
Agent:   documents_sync ./out → /Reports/out ──► {"jobId":"bg_…"}  (the agent keeps working)
                         │
Runner:  background job ─┼─ list /Reports/out in Documents
                         ├─ walk ./out, compare, upload what is new or changed (4 files at a time)
                         ├─ (--delete) send what ./out no longer has to Trash
                         └─ exit with the summary ──► wakes the agent
```

## How it works

The copy itself is in the runner (`src/runner-go`) and needs no new server route: it uses the routes `drive_put` and `drive_list`
already use (`/runner/drive/list`, `stat`, `manifest`, `mkdir`, `create`, `stagings`, `commit`, `utimens`, `delete`).

### Starting it

`documents_sync` (MCP) and `orbit documents sync` without `--wait` both ask the session's background job service
(`bg.sock`, the `bg_run` path) to start one job whose command is the runner's own absolute `orbit` path with
`documents sync --wait <local-dir> <path> [--delete]`. The same session gate as `bg_run` applies, so a Plan-mode
session is refused (D9). A session without the background service gets the same `BG_TRANSPORT_UNAVAILABLE` answer
`bg_run` gives, with `--wait` as the alternative.

The local directory is checked **before** the job starts, so a bad path is the call's error and not a failed job
an hour later:

- it must be a directory inside this session's checkout or uploads directory (the scope `drive_put` reads from,
  `newSessionFileScope`);
- it must not be inside the Documents mount (`~/Documents`, `/run/orbit-files/drive` on Cloud). That would copy the
  drive into itself;
- the destination is normalized as in `drive_put` (no `..`). `--delete` with the root `/` as destination is refused,
  so one mistyped path cannot send the whole drive to Trash.

### One pass

1. **List the destination** recursively with `/list` (paged, one folder at a time) into `path → {kind, size, mtime}`.
   A missing destination is an empty map. The folder is made on the first upload.
2. **Walk the local directory.** Regular files only. Symlinks are skipped and counted, since the drive has no
   symlinks (rule 2). `.git` folders are skipped. Empty local folders are made with `mkdir`.
3. **Decide each file** (the rsync `-t` quick check):
   - missing in Documents → upload;
   - same size and same mtime → unchanged, skip;
   - same size, different mtime → compare the local file's 8 MiB chunk sha256s with `/manifest`. If they are equal,
     only `utimens`. Otherwise upload. This keeps an untouched file from making a new version and putting the old
     one in Trash (D17);
   - different size → upload.
   - A Documents **folder** where the local side has a file (or the reverse) is a per-file failure, never a
     replacement.
4. **Upload** with the existing `putDriveFile` steps (stat/create, staging, 8 MiB chunks, commit with its receipt
   check). After the commit, call `utimens` with the local mtime so the next sync's quick check skips the file. Four
   files at a time; each file's chunks go up in order. A transient error is retried 3 times with backoff
   (`retryIdempotentWhile`). After that the file goes in `failed` and the sync moves on.
5. **A file that changes while it is read** (size or mtime differ after the last chunk) is read once more. If it
   changes again it is reported as `changed while uploading` in `failed`.
6. **`--delete`:** each Documents file or folder under the destination with no local counterpart goes to `/delete`
   (Trash), topmost first, so a removed folder is one Trash group the owner restores whole. Nothing outside the
   destination is ever touched.
7. **Exit** 0 when `failed` is empty, 1 otherwise. The summary is the last output line either way.

`writer.sessionId` is the session that started the sync, as with `drive_put`, so the Documents page says which
session wrote each file.

### Sending what is not there yet

Before a file goes up, the sync hashes its 8 MiB chunks and asks `POST /runner/drive/chunks/held`
(`{chunks: [{sha256, size}]}`, at most 1000) which of them this account already holds. Only the others are PUT. "Held"
is exactly what a commit accepts: a blob whose bytes are not deleted, of that size, named by one of this owner's
staging or version chunks. So the answer never says anything about another account's content. A renamed or copied file,
a second run after a stop, and a large file whose first chunks are unchanged send that much less. A chunk swept
between the question and the commit is answered `DRIVE_CHUNK_NOT_HELD` for that file. The file is tried once more: it
asks again and sends the chunk.

### Many small files

A file of one chunk or less goes in a batch with others: up to 64 files and 32 MiB, held in memory while the batch is
sent. One batch is one held question, one staging bound to no entry (`POST /stagings {}`) for the missing chunks, and
one `POST /runner/drive/batch`. The batch is `{items: [{path, commitId, chunks, mtime}], writer, stagingId?}`, at most
100 items. The server makes the parent folders, creates or overwrites each file (a folder at that path is
`DRIVE_NOT_A_FILE`), commits it and sets its time. So a small file takes about one request instead of seven (stat,
create, staging, PUT, commit, utimens, mkdir). Each item is answered on its own and is idempotent by its `commitId`. The
batch commit does not pass `stagingId` (a commit with one clears that staging's chunks, and the next item still needs
them), so the idle-staging sweep removes it. A larger file is a unit of its own, with the same held question. The four
workers take units, not files. When Orbit cannot be reached for a whole batch, every file of that batch fails together.

A server without these routes answers the empty held question that starts every pass with 404. The sync then sends
file by file as in step 4.

### Refactor

`putDriveFile` is split into "open and check the local file" (stays in `drive_put`) and "send an open file to a
drive path" (shared with the sync). `drive_put` behaves exactly as before.

## Edge cases

| Case | Behaviour |
|---|---|
| The session ends mid-sync | The job is killed like any `bg_run` job. Files already committed stay; nothing is rolled back. The next sync of the same directory finishes the rest via the quick check. |
| Engine recycled mid-sync | The job keeps running; it belongs to the runner. |
| The owner edited a Documents file the local side also has | The local file wins when it differs (S2, rule 1 "last write wins"). The owner's version goes to Trash as the previous version (D17), so it can be restored. |
| Very large tree | No file-count limit. The remote listing is held in memory (about 200 bytes a path). |
| Two syncs to the same destination at once | Allowed. Last commit wins per file, as with any two writers. |
| Cloud runner | Same code path through the API. Writing into the mount with `rsync -rt` still works too; the guidance points at `documents_sync` because it reports what failed. |

## Progress on the Documents page (S4)

Board: [`docs/mocks/drive-sync-tray/board.png`](mocks/drive-sync-tray/board.png) (three frames: a sync next to an owner
upload, every row state, the Details dialog).

The Documents page already has an upload tray in the bottom-right corner (`src/web/src/components/files/FilesUploadTray.tsx`,
board 02-web frame 3). Until now it only lists the owner's own browser uploads (`lib/driveUploads.ts`). An agent's
sync gets **one row per sync** in the same tray. A sync can hold thousands of files, so a row per file would bury the
owner's own uploads.

```
┌──────────────────────────────────────────────────────┐
│ Uploading 2 of 3 · 410 MB of 1.2 GB  Clear finished Hide│
├──────────────────────────────────────────────────────┤
│ holiday.mov → Videos                          Pause  │   owner's upload (unchanged)
│ ██████████░░░░░░░░  310 MB of 800 MB · 12 MB/s       │
├──────────────────────────────────────────────────────┤
│ out/ → Reports/out                    ⟳ Agent sync   │   agent sync row
│ ████░░░░░░░░░░░░░░  12 of 42 files · 90 of 900 MB    │
│ charts/q3.png · Weekly report session                │   current file · session link
├──────────────────────────────────────────────────────┤
│ data/ → Datasets                                  ✓  │
│ Synced 30 files · 1 failed                  Details  │   finished: summary
└──────────────────────────────────────────────────────┘
```

- **While checking** (listing Documents and walking the directory) the row reads `Checking files… 1,204 so far`
  with an indeterminate bar.
- **While uploading:** the bar is bytes sent of bytes to send, counting only files that need uploading. Unchanged
  files are not counted. The line is `12 of 42 files · 90 of 900 MB`, plus a rate and time left as owner uploads show.
  Under it are the file going up now and the session, which links to that session.
- **Finished:** `Synced 42 files · 900 MB`, or `Synced 41 files · 1 failed` with a warning mark. A sync that found
  nothing to upload reads `Already up to date · 42 files`. With `--delete` the line adds `3 moved to Trash`.
  **Details** opens a dialog with the failed paths (at most 100, then "and N more") and their reasons in plain words,
  never a runner's local path, plus **Open <folder>**. It has no Retry: only the agent can run the sync again (S1).
  Selecting the row anywhere else opens the destination folder.
- **Stopped** (killed, the session ended, or no report for 2 minutes): `Stopped · 12 of 42 files synced`.
- The tray's header counts syncs as items alongside uploads. **Clear finished** hides finished syncs as it does
  finished uploads (remembered in localStorage per sync id). The server keeps finished syncs for 24 hours.
- The tray shows on the Documents page, as today. A sync started while the page is closed shows when it opens.

### How the progress gets there

```
runner (sync job) ──POST /runner/drive/syncs──────────────► apiserver: drive_sync row (RUNNING)
                  ──PATCH /runner/drive/syncs/:id every 2 s─► update counts ─► drive.sync event ─► owner's stream
                  ──PATCH … {status: DONE|FAILED}──────────► final row       ─► drive.sync event
web Documents page: GET /drive/syncs on open/focus/reconnect; drive.sync re-reads it (an accelerant, like drive.changed)
```

**Server (`src/apiserver/src/drive/`)**

- New table `document_sync` (migration 1560, already named for the Documents rename's `document_*` tables): `id`,
  `ownerId`, `runnerId`, `sessionId`, `sourceName` (the local directory's last path segment, never the whole local
  path), `destPath`, `destEntryId`, `status` (`CHECKING | UPLOADING | DONE | FAILED | STOPPED`), `filesSeen`,
  `filesTotal`, `filesDone`, `filesSame`, `filesDeleted`, `bytesTotal`, `bytesSent`, `currentPath`, `failed` (JSON, at
  most 100 entries) and `failedCount`, `error`, `startedAt`, `updatedAt`, `endedAt`. DONE may list files that failed;
  FAILED is a sync that could not finish at all (Documents unreachable, the destination a file), `error` saying why.
  If main takes 1560 first, renumber before landing.
- Runner routes, under the runner's own auth like the other `/runner/drive` routes:
  - `POST /runner/drive/syncs {destPath, sourceName, sessionId}` returns `{id}`;
  - `PATCH /runner/drive/syncs/:id {status, counts, currentPath, failed?}`. Only the runner that opened the sync may
    update it, and an ended sync refuses updates.
- Owner route `GET /drive/syncs`: running syncs, and syncs ended in the last 24 hours, newest first.
  A sync that ended with failures stays listed (and is not pruned) whatever its age until it is handled: the owner's
  `POST /drive/syncs/:id/handled`, or a later clean sync of the same source into the same destination.
- A `RUNNING`/`CHECKING`/`UPLOADING` row not updated for 2 minutes reads as `STOPPED` (worked out when the row is
  read). The retention sweep deletes ended rows after 24 hours.
- Event `drive.sync`, payload `{id}` only, published to the owner's scope, and **only to streams that declared
  `hints=drive_syncs`** (a new `CONTROL_HINT_DRIVE_SYNCS` in `@orbit/shared`). Shipped clients that don't know the event
  never receive it. One event per update, so at most one every 2 seconds per sync.
- New routes go into the tenant-isolation case table, the new writes into `db-write-inventory.ts`, and the routes
  into the API reference (regenerate).

**Runner**

- The sync job opens its row after the checks and before listing. Then it reports at most every 2 seconds and once
  when it ends. A report that fails is dropped and never fails the sync: the next report carries the full counts.
- When the job is killed, a `SIGTERM` handler sends `STOPPED` if it can. Otherwise the 2-minute rule covers it.

**Web**

- `lib/driveSyncs.ts`: a store (`useDriveSyncs`) that reads `GET /drive/syncs` and re-reads it on `drive.sync`,
  focus and reconnect. `useControlPlane` adds `drive_syncs` to the event stream's hints.
- `FilesUploadTray` takes `syncs` as well as `uploads`, and draws a `SyncRow` beside `TrayRow`. Sync rows have no
  Pause or Resume. The header text and "Clear finished" count both kinds.
- All copy in English (CLAUDE.md §5).

## Guidance and catalog

- The tool description and `orbit documents sync --help` say: one-way, one-shot, background; the result arrives as
  a job wake; `--delete` sends to Trash; it skips unchanged files, so running it again after more output is cheap.
- Add `documents_sync` to `driveCLICapabilities` / `operation_catalog.go` (Mutates, SessionOnly). Regenerate the
  agent tools guide (`agentToolsGuide.generated.json`, `AgentToolsGuide.generated.swift`) and the primer testdata.
- The other-runner guidance (no mount) names `documents_sync` next to `documents_put` for "a folder of output".

## Tests (runner-go, against the fake door)

1. A fresh destination: every file uploaded, empty folders made, mtimes set; the summary counts match.
2. A second sync with nothing changed: zero uploads, zero commits, zero new versions.
3. `touch` without a content change: only `utimens`, no commit.
4. One file edited: exactly one upload.
5. `--delete`: a removed local file and a removed local folder end in Trash as one delete each; a sibling outside
   the destination is untouched; `--delete` to `/` is refused before the job starts.
6. Symlinks and `.git` are skipped; a path outside the session scope and a path inside the mount are refused.
7. A chunk PUT that fails twice then succeeds is retried; one that always fails lands in `failed`, exit 1, and the
   other files still go up.
8. The MCP call returns a job id at once, and the job's last line is the summary (background job service test).
9. Runner: progress reports are throttled to one every 2 seconds, the last one carries `DONE`/`FAILED`, and a failing
   report endpoint does not fail the sync.
10. Apiserver (pg spec): another runner and another owner cannot update a sync; an ended sync refuses updates; a stale
    row reads `STOPPED`; `drive.sync` reaches only streams with `hints=drive_syncs`; `GET /drive/syncs` drops rows
    older than 24 hours.
11. Web: the tray draws checking, uploading, finished-with-failures and stopped sync rows next to owner uploads; a
    `drive.sync` event re-reads the list; Clear finished hides a finished sync across a reload.

12. Held and batch (runner-go): 151 small files go as 3 batches with one chunk PUT each and no `utimens`; a copy of a
    synced tree to another folder PUTs nothing; an edited tail of a large file PUTs only that chunk; content swept
    before the commit is sent again; an older server (404) gets the per-file path. Apiserver (pg spec
    `drive-batch.pg.spec.ts`): held is owner-scoped and size-checked; a batch makes folders, overwrites with a version
    and sets times; a replayed `commitId` is answered as the first; items fail on their own; another account cannot
    name the staging.

## Not in this design

Continuous or watch mode (S1); download or two-way sync (S2); include or exclude patterns other than `.git`;
syncing to the owner's own computer; the owner stopping a sync from the tray; the tray on iOS, macOS and Android
(they follow once their Documents page has an upload tray).
