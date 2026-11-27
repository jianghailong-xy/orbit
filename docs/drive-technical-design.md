# Documents drive: technical design

Status: **draft for the owner's review, revision 2** (gate G2, and G3 for the container-hardening change in §6).
Task [Documents drive: technical design](orbit-task:350KSO2SDXIBqq7841EEI), 2026-11-20, repository at `58e176a1be`.
Revision 2 answers the independent review of revision 1 (task comment `350aNYQGBxSWjiw9h1ADT`, file
`350a0QdK4XgIEDJIX8ziH`); §14 maps every review item to where this revision answers it.

Inputs:

- `docs/drive-product-design.md`: the product decisions D1–D23 and rules 1–8. Referred to below as "the product".
- The feasibility report of [can Orbit Cloud runners get a FUSE mount at /home/orbit/Files?](orbit-task:350KDMTso7g0wYwYRpU7y)
  (file `350SDm87q1Sxg2WzOEQXB`), cited as "the report" with its check names (D-1 … D-7, K-1 … K-4).
- `docs/drive-design.md`: today's sha256 store, retention sweep and evidence files.
- The owner's rulings on this task (2026-11-19): G0, a node-level CSI driver on Kubernetes and a per-runner mounter
  container on Docker, parent-directory layout; storage, Ceph RGW (S3) for Orbit Cloud, local disk or any S3 for
  self-hosted; drive layer **option C**, our own name layer in Postgres with chunks as sha256 blobs through the existing
  `FileStore`, a Go mount daemon on go-fuse, and a node-only CSI plugin. No JuiceFS.
- The board `docs/mocks/drive/` and its four choices, settled as drawn: Trash and Storage are reached from inside
  Files; Move to Trash asks nothing and web offers undo; an earlier version restores as the current version or as a
  copy; an owner upload whose name is taken gets a suffix and never overwrites.

Line numbers refer to `58e176a1be`.

## 0. Summary

| Piece | What it is | Where |
|---|---|---|
| Name layer | Postgres tables `drive_entry`, `drive_version`, `drive_version_chunk`, `drive_trash_group`, `drive_staging`, `drive_staging_chunk`, `drive_commit`, `drive_change`, `drive_mount_credential` | apiserver, `src/apiserver/src/drive/` |
| Bytes | Chunks of at most 8 MiB kept as ordinary `file_blob` rows through the existing `FileStore`; a file is an ordered chunk list | `src/apiserver/src/files/` gains a ranged read; nothing else in the store changes |
| Owner routes | `/drive/*` under the owner's login, resumable chunked upload, ranged download | apiserver |
| Runner drive door | `/runner/drive/*`, taking the runner credential (drive tools) or a mount credential bound to one runner generation (the mount daemon) | apiserver |
| Mount daemon | `orbit-documents-mount`, Go on go-fuse, one process per runner; handles bound to entry ids, idempotent commits, commit-on-close plus periodic commits, chunk cache, evict-and-refetch spool, change feed | new `src/documents-mount/` |
| Kubernetes | CSI node plugin `drive.orbit.dev` (privileged DaemonSet, namespace `orbit-drive-system`), remounting its runners' drives on restart; the runner Pod gains one `csi:` volume | `deploy/managed-runner/drive-csi/`, `managed-runner-resources.ts`, `managed-runner-admission.ts`, one cluster-wide admission policy |
| Docker (optional) | Per-runner `mrf-<uuid>` mounter container; the runner container gains one `rslave` bind. Production runs on Kubernetes; this is built only if a Docker deployment needs the drive | `deploy/managed-runner/docker-channel/channel.py` |
| Engines | `/run/orbit-drive` (the parent) and `/home/orbit/Files` are workspace roots for every engine in every write mode; Plan mode reads only | `src/runner-go/` |
| Sleep, fencing | A drive write with uncommitted bytes is a reason not to sleep; a mount credential works only for the generation and instance it was issued for | apiserver `managed-runner-work.ts` |
| Sharing | New share-link root kind `DRIVE_FILE`, **pinned to the version shared** | `src/apiserver/src/share-links/` |
| Backup | Postgres first, then bytes, then the orphan lister; the RGW bucket needs an off-host mirror and a pool quota before "kept permanently" means anything | `scripts/pg-backup.sh`, runbook |

Decisions this design asks the owner for are collected in §12.

## 1. The name layer

### 1.1 Tables

Every table has `owner_id`, and every reference between drive tables is a composite foreign key on `(id, owner_id)`,
as the wiki tables do (`share_link_wiki_space_fkey`, `schema.prisma:2593`): a row can only ever point at a row of the
same account, whatever a bug in a route does.

**`drive_entry`**: one folder or file, live or in Trash.

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid (v7) | |
| `owner_id` | uuid | Tenant. |
| `parent_id` | uuid null | The folder it is in, `(parent_id, owner_id)` → `drive_entry`. NULL only on the account's root row. |
| `kind` | text | `FOLDER` \| `FILE`. |
| `name` | text | Exact bytes of the name, valid UTF-8, 1–255 bytes, no `/`, no NUL, not `.` or `..`. Not normalised. The root's name is `''`. |
| `current_version_id` | uuid null | FILE only: the version a read gets. Deferred FK `(current_version_id, owner_id)` → `drive_version`. |
| `size_bytes` | bigint | FILE: the current version's size. FOLDER: 0. |
| `mtime` | timestamptz(3) | What `stat` shows. Set by every write, and by `utimens` (§5.6). |
| `created_at`, `updated_at` | timestamptz(3) | |
| `last_writer_kind` | text | `OWNER` \| `AGENT`. |
| `last_writer_session_id` | uuid null | The session that wrote it, when Orbit could tell (§5.8). |
| `last_writer_runner_id` | uuid null | The runner the write came through, for an agent write. |
| `last_written_at` | timestamptz(3) | |
| `trashed_at` | timestamptz(3) null | Set while the entry is in Trash. |
| `trash_group_id` | uuid null | The group that holds it, `(trash_group_id, owner_id)` → `drive_trash_group`. |
| `trash_top` | boolean | True for an entry that is a top-level item of its group (its parent is not in the same group). |
| `seq` | bigint | The `drive_change.seq` of its last change. Moves on **every** commit, appends included, so it is the cache key (§5.3). |

Indexes and constraints:

- `UNIQUE (owner_id, parent_id, name) WHERE trashed_at IS NULL`: one live name per folder. Trashed entries keep their
  `parent_id` and `name` (their original place), so a new file may reuse the name at once.
- `UNIQUE (owner_id) WHERE parent_id IS NULL`: one root per account, created lazily by the first drive call.
- `CHECK ((kind = 'FILE') = (current_version_id IS NOT NULL))`, deferred, so a file and its first version are written in
  one transaction.
- `CHECK ((trashed_at IS NULL) = (trash_group_id IS NULL))`.
- `(owner_id, trash_group_id)`, and `(owner_id, parent_id, name)` for paged listings.

A folder moved to Trash marks **every descendant** with the same `trashed_at` and `trash_group_id`, so whether an entry
is live is a column, not a walk up its ancestors. §1.4 says how that is done without a race.

**`drive_version`**: one content a file has had.

| Column | Type | Meaning |
|---|---|---|
| `id`, `owner_id` | uuid | |
| `entry_id` | uuid | `(entry_id, owner_id)` → `drive_entry`, `ON DELETE CASCADE`. |
| `size_bytes` | bigint | No per-file limit (D12); `bigint` because `file_blob.size_bytes` is an `Int` (`schema.prisma:3466`). |
| `chunk_count` | int | |
| `created_at` | timestamptz(3) | |
| `handle_id` | uuid null | The mount handle (or upload, or tool call) that is still writing this version, so a later commit of the same handle continues it instead of making another version (§3.1). Cleared when the handle is closed. |
| `writer_kind`, `writer_session_id`, `writer_runner_id` | | Who made this version (same meanings as on the entry). |
| `replaced_at` | timestamptz(3) null | When it stopped being current. NULL on the current version. |
| `trash_group_id` | uuid null | Set while a replaced version is listed in Trash (D17). |

**`drive_version_chunk`**: the ordered chunks of a version.

| Column | Type | Meaning |
|---|---|---|
| `version_id`, `idx` | uuid, int | Primary key. `(version_id, owner_id)` → `drive_version`, `ON DELETE CASCADE`. |
| `owner_id` | uuid | |
| `offset` | bigint | Byte offset of the chunk in the file. |
| `size_bytes` | int | 1 B … 8 MiB. |
| `sha256` | text | → `file_blob(sha256)`, `ON DELETE RESTRICT`, exactly as `attachment.sha256` is (`schema.prisma:3425`). |

Index `(sha256)` for the retention sweep (§2.4).

**`drive_trash_group`**: what one deletion or one overwrite put in Trash.

| Column | Type | Meaning |
|---|---|---|
| `id`, `owner_id` | uuid | |
| `kind` | text | `DELETE` (entries) \| `VERSION` (a replaced version). |
| `folder_id` | uuid null | The folder the items were deleted from (`SET NULL` if it is later deleted for good). |
| `folder_path` | text | That folder's path when the group was made, for display once the folder has moved or gone. |
| `created_at`, `closed_at` | timestamptz(3) | A `DELETE` group from the mount stays open for a burst (§3.4); owner deletions close at once. |
| `burst_key` | text null | Which burst of deletions it collects (§3.4). |
| `actor_kind`, `actor_session_id`, `actor_runner_id` | | Who deleted. |
| `item_count`, `size_bytes` | int, bigint | Written when the group closes, for the Trash list. |

**`drive_staging`** and **`drive_staging_chunk`**: chunks received for a write that is not committed yet: an owner's
resumable upload, a write through the mount, or a drive tool's `put`.

| Column | Meaning |
|---|---|
| `id`, `owner_id` | |
| `source` | `OWNER_UPLOAD` \| `MOUNT` \| `TOOL`. |
| `entry_id` | For `MOUNT`: the entry the handle is bound to (§3.1). |
| `runner_id`, `generation` | For `MOUNT` and `TOOL`: the runner, and for a managed runner the generation, that opened it. |
| `parent_id`, `name`, `relative_path`, `declared_size` | For `OWNER_UPLOAD`: where it will land (§4.1). |
| `dirty` | For `MOUNT`: the handle holds bytes no commit has taken yet. What the sleep hold reads (§8.1). |
| `created_at`, `touched_at`, `committed_at` | `touched_at` moves with every chunk and keepalive; an uncommitted staging untouched for 7 days is removed. |
| chunk rows | `(staging_id, idx)`, `sha256` → `file_blob`, `size_bytes`. A chunk re-sent for the same `idx` replaces the row. |

**`drive_commit`**: `(owner_id, commit_id)` primary key, `entry_id`, `version_id`, `result` (json), `created_at`. The
answer to a commit, kept one day so a retried commit gets the same answer instead of applying twice (§3.1).

**`drive_change`**: the change feed caches and the web page follow. `seq bigserial`, `owner_id`, `entry_id`,
`parent_id`, `op` (`UPSERT` \| `REMOVE`), `at timestamptz(3) DEFAULT clock_timestamp()`. Index `(owner_id, seq)` and
`(owner_id, at)`. Rows older than one day are pruned. §5.4 says how it is read without skipping a late-committing row.

**`drive_mount_credential`**: §4.3.

**`share_link.drive_entry_id`, `share_link.drive_version_id`**: §9.

### 1.2 How names reference sha256 content

A file's bytes are the concatenation of its current version's chunks in `idx` order. Each chunk is an ordinary
`file_blob` row named by the chunk's sha256, stored once per deployment however many versions, files or attachments
name it. Nothing in the drive names a whole-file sha256; a whole-file hash is computed on demand (for a share-link
scan, or `file_upload` of a drive file, which reads the file and makes its own evidence copy under today's rules,
product rule 5).

### 1.3 Paths

The mount and the drive tools speak paths and entry ids; the web speaks ids. The door resolves a path one segment at a
time over `(owner_id, parent_id, name)` on live entries. The mount caches the resolution (§5.4).

`<Project>` folders (D22) are made by the guidance, not the server: the runner computes the safe name (no `/`, trimmed to
60 characters, `-<4 chars of the project id>` when two projects share a title) and tells the agent the path.

### 1.4 Concurrency rules of the tree

Two writes must never leave a live entry under a trashed folder, or a folder inside itself.

- **Folder operations take a per-owner lock**: folder trash, folder move, Trash restore and delete-for-good take
  `pg_advisory_xact_lock(<drive lock key>, hashtext(owner_id))` first, so they run one at a time per account. File
  creates, commits, file renames and deletes do not take it (they are the hot path).
- **A write into a folder takes `FOR SHARE` on that folder's row and re-checks `trashed_at IS NULL`** after the lock is
  granted (Read Committed re-reads a locked row), answering `ENOENT` (door: `404 DRIVE_PARENT_GONE`) if it went to Trash.
- **Folder trash marks a batch per statement, and a batch per transaction**: first `SELECT … FOR UPDATE` of the
  folder, which waits out any create holding `FOR SHARE` on it and blocks new ones, and the folder marked; then, each
  in a **new statement** (a fresh snapshot that sees every create that committed meanwhile), the live children of the
  folders marked so far, up to 1,000 entries a transaction, folders locked before files. A create that committed before
  its folder was marked is marked with the next batch; one that comes after finds its parent trashed. The first
  transaction hides the folder and answers its group; what one transaction cannot hold is marked into the same group by
  the next ones, each under the owner lock, so a folder of 100,000 entries stays inside the bounds below. Until the
  last batch the group carries `marking`; a group left marking (its process gone, a bound hit) is finished by
  deleting the folder again, or by the drive's own timer. A restore leaves unmarked entries in place. Delete for good
  includes them among the folder's descendants (§3.3).
- **A folder move** checks, under the owner lock, that the destination is not the folder itself or inside it (walking the
  destination's ancestors), answering `409 DRIVE_MOVE_INTO_ITSELF` / `EINVAL`. With the owner lock no two moves can
  interleave to form a cycle.
- **Restore** recreates or reuses parents under the owner lock (§3.5).
- **Every drive transaction is short**: no store I/O inside it (§3.2), a Prisma interactive-transaction timeout of 20 s
  and `SET LOCAL statement_timeout = '10s'`. One that still hits a bound answers `503 DRIVE_LIMIT_HIT`
  (`retryable: true`), never a bare 500; what committed before it is kept, and the same request sent again carries on. Production Postgres is 16 (`deploy/postgres-pinned.yml`), which has no
  `transaction_timeout`, so the client-side timeout is the bound the change feed relies on (§5.4).

## 2. Chunked, streamed store

### 2.1 What stays as it is

`FileStore.put(sha256, tempPath, sizeBytes)` (`file-store.ts:28`, `s3-file-store.ts:42`) takes one whole temporary
file, and uploads are capped at 25 MiB (`attachments.media.ts:9`). **Both stay** for attachments, evidence files,
`file_upload` and conversation pictures, with today's rules (retention, the secret scan, the quota).

### 2.2 Chunks

- A drive file is cut into chunks of **at most 8 MiB** (`DRIVE_CHUNK_MAX`). A chunk is small enough to be one
  temporary file, one `file_blob` (whose `Int` size tops out near 2 GiB) and one signed S3 `PUT` (no multipart), and
  small enough that reading a whole chunk to serve part of it is cheap.
- A streaming writer cuts at every 8 MiB; the owner's browser cuts at 8 MiB; an append adds or replaces the tail chunk
  (§3.2). Every chunk row carries its `offset`, so a read finds the chunk for any byte by binary search.
- Storing a chunk is the existing path: the door writes the request body to the files directory's `tmp/` while hashing
  it (`writeHashedTempFile`, `file-store.ts:171`), refuses it if the hash is not the one the client declared, and calls
  `FilesService.store()` (`files.service.ts:355`), which stamps `last_referenced_at` first, puts the bytes in the
  target store or finds them already there, and upserts the `file_blob` row. Then, in the same request, it inserts the
  `drive_staging_chunk` row that holds the chunk until a commit names it.
- A file of any size therefore never exists whole on the server's disk, the runner's volume or the node: at most one
  chunk per request in `tmp/`, and the mount's bounded spool of chunks not yet uploaded (§5.3).

### 2.3 Changes to the store

1. **A ranged read**: `open(sha256, range?: { start: number; end: number })`. The local store passes `start`/`end` to
   `createReadStream`; the S3 store sends `Range: bytes=start-end` and accepts `206`. About 20 lines per store.
2. **Nothing else**. Both backends keep their single-request `put`. Dedup, the stamp-then-grace protocol and the
   per-blob `storage` column work unchanged, so a deployment may move its target store (production moves to RGW,
   §12 decision 3) with older blobs still read from where they are.

The default target is the deployment's `ORBIT_DRIVE_BACKEND`. Self-hosted keeps local disk or any S3 (D23).

### 2.4 The retention sweep treats drive content as held

Today a blob is held by a live attachment row (`file-retention-sweep.ts`, steps 3 and 4). The drive adds two holders:

| Holder | Held while |
|---|---|
| `attachment` row (today) | `expired_at IS NULL`, or tombstoned less than one grace period ago |
| `drive_version_chunk` row | the row exists: the version is current, or replaced and in Trash. Drive content never expires (D2); it stops holding only when the owner deletes it for good or empties Trash, which deletes the rows |
| `drive_staging_chunk` row | the staging exists: uncommitted for at most 7 days without a touch |

Changes, in the sweep's own terms:

- **Step 3** (`markReleased`): a blob is released when no attachment is live **and** no `drive_version_chunk` or
  `drive_staging_chunk` row names it; it loses the mark when any of them names it again.
- **Step 4** (`deleteReleased`, `deleteBytes`): the holder count under the `file_blob` row lock adds both drive tables.
  Both have a foreign key to `file_blob`, so inserting a row naming a blob takes `FOR KEY SHARE` on it, which the sweep's
  `FOR UPDATE` excludes: the protocol the sweep documents for attachments holds for drive rows unchanged.
- **The gap between storing a chunk and naming it** is covered as for attachments: `store()` stamps
  `last_referenced_at` before anything else, and the staging chunk row is inserted in the same request.
- **A new step 0**: remove `drive_staging` rows untouched for 7 days, `drive_commit` rows older than a day, and
  `drive_change` rows older than a day.
- **Tail churn**: an append that replaces a small tail chunk (§3.2) leaves the old tail unreferenced; it is released and
  goes one grace period later. The tail threshold (64 KiB) bounds that churn to 64 KiB per append.
- Purging Trash deletes `drive_entry`/`drive_version` rows in batches of 1,000 (the cascade takes their chunk rows); the
  sweep then releases what no one else holds, and the bytes go one grace period later (`fileGraceMs`, ≥ the Postgres
  backup's reach, §10).
- **Objects with no `file_blob` row at all** (left in the store when the database is restored to an earlier point) are
  invisible to the sweep, which works from `file_blob` rows only (`file-retention-sweep.ts:172`–`195`). The orphan
  lister in §10.3 handles them.

### 2.5 Usage, without changing the attachment quota

`storedTotals` (`files.service.ts:849`) and `assertWithinQuota` (`:866`–`:876`) **stay exactly as they are**, so
`ORBIT_DRIVE_QUOTA_BYTES` keeps limiting attachment uploads by attachment bytes, and drive bytes can never make an
attachment upload fail. Drive writes are not limited (D12; quotas are the cleanup design's).

Storage (D13) uses a **separate query**, `driveUsage(ownerId)`, that counts each distinct sha256 once across live
attachments, drive versions (current and Trash) and stagings, and splits it into the drive's share (chunks drive rows
name) and the rest (attachments whose sha256 no drive row names). It belongs to
[Storage moves into Files](orbit-task:350KSOA9nCBF7zqcWMh8Y) with its route.

One honest limit: a file of more than 8 MiB that is both in the drive and kept as an attachment (for example passed to
`file_upload`) is two contents, its chunks and its whole-file blob, and counts as both. Files of up to 8 MiB are one
chunk whose sha256 is the whole file's, and count once.

## 3. Writes: overwrite, append, delete, restore

All of this is enforced in the apiserver's write path, whichever door the write came through.

### 3.1 Create, commit, and binding to the entry

**Create.** A mount `open(O_CREAT)` of a missing name, a drive tool `put` of a new path, and an owner upload's
`complete` create the `drive_entry` **at once**, with an empty first version (0 bytes, `handle_id` = the creating handle).
The mount binds the open handle to the **entry id**, not the path, so:

- `rename` of a file that is open for writing moves the entry; the handle's later commit lands on the entry wherever it
  now is (`open a.tmp; write; rename a.tmp a.txt; close` ends with `a.txt` holding the bytes).
- `unlink` of a file that is open for writing moves the entry to Trash; the handle's later commit still lands, **in
  Trash**: the file is not resurrected in the live tree and its bytes are not lost.
- Other mounts see the new file (0 bytes) at once, and its content from its first commit.

**Commit.** A write ends with one commit:

```
{ commitId, entryId, handleId, mode, baseVersionId, baseSize, chunks: [{ idx, sha256, size }], replaceTail?, writer }
```

`mode` is `OVERWRITE`, `APPEND` or `CONTINUE`. In one short transaction (§1.4) it:

1. returns the stored answer if `(owner_id, commitId)` is already in `drive_commit`: **a retried commit never applies
   twice**, whether the first try failed, timed out after committing, or its answer was lost;
2. takes `FOR UPDATE` on the entry row;
3. checks that every chunk is this owner's to name: held by a staging of this owner or already named by a version of
   this owner, with `bytes_deleted_at IS NULL`. A chunk another account stored is never accepted on the strength of its
   sha256 alone (§4.4);
4. applies the mode (§3.2), writes the entry's size, `mtime`, `seq` and last-writer fields, one `drive_change` row, and
   the `drive_commit` row;
5. marks the staging's chunk rows taken (they are deleted after commit; the version's rows now hold the chunks).

### 3.2 Overwrite makes a version; append does not (D17)

| Commit | What happens |
|---|---|
| `CONTINUE` of `baseVersionId` | The handle is continuing the version it is writing: allowed when that version is current and its `handle_id` is this handle. Its chunk list is replaced by the new one; **no new version**. This is how the first close of a newly created file fills its empty first version, how a `dup`ed descriptor closed twice stays one version, and how periodic commits of a long-open handle (§5.2) work. If the version is no longer current (someone overwrote the file meanwhile), it becomes an `OVERWRITE`. |
| `OVERWRITE` (`>` on an existing file, `cp` over it, `O_TRUNC`, `truncate`, `put` over an existing path) | A new version becomes current with `handle_id` = this handle. The previous one gets `replaced_at` and goes to Trash in a new `VERSION` group whose folder is the file's folder. |
| Rename onto an existing file (`mv a b`, a write-then-`os.replace` save) | The **target** entry keeps its id and gets a new version whose chunk rows are the source's current chunks; its previous version goes to Trash; the source entry is removed outright (its content lives on as the target's version). A source still open for writing keeps its handle bound to the source entry id, which is now gone: its later commit lands as a new file in Trash named after the source, so nothing it writes is lost. |
| `APPEND` (`>>`, `O_APPEND`, or writing at exactly the end of an existing file) | **No version.** Allowed when `baseVersionId` is current: the current version's chunk list grows in place. The **daemon** builds the new tail: if the current last chunk is under 64 KiB, it sends that chunk merged with the appended bytes and names it in `replaceTail: { idx, oldSha256 }`; otherwise the appended bytes are new chunks. The server only checks, under the entry lock, that the last chunk is still `oldSha256` and swaps the rows: **no store I/O inside the transaction**. Chunks other than the last are therefore at least 64 KiB, so a file's chunk count stays under its size / 64 KiB + 1. |
| `APPEND` whose base is no longer current, or whose tail changed | If the current version is the same version and only grew (another appender came first), the server answers `409 DRIVE_TAIL_MOVED` with the new tail and the daemon rebuilds and retries with the same bytes and a new `commitId`: two appenders both land, in commit order, as `O_APPEND` would. If the file was overwritten meanwhile, the append becomes an `OVERWRITE` whose content is the base version's chunks plus the appended bytes: the newer content goes to Trash. Last write wins (rule 1) and nothing is lost (rule 3). |
| In-place change of an existing file (a write before its end without `O_TRUNC`) | Refused at the mount with `EOPNOTSUPP` (§5.6). |

Versions are kept until the owner deletes them for good (D2, D17; limits are the cleanup design's).

### 3.3 Delete to Trash

- `unlink`/`rmdir` through the mount, `delete` from a drive tool, and the owner's Move to Trash set `trashed_at` and
  `trash_group_id` on the entry and, for a folder, every descendant, a batch per transaction (§1.4), and write
  `drive_change` `REMOVE` rows. Nothing is deleted.
- An entry in Trash cannot be reached by any path, by the mount, by drive tools, or by a share link (§9). Agents cannot
  see Trash (D11): the door has no Trash route. A mount handle already open on it can still commit (§3.1).
- Move to Trash asks nothing; the web's undo is a restore of the group the response named (board choice b).
- After the owner confirms (board choice b), Delete for good of a group and Empty Trash remove up to 1,000 leaf entries
  per transaction under the account's lock (§1.4). A folder is eligible once all its children are gone, including children
  from older groups or whose marking into Trash is incomplete. The database removes each leaf's versions and chunk
  references with it. Replaced versions in Trash can also be deleted on their own, or up to 1,000 per transaction when
  emptying Trash. Each batch removes groups it emptied and updates the counts of other affected groups. A request retried
  after `503 DRIVE_LIMIT_HIT` continues from what is still in Trash. §2.4 says what happens to the bytes.

### 3.4 Grouping what one `rm -rf` removed

The mount sees `rm -rf dir` as many unlinks, leaves first, then `rmdir`s bottom-up. The door groups them:

- Each delete carries a **burst key**: in v1, one key per mount that changes after 2 s without a delete. (Keying by the
  caller's process is a later refinement; it needs the caller's pid, §5.8.)
- The door adds a delete to the open `DELETE` group of the same burst key if that group was last added to less than 10 s
  ago; otherwise it opens a new group. A group closes 10 s after its last delete.
- Entries keep their `parent_id` in Trash, so the group is a tree. When `dir` itself is removed in the same burst, the
  files and folders removed earlier hang under it, and the group's top-level item becomes `dir`, with `folder_id` its
  parent: Trash shows "dir, 152 items, deleted from /Project at 14:02", restored whole.
- Two sessions deleting on one runner within the same 2 s can land in one group. Restore still puts every item back
  where it was; only the grouping is coarser.

### 3.5 Grouped restore with name suffixes

Restoring a group, under the owner lock (§1.4), in transactions of at most 1,000 entries:

1. For each top-level item, the destination is its original `parent_id` if that folder is live. If the folder is in Trash
   or gone, the missing folders of `folder_path` are recreated as new live folders (a name taken by a live file gets the
   suffix below).
2. If the item's name is taken by a live entry in the destination, the restored item gets the first free name of
   `name (2).ext`, `name (3).ext`, … (the extension is kept; a folder or a name without a dot gets the suffix at the end).
3. Descendants come back with their item, folder by folder from the top, and keep their names; one whose name a live
   entry has, or one restored before it in the same folder had, gets the suffix too.
4. `trashed_at`, `trash_group_id` and `trash_top` are cleared; `drive_change` rows are written; the group row is deleted
   with the last batch. A restore cut off by a bound is carried on by restoring the group again.

Restoring a replaced version (board choice c):

- **As the current version**: the current version goes to Trash (a new `VERSION` group), the chosen one becomes current
  and leaves Trash. Its entry must be live; a version of a file in Trash is restored by restoring the file's group first.
- **As a copy**: a new entry beside the file named by the suffix rule, with a first version whose chunk rows copy the
  chosen version's. The chosen version stays in Trash.

The same suffix rule names an owner upload or new folder whose name is taken (board choice d: uploads never overwrite);
writes through the mount and the drive tools overwrite and version instead (D17).

### 3.6 Last-writer fields

Every commit, rename, move, restore and folder creation sets `last_writer_kind`, `last_writer_session_id`,
`last_writer_runner_id` and `last_written_at` on the entry it changed; a commit also sets them on the version. The
session is recorded only when the door could check it: it must be the owner's and run on the runner the write came
through, or it is dropped to NULL and the page says "an agent on Orbit Cloud" (rule 6).

## 4. Doors and tenant isolation

### 4.1 Owner routes

Under the owner's login (and PAT), in a new `DriveController`. Every route takes the owner from the credential and never
from the request.

| Route | What it does |
|---|---|
| `GET /drive/entries?parentId=&cursor=&limit=` | Children of a folder (root when absent), paged by name (at most 1,000 a page), with size, `mtime`, last writer and whether it is shared. |
| `GET /drive/entries/:id` | One entry with its path. |
| `GET /drive/resolve?path=` | Path to entry, for links (§4.5) and the composer's picker. |
| `POST /drive/folders` | `{ parentId, name }`; a taken name gets the suffix. |
| `PATCH /drive/entries/:id` | Rename and/or move: `{ name?, parentId? }`. An owner rename or move onto a taken name answers `409 DRIVE_NAME_TAKEN`; it never overwrites. A folder moved into itself: `409 DRIVE_MOVE_INTO_ITSELF`. |
| `DELETE /drive/entries/:id` | Move to Trash; answers the group id (for undo). |
| `GET /drive/entries/:id/content` | Download, streamed chunk by chunk, with `Range` (`206`) and `ETag` = `"<versionId>.<seq>"`, which changes on append too. |
| `GET /drive/entries/:id/versions` | Current and replaced versions. |
| `GET /drive/versions/:id/content` | Download a version. |
| `POST /drive/versions/:id/restore` | `{ as: "CURRENT" \| "COPY" }`. |
| `GET /drive/trash`, `GET /drive/trash/groups/:id` | Trash grouped by folder and time; one group's tree (paged). |
| `POST /drive/trash/groups/:id/restore` | §3.5. |
| `DELETE /drive/trash/groups/:id`, `DELETE /drive/versions/:id`, `DELETE /drive/trash` | Delete for good, Empty Trash. |
| `POST /drive/uploads` | Open a resumable upload: `{ parentId, name, size, relativePath? }`. Answers the staging id and `chunkSize` (8 MiB). `relativePath` places a file of a dropped folder (D3 asks for folder drops): missing folders are made under `parentId`, and when the dropped folder's top name is taken it gets one suffix for the whole drop. |
| `PUT /drive/uploads/:id/chunks/:idx` | One chunk, ≤ 8 MiB, with `X-Orbit-Chunk-Sha256` (the browser hashes with WebCrypto). Idempotent. |
| `GET /drive/uploads/:id` | Which chunks have arrived: what makes an upload resumable after a reload or a lost connection. |
| `POST /drive/uploads/:id/complete` | Create the entry and commit (§3.1) with the suffix rule, keyed by the staging id so a retry is idempotent. |
| `DELETE /drive/uploads/:id` | Abandon. |
| `GET /drive/changes?since=` | The change feed (§5.4), also announced to the web over the existing realtime stream as `drive.changed { seq }`. |
| `GET /drive/usage` | Storage (§2.5); built by the Storage task. |
| `POST /drive/entries/:id/share-check` | The secret scan before sharing (§9). |

A chunk route carries at most 8 MiB, inside the gateway's `client_max_body_size 30m` (`gateway/nginx.conf:227`), so no
proxy change.

### 4.2 Runner drive door

Under `/runner/drive/*`, for the mount daemon and the drive tools (D20):

| Route | What it does |
|---|---|
| `GET /runner/drive/stat?path=` or `?id=` | One entry's attributes, `seq` and current version id. |
| `GET /runner/drive/list?path=&cursor=` | Children **with attributes**, paged (1,000 a page), each file carrying its `seq` and, for a file of one chunk, that chunk's sha256, so `ls -l`, `find` and `grep -r` over small files cost one listing call per folder page plus one chunk read per file (or none, when the chunk is cached). |
| `GET /runner/drive/chunks/:sha256` | One chunk's bytes, with `Range`; only a chunk this owner's versions or stagings name (§4.4). |
| `GET /runner/drive/manifest?id=` | The current version's chunk list. |
| `POST /runner/drive/create` | Create an entry with an empty first version (§3.1); answers the entry id. |
| `POST /runner/drive/stagings` | Open a staging for a handle; answers its id. |
| `PUT /runner/drive/stagings/:id/chunks/:idx` | One chunk, as §4.1. |
| `GET /runner/drive/stagings/:id/chunks/:idx` | Read a chunk back from the staging: what the spool re-fetches after evicting (§5.3). |
| `POST /runner/drive/stagings/:id/keepalive` | Moves `touched_at` and sets `dirty`; what the sleep hold reads (§8.1). |
| `POST /runner/drive/commit` | §3.1. |
| `GET /runner/drive/commits/:commitId` | Whether a commit applied: what the daemon asks after a commit it could not confirm (§5.7). |
| `POST /runner/drive/mkdir`, `rename`, `delete`, `utimens` | As named; `rename` takes `noReplace`; `delete` takes the burst key. |
| `GET /runner/drive/changes?since=` | Long poll, at most 25 s (§5.4). |

Every write route takes `writer: { sessionId?, burstKey? }` (§5.8). Every route that answers an entry answers its `seq`.

### 4.3 Credentials on the door

The door accepts two credentials, and each resolves to exactly one owner:

1. **The runner credential**, as every `/runner/*` route takes it today, with the managed-runner instance guard
   (`managed-runner-instance.ts`). Used by the drive tools on every runner and by the runner itself (reply links,
   `file_upload` of a drive path).
2. **A mount credential**, used only by the mount daemon and refused by every route outside `/runner/drive/*`. Table
   `drive_mount_credential`: `id`, `owner_id`, `runner_id`, `generation`, `token_hash` (sha256 of 32 random bytes),
   `created_at`, `revoked_at`. The manager issues one per managed-runner generation, with the generation's runner
   credential, and revokes it when the generation is retired. Every request carries the token, the generation and the
   instance UID (the Pod UID on Kubernetes, the container's instance UID on Docker), checked with the same rules as the
   runner guard: a generation below the mapping's answers `403 MANAGED_RUNNER_INSTANCE_SUPERSEDED`, a fenced or deleted
   mapping `403 …_FENCED`, another instance UID `403 …_NOT_AUTHORIZED`, and a Pod the manager has not recorded yet
   `503 MANAGED_RUNNER_INSTANCE_PENDING` (`managed-runner-instance.ts:121`), which the plugin retries (§6.1).

The mount credential never enters the user's container or namespace (§6), and the runner credential never enters the
mounter.

### 4.4 Tenant isolation

- Every drive table carries `owner_id`, and references are composite keys on `(id, owner_id)` (§1.1).
- Every route goes into `src/apiserver/src/auth/tenant-isolation-cases.ts`, owner routes and door routes alike, with a
  second account's entry, version, group, staging, commit and chunk as the spare. **Each task that adds a route adds its
  cases** (§11).
- **Content addressing is not authorisation.** `GET …/chunks/:sha256` answers only a sha256 this owner's versions or
  stagings name. A commit names only chunks this owner holds (§3.1). There is no "do you already have this chunk" probe:
  a client always sends a chunk unless the owner already names it, so no account can learn whether another account
  stores a given content. Cross-account dedup still happens, silently, in `store()`.
- A `commitId` is looked up only within its owner, so guessing another account's commit id answers nothing.
- The mount for a runner holds one account's mount credential; a node plugin serving many runners keeps each runner's
  daemon a separate process with its own credential (§6.1), so no process holds two accounts' access.

### 4.5 Pointing at drive files (D21)

- A reply may link a drive file by any of its spellings: `/home/orbit/Files/...`, `~/Files/...` or
  `/run/orbit-drive/drive/...` (what a tool that resolves symlinks prints). The runner's reply rewriting
  (`codex_artifacts.go`, `session.go:865` reply roots) resolves the path through the door and rewrites it to
  `orbit-drive:<entryId>`, which clients render as that drive file (it follows renames and moves; an entry in Trash
  renders as "In Trash"). Released clients that do not know `orbit-drive:` show the link text, which is the path.
- The composer's drive picker inserts the file's absolute path, `/home/orbit/Files/...`, into the message.
- Known limit: an editor that saves by renaming the old file away and writing a new one (vim's default, §5.9 row 20)
  makes a new entry, so an `orbit-drive:` link made before the save follows the old entry into Trash.

### 4.6 Drive tools on other runners (D20)

MCP `drive_put`, `drive_get`, `drive_list`, `drive_move`, `drive_delete`, and CLI `orbit drive put|get|ls|mv|rm`, on
every runner, using the runner credential. `put` reads only from the session's checkout or uploads folder (the
`file_upload` path rule, `file_tools.go:577`), chunks and streams with no size limit and no scan, overwrites with a
version, and keys its commit by a `commitId` it keeps across its own retries. `get` writes into the uploads folder. On
Orbit Cloud `file_upload` may also read from the drive (D20): `/home/orbit/Files` and `/run/orbit-drive/drive` join its
path rule, and the evidence copy it makes is subject to today's 25 MiB limit and scan.

## 5. The mount daemon

`orbit-documents-mount`, Go on go-fuse (BSD-3), one process per runner, speaking the runner drive door with that runner's
mount credential. It lives in `src/documents-mount/` with the CSI plugin (§6.1), built into one image.

### 5.1 Process shape

- The privileged parent (the CSI plugin, or the optional Docker mounter's entrypoint) opens `/dev/fuse`, mounts
  `fuse.orbit-documents` at `<runner dir>/drive` with `nosuid,nodev,noexec,default_permissions,allow_other` (so uid 10001
  may use a mount made by root), and starts the daemon with the FUSE descriptor inherited, as uid 65532 with no
  capabilities, `no_new_privs` and a seccomp filter, serving the descriptor through go-fuse's `/dev/fd/N` mountpoint
  (the libfuse3 convention for a mount made by a privileged helper; proven in the first commit of
  [Cloud mount daemon](orbit-task:350KSO6FxenOl9slrBQ7i)). The daemon parses what agents write, so it holds no
  privilege.
- Every file shows uid/gid 10001, files `0644`, folders `0755`.
- Kernel options: no writeback cache (writes arrive in order and every `close` maps to one `FLUSH`), `max_write` 1 MiB,
  `READDIRPLUS` on, POSIX and `flock` locks negotiated (so they can be refused, §5.6), entry/attr TTL 60 s and
  negative-entry TTL 10 s, both invalidated by the change feed (§5.4).

### 5.2 Writes and commits

The review's first risk: a `close()` that returns before the manifest commits is silent data loss. So:

- `open(O_CREAT)` of a missing name creates the entry on the server first (§3.1); if that fails, `open` fails. Every
  handle opened for writing is bound to its entry id and gets a `handleId`.
- A handle collects bytes in the spool (§5.3) and uploads each chunk as soon as it is full and the writer has moved past
  it, into the handle's staging (opened with the first upload).
- **`FLUSH` (each `close()` of a descriptor) and `FSYNC` upload what is left and commit, and only then return.** An
  error is the return value of `close()`/`fsync()`. A long file's `close` waits for its last chunk and the commit only,
  because earlier chunks went while it was written.
- **Each commit attempt sequence has one `commitId`**: retries after a timeout reuse it, so a commit that applied but
  whose answer was lost is not applied again (§3.1).
- **Periodic commits**: a dirty handle commits (`CONTINUE`, or `APPEND` for an append handle) after 30 s without a
  write, and at least every 5 minutes while writing continues. A long-open log, or a handle a stray process never
  closes, is therefore on the server within 30 s of its last write, and a daemon that dies loses at most the bytes of
  the last 30 s / 5 minutes. A handle with nothing uncommitted is clean and does not hold sleep (§8.1).
- **What the kernel guarantees, and what it does not.** The kernel sends `FLUSH` on every `close()`, including the
  implicit closes at process exit. But a writer killed while its `FLUSH` is in flight gets no answer, and the commit may
  or may not complete; and many callers ignore `close()`'s result (shells do for redirections: `echo x > f` reports a
  failed `write`, not a failed `close`). So the daemon makes failures visible **at `write()`** wherever it can (offline,
  §5.7; spool, §5.3; fenced, §8.2), and treats a `RELEASE` that arrives with uncommitted bytes (the last reference went
  without a successful flush) by committing them, since there is no one left to tell and keeping the bytes is better
  than dropping them. A partial file committed this way replaces the previous version, which is in Trash.

Write modes of a handle:

| Opened as | Writes accepted |
|---|---|
| New file (`O_CREAT` on a missing name), or `O_TRUNC` | Anywhere: sequential writers, writers that seek back to patch a header (`zip`), and writes past the end (the gap reads as zeros; an all-zero chunk is one shared blob). `ftruncate` to any size. Commit `CONTINUE` (new file) or `OVERWRITE`. |
| `O_APPEND` | At the end. Commit `APPEND`. |
| Existing file without `O_TRUNC`/`O_APPEND` | Only at exactly the current end (treated as an append). `ftruncate` to 0 is an overwrite to empty; to the current size, nothing. Any other write or `ftruncate` answers `EOPNOTSUPP` (§5.6). Opening such a handle and only reading from it is fine; many tools do. |

### 5.3 Spool and chunk cache

- **Spool**: on the node's disk (`/var/lib/orbit-drive-spool/<runner>`), never the runner's data volume. It holds each
  handle's **dirty** chunks (written, not uploaded) and, as cache, clean ones. Limits: 4 GiB per runner, 32 GiB per
  node by default.
- **Under pressure, evict and re-fetch.** When the spool is full, clean chunks (uploaded to the handle's staging) are
  evicted first. A later write or read into an evicted chunk re-fetches it from the staging
  (`GET …/stagings/:id/chunks/:idx`), patches it and marks it dirty. A handle may hold at most 64 dirty chunks
  (512 MiB); past that it uploads its oldest dirty chunk before taking more bytes. Uploading always makes room, so
  parallel large writers never deadlock while the server is reachable: five parallel `cp`s of 900 MiB files each hold a
  few dirty chunks at a time and finish. There is no window behind which writes are refused.
- When the server is unreachable nothing can be uploaded; a write that would need a new dirty chunk past the limits
  fails `EIO` at once (§5.7).
- **Chunk cache**: content-addressed by sha256, so never stale; LRU, 1 GiB per runner, 16 GiB per node.
- **Kernel page cache**: dropped when a file is opened (no `FOPEN_KEEP_CACHE` in v1), so a reader never sees stale
  pages. Keeping it across opens when `seq` is unchanged is a later tuning.
- A reader on the **same mount** as a writer sees the writer's uncommitted bytes (served from the spool), so
  `tail -f` of a log another session is appending works. A reader on another runner sees only committed bytes.

### 5.4 Metadata cache and the change feed

- Listings come with attributes and are paged (`GET /runner/drive/list`), answering `READDIRPLUS` and pre-filling the
  kernel's entries and attributes. A file of one chunk carries its sha256 in the listing, so `grep -r` over small files
  costs one chunk read per file and no separate `stat` or manifest call.
- The daemon caches listings and `stat`s keyed by entry id and validated by `seq`, and follows
  `GET /runner/drive/changes`. On each change it updates its cache and calls go-fuse's `NotifyEntry` / `NotifyContent`
  so the kernel forgets what changed.
- **The feed never skips a late-committing row.** `seq` is taken when a row is inserted, not when its transaction
  commits, so a reader that only asks for `seq > cursor` could miss a row whose transaction commits after a higher one
  was read. Every drive transaction is bounded at 20 s (§1.4). So each poll re-reads, besides `seq > cursor`, every row
  with `at` within the 60 s before the previous poll began; the daemon drops what it has already applied (it keeps the
  `seq`s it applied in that window). A row inserted at time *t* commits before *t* + 20 s, so a poll that missed it
  began before *t* + 20 s, and the next poll, reading back 60 s before that one began, reaches back past *t*.
- **Every reconnect drops the metadata cache** (after an outage, a daemon restart, a `RESYNC` because the cursor is
  older than the pruned feed, or a `seq` lower than the daemon has seen, which means the database was restored, §10.3).
  The chunk cache is kept: it is content-addressed and cannot be wrong.
- Inode numbers: a per-mount table from entry id to a 64-bit inode, stable for the mount's life, with a generation
  number so a reused inode is never confused with an earlier file.

### 5.5 Throughput and latency

The review's sixth risk: every byte passes through the apiserver.

- **Path.** On production the daemon (on the k3s node) sends a chunk to the apiserver, which sends it to RGW (on the
  same Ceph host). v1 keeps that path: it is the simplest, and it reuses the store's verification. Whether the
  production apiserver can reach the RGW endpoint at all, over which network, with TLS, and at what bandwidth is a
  **prerequisite** checked in the RGW step (§11), not assumed here. If the apiserver reaches RGW only over a slow link,
  every byte crosses it twice (in, and out to RGW), and presigned transfer below becomes required rather than optional.
- **Presigned chunk transfer** (the escape, built only if the 5 GiB walk needs it): the door answers a chunk `PUT` with a
  presigned URL for `files/<sha[0:2]>/<sha>` whose signed headers include `x-amz-content-sha256: <the chunk's sha256>`,
  so RGW itself refuses other bytes. The daemon sends the chunk straight to RGW and then asks the door to record it
  (`HEAD` checks presence and size). Reads get presigned `GET`s for chunks the owner names.
- **Small-file latency budget** (what `tar x` and `cp -r` feel): a new small file costs three requests (create, chunk,
  commit; the chunk and commit go in one request when the file is one chunk). Budget on production: **create-write-close
  of a 4 KiB file ≤ 60 ms p50, ≤ 250 ms p95**; `stat` of an uncached entry ≤ 30 ms p50; `tar x` of 2,000 small files
  ≤ 2 minutes. The 5 GiB walk measures these beside the throughput.

### 5.6 Unsupported operations, with errors an agent can read

| Operation | Answer | What the shell prints |
|---|---|---|
| Hard link (`ln`) | `EPERM` | Operation not permitted |
| Symlink (`ln -s`) | `EPERM` | Operation not permitted |
| `chmod` to the mode already shown (files 0644, folders 0755) | success, nothing stored | |
| `chmod` to any other mode, `chown`/`chgrp` to anything but 10001 | `EPERM` | Operation not permitted |
| `utimens` (`touch -d`, `cp -p`, `tar x`, `rsync -t`) | success; `mtime` stored | |
| File locks (`flock`, `fcntl` locks) | `ENOLCK` | No locks available |
| Shared `mmap` of a handle opened for writing | `ENODEV` (the kernel's answer for `MAP_SHARED` on a `FOPEN_DIRECT_IO` handle; the daemon cannot choose it). Handles opened only for reading are not direct-I/O and map normally | No such device |
| A write inside an existing file, or `ftruncate` of one other than to 0 | `EOPNOTSUPP` | Operation not supported |
| `fallocate` | `EOPNOTSUPP` | Operation not supported |
| Executing a file (`./script.sh`) | `EACCES` (the mount is `noexec`); `bash script.sh` works | Permission denied |
| `mknod`, FIFOs, sockets | `EPERM` | Operation not permitted |
| `setxattr` | `ENOTSUP`; `getxattr` answers `ENODATA`, `listxattr` empty | |
| `rename` with `RENAME_EXCHANGE` | `EINVAL` | Invalid argument |
| A name that is not valid UTF-8 | `EINVAL` | Invalid argument |
| A name over 255 bytes | `ENAMETOOLONG` | File name too long |
| `statfs` (`df`) | used = the account's drive bytes, free = 1 PiB | |

**Locks:** FUSE passes `fcntl` and `flock` locks to the daemon only when the daemon negotiates them at `INIT`; without
that, the kernel grants them locally, so they would exclude sessions on one runner and nothing else, silently. The
daemon negotiates both and refuses them with `ENOLCK`, so a program that relies on locks fails visibly, as rule 2 asks.

An errno alone does not say why, so every refusal also appends a line to **`/run/orbit-drive/errors.log`** (in the plain
parent directory, outside the FUSE mount; root-owned, mode 0644, the last 1,000 lines):

```
2026-11-20T10:00:00Z EOPNOTSUPP write /home/orbit/Files/Proj/app.db at offset 4096: the drive does not change a file in place; write a new file and rename it over the old one
```

and **`/run/orbit-drive/status.json`** says whether the drive is connected, since when not, and how many handles hold
uncommitted bytes. The guidance names both (§7.3).

### 5.7 When the server is unreachable

The product asks for a clear error, not a hang.

- Every door request has a deadline (10 s for metadata, 60 s for a chunk). After three failures in 10 s the daemon is
  **offline**: it probes every 5 s and fails what needs the server at once instead of waiting each time.
- **A slow answer is not no answer.** A refused or reset connection, or a 5xx, is one failure. A request past its
  deadline is offline at once only if the server answered nothing while it waited: a request still waiting halfway to
  its deadline, with nothing answered since it was sent, probes the door meanwhile, so a server that is up but busy
  (a loaded host, a long Postgres transaction) answers the probe and the timeout is one failure, while one that holds
  connections unanswered answers neither and is offline within the deadline. A read (`stat`, a listing) past its
  deadline on a server that answered is sent once more, given three times the deadline, instead of failing the call,
  so one slow answer neither fails the operation nor every operation after it in an agent's long `rm -rf`.
- **Offline is read-only from cache.** Reads of cached chunks, and lookups and listings in the metadata cache (up to
  10 minutes old), work. Everything else fails `EIO` at once: reads of uncached chunks, uncached lookups and listings,
  `open(O_CREAT)` (it must create the entry), `mkdir`, `rename`, `unlink`, and **`write()` itself** on any handle, so
  that a caller that ignores `close()` (a shell redirection) still sees the failure. A `write()` needs only the spool,
  so in the first 30 s of an outage (the close's wait) it waits for the server instead: a stall of a loaded server that
  answers nothing for 20 s makes a long writer's writes slow, not failed (the sleep/wake walk lost a writer that way).
  A write later in the outage fails at once, and `errors.log` says how long the server has been unreachable.
- A handle that had uncommitted bytes when the daemon went offline fails its `close()` with `EIO` after waiting up to 30 s
  for the server. Its bytes are kept as **`/run/orbit-drive/unsent/<time>-<name>`** (readable by the agent, removed only
  by the mounter after 24 h, and **at most 1 GiB per runner**: past that the oldest go first, each removal logged), and
  `errors.log` names the file. When the server is back, the daemon asks `GET …/commits/:commitId` for each unsent file:
  one whose commit did apply (the answer was lost, not the commit) is removed and logged as committed. A failed close is
  otherwise never committed later behind the writer's back.
- **A frozen daemon** (alive, not answering) is the one case that would hang callers (D-4 b3, K-2 b3). The privileged
  parent runs a watchdog: every 10 s it `stat`s a virtual entry the daemon answers from memory (never the server, so an
  outage is not a freeze) with a 5 s deadline; on a miss it writes `1` to `/sys/fs/fuse/connections/<dev>/abort`
  (callers get `ENOTCONN` at once), kills the daemon, lazily unmounts and mounts again. The parent-directory layout lets
  the running agent see the new mount (D-4 b2, K-2 b2).

### 5.8 Session attribution (after v1)

The review's fifth risk: FUSE reports the caller's pid **in the pid namespace of the process that mounted**, and 0 when
the caller is not visible there. v1 attributes every agent write as "an agent on Orbit Cloud" with its runner (rule 6
allows it), and groups deletes by the per-mount window (§3.4). The refinement, built second in the daemon task:

- **Kubernetes:** the CSI plugin runs with `hostPID: true` and mounts, so every request carries the caller's host pid.
  The daemon asks the privileged parent, over a socket, "which session is host pid P?". The parent checks that
  `/proc/P/cgroup` belongs to the runner Pod this mount serves (its Pod UID) and reads `ORBIT_SESSION_ID` from
  `/proc/P/environ`, walking up parents until it finds one (the runner sets it for engines and background jobs:
  `claude_spawn.go:258`, `background_job.go:460`, `antigravity.go:297`). Answers are cached by (pid, start time), which
  also becomes the `rm -rf` burst key. The session id is a hint; the door keeps it only if that session is the owner's
  and runs on this runner. An agent can change its own environment, so attribution says which session the write
  *appears* to come from, which is all rule 6 promises.
- **Docker:** the optional `mrf-<uuid>` mounter keeps its own pid namespace (§12 decision 4), so pids read 0 and there is
  no attribution.
- **Drive chats.** A Drive chat's mount writes are held to its rules (one change group a turn, no overwrite, the
  200-item hold) wherever the session is named: the door answers 409 `DRIVE_CHAT_NO_OVERWRITE` (the daemon: `EEXIST`)
  or `DRIVE_CHAT_HELD` / `DRIVE_CHAT_TURN_FULL` (`EDQUOT`), and errors.log carries the door's words; the daemon never
  waits for the owner's answer. A mount write that names no session is counted as the chat's when the chat is the
  runner's only live session (not ended, with a turn in flight or a background process running); with another session
  live it stays nobody's, which is why a Cloud Drive chat's guidance has it change the drive only through the drive_*
  tools and read ~/Files.

### 5.9 The daemon's finish line: shell operations and expected results

Run as uid 10001 inside a managed runner container on Kubernetes (and on Docker if §6.2 is built), with
`F=/home/orbit/Files`. **`$F` is a symlink**: commands that do not follow a symlink given as their argument (`ls -l`,
`find`, `du`) must be given `$F/`; the rows do, and the guidance says so (§7.3). Each row is a test in
[Cloud mount daemon](orbit-task:350KSO6FxenOl9slrBQ7i) unless it names another task; starred rows are repeated end to end
by the walks. "Trash" means the owner's Trash as the owner routes list it.

**Everyday writes**

| # | Command | Expected |
|---|---|---|
| 1 | `echo hi > $F/a.txt; cat $F/a.txt` | Prints `hi`, exit 0; the Files page shows `a.txt`, 3 bytes, written by an agent on this runner. |
| 2* | `echo bye > $F/a.txt` | Exit 0; content `bye`; the version `hi` is in Trash as a version of `a.txt`. |
| 3* | `echo more >> $F/a.txt` (×3) | Content `bye` + three `more` lines; **no** new version in Trash. |
| 4 | Two processes appending 1,000 lines each to `$F/log` at once | 2,000 lines, none lost or torn (each `write` ≤ 4 KiB); no version in Trash. |
| 5* | Runner A and runner B of the same account each append 1,000 lines to `$F/shared.log` at once | 2,000 lines, none lost (the `409 DRIVE_TAIL_MOVED` retry, §3.2); no version in Trash. |
| 6* | `cp ~/big.bin $F/` (5 GiB) then `sha256sum` both | Same hash; `close` returns after the commit; the node's spool never holds more than its limits; the runner's volume never holds a copy. |
| 7* | Five parallel `cp` of 900 MiB files into `$F/` with the spool limit set to 1 GiB | All five finish with correct hashes; no writer waits forever (§5.3). |
| 8 | `cp $F/a.txt $F/b.txt`; `cp -r ~/dir $F/` (1,000 files, 100 folders) | Exit 0; trees identical (`diff -r`); `cp -r` within the latency budget (§5.5). |
| 9 | `cp -p ~/x $F/` (mode 0644) | Exit 0; `mtime` preserved. |
| 10 | `cp -p ~/script.sh $F/` and `cp -a ~/dir $F/` with an executable in `dir` | Content copied; `cp` prints `preserving permissions … Operation not permitted`, exit 1; `errors.log` has the line. |
| 11 | `install -m755 ~/tool $F/tool` | Content copied; `install` reports `Operation not permitted` changing the mode, exit 1. |
| 12 | `echo x \| tee $F/t.txt`; `curl -o $F/page.html <url>`; `wget -c <url>` interrupted and resumed into `$F/` | Exit 0 each; `wget -c` resumes by appending (no new version); final hash matches the source. |
| 13 | `truncate -s 1G $F/sparse`; `python3 -c` creating `$F/holes`, writing 1 byte at offset 100 MiB and closing; then `dd if=/dev/urandom of=$F/sparse bs=1M count=1 seek=512 conv=notrunc` | `truncate` creates a 1 GiB file of zeros (one shared all-zero chunk), exit 0; `holes` is 100 MiB + 1 byte, zeros then the byte; the `dd` into the closed `sparse` fails `Operation not supported` (§5.6). |

**Moves, renames, editors**

| # | Command | Expected |
|---|---|---|
| 14* | `mv $F/a.txt $F/sub/c.txt` | Exit 0; same entry id, new path; no Trash item. |
| 15* | `mv $F/new.txt $F/b.txt` (onto an existing file) | Exit 0; `b.txt` keeps its entry id and has `new.txt`'s content; its old version is in Trash; `new.txt` is gone, not in Trash. |
| 16* | Rename of an open file: `exec 3> $F/a.tmp; echo x >&3; mv $F/a.tmp $F/a.out; echo y >&3; exec 3>&-` | Exit 0; `a.out` holds `x\ny`; no `a.tmp` anywhere. |
| 17* | Unlink of an open file: `exec 3> $F/gone; echo x >&3; rm $F/gone; echo y >&3; exec 3>&-` | Exit 0; no live `gone`; Trash holds `gone` with `x\ny`. |
| 18 | `mv ~/file $F/` and `mv $F/file ~/` | Exit 0 (the kernel answers `EXDEV`, `mv` copies and removes); the moved-out file is in Trash. |
| 19 | `mv $F/dir $F/full/` where `full/dir` is a non-empty folder; `mv $F/p $F/p/q` | `Directory not empty`, exit 1; `Invalid argument`, exit 1. |
| 20* | Editor saves: (a) `vim $F/a.txt`, change, `:wq` with vim's defaults; (b) `python3` writing `a.tmp` then `os.replace('a.tmp','a.txt')`; (c) `sed -i s/x/y/ $F/a.txt` | All exit 0 with the new content. (b) and (c) keep `a.txt`'s entry id and put the previous content in Trash as a version. (a) vim's default save renames `a.txt` to `a.txt~`, writes a new `a.txt` and removes the backup, after probing the folder with a file named `4913` and keeping `.a.txt.swp` while editing: `a.txt` is a **new entry**, and Trash holds one group with `a.txt~` (the previous content), `4913` and `.a.txt.swp`. With `:set backupcopy=yes` vim writes in place as a truncate, which versions like (c). The test records exactly what each produces. |
| 21 | `: > $F/a.txt` and `truncate -s 0 $F/a.txt` | Exit 0; empty file; previous version in Trash. |

**Archives and sync**

| # | Command | Expected |
|---|---|---|
| 22* | `tar -C $F/ -xzf ~/src.tgz` with 2,000 files, none executable | Exit 0; every file's content and `mtime` match. |
| 23 | The same with some executable files | Every file's content matches; `tar` reports `Cannot change mode … Operation not permitted` for the executables and exits 2 (§12 decision 5); the guidance says to expect this. |
| 24 | `tar -C $F/ -czf ~/out.tgz .` and `tar -tzf ~/out.tgz` | Exit 0; lists every file. |
| 25* | `rsync -rt ~/dir/ $F/dir/`, then again | Exit 0 both; the second run transfers nothing. |
| 26 | `rsync -a ~/dir/ $F/dir/` with only 0644 files and 0755 folders; then with one 0755 file | First: exit 0. Second: content copied; exit 23, naming the file and `Operation not permitted`. |
| 27* | `cd $F/ && zip -r out.zip dir && unzip -t out.zip`; `unzip -d $F/x ~/in.zip` | Exit 0 each; archive tests OK; extracted tree matches. |
| 28 | `zip` of a folder whose largest member is 3 GiB | Exit 0 (writes anywhere in a new file are allowed, §5.2). |

**Deletes, Trash and folders**

| # | Command | Expected |
|---|---|---|
| 29* | `rm $F/a.txt`; `rm -rf $F/dir` (500 entries) | Exit 0; Trash shows `a.txt` and **one** group "dir, 500 items" under its folder; restoring it brings back the tree. |
| 30 | `rm -rf $F/huge` (100,000 files in 1,000 folders) | Exit 0 within 15 minutes; one group in Trash; restoring it brings back 100,000 files. |
| 31 | Restore `a.txt` after a new `a.txt` was written | The restored file is `a (2).txt`. |
| 32* | Concurrent: the owner moves `$F/p` into `$F/q` while a session on runner A moves `$F/q` into `$F/p`; and the owner trashes `$F/r` while a session creates `$F/r/s/new.txt` | One move succeeds and the other fails (`Invalid argument` or `409`); no folder is inside itself. Either `new.txt` is created before the trash and is in Trash with `r`, or its `open` fails `No such file or directory`; never a live `new.txt` under a trashed `r`. |
| 33 | `mkdir -p $F/p/q/r`; `rmdir $F/p/q/r`; `rmdir $F/p` | Exit 0, exit 0; then `Directory not empty`. |
| 34 | A folder of 100,000 files: `ls $F/big/ \| wc -l`; `ls -l $F/big/f99999` | 100,000 in under 30 s cold (paged listing); the single `ls -l` in under 1 s. |
| 35 | `ls -la $F/` (with the slash) | Owner `orbit orbit`, files `-rw-r--r--`, folders `drwxr-xr-x`, no Trash folder. `ls -la $F` (no slash) shows the symlink, as on any Linux system. |
| 36 | `find $F/ \| wc -l` and `grep -r needle $F/` over 10,000 entries in 2,000 folders | Cold under 15 s and 60 s; warm `find` under 2 s. |
| 37 | `du -sh $F/`; `df -h $F/` | `du` adds up the files' sizes; `df` shows the drive's use and a large free figure. |

**Refusals**

| # | Command | Expected |
|---|---|---|
| 38 | `ln $F/a $F/b`; `ln -s a $F/l`; `mkfifo $F/p` | `Operation not permitted` each, exit 1. |
| 39 | `chmod +x $F/a.txt`; `chmod 644 $F/a.txt` | First: `Operation not permitted`; second: exit 0. |
| 40 | `flock $F/a.txt true`; `sqlite3 $F/x.db 'create table t(a)'` | `flock`: `No locks available`, exit 1; `sqlite3`: fails (locking or in-place write refused), exit ≠ 0, and `errors.log` says why. |
| 41 | `git init $F/repo && git -C $F/repo commit --allow-empty -m x` | Passes if it ends within 30 s and any failure prints a readable error (no hang, no `Input/output error`). Expected from git's code: it treats a refused `chmod` probe as `core.fileMode=false` and falls back from hard links to renames, so both likely succeed; the test records which. The guidance says not to keep repositories in the drive either way. |
| 42 | `dd if=/dev/zero of=$F/a.txt bs=1 count=1 seek=2 conv=notrunc` | `Operation not supported`, exit 1; `a.txt` unchanged. |
| 43 | Python `mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_WRITE)` on a file opened `r+b` | `OSError: [Errno 19] No such device`. A read-only `mmap` of a file opened `rb` works. |
| 44 | `printf '#!/bin/sh\necho ok' > $F/s.sh; $F/s.sh; bash $F/s.sh` | First: `Permission denied`; second prints `ok`. |
| 45 | `touch -d 2020-01-01 $F/a.txt; stat -c %y $F/a.txt` | Shows 2020-01-01. |
| 46 | A name of 256 bytes; a name with invalid UTF-8 | `File name too long`; `Invalid argument`. |

**Sharing state, outages, failures**

| # | Command | Expected |
|---|---|---|
| 47* | Write on runner A, read on runner B; the owner renames on the web | B sees the new content within the change-feed delay (measured, reported); A sees the rename without a remount. |
| 48 | Server unreachable: `cat` a cached file; `cat` an uncached file; `ls` a cached folder; `echo x > $F/n`; `echo x >> $F/a.txt` | Cached reads and `ls` work; uncached `cat` fails `Input/output error` within 10 s; `echo x > $F/n` fails at `open` (`Input/output error`); the append fails at `write` (`write error: Input/output error`); `status.json` says offline. |
| 49 | A writer with uncommitted bytes when the server goes away, then the server returns | Its `close` fails `Input/output error` within 30 s; `unsent/` holds its bytes; after the return, reads and writes work without a remount, and the unsent file stays (24 h) unless its commit had applied, in which case it is removed and `errors.log` says so. |
| 50 | A commit whose answer is lost (the door applies it, the connection drops before the answer) and is retried | Applied once: one version, not two; an append's lines appear once. |
| 51 | `unsent/` past 1 GiB | The oldest files are removed first, each removal in `errors.log`. |
| 52 | A process holds `$F/long.log` open, writes one line, then sleeps for 10 minutes | The line is on the server within 30 s (periodic commit); runner B reads it; the runner may sleep while the handle stays open (it holds nothing uncommitted). |
| 53* | Daemon `SIGKILL`ed | Calls fail `Transport endpoint is not connected` at once, never hang; the drive is back within 15 s without restarting the runner. |
| 54* | Daemon `SIGSTOP`ed | Calls block at most until the watchdog aborts (≤ 20 s), then `Transport endpoint is not connected`; recovered as in 53. |
| 55* | The CSI plugin Pod is deleted (and, separately, OOM-killed) on a node with two running runners | Each runner's drive is back within 30 s without restarting either runner; writers that were mid-write get `Transport endpoint is not connected` or `Input/output error`, and their uncommitted bytes are in `unsent/` (§6.1). Wiring task. |
| 56* | For each engine (Claude, Codex app-server, Codex exec, Cursor, OpenCode, Antigravity) and a background job: start a session, kill the daemon, let it remount, then have the engine write `$F/after-remount.txt` | The write succeeds in every engine's sandbox: none keeps a stale reference to the old mount (§7.2). Engine grants task. |
| 57* | `umount`, `fusermount3 -u`, `mount -o remount,ro` from the agent | Refused (`must be superuser` / `Operation not permitted`), as D-5/K-3 measured. |
| 58* | A superseded generation's daemon writes | `write` fails `Input/output error`; `errors.log` says the runner instance was replaced; nothing committed (§8.2). |
| 59* | A Plan-mode session asks its engine to write `$F/x` | The engine refuses (§7); the drive is unchanged. |
| 60 | A reply containing `/run/orbit-drive/drive/Proj/r.md`, `~/Files/Proj/r.md` and `/home/orbit/Files/Proj/r.md` | All three render as the same drive file. Door task. |
| 61 | `rm ~/Files` (the symlink) and the runner restarts | The entrypoint makes the link again. |

## 6. Wiring

### 6.1 Kubernetes (required; production)

What the report recommended and the owner chose at G0, made concrete.

**The plugin.** `orbit-drive-csi`, a node-only CSI plugin (Identity + Node services, no controller), driver name
`drive.orbit.dev`, in its own namespace `orbit-drive-system` (Pod Security `privileged`):

- `CSIDriver drive.orbit.dev`: `attachRequired: false`, `podInfoOnMount: true` (the kubelet passes the Pod's name,
  namespace and UID to `NodePublishVolume`), `volumeLifecycleModes: [Ephemeral]`, `fsGroupPolicy: None`.
- DaemonSet, `updateStrategy: OnDelete` (an upgrade is rolled by an operator, §6.1 "Restart and upgrade"): the plugin
  container `privileged: true`, `hostPID: true` (§5.8), with `/var/lib/kubelet` and `/var/lib/orbit-drive` both
  `mountPropagation: Bidirectional`, `/var/lib/orbit-drive-spool` and `/var/lib/orbit-drive-state` (node disk), and
  `/sys/fs/fuse` for the watchdog; beside it the stock `node-driver-registrar` and `livenessprobe` sidecars. Its
  ServiceAccount may `get` Secrets in `orbit-drive-system` and nothing else.
- `NodePublishVolume`:
  1. refuse unless the Pod's namespace (from the kubelet's pod info) is the configured managed-runner namespace and
     `volumeAttributes` is exactly `{ runnerId }`;
  2. read Secret `mrf-<runnerId>` (token and generation);
  3. create `/var/lib/orbit-drive/<runnerId>/` (root, 0755) and `drive/` (root, 0555) if missing, never while mounted;
  4. start that runner's daemon (§5.1) presenting token, generation and the Pod UID. The door decides whether that Pod may
     use the drive (§4.3). A `503 PENDING` (the manager has not yet recorded the Pod's UID) makes `NodePublishVolume`
     answer gRPC `UNAVAILABLE`, which the kubelet retries with backoff; a `403` answers `PERMISSION_DENIED`;
  5. once the mount answers, bind-mount the **plain** directory `/var/lib/orbit-drive/<runnerId>` (never `drive/`) onto
     the kubelet's target, and write `/var/lib/orbit-drive-state/<runnerId>.json` (Pod UID, generation, target path).
- `NodeUnpublishVolume`: unmount the target; stop the daemon after its open commits finish (at most 60 s), then
  `umount -l` the drive and remove the state file. A runner's processes are dead by then, so every handle has flushed.

**Restart and upgrade (review A8).** The daemons run in the plugin container's cgroup, so they die with it, and the
kubelet does not call `NodePublishVolume` again for a Pod already running. So on start the plugin **remounts from its
state files**: for each `/var/lib/orbit-drive-state/*.json` whose target is still mounted, it re-reads the Secret,
moves the dead daemon's dirty spool chunks of each handle into that runner's `unsent/` (§5.7; the writers were told by
`ENOTCONN`/`EIO`), lazily unmounts the dead `drive/`, starts a new daemon and mounts again. The parent-directory layout
makes the new mount appear in the running runner (D-4 b2, K-2 b2), and the engines see it through the parent (§7.2).
A drive is down for the plugin's restart time (seconds); row 55 measures it. Upgrades use `OnDelete`, rolled per node
by the operator when its runners are asleep or in a stated maintenance window, so an upgrade is never a surprise outage.

**The runner Pod** gets one volume and one mount, nothing else:

```yaml
volumes:
  - name: orbit-documents
    csi:
      driver: drive.orbit.dev
      volumeAttributes:
        runnerId: __RUNNER_UUID__
containers:
  - name: runner
    volumeMounts:
      - name: orbit-documents
        mountPath: /run/orbit-drive
        mountPropagation: HostToContainer
```

The entrypoint (`orbit run`, as uid 10001) makes `/home/orbit/Files` a symlink to `/run/orbit-drive/drive`; if
`/home/orbit/Files` already exists and is not that link, it is renamed `Files.local-<date>` first and the rename logged.
Pod Security `restricted` admits `csi:` inline volumes; the walk
[mount and Files page on Kubernetes](orbit-task:350KSOBcVlQNbArIDwG2Q) measures it, closing the report's gap.

**Who may name the driver (review B13).** Orbit's webhook today answers `NOT_MANAGED` (allowed) for any Pod outside
the managed namespace (`managed-runner-admission.ts:176`–`180`), so it cannot be the only guard. Three layers:

1. A cluster-wide **ValidatingAdmissionPolicy** (CEL; k3s v1.36 has it) `orbit-drive-driver`: deny any Pod with a
   volume whose `csi.driver` is `drive.orbit.dev` unless its namespace is the managed-runner namespace.
2. Orbit's webhook, inside the managed namespace: `templateProblem` (`:138`, volume check `:146`–`:152`) allows exactly
   one volume of kind `csi` with `driver === 'drive.orbit.dev'` and `volumeAttributes` exactly
   `{ runnerId: mapping.runnerId }`, mounted only in the `runner` container, only at `/run/orbit-drive`, only with
   `HostToContainer`, not read-only. A Pod there without a mapping is already denied. Everything else is unchanged:
   still no privileged container, still only the pinned image, still the volumes it allows today.
3. The plugin's namespace check (above) and the door's Pod-UID check (§4.3).

**Orbit's other changes:**

- `managed-runner-resources.ts` and `runner-pod.yaml.example`: the volume and mount above.
- The manager: issue the generation's mount credential with its runner credential and write Secret `mrf-<runner uuid>`
  in `orbit-drive-system` before it creates the Pod; delete it when the generation is retired or the mapping deleted.
  One new Role for the manager: `create`, `update`, `delete` on Secrets in `orbit-drive-system`.
- `deploy/managed-runner/drive-csi/`: CSIDriver, DaemonSet, namespace, RBAC, the admission policy, README; image build
  next to the runner image's, with the same local-import caveat as the deployment record.

**Ceph RGW** is not deployed on `.3` (`docs/managed-runner-k3s-xfs-deployment.md` lists Ceph without RGW). Provisioning
it, its pool quota (§10.2), its bucket, its credentials for the apiserver, the apiserver's route to it (§5.5) and the
off-host mirror (§10.2) is **its own owner-approved step**, before the Kubernetes walk and before production uses the
drive (§11).

### 6.2 Docker (optional)

Production runs on Kubernetes. This section is built only if a Docker-backed deployment is to have the drive; the
feasibility report showed it can (D-4). If built:

- `channel.py` gains the optional `filesRoot` (D-7's diff, tested 74/74): `container_spec()` adds to the runner one
  bind `{"Type": "bind", "Source": "<filesRoot>/<runner uuid>", "Target": "/run/orbit-drive", "ReadOnly": false,
  "BindOptions": {"Propagation": "rslave"}}`, and `unsafe()`/`unsafe_container()` let that one bind through and nothing
  else.
- A second template `files_mounter_spec()` creates **`mrf-<runner uuid>`** from the configured mounter image (the CSI
  plugin's image): user 0, `CapDrop: [ALL]`, `CapAdd: [SYS_ADMIN]`, `Devices: [/dev/fuse rwm]`,
  `SecurityOpt: [no-new-privileges:true, apparmor=orbit-drive-mounter]`, read-only root, its own bootstrap volume
  `mrf-boot-<uuid>-g<gen>` holding the mount credential, a spool volume `mrf-spool-<uuid>`, one `rshared` bind of
  `<filesRoot>/<runner uuid>` at `/run/orbit-drive`, network `orbit-documents` (egress to the apiserver only), its own pid
  namespace. `unsafe_mounter()` refuses any other image or field.
- The channel creates the host directory before any bind (D-3), starts `mrf` before the runner and stops it after (D-3
  c), and runs the watchdog (§5.7) from the host.
- The AppArmor profile `orbit-drive-mounter` (D-1): docker-default plus `mount fstype=fuse.orbit-documents ->
  /run/orbit-drive/drive/,` and `umount /run/orbit-drive/drive/,`, installed on every channel host by `host.sh`.
- It needs its own walk (§11).

### 6.3 Exactly what changes in container hardening (gate G3)

| | Before | After |
|---|---|---|
| Runner container, Kubernetes | `runAsUser 10001`, `runAsNonRoot`, `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem`, `capabilities.drop [ALL]`, Pod `seccompProfile RuntimeDefault`, no host namespaces, no service-account token; volumes: data PVC, `/tmp` emptyDir, bootstrap Secret | **Security context unchanged.** One more volume: `csi` `drive.orbit.dev` with `runnerId`, mounted at `/run/orbit-drive`, `HostToContainer`. |
| New, Kubernetes | — | DaemonSet `orbit-drive-csi` in `orbit-drive-system`: `privileged: true`, `hostPID: true`, `Bidirectional` on `/var/lib/kubelet` and `/var/lib/orbit-drive`. Its per-runner daemons drop to uid 65532 with no capabilities. Not in any user's Pod or namespace. |
| Admission, Kubernetes | `templateProblem` allows the data PVC, emptyDirs, the bootstrap Secret | Plus exactly the one `csi` volume above; plus the cluster-wide policy denying the driver outside the managed namespace. |
| Runner container, Docker (optional) | `CapDrop ALL`, no `CapAdd`, not privileged, no devices, `no-new-privileges`, read-only root; mounts: data volume, bootstrap volume, `/tmp` | **Security options unchanged.** One more mount: bind of `<filesRoot>/<runner uuid>` at `/run/orbit-drive`, writable, `rslave`. |
| New, Docker (optional) | — | One `mrf-<runner uuid>` per runner: `SYS_ADMIN`, `/dev/fuse`, AppArmor `orbit-drive-mounter`, `no-new-privileges`, read-only root, one `rshared` bind. |

What the agent can do with it is what the report measured (D-5, K-3 d): use the drive as files; not unmount, remount,
reach `/dev/fuse`, see or signal the mounter, or `unshare`.

### 6.4 `docs/session-checkout-storage-design.md` §3, reopened

§3's first bullet today (lines 84–86):

> **Managed container hardening is fixed.** … So no mounts, no FUSE, no loop devices and no kernel modules inside the
> container. Nothing in this design may relax that.

This design relaxes it, on purpose, for one thing. The replacement text, from the report, to be committed by
[Kubernetes (and Docker if feasible) wiring](orbit-task:350KSO6qGQSFPHc4Pe0aB) once the owner approves G3:

> **Managed container hardening is fixed.** The channel (`deploy/managed-runner/docker-channel/channel.py`) refuses
> privileged mode, added capabilities, devices, host binds and user-namespace modes for the runner container, and the
> Pod template drops every capability. So the runner container cannot mount anything, use FUSE or loop devices, or
> load kernel modules. **One exception, decided for Documents (docs/drive-product-design.md,
> docs/drive-technical-design.md §6):** the runner container may *receive* exactly one mount made outside
> it, `/run/orbit-drive` (a plain per-runner directory with slave propagation; the drive's FUSE mount sits below it),
> from an Orbit-owned mounter: on Kubernetes the `drive.orbit.dev` CSI node driver; on Docker the per-runner
> `mrf-<uuid>` container, the only container the channel creates with `SYS_ADMIN`, `/dev/fuse` and the
> `orbit-drive-mounter` AppArmor profile. Nothing else in this design may relax the runner container's hardening.

The product's "Feasibility first" risk in `docs/drive-product-design.md` (around line 146), which quotes §3, then
points at the new wording.

## 7. Engine sandbox grants (D16)

### 7.1 When

The runner grants the drive only when `/run/orbit-drive/drive` is a mount of type `fuse.orbit-documents` (checked in
`/proc/self/mountinfo` at each spawn). Self-registered runners never have it and nothing changes for them.

### 7.2 What is granted, and why the parent

A sandbox that binds a path into its own mount namespace (Cursor's bwrap, `cursor_sandbox.go:53` resolves the root with
`EvalSymlinks` to `/run/orbit-drive/drive`) captures **the mount that is there at spawn**. After a daemon or plugin
restart remounts `drive/` (§5.7, §6.1), such a sandbox would keep the dead mount and answer `ENOTCONN` for the rest of
the session. A bind of the **parent** `/run/orbit-drive`, a plain directory, receives later mounts below it, exactly as
the runner container does (the report's parent-directory finding). So every sandbox that binds paths is given
`/run/orbit-drive`, and every grant that matches paths names `/home/orbit/Files` and `/run/orbit-drive/drive` as well.
Row 56 tests a remount inside each engine.

The drive is a workspace root, like the uploads folder: writable in every write mode, readable in Plan mode, never a
reason for an "outside the workspace" card.

| Engine | Where | Change |
|---|---|---|
| Claude | `claude_spawn.go:151` | `--add-dir` for `/home/orbit/Files` and `/run/orbit-drive/drive` beside the uploads folder, in every mode. Plan mode (`--permission-mode plan`) does not refuse a write by itself: it asks its permission prompt about every Write, Edit and Bash call, so the runner refuses a drive write there (see below). |
| Codex app-server | `codex_auto_policy.go:22` (`codexAutoApprovalContextFor`), `:31` (`codexRuntimeWorkspaceRoots`), `:48` (`codexSandboxPolicy`) | `/run/orbit-drive` and both drive spellings join `workspaceRoots` (not `tempRoots`) and the Auto sandbox's `writableRoots`. Plan keeps its refusal of every write (`codex_appserver.go:1132`); the read-only subagent's `readOnly` sandbox still reads them. |
| Codex exec | `codex.go:490` | `--add-dir` for `/run/orbit-drive` beside the uploads folder. |
| Cursor | `cursor_sandbox.go` (`detectCursorSandbox` roots) | `/run/orbit-drive` (the parent, never the resolved `drive/`) joins the bwrap writable roots outside Plan; Plan's ACP mode refuses edits (`cursor_permissions.go:87`). |
| OpenCode | `opencode.go` permission map | The drive paths are allowed for external-directory access and edits outside Plan; Plan already denies `edit`, `write`, `patch` (`opencode.go:1083`). |
| Antigravity | `antigravity_approval.go:597` | The approval policy gains a `Drive` root (`/run/orbit-drive` and both spellings) beside `Uploads`, writable outside Plan. |
| Background jobs | `background_socket.go:463` | `extraDirs` gains the drive. |
| `file_upload`, reply files | `file_tools.go:577`, `session.go:865` | The drive joins the path rules (D20, D21). |

How Plan keeps the drive read-only. No engine's Plan mode can be relied on to refuse every write by itself: Claude
Code's Plan asks its permission prompt about each Write, Edit and Bash call, and an Allow on that card wrote the drive
(walk [permission modes and container hardening](orbit-task:350KSODTF8PzMHyZ3bSxP), round 3); Kimi's plan mode asks
about every shell call the same way. So wherever the runner answers an engine's permission request, a Plan-mode call
that would write under `/home/orbit/Files`, `/run/orbit-drive` or `/run/orbit-drive/drive`, by any spelling (`~`,
`$HOME`, a relative path or a link), is refused on the spot with "The Files drive is read-only in Plan mode", and no
card is filed (`plan_drive.go`, `planDriveWrite`). The calls are Write, Edit, MultiEdit and NotebookEdit naming a path
there, and a shell command that names a path there and is not a read-only command (a known reader such as `ls`, `cat`,
`grep` or `find` without `-delete`/`-exec`, with no redirection into the drive and no command substitution). Reads are
not refused, and every other path keeps the Plan behaviour it had.

| Engine | Plan enforcement for the drive |
|---|---|
| Claude | `mcp.go` `permissionPrompt` refuses a drive write when the session's live mode is Plan, before any card; the PreToolUse hook (`hook_bg_guard.go`) refuses the same Bash command, so an allow rule that skips the prompt does not run it. |
| Kimi | `kimiAutomaticPermissionOption` rejects a Plan-mode drive write ahead of the allow rules and the card. |
| Cursor | Plan already rejects every request unasked; the drive check also comes ahead of a standing allow rule (`cursor_permissions.go`). |
| Codex app-server | Plan answers every approval request itself with a refusal (`codexAutomaticApproval`), so none reaches a card. |
| OpenCode | Plan denies `edit`, `write` and `patch`, and its `bash: ask` is rejected by non-interactive OpenCode; the runner mediates no approval. |
| Antigravity | Plan runs `agy --mode plan` with no Orbit approval hook and no allow rule but Orbit's tools, so agy refuses the write itself. |
| DeepSeek Harness | Has no Plan mode: a Plan session is refused before it starts. |

The tests are `src/runner-go/plan_drive_test.go` (row 59*).

Claude Default mode: a Default-mode edit in the drive asks exactly as the same edit in the checkout does, and nothing
asks about leaving the workspace (§12 decision 2, as recommended). The walk
[permission modes and container hardening](orbit-task:350KSODTF8PzMHyZ3bSxP) reads its criterion that way.

### 7.3 Guidance

`agent_instructions.go` gains the product's paragraph (when the drive is mounted), plus, briefly:

- `~/Files` is a symlink: give `ls -l`, `find` and `du` the path with a trailing slash (`~/Files/`).
- Copy into it with `cp -r` or `rsync -rt`: `cp -a`, `cp -p`, `rsync -a` and `tar x` report errors (and exit non-zero)
  for executable files, because the drive keeps no modes; the contents are still copied.
- What is not supported (§5.6), and that `errors.log`, `status.json` and `unsent/` are in `/run/orbit-drive/`.
- Verification, judgment and guest-driven runs read and do not write (D9). A turn is guest-driven when its message
  carries the `ORBIT_GUEST` sender marker (`external_sender.go:46`), which the agent already sees, answering the
  product's question whether an agent can tell.

On other runners the guidance describes the drive tools instead.

## 8. Sleep and fencing

### 8.1 Holding sleep while drive writes are unflushed

A drive write is unflushed while a handle holds bytes no commit has taken. With periodic commits (§5.2) that lasts at
most 30 s after the last write, or for the length of a write still in progress.

- **One signal, on the control plane.** The daemon keeps a `MOUNT` staging per dirty handle and calls its keepalive
  every 30 s with `dirty`. A staging of the runner's **current generation** with `dirty = true` touched in the last
  2 minutes is a new reason in `managedRunnerWork` (`managed-runner-work.ts`): `DRIVE_WRITE`. The manager drains a
  runner only when its records and its report both say idle, and the route confirming a sleep acceptance requires the
  records to show nothing (`managed-runner-sleep.ts`), so a runner with an unflushed drive write is neither drained nor
  confirmed. A dead daemon stops touching its staging, which stops holding after 2 minutes: nothing it held can be
  flushed any more, and its bytes are in `unsent/` once the plugin restarts it (§6.1).
- **`managed_sleep.go` does not change.** Revision 1 also added a `driveWrites` count to the runner's own workload
  report, read from `status.json`. It is dropped as redundant: the manager does not begin a drain while the records
  show `DRIVE_WRITE`, so the runner's idle clock never causes a drain the records would refuse.

Order on sleep and wake: Kubernetes publishes the CSI volume before the runner container starts and unpublishes after
it stops. A runner's processes end before unpublish, so their closes have committed.

### 8.2 Fencing superseded instances

- The mount credential is issued for one generation and checked with the instance UID on every request (§4.3). A commit
  re-checks the mapping's generation under `FOR SHARE` in its own transaction, so a commit racing a generation change
  either lands before it or is refused.
- On `SUPERSEDED` or `FENCED` the daemon stops accepting work: every `write` and `close` fails `EIO` with the reason in
  `errors.log`, it aborts its FUSE connection (`ENOTCONN` from then on) and exits. Its stagings are never committed and
  expire.
- The manager revokes the old generation's mount credential when it advances the generation, after the stop proof it
  already requires (`managed-runner-fencing.ts`). A node lost without that proof is fenced by the operator's receipt as
  today; its daemon's credential is refused from the moment the generation advances.
- Drive tools on a superseded instance are refused by the existing runner guard.

## 9. Share links: the `DRIVE_FILE` root kind (D18)

- `share-link.ts:10`: `ShareRootKind` gains `'DRIVE_FILE'`, `SHARE_ROOT_KINDS` lists it, `LAYER_DEFAULTS.DRIVE_FILE = {}`.
- `share_link` gains `drive_entry_id` and **`drive_version_id`**, composite FKs `(…, owner_id)` → `drive_entry` and
  `drive_version`, both `ON DELETE CASCADE`; `share_link_one_root_chk` (0403) is replaced by the same check over all five
  roots.
- **A link is pinned to the version shared** (§12 decision 1, recommended by the review): it serves that version's
  bytes, whatever is written to the file later. An agent overwriting a shared file therefore cannot publish anything:
  only the owner shares, which is D18's reason for keeping links away from agents. The Files page shows a shared file
  whose current version is newer than the shared one as "Shared: an earlier version", with **Share this version**, which
  re-runs the scan and moves the link to the current version (the owner's act). A pinned version is kept: it is either
  current or in Trash, and while a link pins a version, Delete for good of that version (or of its group, or Empty Trash)
  asks "This ends a share link" before ending the link with it.
- Only the owner creates or moves a link, from the Files page: `POST /share-links` with
  `{ kind: 'DRIVE_FILE', driveEntryId }` (pinned to the current version) under the owner's login. The runner door has
  no share route, and the share-link routes refuse a runner credential.
- **The scan.** Before creating or moving, the page calls `POST /drive/entries/:id/share-check`: the existing secret scan
  (`file-secret-scan.ts`, the high-confidence `ISSUED_CREDENTIALS` shapes) over the version's text, chunk by chunk with
  an overlap carried between chunks so a key spanning two is found, **bounded to the first 25 MiB** (the evidence scan's
  bound) and to 20 s; binary files are not scanned, as today. A match is answered as a warning naming the shape and line,
  never the secret; a file larger than the bound is answered "the first 25 MiB was checked". The owner can still share.
- The public door: `GET /shared/:token` answers the file's name, size, type and preview; `GET /shared/:token/content`
  streams the pinned version with `Range`. An entry in Trash answers as a link that has ended; restored, the link works
  again; deleted for good, the link goes with it.
- Released clients: `GET /share-links` without `kind` lists only `SESSION`, `TASK` and `PROJECT`, as it already does for
  `WIKI` (`share-links.controller.ts:104`), so a client that does not know `DRIVE_FILE` never receives one. Clients that
  do ask for it by name, and skip any kind they do not know.

## 10. Backup and restore

### 10.1 What is where

| Data | Where | Backed up by |
|---|---|---|
| Names, versions, chunk lists, Trash, stagings, commits, change feed, mount credentials | Postgres | The existing WAL archive and base backups (`scripts/pg-backup.sh`), off host. |
| Chunk bytes, local store | `./data/files` | The existing `<target>-files` copy, write-once names, pruned by `file_blob.off_host_prune_at`. |
| Chunk bytes, S3 store (Orbit Cloud on RGW) | The bucket | **New**: an off-host mirror of the bucket's `files/` prefix (§10.2). |
| Spool, caches, `unsent/` | Node disk | Not backed up: the cache is derived, and spooled bytes are either committed or reported to the writer as failed. |

### 10.2 Ceph durability, pool quota, and "kept permanently"

The review's seventh risk. The production Ceph is two HDD OSDs on one host, `size 2 / min_size 1`
(`docs/managed-runner-k3s-xfs-deployment.md:38`, `:184`): it survives one disk, not the host, and with `min_size 1`
writes are accepted while only one copy exists. And the RGW pool shares those OSDs with every runner's RBD volume.
Before the drive opens to accounts on production:

1. **A pool quota with an alert.** The RGW data pool gets `ceph osd pool set-quota … max_bytes` (a share of the cluster
   the owner sets, so a drive that grows without limit, D12, cannot fill the OSDs the runners' volumes live on), and an
   alert at 80 % of it to the operator. At the quota RGW refuses writes; the door answers `507 DRIVE_STORAGE_FULL` and
   the daemon fails the `write` with `ENOSPC` ("No space left on device") and a line in `errors.log`.
2. **An off-host mirror of the bucket**: a periodic one-way copy of new objects under `files/` to the backup target
   (`rclone copy` or equivalent, never `sync`), cheap because names are sha256 and never rewritten. The retention sweep
   then sets `off_host_prune_at` for `s3` blobs too when the deployment declares the mirror (`ORBIT_DRIVE_S3_MIRROR=1`),
   and the backup sidecar prunes the mirror by that column, as it prunes the local copy today. The sweep's comment
   "only the local store's bytes are in the off-host copy" (`file-retention-sweep.ts:234`) changes with it. The backup
   target's capacity must be sized for the drive, which has no limit.
3. The RGW data pool at the same replication as the RBD pool, with `min_size 1` named in the runbook as an accepted risk,
   and the mirror's lag (one interval) named as the most a host loss can lose.

All three are part of the RGW provisioning step (§11), for the owner to approve.

### 10.3 Restore order

1. Stop the apiserver (and so every door); mounters go offline (§5.7).
2. **Restore Postgres** to the chosen point.
3. **Restore bytes** only if the store itself was lost: the files directory from `<target>-files`, or the bucket from its
   mirror.
4. Start the apiserver. Run `files verify`, the existing missing-bytes check extended to drive chunks and to the S3
   store: it lists every drive entry whose chunks are missing, which with the grace period below should be none.
5. Run **`files orphans`**: it lists objects in the store (local directory or bucket) that no `file_blob` row names,
   which restoring the database to an earlier point leaves behind (the sweep cannot see them, §2.4). It deletes an orphan
   only when the object is older than the grace period, because a later restore to a newer point could still name it,
   and reports its count and bytes. The weekly scrub runs deep `files verify` and reports orphans. It writes both
   reports to the apiserver log without deleting any bytes.
6. Mounters reconnect, see a `seq` lower than they had seen, and drop their metadata caches (§5.4). Writes that
   committed after the restore point are lost with the database, as any write after the point is.

Why the order works: Postgres names bytes, never the reverse. Bytes are deleted only one grace period after nothing
names them, and the grace period is at least as long as the oldest retained Postgres backup reaches back
(`fileGraceMs`, `file-retention.ts`). So any retained backup restored finds every chunk its drive rows name, including
the rows of Trash the owner emptied after that backup: those items reappear in Trash, with their bytes.

## 11. Tasks of this project against the sections

| Task | Sections | Scope as this design sets it |
|---|---|---|
| [technical design](orbit-task:350KSO2SDXIBqq7841EEI) (this) | all | This document. |
| [chunked streamed store for large files](orbit-task:350KSO3QhWxHH7y5Ot3hb) | §2.1–§2.4, §1.1 (`drive_version_chunk`, `drive_staging*`) | **Shrunk** (owner, 2026-11-19): chunk manifest and staging tables, the streaming chunk door (store a ≤ 8 MiB chunk through `store()` with its staging row), the ranged `open`, the sweep's new holders and step 0, and their tenant-isolation cases. |
| [name layer, versions, Trash and owner routes](orbit-task:350KSO476FnLnlYnfDTS6) | §1, §3, §4.1 (except uploads and usage), §4.4, §5.4 feed semantics, §9 Trash interplay | Tables, create and commit with `commitId`/`CONTINUE`, overwrite/append/rename rules, §1.4 locking, Trash groups and restore with suffixes, last-writer fields, owner routes and their tenant-isolation cases, the change feed with its look-back, and the `drive.changed` realtime event. |
| [resumable upload and ranged download](orbit-task:350KSO4nNiSOUmCcUQHcr) | §4.1 uploads and download | Upload sessions, chunk `PUT`, resume, folder drops with one suffix, `Range` downloads, their tenant-isolation cases. |
| [runner drive door and drive tools](orbit-task:350KSO5NhJYQ0axTV6vXE) | §4.2, §4.3, §4.5 runner side, §4.6, §8.2 door checks | `/runner/drive/*` (including staging read-back, commit status, keepalive), the mount credential and its checks, burst grouping, drive MCP tools and CLI, `file_upload` from the drive, `orbit-drive:` rewriting of all three path spellings (row 60), its tenant-isolation cases. |
| [Cloud mount daemon](orbit-task:350KSO6FxenOl9slrBQ7i) | §5 | **On go-fuse** (owner, 2026-11-19). Entry-bound handles, commit-on-close and periodic commits, evict-and-refetch spool, caches, change feed with look-back, errors and `errors.log`, offline behaviour and `unsent/`, the attribution helper as a second step. Its finish line is §5.9 except rows 55, 56 and 60. |
| [Kubernetes (and Docker if feasible) wiring for the mount](orbit-task:350KSO6qGQSFPHc4Pe0aB) | §6, §5.7 watchdog, §6.4 | CSI plugin and manifests, **the watchdog (it runs in the privileged parent)**, **restart re-adoption and the `OnDelete` upgrade procedure (row 55)**, the admission policy, webhook and resources changes, manager Secret and Role, the §3 edit after G3. Docker `filesRoot` and `mrf` only if a Docker deployment needs the drive. |
| [engine grants and sleep hold](orbit-task:350KSO86tzR9l8gDbyFvX) | §7, §8.1 | Grants per engine (the parent `/run/orbit-drive` for binding sandboxes), the remount test in each engine (row 56), guidance, the `DRIVE_WRITE` work reason. **Depends on the door task** (staging keepalive). |
| [one-file share links](orbit-task:350KSO8zEpJwfrWaAcG7T) | §9 | Root kind, columns, pinning and "Share this version", bounded share-check, public door, tenant-isolation cases. |
| [web Files page and menu entry](orbit-task:350KSO9ZWyHnFi2Y3MnzI) | §3.5, §4.1 (client) | Page, Trash and versions inside Files (board a–c), upload suffix (d), undo, following `drive.changed`. |
| [Storage moves into Files (web)](orbit-task:350KSOA9nCBF7zqcWMh8Y) | §2.5 | **`driveUsage` and `GET /drive/usage`** (moved here from the upload task), Storage inside Files, attachment quota unchanged. |
| [reply links and composer drive picker (web)](orbit-task:350KSOAw2HEPizXCn9HR4) | §4.5 | `orbit-drive:` rendering, picker inserting the path. |
| [walk: mount and Files page on Kubernetes](orbit-task:350KSOBcVlQNbArIDwG2Q) | §5.9 (1–3, 14–17, 29, 35, 47, 53–55, 57), §6.1 | Includes the Pod Security `restricted` measurement the report could not make. **Blocked by the RGW step** below. |
| [walk: Trash and versions through the mount](orbit-task:350KSOCCj3ncLTo9pdrsx) | §3, §5.9 (2–3, 15–17, 20–21, 29–32) | |
| [walk: 5 GiB files on local and S3 stores](orbit-task:350KSOCmssIelClhQC6ah) | §2, §5.3, §5.5, §5.9 (6–7) | Measures throughput **and the small-file latency budget**; decides whether presigned transfer is needed. |
| [walk: permission modes and container hardening](orbit-task:350KSODTF8PzMHyZ3bSxP) | §6.3, §7, §5.9 (56–57, 59) | Criterion read as §7.2 says. |
| [walk: sleep, wake and superseded runner](orbit-task:350KSODxS9AKn76E4hiAX) | §8, §5.9 (52, 58) | |
| [trial JuiceFS](orbit-task:350SVIMb3x4jPTuokO6B2) | — | Cancelled (option C chosen). |

**Work no task holds yet**, for the coordinator to file once the design is approved:

1. **Provision Ceph RGW on production** (§6.1, §10.2): the pool with its quota and 80 % alert, the bucket and its
   credentials, the apiserver's route to RGW with a measured bandwidth (§5.5), and the bucket's off-host mirror with the
   backup target sized for it. Owner-approved. **Blocks the Kubernetes walk** and production use.
2. **Backup sidecar for S3** (§10.2): `off_host_prune_at` for `s3` blobs when `ORBIT_DRIVE_S3_MIRROR=1`, and the sidecar
   pruning the bucket mirror by it.
3. **`files orphans` and `files verify` for drive chunks and S3** (§10.3), with the weekly report-only scrub.
4. **Native clients**: Files on iOS, macOS and Android (the product: "web first"), and, before that, the released clients
   rendering `orbit-drive:` links as plain text and skipping `DRIVE_FILE` links (verify, and fix any that fail).
5. **A Docker walk**, only if Docker wiring is built (§6.2).

Items the review listed as unowned that this revision **places in existing tasks** instead: plugin restart and upgrade
(wiring task), the `/run/orbit-drive/drive` reply spelling (door task), the `drive.changed` event (name-layer task).

## 12. Decisions for the owner

1. **Share links are pinned to the version shared** (changed from revision 1 on the review's finding B11). Recommended:
   an agent overwriting a shared file cannot publish its new content; the owner moves a link to a newer version with
   **Share this version**, which scans again. Alternative: links follow the file, which lets any agent write publish
   through a link the owner made once.
2. **Claude Default mode.** Recommended: the drive is a workspace root, so a Default-mode edit there asks exactly as it
   would in the checkout, and nothing asks about leaving the workspace (§7.2). Alternative: allow drive edits without a
   card in every write mode, which would make the drive looser than the checkout.
3. **Production store.** Recommended, provided the pool quota and the mirror of §10.2 are in place:
   `ORBIT_DRIVE_BACKEND=s3` on RGW for all new bytes (drive and attachments alike), one store and one mirror; older local
   bytes stay readable where they are. Alternative: a separate target for drive chunks only, at the cost of a second
   store configuration.
4. **Attribution on Docker.** Recommended: none, keeping the optional `mrf` without host pid access. Alternative:
   `PidMode: host` on `mrf`, adding host pid visibility to a container that already has `SYS_ADMIN`.
5. **Mode changes.** Recommended as §5.6: `chmod` to the mode already shown succeeds as a no-op and any other mode is
   refused, so `cp -r`, `rsync -rt` and `tar x` of non-executable files work while rule 2 holds; the guidance says that
   `-a`, `-p` and `tar x` exit non-zero on executables (rows 10, 23, 26). Alternative: keep an executable bit (a product
   change).
6. **Presigned chunk transfer.** Recommended: not in v1; the 5 GiB walk measures throughput and small-file latency, and
   the RGW step measures the apiserver's route; build it only if either shows the apiserver hop is the limit (§5.5).

## 13. Not in this design, and what v1 leaves out

Not in this design: cleanup, version limits and quotas; folder share links; sync to the owner's computer; a mount on
self-registered runners; collaborative editing; previews beyond pictures and Markdown (the product's "Not in this
round").

Left out of v1 on the review's advice (its "overbuilt" list), each with what replaces it:

| Item | v1 |
|---|---|
| The 1 GiB spool window | **Dropped**: evict-and-refetch (§5.3) supports writes anywhere in a new file. |
| Server-side tail merge | **Dropped**: the daemon sends the whole new tail chunk (§3.2). |
| Burst keys from pid and start time | **Dropped from v1**: a per-mount 2 s window (§3.4); pid keys come with attribution. |
| `status.json` as a second sleep signal | **Dropped**: `managed_sleep.go` unchanged; `status.json` stays only as something the agent can read (§5.6, §8.1). |
| `FOPEN_KEEP_CACHE` and prefetch tuning | **Dropped from v1**: page cache dropped on open, no prefetch (§5.3). |
| Docker `mrf` wiring | **Optional**, built only for a Docker deployment that needs the drive (§6.2). |
| `/proc` session attribution | **Second step** of the daemon task (§5.8); v1 says "an agent on Orbit Cloud". |
| `relativePath` folder drops | **Kept**: D3 asks for uploading folders by dragging, and without it a folder drop would need one request per folder from the browser plus its own conflict rules; `relativePath` is the smaller way to meet D3. |

## 14. Response to the review of revision 1

| Item | Answer | Where |
|---|---|---|
| A1 feed skips late commits | Look-back re-read of 60 s with every drive transaction bounded at 20 s; cache dropped on every reconnect. | §1.4, §5.4 |
| A2 commit idempotency | `commitId` per commit sequence, `drive_commit` table, commit-status route; explicit `CONTINUE` mode with `handle_id`. | §1.1, §3.1, §3.2, §4.2, §5.2 |
| A3 handles bound to paths | Entry created at `O_CREAT`; handles bound to entry id; commit to a trashed entry stays in Trash; rename-over of an open source handled. | §3.1, §3.2, rows 16–17 |
| A4 folder races and cycles | Per-owner advisory lock for folder trash/move/restore; `FOR SHARE` + recheck on the parent; two-statement trash; ancestor check on move. | §1.4, row 32 |
| A5 spool deadlock | 1 GiB window dropped; evict clean chunks and re-fetch from staging; dirty-chunk cap per handle that always drains. | §5.3, rows 7, 28 |
| A6 store I/O in a transaction, tail churn | Daemon builds the tail; server only checks and swaps; 64 KiB threshold. | §3.2, §2.4 |
| A7 cache key on append | `seq` is the cache key and in the `ETag`; it moves on every commit. | §1.1, §4.1, §5.3, §5.4 |
| A8 plugin restart | Remount from state files on start, dirty spool salvaged to `unsent/`; `OnDelete` upgrades. | §6.1, row 55 |
| A9 idle dirty handles | Periodic commits after 30 s idle and every 5 minutes. | §5.2, §8.1, row 52 |
| A10 close/FLUSH claims | Restated; failures surfaced at `write()`; `RELEASE` commits leftover bytes. | §5.2, §5.7, row 48 |
| B11 share links | Pinned to the version shared, now the recommendation; scan bounded to 25 MiB and 20 s. | §9, §12.1 |
| B12 quota | `storedTotals` and `assertWithinQuota` unchanged; separate `driveUsage`. | §2.5 |
| B13 driver on other Pods | Cluster-wide admission policy, webhook rule, plugin namespace check, door Pod-UID check; `UNAVAILABLE` retry on `503 PENDING`. | §6.1, §4.3 |
| B14 bwrap and remounts | Sandboxes bind the parent `/run/orbit-drive`; remount test per engine. | §7.2, row 56 |
| B15 unbounded growth | `unsent/` capped at 1 GiB per runner; RGW pool quota with an 80 % alert and `ENOSPC`. | §5.7, §10.2, row 51 |
| C16 orphans after restore | `files orphans`, with grace and a weekly scrub. | §10.3, §2.4, §11 item 3 |
| C17 mmap errno | `ENODEV` for shared mappings of write handles, as the kernel answers. | §5.6, row 43 |
| C18 nginx limit | 30m. | §4.1 |
| C19 lock semantics | Locks negotiated so they can be refused; the local-grant behaviour without negotiation is stated. | §5.1, §5.6, row 40 |
| Test list | `$F/` throughout and the trap in the guidance; rows 34/38 of revision 1 corrected (now 43, 48); tar, vim and git rows re-checked (23, 20, 41); the missing cases added (5, 7, 11–13, 16–17, 30, 32, 34, 44, 50–52, 55–56, 60). | §5.9, §7.3 |
| Risk 3 extras | Paged listings; the single-chunk sha256 inlined in listings. | §4.2, §5.4 |
| Throughput | Small-file latency budget; RGW reachability and double transit made a prerequisite of the RGW step. | §5.5, §11 item 1 |
| Placement | Unowned items listed or placed; usage route to Storage; isolation cases per route task; watchdog to wiring; grants depend on the door task; RGW step blocks the Kubernetes walk. | §11 |
| Overbuilt | Seven dropped, deferred or made optional; folder drops kept, with the reason. | §13 |
