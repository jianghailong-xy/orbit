# Documents: the account's drive (product proposal)

Status: **product decisions settled, round 4** (owner, 2026-11-19), after two reviews by a second model. Next: the
feasibility check for the mount, then the board under `docs/mocks/drive/`, then the technical design. This
builds on `docs/drive-design.md` (sha256-addressed bytes, `file_upload`, `FILE` evidence) and adds a drive the
owner and agents share.

## One sentence

Each account has one drive, **Documents**. The owner sees it under **Files** in the left menu; every Orbit Cloud
agent sees the same drive as the local folder **`/home/orbit/Files`** (`~/Files`). What is put there is kept until
someone deletes it.

## Why

- What agents produce is scattered across conversation pictures, evidence cards, uploads folders and commits. There is
  no one place to see it.
- Agents cannot build on earlier output without knowing a file id and calling `file_fetch`.
- Owners moving their work from a local machine to Orbit Cloud have nowhere to put their files.

## Decisions

Round 1 (owner, 2026-11-19):

| # | Question | Decision |
|---|---|---|
| — | What it is | An ordinary drive: folders and files. No imposed structure; the owner and agents organise it. |
| D1 | What a Cloud agent sees | The whole drive, mounted with FUSE. |
| D2 | Retention | Permanent. Cleanup is a separate design, not this round. |
| D3 | Owner upload | Yes: drag files or folders onto the Files page. |
| D4 | Mount path | `~/Files`, fixed. It matches the sidebar label. The guidance gives the absolute `/home/orbit/Files`, because some engines start with their own `HOME`. |
| D5 | Agent writes | Read and write, ordinary file semantics. |
| D6 | Deletion | Deleted items go to **Trash** (the product's existing word). |
| D7 | Existing files | Superseded by D19: no import. |
| D8 | Default place for agent output | Guidance suggests `~/Files/<Project>/` (folder name per D22); the owner's instruction comes first. Revisit with usage data. |

Round 2 (owner, 2026-11-19):

| # | Question | Decision |
|---|---|---|
| D9 | Verification runs, judgment runs, guest-driven turns and Plan-mode sessions | Treat the drive as read-only. Not enforced by the mount (D14); enforced by the engine only in Plan mode (D16), by guidance elsewhere. |
| D10 | Evidence files in the drive | **Excluded.** Evidence files stay on evidence cards; the drive never holds them. |
| D11 | Trash and agents | Agents cannot see Trash. Only the owner restores or empties it, from the Files page. |
| D12 | File size | **No per-file limit**: owners moving from a local machine may upload very large files. |
| D13 | Settings → Storage | **Replaced** by the Files page. |

Round 3 (owner, 2026-11-19):

| # | Question | Decision |
|---|---|---|
| D14 | One view per runner, or per session | **One mount per Cloud runner**, read-write, the same for every session on it. Sessions on a runner already share its local disk, so a shared drive folder adds no new exposure. |
| D15 | Agent organising step | Dropped (and with D19 there is nothing to organise). |

Round 4 (owner, 2026-11-19, all as recommended):

| # | Question | Decision |
|---|---|---|
| D16 | Engine access to `~/Files` | **Granted in every write mode**, like the checkout and the uploads folder. Plan mode stays read-only, so D9 is enforced by the engine only there. |
| D17 | Versions | **An append makes no version.** An overwrite keeps the previous version; all versions are kept until the cleanup design limits them. |
| D18 | Share links | **Only the owner creates them, from the Files page.** Agents cannot. On sharing, the secret scan runs; a match warns and names what it found, and does not block. |
| D19 | Importing existing `file_upload` files | **Dropped.** Files → Storage lists them where they are. |
| D20 | Agent tools on other runners | **Separate drive tools** by path (put, get, list, move, delete) with the drive's rules: no scan, no size limit, kept. `file_upload` stays the evidence tool, with today's rules; on Cloud it may also read from `~/Files`. |
| D21 | Pointing at drive files | **A reply may link a file in `~/Files`**, and it renders as that drive file. **The composer gets a drive file picker** that puts the file's path into the message. |
| D22 | `<Project>` folder name | **The project title made safe**: no `/`, trimmed to a readable length, a short id suffix when two projects share a title. Renaming a project does not rename its folder; it is an ordinary folder once made. |
| D23 | Self-hosted on the local disk store | **Same rules, no limit.** The operator owns the disk; files stream to it in parts. |

Runners other than Orbit Cloud get no mount; see "Other runners".

## What the owner sees

**Left menu:** Files, directly under Wiki. The Wiki is what the work learned and Files is what it produced. One entry
for the account, no count: nothing in it waits on the owner.

**The Files page** (web first; iOS, macOS and Android follow):

- Folders and files, with preview for pictures and Markdown in the first version.
- On each file: who last wrote it: the owner, or "an agent on Orbit Cloud" with the session where Orbit could tell
  (rule 6).
- Upload (files or folders, any size, resumable), download, rename, move, new folder, delete to Trash.
- **Share link for one file** (D18). Before the link is made, a secret-scan match shows a warning naming what it found;
  the owner can still share.
- **Trash:** grouped by the folder an item was deleted from and when, so a deleted folder is restored whole. Restore,
  or delete for good. Earlier versions of an overwritten file are in Trash too (D17).
- **Storage** (replacing Settings → Storage, D13): the account's total, the drive's share of it, and the rest
  (conversation pictures, attachments, evidence files and earlier `file_upload` files) with the per-project, per-task
  and per-week lists Settings shows today. Those files are listed there and nowhere in the drive tree, and each byte
  is counted once. Settings → Storage exists only on web today, so "replaced" is a web change; the other clients get
  Storage with their Files page.

## What an agent sees (Orbit Cloud)

- `/home/orbit/Files` is the drive, outside every worktree, so nothing in it is committed.
- One read-write mount per Cloud runner, the same for every session on it (D14), granted to the engine in every write
  mode and read-only in Plan mode (D16).
- No Trash folder (D11).
- A reply can link a drive file (D21), and messages from the owner can carry drive paths from the composer's picker.
- The guidance says: *`/home/orbit/Files` is the owner's Documents drive. What you put there they see under Files,
  and it is kept. Put output for a project under `/home/orbit/Files/<Project>/` unless told otherwise. It is not a
  place for repositories, databases or build output. In a verification, judgment or guest-driven run, read it and do
  not write to it.*

## Rules that follow from "an ordinary drive"

1. **Last write wins.** No locks and no merging. Another session's change is seen on the next read; how quickly is for
   the technical design to measure, not to promise here.
2. **Supported operations.** Create, read, overwrite, append, rename, move, delete, `mkdir`, `rmdir`, listing. Not
   supported, with an error the agent can read: hard links, symlinks, permission changes, file locks, `mmap` writes,
   random-access writes into a closed file. SQLite, `git init` and `npm install` do not belong in the drive, and the
   guidance says so.
3. **Nothing written over is lost.** Deleting moves the item to Trash. Overwriting a file (`>`, `cp` over it, `mv`
   onto it) moves the previous version to Trash as well; appending does not (D17). Trash shows what one `rm -rf`
   removed as one group under its folder, restored whole, even though the mount sees it as many deletes. A restore
   that meets a name already taken gets a suffix.
4. **Trash keeps everything until the owner empties it.** It counts toward storage. When it is emptied automatically,
   and how many versions it keeps, is part of the cleanup design.
5. **Evidence is separate.** A drive file is not cited by its path. To cite one, the agent passes it to `file_upload`
   (which on Cloud may read from `~/Files`, D20); that scans it for secrets and makes an evidence file with its own
   copy, under today's evidence rules. The drive copy can then change or go without touching the card.
6. **Who wrote it.** All sessions on one Cloud runner share one user, so a write is attributed to a session only where
   the runner can tell which session's process made it. Elsewhere the page says "an agent on Orbit Cloud". The board
   draws both.
7. **No secret scan on drive writes.** It is ordinary storage. The scan runs on sharing (D18) and on evidence (rule 5).
8. **Sharing:** a link to one file, made by the owner (D18). It is a new kind of share link next to sessions, tasks,
   projects and wikis; released apps that do not know the kind must skip it, not fail the list. Folder links are a
   later decision: a folder link is live, so anything an agent writes there later would be shared too.

## Other runners

No mount. Agents there get the drive tools (D20): put, get, list, move and delete by path, under the drive's rules.
They can put a file from their checkout or uploads folder into the drive and take one out into their uploads folder.
The guidance on those runners describes the tools, not a folder.

## Existing files

Nothing is imported (D19). Earlier `file_upload` files, evidence files, conversation pictures and chat attachments
stay where they are, under their current rules, and Files → Storage lists them.

## Not in this round

Importing existing files; syncing or mounting the drive on the owner's own computer (they download); a mount on
self-registered runners; mounting local folders into Orbit Cloud; collaborative editing; cleanup, version limits and
quotas; folder share links; HTML, log and test-report preview; replacing git for code.

## Risks the technical design must answer

- **Feasibility first.** The Cloud container drops every capability, sets `no-new-privileges` and allows no devices
  (`deploy/managed-runner/docker-channel/channel.py`, around line 575), and
  `docs/session-checkout-storage-design.md` §3 forbade mounts in it. The mount therefore has to be made outside the
  agent's container and passed in, on both the Kubernetes and the Docker backend (the Docker channel allows only its
  own data volume today), and that design must reopen §3 on purpose. If neither works, D1 needs another answer (for
  example a sync folder), and rules 1 and 3 change with it. **Settled:** §3 now names the one exception, the mount
  the `drive.orbit.dev` CSI driver passes in at `/run/orbit-drive` (deploy/managed-runner/drive-csi/).
- **Engine grants (D16).** Each engine's sandbox must list `/home/orbit/Files` as writable outside Plan mode (today
  Claude gets `--add-dir` for the uploads folder, `src/runner-go/claude_spawn.go:151`; Codex Auto's writable roots are
  in `src/runner-go/codex_auto_policy.go:31`), and as readable in Plan mode.
- **Very large files (D12, D23).** Uploads, mount writes and appends must stream to storage in parts, not be staged
  whole on the runner's volume or the server's disk. The current upload path is capped at 25 MiB, writes a whole temp
  file and stores a file as one object keyed by its whole-content sha256, so an append to a large file would rewrite
  it. Storing large files in chunks is the likely answer.
- **Prompt injection.** A read-write session has the internet and the whole drive. One injected session can read or
  overwrite everything the owner put there. Rule 3 makes overwrites recoverable; reading cannot be undone. Agents
  cannot make share links (D18).
- **Guests** reach the drive through the owner's Cloud agents (D14). They cannot get a share link (D18). Whether an
  agent can tell a turn is guest-driven, which the guidance relies on, is for the technical design to confirm.
- **Sleep.** Unflushed drive writes must hold off a Cloud runner's sleep, and a replaced runner instance must lose
  write access with its credential.
- **Server unreachable:** reads of uncached files fail with a clear error, not a hang.
- **Cost:** permanent storage, no size limit, and Trash that keeps every version make storage per account unbounded
  until cleanup and quotas exist.
- **Tenant isolation:** whatever serves the mount must only ever reach one account; every new route goes into the
  tenant-isolation case table.
- **Backup:** drive paths live in Postgres and bytes in storage; restore order and the deletion grace period cover
  drive entries and Trash.

## Next

1. Feasibility check: one read-write mount per Cloud runner, made outside the agent's container and passed in, on
   Kubernetes and on Docker.
2. Board `docs/mocks/drive/`: the left menu entry, the Files page (folders, preview, upload, share with the
   secret warning, grouped Trash, Storage, who wrote it), the composer's drive picker, a reply linking a drive file, and
   the phone layout.
3. Technical design.
