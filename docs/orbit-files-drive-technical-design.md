# Orbit Files drive: technical design

Status: **draft for the owner's review** (gate G2, and G3 for the container-hardening change in §6). Task
[Orbit Files drive: technical design](orbit-task:350KSO2SDXIBqq7841EEI), 2026-11-20, repository at `58e176a1be`.

Inputs:

- `docs/orbit-files-drive-design.md`: the product decisions D1–D23 and rules 1–8. Referred to below as "the product".
- The feasibility report of [can Orbit Cloud runners get a FUSE mount at /home/orbit/Files?](orbit-task:350KDMTso7g0wYwYRpU7y)
  (file `350SDm87q1Sxg2WzOEQXB`), cited as "the report" with its check names (D-1 … D-7, K-1 … K-4).
- `docs/orbit-files-design.md`: today's sha256 store, retention sweep and evidence files.
- The owner's rulings on this task (2026-11-19): G0, a node-level CSI driver on Kubernetes and a per-runner mounter
  container on Docker, parent-directory layout; storage, Ceph RGW (S3) for Orbit Cloud, local disk or any S3 for
  self-hosted; drive layer **option C**, our own name layer in Postgres with chunks as sha256 blobs through the existing
  `FileStore`, a Go mount daemon on go-fuse, and a node-only CSI plugin. No JuiceFS.
- The board `docs/mocks/orbit-files/` and its four choices, settled as drawn: Trash and Storage are reached from inside
  Files; Move to Trash asks nothing and web offers undo; an earlier version restores as the current version or as a
  copy; an owner upload whose name is taken gets a suffix and never overwrites.

Line numbers refer to `58e176a1be`.

## 0. Summary

| Piece | What it is | Where |
|---|---|---|
| Name layer | Postgres tables `drive_entry`, `drive_version`, `drive_version_chunk`, `drive_trash_group`, `drive_staging`, `drive_staging_chunk`, `drive_change`, `drive_mount_credential` | apiserver, new `src/apiserver/src/drive/` |
| Bytes | Fixed-maximum chunks (8 MiB) kept as ordinary `file_blob` rows through the existing `FileStore`; a file is an ordered chunk list | `src/apiserver/src/files/` gains a ranged read; nothing else in the store changes |
| Owner routes | `/drive/*` under the owner's login, resumable chunked upload, ranged download | apiserver |
| Runner drive door | `/runner/drive/*`, taking either the runner credential (drive tools) or a mount credential bound to one runner generation (the mount daemon) | apiserver |
| Mount daemon | `orbit-files-mount`, Go on go-fuse, one process per runner, commit-on-close, chunk cache, spool, change feed | new `src/drive-mount/` |
| Kubernetes | CSI node plugin `files.orbit.dev` (privileged DaemonSet, namespace `orbit-files-system`); the runner Pod gains one `csi:` volume | `deploy/managed-runner/files-csi/`, `managed-runner-resources.ts`, `managed-runner-admission.ts` |
| Docker | Per-runner `mrf-<uuid>` mounter container; the runner container gains one `rslave` bind | `deploy/managed-runner/docker-channel/channel.py` |
| Engines | `/home/orbit/Files` is a workspace root for every engine in every write mode; Plan mode reads only | `src/runner-go/` |
| Sleep, fencing | Open drive writes are a reason not to sleep; a drive credential works only for the generation and instance it was issued for | apiserver `managed-runner-work.ts`, runner `managed_sleep.go` |
| Sharing | New share-link root kind `DRIVE_FILE` | `src/apiserver/src/share-links/` |
| Backup | Postgres first, then bytes; the RGW bucket needs an off-host mirror before "kept permanently" means anything | `scripts/pg-backup.sh`, runbook |

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
| `name` | text | Exact bytes of the name, valid UTF-8, 1–255 bytes, no `/`, no NUL, not `.` or `..`. Not normalised: a name is what the writer wrote. The root's name is `''`. |
| `current_version_id` | uuid null | FILE only: the version a read gets. Deferred FK `(current_version_id, owner_id)` → `drive_version`. |
| `size_bytes` | bigint | FILE: the current version's size. FOLDER: 0. |
| `mtime` | timestamptz(3) | What `stat` shows. Set by every write, and by `utimens` (§5.6), which tools that copy times use. |
| `created_at`, `updated_at` | timestamptz(3) | |
| `last_writer_kind` | text | `OWNER` \| `AGENT`. |
| `last_writer_session_id` | uuid null | The session that wrote it, when Orbit could tell (§5.8). |
| `last_writer_runner_id` | uuid null | The runner the write came through, for an agent write. |
| `last_written_at` | timestamptz(3) | |
| `trashed_at` | timestamptz(3) null | Set while the entry is in Trash. |
| `trash_group_id` | uuid null | The group that holds it, `(trash_group_id, owner_id)` → `drive_trash_group`. |
| `trash_top` | boolean | True for an entry that is a top-level item of its group (its parent is not in the same group). |
| `seq` | bigint | The `drive_change.seq` of its last change, for caches (§5.4). |

Indexes and constraints:

- `UNIQUE (owner_id, parent_id, name) WHERE trashed_at IS NULL`: one live name per folder. Trashed entries keep their
  `parent_id` and `name` (their original place), so a new file may reuse the name at once.
- `UNIQUE (owner_id) WHERE parent_id IS NULL`: one root per account, created lazily by the first drive call.
- `CHECK ((kind = 'FILE') = (current_version_id IS NOT NULL))`, deferred, so a file and its first version are written in
  one transaction.
- `CHECK ((trashed_at IS NULL) = (trash_group_id IS NULL))`.
- `(owner_id, trash_group_id)`, `(owner_id, parent_id)` for listings.

A folder moved to Trash marks **every descendant** with the same `trashed_at` and `trash_group_id` (one recursive
statement, batched above 10,000 rows). Whether an entry is live is then a column, not a walk up its ancestors, which
every read path (door lookups, share links, the mount) needs to answer cheaply.

**`drive_version`**: one content a file has had.

| Column | Type | Meaning |
|---|---|---|
| `id`, `owner_id` | uuid | |
| `entry_id` | uuid | `(entry_id, owner_id)` → `drive_entry`, `ON DELETE CASCADE`. |
| `size_bytes` | bigint | No per-file limit (D12); `bigint` because `file_blob.size_bytes` is an `Int` (`schema.prisma:3466`). |
| `chunk_count` | int | |
| `created_at` | timestamptz(3) | |
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
resumable upload, a large write through the mount, or a drive tool's `put`.

| Column | Meaning |
|---|---|
| `id`, `owner_id` | |
| `source` | `OWNER_UPLOAD` \| `MOUNT` \| `TOOL`. |
| `runner_id`, `generation` | For `MOUNT` and `TOOL`: the runner, and for a managed runner the generation, that opened it. |
| `parent_id`, `name`, `relative_path`, `declared_size` | For `OWNER_UPLOAD`: where it will land (§4.1). |
| `created_at`, `touched_at`, `committed_at` | `touched_at` moves with every chunk and keepalive; an uncommitted staging untouched for 7 days is removed. |
| chunk rows | `(staging_id, idx)`, `sha256` → `file_blob`, `size_bytes`. |

**`drive_change`**: the change feed caches and the web page follow. `seq bigserial` (one global sequence, so no
per-account counter row becomes a hot spot when `tar x` commits thousands of files), `owner_id`, `entry_id`,
`parent_id`, `op` (`UPSERT` \| `REMOVE`), `at`. Index `(owner_id, seq)`. Rows older than one day are pruned; a reader whose
cursor is older than the oldest kept row is told `RESYNC` (§5.4).

**`drive_mount_credential`**: §4.3.

**`share_link.drive_entry_id`**: §9.

### 1.2 How names reference sha256 content

A file's bytes are the concatenation of its current version's chunks in `idx` order. Each chunk is an ordinary
`file_blob` row named by the chunk's sha256, stored once per deployment however many versions, files or attachments
name it. Nothing in the drive names a whole-file sha256; a whole-file hash is computed on demand (for a share-link
scan, or `file_upload` of a drive file, which reads the file and makes its own evidence copy under today's rules,
product rule 5).

### 1.3 Paths

The mount and the drive tools speak paths; the web speaks ids. The door resolves a path one segment at a time over
`(owner_id, parent_id, name)` on live entries. The mount caches the resolution (§5.4), so a path lookup costs one
query per uncached segment.

`<Project>` folders (D22) are made by the guidance, not the server: the runner computes the safe name (no `/`, trimmed to
60 characters, `-<4 chars of the project id>` when two projects share a title) and tells the agent the path.

## 2. Chunked, streamed store

### 2.1 What stays as it is

`FileStore.put(sha256, tempPath, sizeBytes)` (`file-store.ts:28`, `s3-file-store.ts:42`) takes one whole temporary
file, and uploads are capped at 25 MiB (`attachments.media.ts:9`). **Both stay** for attachments, evidence files,
`file_upload` and conversation pictures, with today's rules (retention, the secret scan, the quota).

### 2.2 Chunks

- A drive file is cut into chunks of **at most 8 MiB** (`DRIVE_CHUNK_MAX = 8 MiB`). A chunk is small enough to be one
  temporary file, one `file_blob` (whose `Int` size tops out near 2 GiB) and one signed S3 `PUT` (no multipart), and
  small enough that reading a whole chunk to serve part of it is cheap.
- Sizes are not fixed: a writer that streams cuts at every 8 MiB, an append adds chunks of whatever it appended
  (§3.2), and the owner's browser cuts at 8 MiB. Every chunk row carries its `offset`, so a read finds the chunk for any
  byte by binary search over the version's chunk list.
- Storing a chunk is the existing path: the door writes the request body to the files directory's `tmp/` while hashing
  it (`writeHashedTempFile`, `file-store.ts:171`), refuses it if the hash is not the one the client declared, and calls
  `FilesService.store()` (`files.service.ts:355`), which stamps `last_referenced_at` first, puts the bytes in the
  target store or finds them already there, and upserts the `file_blob` row. Then, in the same request, it inserts the
  `drive_staging_chunk` row that holds the chunk until a commit names it.
- A file of any size therefore never exists whole on the server's disk, the runner's volume or the node: at most one
  chunk per request in `tmp/`, and the mount's bounded spool (§5.3).

### 2.3 Changes to the store

1. **A ranged read**: `open(sha256, range?: { start: number; end: number })`. The local store passes `start`/`end` to
   `createReadStream`; the S3 store sends `Range: bytes=start-end` and accepts `206`. Used by ranged downloads and the
   mount's first read of a large chunk. Small (≈20 lines per store).
2. **Nothing else**. Both backends keep their single-request `put`. Dedup, the stamp-then-grace protocol and the
   per-blob `storage` column work unchanged, so a deployment may move its target store (production moves to RGW, §6.3)
   with older blobs still read from where they are.

The default target is the deployment's `ORBIT_FILES_BACKEND`. Self-hosted keeps local disk or any S3 (D23). Orbit Cloud
sets `ORBIT_FILES_BACKEND=s3` against Ceph RGW (§12, decision 3).

### 2.4 The retention sweep treats drive content as held

Today a blob is held by a live attachment row (`file-retention-sweep.ts`, steps 3 and 4). The drive adds two holders:

| Holder | Held while |
|---|---|
| `attachment` row (today) | `expired_at IS NULL`, or tombstoned less than one grace period ago |
| `drive_version_chunk` row | the row exists: the version is current, or replaced and in Trash. Drive content never expires (D2); it stops holding only when the owner deletes it for good or empties Trash, which deletes the rows |
| `drive_staging_chunk` row | the staging exists: uncommitted for at most 7 days without a touch |

Changes, each in the sweep's own terms:

- **Step 3** (`markReleased`): a blob is released when no attachment is live **and** no `drive_version_chunk` or
  `drive_staging_chunk` row names it; it loses the mark when any of them names it again.
- **Step 4** (`deleteReleased` and `deleteBytes`): the holder count under the `file_blob` row lock adds both drive
  tables. Both have a foreign key to `file_blob`, so inserting a row naming a blob takes `FOR KEY SHARE` on it, which
  the sweep's `FOR UPDATE` excludes: the protocol the sweep documents for attachments (lines 41–46) holds for drive rows
  without change.
- **The gap between storing a chunk and naming it** is covered as for attachments: `store()` stamps
  `last_referenced_at` before anything else, and the staging chunk row is inserted in the same request, so a chunk is
  never without a holder for longer than that request.
- **A new step 0**: remove `drive_staging` rows untouched for 7 days (their chunks are then released and go one grace
  period later), and prune `drive_change` older than a day.
- Purging Trash deletes `drive_entry`/`drive_version` rows in batches of 1,000 (the cascade takes their chunk rows); the
  sweep then releases what no one else holds, and the bytes go one grace period later (`fileGraceMs`, ≥ the Postgres
  backup's reach, §10).

### 2.5 Usage

Storage (D13; [Storage moves into Files](orbit-task:350KSOA9nCBF7zqcWMh8Y)) counts **each distinct sha256 once** across
live attachments, drive versions (current and Trash) and staging, extending `storedTotals` (`files.service.ts:849`). The
drive's share is the distinct chunks drive rows name; "the rest" is attachments whose sha256 no drive row names.

One honest limit: a file of more than 8 MiB that is both in the drive and kept as an attachment (for example passed to
`file_upload` for evidence) is two contents, its chunks and its whole-file blob, and is counted as both. Files of up to
8 MiB are one chunk whose sha256 is the whole file's, and count once.

`ORBIT_FILES_QUOTA_BYTES` keeps limiting attachment uploads as today and does not refuse drive writes (D12: no limit;
quotas are the cleanup design's).

## 3. Writes: overwrite, append, delete, restore

All of this is enforced in the apiserver's write path, whichever door the write came through.

### 3.1 Commit

A write ends with one **commit**: `{ target, mode, chunks: [{ sha256, size }], baseVersionId?, writer }` where `target`
is a path (door) or `parentId` + `name` (owner upload), and `mode` is `CREATE`, `OVERWRITE` or `APPEND`. In one
transaction it:

1. resolves the target and takes `FOR UPDATE` on the entry row (or on the parent's row for a new name);
2. checks that every chunk is this owner's to name: held by a staging of this owner, or already named by a version of
   this owner, and `bytes_deleted_at IS NULL`. A chunk another account stored is never accepted on the strength of its
   sha256 alone (§4.4);
3. writes the version and its chunk rows, the entry's size, `mtime` and last-writer fields, one `drive_change` row;
4. marks the staging committed (its chunk rows are deleted after the commit; the version's rows now hold the chunks).

### 3.2 Overwrite makes a version; append does not (D17)

| Write | What happens |
|---|---|
| New name (`>` on a new file, `cp`, upload, `put`) | `drive_entry` + its first version. |
| Overwrite (`>`, `cp` over, `O_TRUNC`, `truncate`, `put` over an existing path) | A new version becomes current. The previous one gets `replaced_at` and goes to Trash in a new `VERSION` group whose folder is the file's folder. |
| Rename onto an existing file (`mv a b`, an editor's atomic save) | The **target** entry keeps its id and gets a new version whose chunk rows are the source's current chunks; its previous version goes to Trash as above; the source entry is removed outright (its content lives on as the target's version, so nothing is lost and nothing is duplicated in Trash). |
| Append (`>>`, `O_APPEND`, or writing at exactly the end of an existing file) | **No version.** The current version's chunk list grows in place. If the current version's last chunk is under 1 MiB, it is replaced by that chunk plus the appended bytes (cut at 8 MiB); otherwise the appended bytes are new chunks. Each append therefore re-sends at most 1 MiB of old bytes, and a file's chunk count stays below its size in MiB + 1. The merge is done by the server, under the entry's row lock, reading the ≤ 1 MiB tail from the store. |
| Append whose `baseVersionId` is no longer current (another writer overwrote the file meanwhile) | Converted to an overwrite whose content is the base version's chunks plus the appended bytes: the current version goes to Trash. Last write wins (rule 1) and nothing written is lost (rule 3). Two writers appending to the same version both land, in commit order, as `O_APPEND` would. |
| In-place change of an existing file (a write before its end without `O_TRUNC`) | Refused at the mount with `EOPNOTSUPP` (§5.6). Not a version. |

Versions are kept until the owner deletes them for good (D2, D17; limits are the cleanup design's).

### 3.3 Delete to Trash

- `unlink`/`rmdir` through the mount, `delete` from a drive tool, and the owner's Move to Trash all set `trashed_at` and
  `trash_group_id` on the entry and every descendant, and write `drive_change` `REMOVE` rows. Nothing is deleted.
- An entry in Trash cannot be reached by any path, by the mount, by drive tools, or by a share link (which answers as a
  link that has ended, §9). Agents cannot see Trash (D11): the door has no Trash route.
- Move to Trash asks nothing; the web's undo is a restore of the group the response named (board choice b).
- Delete for good (a group, or a version) and Empty Trash delete rows, in batches, after the owner confirms (board
  choice b). §2.4 says what happens to the bytes.

### 3.4 Grouping what one `rm -rf` removed

The mount sees `rm -rf dir` as many unlinks, leaves first, then `rmdir`s bottom-up. The door groups them:

- Each delete carries a **burst key** chosen by the mount: the caller's thread-group id and process start time when the
  mount can see the caller (§5.8), otherwise one key per mount that changes after 2 s without a delete.
- The door adds a delete to the open `DELETE` group of the same burst key if that group was last added to less than 10 s
  ago; otherwise it opens a new group. A group closes 10 s after its last delete.
- Entries keep their `parent_id` in Trash, so the group is a tree. When `dir` itself is removed in the same burst, the
  files and folders removed earlier hang under it, and the group's top-level item becomes `dir`, with `folder_id` its
  parent: Trash shows "dir, 152 items, deleted from /Project at 14:02", restored whole.
- Without a visible caller (the Docker mounter, §5.8), two sessions deleting at the same moment on one runner can land in
  one group. Restore still puts every item back where it was; only the grouping is coarser.

### 3.5 Grouped restore with name suffixes

Restoring a group, in one transaction per 1,000 entries:

1. For each top-level item, the destination is its original `parent_id` if that folder is live. If the folder is in Trash
   or gone, the missing folders of `folder_path` are recreated as new live folders (a name taken by a live file gets the
   suffix below).
2. If the item's name is taken by a live entry in the destination, the restored item gets the first free name of
   `name (2).ext`, `name (3).ext`, … (the extension is kept; a folder or a name without a dot gets the suffix at the end).
3. Descendants come back with their item and keep their names (their folder is new to the live tree, so nothing can
   collide inside it).
4. `trashed_at`, `trash_group_id` and `trash_top` are cleared; `drive_change` rows are written; the group row is deleted.

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
session is recorded only when the door could check it (§5.8): it must be the owner's and must run on the runner the
write came through, or it is dropped to NULL and the page says "an agent on Orbit Cloud" (rule 6).

## 4. Doors and tenant isolation

### 4.1 Owner routes

Under the owner's login (and PAT), in a new `DriveController`. Every route takes the owner from the credential and never
from the request.

| Route | What it does |
|---|---|
| `GET /drive/entries?parentId=&cursor=` | Children of a folder (root when absent), with size, `mtime`, last writer and whether it is shared. |
| `GET /drive/entries/:id` | One entry with its path. |
| `GET /drive/resolve?path=` | Path to entry, for links (§4.5) and the composer's picker. |
| `POST /drive/folders` | `{ parentId, name }`; a taken name gets the suffix. |
| `PATCH /drive/entries/:id` | Rename and/or move: `{ name?, parentId? }`. An owner rename or move onto a taken name answers `409 DRIVE_NAME_TAKEN`; it never overwrites. Moving a folder into itself answers `409 DRIVE_MOVE_INTO_ITSELF`. |
| `DELETE /drive/entries/:id` | Move to Trash; answers the group id (for undo). |
| `GET /drive/entries/:id/content` | Download, streamed chunk by chunk, with `Range` (`206`) and `ETag` = version id. |
| `GET /drive/entries/:id/versions` | Current and replaced versions. |
| `GET /drive/versions/:id/content` | Download a version. |
| `POST /drive/versions/:id/restore` | `{ as: "CURRENT" \| "COPY" }`. |
| `GET /drive/trash`, `GET /drive/trash/groups/:id` | Trash grouped by folder and time; one group's tree. |
| `POST /drive/trash/groups/:id/restore` | §3.5. |
| `DELETE /drive/trash/groups/:id`, `DELETE /drive/versions/:id`, `DELETE /drive/trash` | Delete for good, Empty Trash. |
| `POST /drive/uploads` | Open a resumable upload: `{ parentId, name, size, relativePath? }`. Answers the staging id and `chunkSize` (8 MiB). `relativePath` places a file of a dropped folder: missing folders are made under `parentId`, and when the dropped folder's top name is taken it gets one suffix for the whole drop. |
| `PUT /drive/uploads/:id/chunks/:idx` | One chunk, ≤ 8 MiB, with `X-Orbit-Chunk-Sha256` (the browser hashes with WebCrypto). Idempotent. |
| `GET /drive/uploads/:id` | Which chunks have arrived: what makes an upload resumable after a reload or a lost connection. |
| `POST /drive/uploads/:id/complete` | Commit (§3.1) with the suffix rule. |
| `DELETE /drive/uploads/:id` | Abandon. |
| `GET /drive/changes?since=` | The change feed (§5.4), also pushed to the web over the existing realtime stream as `drive.changed { seq }`. |
| `GET /drive/usage` | Storage (§2.5). |
| `POST /drive/entries/:id/share-check` | The secret scan before sharing (§9). |

A chunk route is a body of at most 8 MiB, inside nginx's `client_max_body_size` of 25 MiB, so no proxy changes.

### 4.2 Runner drive door

Under `/runner/drive/*`, for the mount daemon and the drive tools (D20). The routes speak paths:

| Route | What it does |
|---|---|
| `GET /runner/drive/stat?path=` | One entry's attributes (and the version id, as the cache key). |
| `GET /runner/drive/list?path=` | Children **with attributes**, so `ls -l`, `find` and `READDIRPLUS` cost one call per folder. |
| `GET /runner/drive/chunks/:sha256` | One chunk's bytes, with `Range`; only a chunk this owner's versions or stagings name (§4.4). |
| `GET /runner/drive/manifest?path=` | The current version's chunk list. |
| `POST /runner/drive/files?path=&mode=` | A whole small file in one request: body ≤ 8 MiB, stored as one chunk and committed at once. What `tar x` of many small files costs: one request each. |
| `POST /runner/drive/stagings` | Open a staging for a larger write; answers its id. |
| `PUT /runner/drive/stagings/:id/chunks/:idx` | One chunk, as §4.1. |
| `POST /runner/drive/stagings/:id/keepalive` | Moves `touched_at`; what the sleep hold reads (§8.1). |
| `POST /runner/drive/stagings/:id/commit` | §3.1. |
| `POST /runner/drive/mkdir`, `POST /runner/drive/rename`, `POST /runner/drive/delete`, `POST /runner/drive/utimens` | As named; `rename` takes `noReplace`; `delete` takes the burst key. |
| `GET /runner/drive/changes?since=` | Long poll, at most 25 s, woken through the realtime bus the API servers already share. |

Every write route takes `writer: { sessionId?, burstKey? }` (§5.8).

### 4.3 Credentials on the door

The door accepts two credentials, and each resolves to exactly one owner:

1. **The runner credential**, as every `/runner/*` route takes it today, with the managed-runner instance guard
   (`managed-runner-instance.ts`). Used by the drive tools on every runner and by the runner itself (reply links,
   `file_upload` of a drive path).
2. **A mount credential**, used only by the mount daemon and refused by every route outside `/runner/drive/*`. Table
   `drive_mount_credential`: `id`, `owner_id`, `runner_id`, `generation`, `token_hash` (sha256 of 32 random bytes),
   `created_at`, `revoked_at`. The manager issues one per managed-runner generation, when it issues the generation's
   runner credential, and revokes it when the generation is retired. Every request carries the token, the generation and
   the instance UID (the Pod UID on Kubernetes, the container's instance UID on Docker), checked with the same rules as
   the runner guard: a generation below the mapping's answers `403 MANAGED_RUNNER_INSTANCE_SUPERSEDED`, a fenced or
   deleted mapping `403 MANAGED_RUNNER_INSTANCE_FENCED`, another instance UID `403 …_NOT_AUTHORIZED` (§8.2).

The mount credential never enters the user's container or namespace (§6), and the runner credential never enters the
mounter.

### 4.4 Tenant isolation

- Every drive table carries `owner_id`, and references are composite keys on `(id, owner_id)` (§1.1).
- Every route above goes into `src/apiserver/src/auth/tenant-isolation-cases.ts`, owner routes and door routes alike,
  with a second account's entry, version, group, staging and chunk as the spare.
- **Content addressing is not authorisation.** `GET …/chunks/:sha256` answers only a sha256 this owner's versions or
  stagings name. A commit names only chunks this owner holds (§3.1). And there is no "do you already have this chunk"
  probe: a client always sends a chunk unless the owner already names it, so no account can learn from the server
  whether some other account stores a given content. Cross-account dedup still happens, silently, in `store()`.
- The mount for a runner holds one account's mount credential; a node plugin serving many runners keeps each runner's
  daemon a separate process with its own credential (§6.1), so no process holds two accounts' access.

### 4.5 Pointing at drive files (D21)

- A reply may link a drive file by its path (`/home/orbit/Files/...` or `~/Files/...`). The runner's reply rewriting
  (`codex_artifacts.go`, `session.go:865` reply roots) resolves the path through the door and rewrites it to
  `orbit-drive:<entryId>`, which clients render as that drive file (it follows renames and moves; an entry in Trash
  renders as "In Trash").
- The composer's drive picker inserts the file's absolute path, `/home/orbit/Files/...`, into the message.
- Both belong to [reply links and composer drive picker (web)](orbit-task:350KSOAw2HEPizXCn9HR4) on the client side and to
  [runner drive door and drive tools](orbit-task:350KSO5NhJYQ0axTV6vXE) on the runner side.

### 4.6 Drive tools on other runners (D20)

MCP `drive_put`, `drive_get`, `drive_list`, `drive_move`, `drive_delete`, and CLI `orbit drive put|get|ls|mv|rm`, on
every runner, using the runner credential. `put` reads only from the session's checkout or uploads folder (the
`file_upload` path rule, `file_tools.go:577`), chunks and streams with no size limit and no scan, and overwrites with a
version. `get` writes into the uploads folder. On Orbit Cloud `file_upload` may also read from `/home/orbit/Files` (D20):
that root joins its path rule, and the evidence copy it makes is subject to today's 25 MiB limit and scan.

## 5. The mount daemon

`orbit-files-mount`, Go on go-fuse (BSD-3), one process per runner, speaking the runner drive door with that runner's
mount credential. It lives in `src/drive-mount/` with the CSI plugin (§6.1), built into one image used on both backends.

### 5.1 Process shape

- The privileged parent (the CSI plugin, or the Docker mounter's entrypoint) opens `/dev/fuse`, mounts
  `fuse.orbit-files` at `<runner dir>/drive` with `nosuid,nodev,noexec,default_permissions` and `allow_other` (so uid
  10001 may use a mount made by root), and starts the daemon with the FUSE descriptor inherited, as uid 65532 with no
  capabilities, `no_new_privs` and a seccomp filter, serving the descriptor through go-fuse's `/dev/fd/N` mountpoint
  (the libfuse3 convention for a mount made by a privileged helper; to be proven in the first commit of
  [Cloud mount daemon](orbit-task:350KSO6FxenOl9slrBQ7i)). The daemon parses what agents write, so it holds no
  privilege (the report's "Still required in the driver").
- Every file shows uid/gid 10001, files `0644`, folders `0755`, so `ls -l` looks ordinary.
- Kernel options: no writeback cache (writes arrive in order and `close` maps to `FLUSH` exactly), `max_write` 1 MiB,
  `READDIRPLUS` on, entry/attr TTL 60 s and negative-entry TTL 10 s, both invalidated by the change feed (§5.4).

### 5.2 Writes and commit-on-close

The independent review's first risk: a `close()` that returns before the manifest commits is silent data loss. So:

- A file handle opened for writing collects bytes in the spool (§5.3) and uploads each chunk as soon as it is full and
  the writer has moved past it.
- **`FLUSH` (every `close()` of the descriptor) and `FSYNC` upload what is left and commit, and only then return.**
  An error there (server refused, unreachable past the deadline, §5.7) is the return value of `close()`/`fsync()`:
  `EIO`, so `cp`, `tar`, editors and `dd conv=fsync` see a failed write. A long file's `close` waits for at most its last
  chunk and the commit, because the earlier chunks went while it was written.
- A handle flushed more than once (a `dup`ed descriptor closed twice) commits again as a continuation of the same
  version: one open-write-close is one version.
- A file at most 8 MiB long when it is first flushed goes in one `POST /runner/drive/files`, with no staging. A
  larger one opens a staging when its first chunk is full.
- A process killed mid-write still closes its descriptors, so the kernel still sends `FLUSH`: the partial file is
  committed, and the version it replaced is in Trash, as a partial write on any disk would be, but recoverable.
- `RELEASE` without a preceding successful `FLUSH` (only after an error) drops the handle's spool; nothing is committed
  behind the writer's back.

Write modes of a handle:

| Opened as | Writes accepted |
|---|---|
| New file (`O_CREAT` on a missing name), or `O_TRUNC` | Anywhere within the spool window (below): sequential writers, and writers that seek back to patch a header (`zip`, some archivers). Commit mode `CREATE`/`OVERWRITE`. |
| `O_APPEND` | At the end. Commit mode `APPEND`. |
| Existing file without `O_TRUNC`/`O_APPEND` (`O_WRONLY` or `O_RDWR`) | Only at exactly the current end (treated as an append). A write anywhere else answers `EOPNOTSUPP` (§5.6). Opening such a handle and only reading from it is fine; many tools do. |

The **spool window** answers the second review risk (writers that seek within a new file): a new file's bytes stay in
the spool until commit while the file is at most 1 GiB; beyond that, chunks more than 1 GiB behind the furthest byte
written are uploaded and dropped, and a later write into one of them answers `EOPNOTSUPP`. `zip` seeks back by at most
one member's size, so a zip whose largest member is under 1 GiB writes through.

### 5.3 Spool and chunk cache

- **Spool**: per runner, on the node's (Kubernetes) or the mounter volume's (Docker) disk, never the runner's data
  volume, at most 4 GiB per runner and 32 GiB per node by default. When it is full, writers wait for uploads to drain
  it; if the server is unreachable (§5.7) they get `ENOSPC` once the spool stays full for 30 s.
- **Chunk cache**: content-addressed by sha256, so it is never stale: an entry is valid forever and only evicted (LRU,
  1 GiB per runner, 16 GiB per node). Sequential reads prefetch the next two chunks.
- **Kernel page cache**: kept across opens (`FOPEN_KEEP_CACHE`) while the entry's version id is the one cached, and
  invalidated with the entry otherwise.
- A reader on the **same mount** as a writer sees the writer's uncommitted bytes (served from the spool), so
  `tail -f` of a log another session is appending works. A reader on another runner sees only committed bytes.

### 5.4 Metadata cache and the change feed (listing storms)

The third review risk is `find`, `grep -r` and `ls -R` over thousands of entries.

- Listings come with attributes (`GET /runner/drive/list`), one call per folder, answering `READDIRPLUS` and
  pre-filling the kernel's entries and attributes.
- The daemon keeps folder listings and `stat`s keyed by entry id, and follows `GET /runner/drive/changes` with a long
  poll. On each change it updates its cache and calls go-fuse's `NotifyEntry` / `NotifyContent` so the kernel forgets
  what changed. This lets the kernel TTLs be long (60 s) while another runner's or the owner's change is seen within a
  second or two (rule 1: the walks measure the actual figure).
- `RESYNC` from the feed (the cursor is older than the pruned feed), or a `seq` lower than the daemon has already
  seen (the database was restored to an earlier point, §10), drops every cached name and attribute. The chunk cache is
  kept: it is content-addressed and cannot be wrong.
- Inode numbers: a per-mount table from entry id to a 64-bit inode, stable for the mount's life, with a generation
  number so a reused inode is never confused with an earlier file.

Targets, written into the test list (§5.9): `find ~/Files | wc -l` over 10,000 entries in 2,000 folders in under 15 s
cold and 2 s warm; `grep -r` over 10,000 small files (100 MiB) in under 60 s cold.

### 5.5 Throughput

The sixth review risk: every byte passes through the apiserver. On production the daemon (on the k3s node `.3`) sends
a chunk to the apiserver, which sends it to RGW (on `.3`). v1 keeps that path: it is the simplest, it reuses the
store's verification, and the D-6/K-4 measurements show FUSE itself is not the limit. The escape, if the 5 GiB walk
([5 GiB files on local and S3 stores](orbit-task:350KSOCmssIelClhQC6ah)) shows it is needed: **presigned chunk
transfer**. On the S3 store, the door answers a chunk `PUT` with a presigned URL for `files/<sha[0:2]>/<sha>` whose
signed headers include `x-amz-content-sha256: <the chunk's sha256>`, so RGW itself refuses a body with other bytes.
The daemon sends the chunk straight to RGW and then asks the door to record it (`HEAD` checks size and presence).
Reads get presigned `GET`s for chunks the owner names. Nothing else in the design changes.

### 5.6 Unsupported operations, with errors an agent can read

| Operation | Answer | `strerror` the shell prints |
|---|---|---|
| Hard link (`ln`) | `EPERM` | Operation not permitted |
| Symlink (`ln -s`) | `EPERM` | Operation not permitted |
| `chmod` to the mode already shown (files 0644, folders 0755) | success, nothing stored | |
| `chmod` to any other mode, `chown`/`chgrp` to anything but 10001 | `EPERM` | Operation not permitted |
| `utimens` (`touch -d`, `cp -p`, `tar x`, `rsync -t`) | success; `mtime` stored | |
| File locks (`flock`, `fcntl` locks) | `ENOLCK` | No locks available |
| Writable shared `mmap` | `EOPNOTSUPP` at `mmap` (`FOPEN_DIRECT_IO` on handles opened for writing; read-only mappings work) | Operation not supported |
| A write inside an existing file, or behind the spool window | `EOPNOTSUPP` | Operation not supported |
| `fallocate` | `EOPNOTSUPP` | Operation not supported |
| `mknod`, FIFOs, sockets | `EPERM` | Operation not permitted |
| `setxattr` | `ENOTSUP`; `getxattr` answers `ENODATA`, `listxattr` empty | |
| `rename` with `RENAME_EXCHANGE` | `EINVAL` | Invalid argument |
| A name that is not valid UTF-8 | `EINVAL` | Invalid argument |
| A name over 255 bytes | `ENAMETOOLONG` | File name too long |
| `statfs` (`df`) | used = the account's drive bytes, free = 1 PiB | |

An errno alone does not say why, so every refusal also appends a line to **`/run/orbit-files/errors.log`** (in the plain
parent directory, outside the FUSE mount; root-owned, mode 0644, the last 1,000 lines):

```
2026-11-20T10:00:00Z EOPNOTSUPP write /home/orbit/Files/Proj/app.db at offset 4096: the drive does not change a file in place; write a new file and rename it over the old one
```

and **`/run/orbit-files/status.json`** says whether the drive is connected, since when not, and how many writes are open.
The agent guidance names both files (§7.3).

### 5.7 When the server is unreachable

The product asks for a clear error, not a hang.

- Every door request has a deadline (10 s for metadata, 60 s for a chunk). After three failures in 10 s the daemon is
  **offline**: it probes every 5 s and fails what needs the server at once instead of waiting each time.
- Offline: reads of cached chunks, and lookups and listings in the metadata cache (up to 10 minutes old), still work.
  A read of an uncached chunk, an uncached lookup or listing, a `mkdir`, `rename` or `unlink` answer `EIO` at once.
  Writes go on into the spool.
- A `close()` that must commit while offline waits up to 30 s for the server, then returns `EIO`. The written bytes are
  kept for 24 h as **`/run/orbit-files/unsent/<time>-<name>`** (readable by the agent, removable only by the mounter), and
  `errors.log` names that file, so a writer that was told its write failed can still recover what it wrote. A failed
  close is never committed later behind the writer's back.
- A **frozen daemon** (alive, not answering) is the one case that would hang callers (D-4 b3, K-2 b3). The privileged
  parent runs a watchdog: every 10 s it `stat`s a virtual entry the daemon answers from memory (never the server, so an
  outage is not a freeze) with a 5 s deadline; on a miss it writes `1` to `/sys/fs/fuse/connections/<dev>/abort`
  (callers get `ENOTCONN` at once), kills the daemon, lazily unmounts and mounts again. The parent-directory layout lets
  the running agent see the new mount (D-4 b2, K-2 b2).

### 5.8 Best-effort session attribution

The fifth review risk: FUSE reports the caller's pid **in the pid namespace of the process that mounted**, and 0 when
the caller is not visible there.

- **Kubernetes:** the CSI plugin runs with `hostPID: true` and mounts, so every request carries the caller's host pid.
  The daemon asks the privileged parent, over a socket, "which session is host pid P?". The parent checks that
  `/proc/P/cgroup` belongs to the runner Pod this mount serves (its Pod UID) and reads `ORBIT_SESSION_ID` from
  `/proc/P/environ`, walking up parents until it finds one (the runner sets it for engines and background jobs:
  `claude_spawn.go:258`, `background_job.go:460`, `antigravity.go:297`). Answers are cached by (pid, start time). The
  session id is a hint; the door keeps it only if that session is the owner's and runs on this runner (§3.6). An agent
  can change its own environment, so attribution says which session the write *appears* to come from, which is all
  rule 6 promises.
- **Docker:** the `mrf-<uuid>` mounter keeps its own pid namespace (§6.2 and §12, decision 4), so pids read 0:
  every agent write shows as "an agent on Orbit Cloud", and the `rm -rf` burst key is the per-mount 2 s window (§3.4).
- The same pid and start time are the `rm -rf` **burst key** where they are visible.

### 5.9 The daemon's finish line: shell operations and expected results

Run as uid 10001 inside a managed runner container, with `F=/home/orbit/Files`, on Kubernetes (and on Docker once §6.2
is built). Each row is a test in [Cloud mount daemon](orbit-task:350KSO6FxenOl9slrBQ7i); the walks repeat the starred
ones end to end. "Trash" means the owner's Trash as the owner routes list it.

| # | Command | Expected |
|---|---|---|
| 1 | `echo hi > $F/a.txt; cat $F/a.txt` | Prints `hi`, exit 0; the Files page shows `a.txt`, 3 bytes, written by this session (Kubernetes) or "an agent on Orbit Cloud" (Docker). |
| 2* | `echo bye > $F/a.txt` | Exit 0; content `bye`; the version `hi` is in Trash as a version of `a.txt`. |
| 3* | `echo more >> $F/a.txt` (×3) | Content `bye` + three `more` lines; **no** new version in Trash. |
| 4 | Two processes appending 1,000 lines each to `$F/log` at once | 2,000 lines, none lost or torn (each `write` ≤ 4 KiB); no version in Trash. |
| 5* | `cp ~/big.bin $F/` (5 GiB) then `sha256sum` both | Same hash; `close` returns after the commit; the node's spool never holds more than its window; the runner's volume never holds a copy. |
| 6 | `cp $F/a.txt $F/b.txt`; `cp -r ~/dir $F/` (1,000 files, 100 folders) | Exit 0; trees identical (`diff -r`); `cp -r` under 60 s. |
| 7 | `cp -p ~/x $F/` (mode 0644) | Exit 0; `mtime` preserved. |
| 8 | `cp -p ~/script.sh $F/` (mode 0755) | Content copied; `cp` prints `preserving permissions … Operation not permitted`, exit 1; `errors.log` has the line. |
| 9* | `mv $F/a.txt $F/sub/c.txt` | Exit 0; same entry id, new path; no Trash item. |
| 10* | `mv $F/new.txt $F/b.txt` (onto an existing file) | Exit 0; `b.txt` keeps its entry id and has `new.txt`'s content; its old version is in Trash; `new.txt` is gone, not in Trash. |
| 11 | `mv ~/file $F/` and `mv $F/file ~/` | Exit 0 (the kernel answers `EXDEV`, `mv` copies and removes); the moved-out file is in Trash. |
| 12 | `mv $F/dir $F/full/` where `full/dir` is a non-empty folder | `Directory not empty`, exit 1. |
| 13* | `tar -C $F -xzf ~/src.tgz` (2,000 files, some executable) | Exit 0; every file's content and `mtime` match; executables show 0644 (the drive keeps no modes). |
| 14 | `tar -C $F -czf ~/out.tgz .` and `tar -tzf` | Exit 0; lists every file. |
| 15* | `rsync -rt ~/dir/ $F/dir/`, then again | Exit 0 both; the second run transfers nothing. |
| 16 | `rsync -a ~/dir/ $F/dir/` with only 0644 files and 0755 folders | Exit 0. |
| 17 | `rsync -a` with one 0755 file | Content copied; exit 23; `rsync` names the file and `Operation not permitted`. |
| 18* | `cd $F && zip -r out.zip dir` and `unzip -t out.zip` | Exit 0; archive tests OK. |
| 19 | `zip` with one member over 1 GiB | `zip` fails with `Operation not supported`; `errors.log` explains; no partial `out.zip` committed (zip removes its temporary file). |
| 20* | Editor atomic save: `vim $F/a.txt`, change, `:wq`; and `python3 -c` writing `a.tmp` then `os.replace('a.tmp','a.txt')` | Exit 0; new content; the previous content is recoverable from Trash (as a version, or as vim's deleted backup `a.txt~`). |
| 21 | `sed -i s/x/y/ $F/a.txt` | Exit 0; new version; previous in Trash. |
| 22 | `: > $F/a.txt` and `truncate -s 0 $F/a.txt` | Exit 0; empty file; previous version in Trash. |
| 23* | `rm $F/a.txt`; `rm -rf $F/dir` (500 entries) | Exit 0; Trash shows `a.txt` and **one** group "dir, 500 items" under its folder; restoring the group brings back the tree. |
| 24 | Restore `a.txt` after a new `a.txt` was written | The restored file is `a (2).txt`. |
| 25 | `mkdir -p $F/p/q/r`; `rmdir $F/p/q/r` | Exit 0; `rmdir` of a non-empty folder: `Directory not empty`. |
| 26 | `ls -la $F` | Owner `orbit orbit`, files `-rw-r--r--`, folders `drwxr-xr-x`, no Trash folder. |
| 27 | `find $F | wc -l` and `grep -r needle $F` over 10,000 entries | Cold under 15 s and 60 s; warm `find` under 2 s. |
| 28 | `du -sh $F`; `df -h $F` | Sizes add up; `df` shows the drive's use and a large free figure. |
| 29 | `ln $F/a $F/b`; `ln -s a $F/l`; `mkfifo $F/p` | `Operation not permitted` each, exit 1. |
| 30 | `chmod +x $F/a.txt`; `chmod 644 $F/a.txt` | First: `Operation not permitted`; second: exit 0. |
| 31 | `flock $F/a.txt true`; `sqlite3 $F/x.db 'create table t(a)'` | `flock`: `No locks available`; `sqlite3`: fails with a locking or I/O error, exit ≠ 0. |
| 32 | `git init $F/repo` | Fails (`Operation not permitted` on a mode change); the guidance says not to. |
| 33 | `dd if=/dev/zero of=$F/a.txt bs=1 count=1 seek=2 conv=notrunc` | `Operation not supported`, exit 1; `a.txt` unchanged. |
| 34 | Python `mmap` with `ACCESS_WRITE` on a drive file | `OSError: [Errno 95] Operation not supported`. |
| 35 | `touch -d 2020-01-01 $F/a.txt; stat -c %y $F/a.txt` | Shows 2020-01-01. |
| 36 | A file name of 256 bytes; a name with invalid UTF-8 | `File name too long`; `Invalid argument`. |
| 37* | Write on runner A, read on runner B of the same account; the owner renames on the web | B sees the new content within the change-feed delay (measured, reported); A sees the rename without a remount. |
| 38 | Server unreachable: `cat` a cached file; `cat` an uncached file; `ls` a cached folder; `echo x > $F/n` | Cached reads and `ls` work; uncached `cat` fails `Input/output error` within 10 s; the write's `close` fails `Input/output error` within 30 s, and `/run/orbit-files/unsent/` holds its bytes; `status.json` says offline. |
| 39 | Server back | Reads and writes work again with no remount; the unsent file stays until copied or 24 h pass. |
| 40* | Daemon `SIGKILL`ed | Calls fail `Transport endpoint is not connected` at once, never hang; the drive is back within 15 s without restarting the runner. |
| 41* | Daemon `SIGSTOP`ed | Calls block at most until the watchdog aborts (≤ 20 s), then `Transport endpoint is not connected`; recovered as in 40. |
| 42* | `umount`, `fusermount3 -u`, `mount -o remount,ro` from the agent | Refused (`must be superuser` / `Operation not permitted`), as D-5/K-3 measured. |
| 43* | A superseded generation's daemon writes | `close` fails `Input/output error`; `errors.log` says the runner instance was replaced; nothing committed (§8.2). |
| 44* | Plan-mode session asks its engine to write `$F/x` | The engine refuses (§7); the drive is unchanged. |
| 45 | `rm ~/Files` (the symlink) and the runner restarts | The entrypoint makes the link again. |

## 6. Wiring

### 6.1 Kubernetes (required; production)

What the report recommended and the owner chose at G0, made concrete:

**The plugin.** `orbit-files-csi`, a node-only CSI plugin (Identity + Node services, no controller), driver name
`files.orbit.dev`, in its own namespace `orbit-files-system` (Pod Security `privileged`):

- `CSIDriver files.orbit.dev`: `attachRequired: false`, `podInfoOnMount: true` (the kubelet passes the Pod's name,
  namespace and UID to `NodePublishVolume`), `volumeLifecycleModes: [Ephemeral]`, `fsGroupPolicy: None`.
- DaemonSet: the plugin container `privileged: true`, `hostPID: true` (§5.8), with `/var/lib/kubelet` and
  `/var/lib/orbit-files` both `mountPropagation: Bidirectional`, `/var/lib/orbit-files-spool` (node disk), and
  `/sys/fs/fuse` for the watchdog; beside it the stock `node-driver-registrar` and `livenessprobe` sidecars. Its
  ServiceAccount may `get` Secrets in `orbit-files-system` and nothing else.
- `NodePublishVolume(runnerId from volumeAttributes, pod UID from the kubelet)`: read Secret `mrf-<runnerId>` (token
  and generation); create `/var/lib/orbit-files/<runnerId>/` (root, 0755) and `drive/` (root, 0555) if missing, never
  while mounted (D-7's warning); start that runner's daemon (§5.1) presenting token, generation and the Pod UID; once the
  mount answers, bind-mount the **plain** directory `/var/lib/orbit-files/<runnerId>` (never `drive/`) onto the
  kubelet's target. The door, not the plugin, decides whether that Pod may use the drive (§4.3): a wrong Pod UID or a
  stale generation is refused there and the publish fails.
- `NodeUnpublishVolume`: unmount the target; stop the daemon after its open commits finish (at most 60 s), then
  `umount -l` the drive. A runner's processes are dead by then, so every handle has flushed.
- A plugin restart re-adopts running daemons from their pid files (each daemon is its own process, so a plugin restart
  never takes the drives down, as the report recommends).

**The runner Pod**: one volume and one mount, nothing else:

```yaml
volumes:
  - name: orbit-files
    csi:
      driver: files.orbit.dev
      volumeAttributes:
        runnerId: __RUNNER_UUID__
containers:
  - name: runner
    volumeMounts:
      - name: orbit-files
        mountPath: /run/orbit-files
        mountPropagation: HostToContainer
```

The entrypoint (`orbit run`, as uid 10001) makes `/home/orbit/Files` a symlink to `/run/orbit-files/drive`; if
`/home/orbit/Files` already exists and is not that link, it is renamed `Files.local-<date>` first and the rename logged.
Pod Security `restricted` admits `csi:` inline volumes (`HostToContainer` needs no privilege); the walk
[mount and Files page on Kubernetes](orbit-task:350KSOBcVlQNbArIDwG2Q) measures it, closing the report's gap.

**Orbit's changes:**

- `managed-runner-resources.ts` and `runner-pod.yaml.example`: the volume and mount above.
- `managed-runner-admission.ts` `templateProblem` (`:138`, volume check `:146`–`:152`): allow exactly one volume of kind
  `csi` with `driver === 'files.orbit.dev'` and `volumeAttributes` exactly `{ runnerId: mapping.runnerId }`, mounted only
  in the `runner` container, only at `/run/orbit-files`, only with `HostToContainer`, not read-only. Everything else is
  unchanged: still no privileged container, still only the pinned image, still the three volumes it allows today.
- The manager: issue the generation's mount credential with its runner credential and write Secret `mrf-<runner uuid>`
  in `orbit-files-system` before it creates the Pod; delete it when the generation is retired or the mapping deleted.
  This needs one new Role for the manager: `create`, `update`, `delete` on Secrets in `orbit-files-system`.
- `deploy/managed-runner/files-csi/`: CSIDriver, DaemonSet, namespace, RBAC, README; image build next to the runner
  image's, with the same local-import caveat as the deployment record.

**Ceph RGW** is not deployed on `.3` (`docs/managed-runner-k3s-xfs-deployment.md` lists Ceph without RGW). Provisioning
it, its bucket, its credentials for the apiserver and the off-host mirror (§10.2) is **its own owner-approved step**,
before production can use the drive (§11, not yet a task).

### 6.2 Docker (feasible; built after Kubernetes)

The report's D-4 layout:

- `channel.py` gains the optional `filesRoot` (D-7's diff, tested 74/74): `container_spec()` adds to the runner one
  bind `{"Type": "bind", "Source": "<filesRoot>/<runner uuid>", "Target": "/run/orbit-files", "ReadOnly": false,
  "BindOptions": {"Propagation": "rslave"}}`, and `unsafe()`/`unsafe_container()` let that one bind through and nothing
  else.
- A second template `files_mounter_spec()` creates **`mrf-<runner uuid>`** from the configured mounter image (the same
  image as the CSI plugin): user 0, `CapDrop: [ALL]`, `CapAdd: [SYS_ADMIN]`, `Devices: [/dev/fuse rwm]`,
  `SecurityOpt: [no-new-privileges:true, apparmor=orbit-files-mounter]`, read-only root, its own bootstrap volume
  `mrf-boot-<uuid>-g<gen>` holding the mount credential, a spool volume `mrf-spool-<uuid>`, one `rshared` bind of
  `<filesRoot>/<runner uuid>` at `/run/orbit-files`, network `orbit-files` (egress to the apiserver only), its own pid
  namespace. `unsafe_mounter()` refuses any other image or field.
- The channel creates the host directory before any bind (D-3), starts `mrf` before the runner and stops it after (D-3
  c), and runs the watchdog (§5.7) from the host, where it can write `/sys/fs/fuse/connections/*/abort`.
- The AppArmor profile `orbit-files-mounter` (D-1): docker-default plus `mount fstype=fuse.orbit-files ->
  /run/orbit-files/drive/,` and `umount /run/orbit-files/drive/,`, installed on every channel host by `host.sh`.
- The channel's credential store keeps the mount credential beside the runner credential, issued with it.

### 6.3 Exactly what changes in container hardening (gate G3)

| | Before | After |
|---|---|---|
| Runner container, Kubernetes | `runAsUser 10001`, `runAsNonRoot`, `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem`, `capabilities.drop [ALL]`, Pod `seccompProfile RuntimeDefault`, no host namespaces, no service-account token; volumes: data PVC, `/tmp` emptyDir, bootstrap Secret | **Security context unchanged.** One more volume: `csi` `files.orbit.dev` with `runnerId`, mounted at `/run/orbit-files`, `HostToContainer`. |
| Runner container, Docker | `CapDrop ALL`, no `CapAdd`, not privileged, no devices, `no-new-privileges`, read-only root; mounts: data volume, bootstrap volume, `/tmp` | **Security options unchanged.** One more mount: bind of `<filesRoot>/<runner uuid>` at `/run/orbit-files`, writable, `rslave`. |
| New, Kubernetes | — | DaemonSet `orbit-files-csi` in `orbit-files-system`: `privileged: true`, `hostPID: true`, `Bidirectional` on `/var/lib/kubelet` and `/var/lib/orbit-files`. Its per-runner daemons drop to uid 65532 with no capabilities. Not in any user's Pod or namespace. |
| New, Docker | — | One `mrf-<runner uuid>` per runner: `SYS_ADMIN`, `/dev/fuse`, AppArmor `orbit-files-mounter`, `no-new-privileges`, read-only root, one `rshared` bind. |
| Admission | `templateProblem` allows the data PVC, emptyDirs, the bootstrap Secret | Plus exactly the one `csi` volume above. |

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
> load kernel modules. **One exception, decided for Orbit Files (docs/orbit-files-drive-design.md,
> docs/orbit-files-drive-technical-design.md §6):** the runner container may *receive* exactly one mount made outside
> it, `/run/orbit-files` (a plain per-runner directory with slave propagation; the drive's FUSE mount sits below it),
> from an Orbit-owned mounter: on Kubernetes the `files.orbit.dev` CSI node driver; on Docker the per-runner
> `mrf-<uuid>` container, the only container the channel creates with `SYS_ADMIN`, `/dev/fuse` and the
> `orbit-files-mounter` AppArmor profile. Nothing else in this design may relax the runner container's hardening.

The product's "Feasibility first" risk in `docs/orbit-files-drive-design.md` (around line 146), which quotes §3, then points at the new wording.

## 7. Engine sandbox grants (D16)

### 7.1 When

The runner grants the drive only when `/run/orbit-files/drive` is a mount of type `fuse.orbit-files` (checked with
`statfs`/`/proc/self/mountinfo` at each spawn). Self-registered runners never have it and nothing changes for them. Every
grant names **both** spellings, `/home/orbit/Files` and `/run/orbit-files/drive`, because some sandboxes resolve
symlinks (Cursor's does, `cursor_sandbox.go`, `EvalSymlinks`) and some match the path as written.

### 7.2 Per engine

The drive is treated as a second workspace root, like the uploads folder: writable in every write mode, readable in
Plan mode, and never a reason for an "outside the workspace" card.

| Engine | Where | Change |
|---|---|---|
| Claude | `claude_spawn.go:151` | `--add-dir` for both drive paths beside the uploads folder, in every mode. In Plan mode `--permission-mode plan` already refuses every edit and command, so the drive is readable and not writable. |
| Codex app-server | `codex_auto_policy.go:22` (`codexAutoApprovalContextFor`), `:31` (`codexRuntimeWorkspaceRoots`), `:48` (`codexSandboxPolicy`) | Both paths join `workspaceRoots` (not `tempRoots`) and the Auto sandbox's `writableRoots`. Plan keeps its refusal of every write (`codex_appserver.go:1132`); the read-only subagent's `readOnly` sandbox still reads them. |
| Codex exec | `codex.go:490` | `--add-dir` for both paths beside the uploads folder. |
| Cursor | `cursor_sandbox.go` (`detectCursorSandbox` roots) | The resolved drive path joins the bwrap writable roots outside Plan; Plan's ACP mode refuses edits (`cursor_permissions.go:87`). |
| OpenCode | `opencode.go` permission map | The drive paths are allowed for `external_directory`/edit outside Plan; Plan already denies `edit`, `write`, `patch` (`opencode.go:1083`). |
| Antigravity | `antigravity_approval.go:597` | The approval policy gains a `Drive` root beside `Uploads`, writable outside Plan. |
| Background jobs | `background_socket.go:463` | `extraDirs` gains the drive. |
| `file_upload`, reply files | `file_tools.go:577`, `session.go:865` | The drive joins the path rules (D20, D21). |

One wording question for the owner (§12, decision 2): the walk [permission modes and container
hardening](orbit-task:350KSODTF8PzMHyZ3bSxP) says Claude Default writes to the drive "with no permission card". With
this design a Default-mode edit in the drive asks exactly as the same edit in the checkout does, and nothing asks for
reaching outside the workspace. Making drive edits card-free in Default mode would make the drive looser than the
checkout.

### 7.3 Guidance

`agent_instructions.go` gains the product's paragraph (when the drive is mounted), plus: the errors in §5.6 and where
`errors.log` and `unsent/` are; that verification, judgment and guest-driven runs read and do not write (D9). A turn is
guest-driven when its message carries the `ORBIT_GUEST` sender marker (`external_sender.go:46`), which the agent
already sees, answering the product's question whether an agent can tell. On other runners the guidance describes the
drive tools instead.

## 8. Sleep and fencing

### 8.1 Holding sleep while drive writes are open

With commit-on-close, a write is unflushed exactly while some process holds a written-to handle open, or a `close`
is committing. Two signals, so that neither side can be fooled alone:

- **Control plane (authoritative).** An open `MOUNT` staging of the runner's current generation touched in the last
  2 minutes is a new reason in `managedRunnerWork` (`managed-runner-work.ts`): `DRIVE_WRITE`. The daemon opens a
  staging for any handle that has been dirty for 5 s (even a small one) and keeps it alive every 30 s. The
  route confirming a sleep acceptance already requires the records to show nothing (`managed-runner-sleep.ts`), so a
  runner with an open drive write is never confirmed for sleep. A dead daemon stops touching its staging, which stops
  holding after 2 minutes, because nothing it held can be flushed any more.
- **Runner (its own idle clock).** `managed_sleep.go`'s `ManagedWorkload` gains `DriveWrites int
  json:"driveWrites,omitempty"`, counted in `idle()`, read from `/run/orbit-files/status.json` when it is under 30 s
  old (0 otherwise). The runner's idle seconds then restart with drive activity, so the manager does not keep asking a
  busy runner to sleep only to be refused. `sanitizeManagedWorkload` accepts the optional field; an older server ignores
  it.

Order on sleep and wake: Kubernetes publishes the CSI volume before the runner container starts and unpublishes after
it stops; the Docker channel starts `mrf` first and stops it last (D-3 c).

### 8.2 Fencing superseded instances

- The mount credential is issued for one generation and checked with the instance UID on every request (§4.3), with the
  same answers as the runner guard. A commit re-checks the mapping's generation under `FOR SHARE` in its own
  transaction, so a commit racing a generation change either lands before it or is refused.
- On `SUPERSEDED` or `FENCED` the daemon stops: every open write's `close` fails `EIO` with the reason in `errors.log`,
  it aborts its FUSE connection (`ENOTCONN` from then on) and exits. Its open stagings are never committed and expire.
- The manager revokes the old generation's mount credential when it advances the generation, after the stop proof it
  already requires (`managed-runner-fencing.ts`). A node lost without that proof is fenced by the operator's receipt as
  today; its daemon's credential is refused from the moment the generation advances, whether or not the node comes back.
- Drive tools on a superseded instance are refused by the existing runner guard.

## 9. Share links: the `DRIVE_FILE` root kind (D18)

- `share-link.ts:10`: `ShareRootKind` gains `'DRIVE_FILE'`, `SHARE_ROOT_KINDS` lists it, `LAYER_DEFAULTS.DRIVE_FILE = {}`
  (a file has no layers).
- `share_link` gains `drive_entry_id`, a composite FK `(drive_entry_id, owner_id)` → `drive_entry`, `ON DELETE CASCADE`,
  and `share_link_one_root_chk` (0403) is replaced by the same check over all five roots.
- Only the owner creates one, from the Files page (D18): `POST /share-links` with `{ kind: 'DRIVE_FILE', driveEntryId }`
  under the owner's login. The runner door has no share route, and the share-link routes refuse a runner credential.
- Before creating, the page calls `POST /drive/entries/:id/share-check`: the existing secret scan
  (`file-secret-scan.ts`, the high-confidence `ISSUED_CREDENTIALS` shapes) over the file's text, chunk by chunk with a
  carried overlap so a key spanning two chunks is found; binary files are not scanned, as today. A match is answered as
  a warning naming the shape and line, never the secret; the owner can still share.
- The public door: `GET /shared/:token` answers the file's name, size, type and preview; `GET /shared/:token/content`
  streams it with `Range`. An entry in Trash answers as a link that has ended; restored, the link works again; deleted
  for good, the link goes with it.
- Released clients: `GET /share-links` without `kind` lists only `SESSION`, `TASK` and `PROJECT`, as it already does for
  `WIKI` (`share-links.controller.ts:104`), so a client that does not know `DRIVE_FILE` never receives one. Clients that
  do ask for it by name; they also skip any kind they do not know.
- A link follows the file: renames, moves and new versions (§12, decision 1).

## 10. Backup and restore

### 10.1 What is where

| Data | Where | Backed up by |
|---|---|---|
| Names, versions, chunk lists, Trash, stagings, change feed, mount credentials | Postgres | The existing WAL archive and base backups (`scripts/pg-backup.sh`), off host. |
| Chunk bytes, local store | `./data/files` | The existing `<target>-files` copy, write-once names, pruned by `file_blob.off_host_prune_at`. |
| Chunk bytes, S3 store (Orbit Cloud on RGW) | The bucket | **New**: an off-host mirror of the bucket's `files/` prefix (§10.2). |
| Mount spool and caches | Node disk / mounter volume | Not backed up: the cache is derived, and spooled bytes are either committed or reported to the writer as failed. |

### 10.2 Ceph durability and "kept permanently"

The seventh review risk. The production Ceph is two HDD OSDs on one host, `size 2 / min_size 1`
(`docs/managed-runner-k3s-xfs-deployment.md:38`, `:184`): it survives one disk, not the host, and with `min_size 1`
writes are accepted while only one copy exists. "Kept until someone deletes it" (D2) therefore needs, before the drive
opens to accounts on production:

1. **An off-host mirror of the bucket**: a periodic one-way copy of new objects under `files/` to the backup target
   (`rclone copy` or equivalent, never `sync`, from the backup sidecar's host), as cheap as the local copy because names
   are sha256 and never rewritten. The retention sweep then sets `off_host_prune_at` for `s3` blobs too when the
   deployment declares the mirror (`ORBIT_FILES_S3_MIRROR=1`), and the sidecar prunes the mirror by that column, as it
   prunes the local copy today. The sweep's comment "only the local store's bytes are in the off-host copy"
   (`file-retention-sweep.ts:234`) changes with it.
2. The RGW data pool at the same replication as the RBD pool, with `min_size 1` named in the runbook as accepted risk,
   and the mirror's lag (one interval) named as the most a host loss can lose.

Both are part of the RGW provisioning step (§6.1), for the owner to approve.

### 10.3 Restore order

1. Stop the apiserver (and so every door); mounters go offline (§5.7) and keep spooling.
2. **Restore Postgres** to the chosen point.
3. **Restore bytes** only if the store itself was lost: the files directory from `<target>-files`, or the bucket from its
   mirror. Bytes newer than the database are harmless: nothing names them, the sweep releases them and they go after a
   grace period.
4. Start the apiserver. Run the existing missing-bytes check, extended to drive chunks (`files verify`): it lists every
   drive entry whose chunks are missing, which with the grace period below should be none.
5. Mounters reconnect, see a `seq` lower than they had seen, and drop their metadata caches (§5.4). Writes that
   committed after the restore point are lost with the database, as any write after the point is; their bytes are in the
   store and released.

Why this order and why it works: Postgres names bytes, never the reverse. Bytes are deleted only one grace period after
nothing names them, and the grace period is at least as long as the oldest retained Postgres backup reaches back
(`fileGraceMs`, `file-retention.ts`). So any retained backup restored finds every chunk its drive rows name, including
the rows of Trash the owner emptied after that backup: those items reappear in Trash, with their bytes.

## 11. Tasks of this project against the sections

| Task | Sections | Scope as this design sets it |
|---|---|---|
| [technical design](orbit-task:350KSO2SDXIBqq7841EEI) (this) | all | This document. |
| [chunked streamed store for large files](orbit-task:350KSO3QhWxHH7y5Ot3hb) | §2, §1.1 (`drive_version_chunk`, `drive_staging*`) | **Shrunk** (owner, 2026-11-19): the chunk manifest tables, the streaming chunk door (store a ≤ 8 MiB chunk through `store()` with its staging row), the ranged `open`, and the retention sweep's new holders and step 0. No multipart, no new store. |
| [name layer, versions, Trash and owner routes](orbit-task:350KSO476FnLnlYnfDTS6) | §1, §3, §4.1 (except uploads), §4.4, §10.3 step 4 | Tables, commit, overwrite/append/rename rules, Trash groups and restore with suffixes, last-writer fields, owner routes, tenant-isolation cases, `files verify`. |
| [resumable upload and ranged download](orbit-task:350KSO4nNiSOUmCcUQHcr) | §4.1 uploads, download, §2.5 usage route | Upload sessions, chunk `PUT`, resume, folder drops with one suffix, `Range` downloads. |
| [runner drive door and drive tools](orbit-task:350KSO5NhJYQ0axTV6vXE) | §4.2, §4.3, §4.5 runner side, §4.6, §8.2 (door checks) | `/runner/drive/*`, the mount credential and its checks, change feed, burst grouping, drive MCP tools and CLI, `file_upload` from the drive, `orbit-drive:` rewriting. |
| [Cloud mount daemon](orbit-task:350KSO6FxenOl9slrBQ7i) | §5 | **On go-fuse** (owner, 2026-11-19). Commit-on-close, spool, caches, change feed, errors and `errors.log`, offline behaviour, watchdog, attribution helper; its finish line is §5.9. |
| [Kubernetes (and Docker if feasible) wiring for the mount](orbit-task:350KSO6qGQSFPHc4Pe0aB) | §6, §8.1 order, §6.4 | CSI plugin and manifests, admission and resources changes, manager Secret and Role, Docker channel `filesRoot` and `mrf`, AppArmor profile, the §3 edit after G3. |
| [engine grants and sleep hold](orbit-task:350KSO86tzR9l8gDbyFvX) | §7, §8.1 | Grants per engine, guidance, `DRIVE_WRITE` work reason, `driveWrites` in the workload report. |
| [one-file share links](orbit-task:350KSO8zEpJwfrWaAcG7T) | §9 | Root kind, column, share-check, public door. |
| [web Files page and menu entry](orbit-task:350KSO9ZWyHnFi2Y3MnzI) | §3.5, §4.1 (client) | Page, Trash and versions inside Files (board a–c), upload suffix (d), undo. |
| [Storage moves into Files (web)](orbit-task:350KSOA9nCBF7zqcWMh8Y) | §2.5 | Storage inside Files, counted once per content. |
| [reply links and composer drive picker (web)](orbit-task:350KSOAw2HEPizXCn9HR4) | §4.5 | `orbit-drive:` rendering, picker inserting the path. |
| [walk: mount and Files page on Kubernetes](orbit-task:350KSOBcVlQNbArIDwG2Q) | §5.9 (1–3, 9–10, 23, 26, 37, 40–42), §6.1 | Includes the Pod Security `restricted` measurement the report could not make. |
| [walk: Trash and versions through the mount](orbit-task:350KSOCCj3ncLTo9pdrsx) | §3, §5.9 (2–3, 10, 20–24) | |
| [walk: 5 GiB files on local and S3 stores](orbit-task:350KSOCmssIelClhQC6ah) | §2, §5.3, §5.5, §5.9 (5) | Decides whether presigned transfer (§5.5) is needed. |
| [walk: permission modes and container hardening](orbit-task:350KSODTF8PzMHyZ3bSxP) | §6.3, §7, §5.9 (42, 44) | Wording of its criterion: §12, decision 2. |
| [walk: sleep, wake and superseded runner](orbit-task:350KSODxS9AKn76E4hiAX) | §8, §5.9 (43) | |
| [trial JuiceFS](orbit-task:350SVIMb3x4jPTuokO6B2) | — | Cancelled (option C chosen). |

Work this design needs that **no task holds yet**, for the coordinator to file once the design is approved:

- **Provision Ceph RGW on production**, its bucket and credentials, and the bucket's off-host mirror (§6.1, §10.2):
  an owner-approved step, before production uses the drive.
- **Files on iOS, macOS and Android** (the product: "web first; iOS, macOS and Android follow"), including their Storage.

## 12. Decisions for the owner

1. **Share links follow the file.** Recommended: a `DRIVE_FILE` link shows the file's current version, as a drive link
   does elsewhere, and the Files page marks the file "shared" so an overwrite of a shared file is visible. Alternative:
   pin the link to the version shared, so later agent writes are never shared without a new link. Following is what
   owners expect of a drive; pinning is safer if agents often rewrite shared files.
2. **Claude Default mode.** Recommended: the drive is a workspace root, so a Default-mode edit there asks exactly as it
   would in the checkout, and nothing asks about leaving the workspace (§7.2). The walk's criterion would then read "no
   card beyond what the mode asks in the checkout". Alternative: allow drive edits without a card in every write mode.
3. **Production store.** Recommended: `ORBIT_FILES_BACKEND=s3` on RGW for all new bytes (drive and attachments alike),
   one store and one mirror; older local bytes stay readable where they are. Alternative: a separate target for drive
   chunks only, leaving attachments on the apiserver's disk, at the cost of a second store configuration.
4. **Attribution on Docker.** Recommended: none (pids read 0 in the mounter's own pid namespace; the page says "an
   agent on Orbit Cloud", which rule 6 allows), keeping `mrf` without host pid access. Alternative: `PidMode: host` on
   `mrf` for attribution and finer `rm -rf` grouping, adding host pid visibility to a container that already has
   `SYS_ADMIN`.
5. **Mode changes.** Recommended as §5.6: `chmod` to the mode already shown succeeds as a no-op and any other mode is
   refused, so `tar x` and `rsync -rt` work while rule 2's "permission changes are not supported" holds. Alternative:
   refuse every `chmod` (then `tar x` of directories prints errors), or keep an executable bit (a product change).
6. **Presigned chunk transfer.** Recommended: not in v1; build it only if the 5 GiB walk shows the apiserver hop is the
   limit (§5.5).

## 13. Not in this design

Cleanup, version limits and quotas; folder share links; sync to the owner's computer; a mount on self-registered
runners; collaborative editing; previews beyond pictures and Markdown (the product's "Not in this round").
