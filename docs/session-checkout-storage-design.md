# Session checkout storage: bounded, sparse and copy-on-write checkouts

Status: draft for owner review, 2026-11-06. Decisions D1–D6 (§8) are open; each has a recommended default.

Every isolated session gets its own `git worktree` under `$ORBIT_HOME/worktrees/<session>`. Git shares the object
database between worktrees, but every working tree is a full copy of the checked-out files plus whatever the session
builds or installs there. This design makes three changes, all of which work without privileges:

1. **Budget-aware reclamation.** A runner reclaims checkouts against the storage it is actually allowed to use. On a
   managed runner that is the data volume's budget, which the runner cannot see today.
2. **Repository-declared sparse checkouts.** A repository can name paths that session checkouts leave out.
3. **Copy-on-write checkout creation.** Where the filesystem can clone files (APFS, XFS, btrfs, OpenZFS block cloning),
   a new checkout is cloned from the workspace's checkout instead of written out again. Anywhere else the runner falls
   back to `git worktree add` as today.

Layer 1 stops checkouts from filling a volume. Layer 2 makes each checkout smaller everywhere. Layer 3 makes the
copies that remain nearly free on capable filesystems.

## 1. Problem

**Managed runners (Docker backend).** Each account's runner keeps checkouts, sessions and engine state on one Docker
volume, `mr-data-<runner uuid>`. The channel enforces its limit (`storage.capacity`, 20 GiB by default) by measuring
the volume every `diskCheckSeconds` (120 s) and stopping the container once it is over (`VOLUME_OVER_LIMIT`). The
runner's own reclamation cannot see that limit:

- `measureWorktreePressure` (`src/runner-go/worktree.go`) reads `statfs` of the worktrees root. A Docker local volume is
  a directory on the host's filesystem, so `statfs` reports the host disk, not the volume's budget.
- The floor it compares against, `Runner.minFreeDiskMb`, is unset (no gate) unless someone sets it.
- With no pressure, the sweep keeps up to `maxRetainedEligibleCheckouts` (32) checkouts of ended sessions, and every
  checkout of a session that can still resume.

Take the Orbit repository: about 2 GiB of history (GitHub reports 1.91 GiB) and 1.8 GiB per checkout. A 20 GiB volume
then has room for the clone, the workspace checkout and fewer than ten session checkouts, and fewer still once sessions
install dependencies. The runner keeps going until the channel stops it.

**Self-registered runners.** The same accumulation happens on users' machines. Measured on the HPC runner
(`workstation-gpu`, ext4) on 2026-11-06: 160 session worktrees held 267.6 GiB of a 915 GiB root disk that was 97% full.
The orbit-macos Mac mini was at 99% (2.7 GiB free) the same day; what filled it was not measured.

## 2. Measurements (2026-11-06)

**What the HPC worktrees hold** (`du` over all 160 worktrees, and the blob ids in each worktree's index):

| Part | Bytes |
| --- | --- |
| All worktrees | 267.6 GiB, median 1.74 GiB each |
| `docs/` | 213.0 GiB (`docs/evidence` 146.6 GiB, of which `docs/evidence/base-ui-migration` 108.2; `docs/mocks` 65.8 GiB) |
| `node_modules` (39 worktrees with their own `npm ci`; 8 distinct lockfiles) | 35.5 GiB |
| `src/` | 20.7 GiB |
| Tracked content, 4 KiB-rounded | 227.6 GiB, of which **3.33 GiB unique** (68×; 54,008 distinct blobs) |

The Orbit `HEAD` tree is 1.79 GiB in 30,423 files: `docs/evidence` 1.09 GiB (`base-ui-migration` alone 715 MiB in
14,933 files), `docs/mocks` 554 MiB, everything else about 121 MiB.

**Cloning a checkout** (the same steps on both machines; recipe in Appendix A):

| | Plain `git worktree add` | Cloned checkout |
| --- | --- | --- |
| Linux XFS (`reflink=1`, loop file on an HDD) | 18.3 s, +1882 MiB | 19.2 s, **+26 MiB** (clone 2.1 s, index refresh 17.0 s) |
| macOS 27.2 APFS (orbit-macos, Mac mini) | 12.8 s, +1857 MiB | 20.7 s, **within measurement noise** (clone 5.4 s with `cp -c -R`, index refresh 15.3 s) |

On both machines the cloned checkout read as clean (`git status --porcelain` empty, no diff against the commit),
executable bits and symlinks survived, and editing a cloned file left the template unchanged. The index refresh
dominates the time: the clones have new inode numbers, so git rehashes every file once.

**Inside a managed-runner container.** A container started with the managed runner's hardening (UID 10001,
`CapDrop ALL`, `no-new-privileges`, read-only root filesystem, no network) on a plain Docker volume backed by XFS could
clone with `cp --reflink=always`. Four 512 MiB files took 512 MiB on disk. Docker's `GET /system/df` counted that
volume as 2048 MiB: it sums apparent sizes and counts a hardlinked inode once, so clones count in full. Volumes created
with driver options are left out of `/system/df` sizes altogether.

**Sparse checkouts.** With `docs/evidence/` excluded, a new file written under `docs/evidence/` makes `git add -A` exit
1 and leaves that file unstaged (it stages the rest). `git add -A --sparse` stages it. `add --sparse` exists since git
2.34.

## 3. Constraints

- **Managed container hardening is fixed.** The channel (`deploy/managed-runner/docker-channel/channel.py`, around line
  576) refuses privileged mode, added capabilities, devices, host binds and user-namespace modes. So no mounts, no
  FUSE, no loop devices and no kernel modules inside the container. Nothing in this design may relax that.
- **Docker volume accounting is logical.** The 20 GiB limit is measured with Docker's sizes. Clones save host disk but do
  not lower the measured size.
- **Kubernetes backend.** The PVC is an ext4 RBD filesystem of a fixed size (`docs/managed-runner-design.md`), so
  `statfs` inside the pod already reports the budget. ext4 cannot clone.
- **Self-registered runners** run on linux and darwin, amd64 and arm64 (`scripts/build-binaries.sh`), on whatever
  filesystem the user has, as the user's own account.
- **Existing reclamation stays the mechanism.** `gcWorktrees` reclaims checkouts of ended sessions;
  `gcResumableCheckouts` reclaims checkouts of resting sessions below the floor; `leaveCheckoutAbsent` and
  `restoreAbsentCheckout` recreate a reclaimed checkout from its branch on the session's next claim. Branches are never
  deleted.

## 4. Options considered

| Option | Verdict |
| --- | --- |
| ZFS dedup on the host | Effective for this data (68× redundant, few unique blocks), but it is a host decision: the operator must run ZFS and reserve ARC memory. Docker accounting stays logical. Documented as an operator option, not built. |
| overlayfs or fuse-overlayfs per checkout | Needs `CAP_SYS_ADMIN` or `/dev/fuse`, which the channel refuses. On user machines it adds mounts that must be restored after every reboot. Rejected. |
| Hardlink deduplication (`hardlink`, `jdupes -L`) | Unsafe. Node's `fs.writeFile` and shell `>` rewrite a file in place, which changes every linked copy; each session's turn-end commit would then spread the change into its branch. Rejected. |
| Filesystem snapshots and clones per checkout (ZFS, btrfs) | Needs root and a specific filesystem; not portable. Rejected. |
| Out-of-band dedup (`duperemove`, `FIDEDUPERANGE`) | Works on XFS and btrfs, not on OpenZFS 2.3 (returns `EOPNOTSUPP`). It needs a background scan; cloning at creation gets the same sharing without one. Rejected for now. |
| Moving artifacts out of git | Orbit Files (project `34qIISTdcSurVokwRlp4w`) stops new evidence from entering the Orbit repository. It does not help other repositories or the existing tree; this design does both. |

## 5. Layer 1: budget-aware reclamation

The runner judges pressure against the storage it may use:

- `worktreeGCPressure` gains an optional budget: `limitBytes`, `usageBytes`, `measuredAt` and `floorBytes`. When a
  budget is present, free space is the smaller of `statfs` free space and `limitBytes − usageBytes`, and the floor is
  `floorBytes`. Without one, it works as today.
- **Docker backend.** The apiserver already receives each volume's `usageBytes` and `limitBytes` from the channel
  (`ChannelVolume` in `src/apiserver/src/managed-runners/docker-channel-client.ts`). It relays them to the managed
  runner in the heartbeat response, next to `minFreeDiskMb` (D1).
- **Field names as implemented** (`StorageBudget` in `src/runner-go/types.go`): the heartbeat response's
  `storageBudget` is `{limitBytes, usageBytes, measuredAt, floorBytes}`, the byte counts as integers and `measuredAt`
  as RFC 3339, never earlier than when the channel's measurement finished. Like `minFreeDiskMb`, an answer without
  `storageBudget` means no budget, so every answer a managed runner gets carries it. A managed runner's beat always
  reconciles in full, over the link too; the link's quiet answer goes only to other runners, which have no budget.
- **The relay as implemented** (`src/apiserver/src/managed-runners/managed-runner-storage.ts`). Each manager pass
  already reads the channel's view of the volume (`verifyStorage`). When the figures differ from the ones kept, the
  manager keeps them on the mapping (`managed_runner.volume_measurement`, migration 0480) with the time it read them.
  The channel does not say when it measured, and its view is at most `diskCheckSeconds` old, so that time is never
  earlier than the measurement. The same figures read again keep their first time, so the runner's lag compensation
  holds across passes. The heartbeat relays the kept measurement while the managed runner switch is on; with the
  switch off, management is frozen and the runner gets no budget, as before.
- **Kubernetes backend.** `statfs` is already right. When the owner has not set a floor, the heartbeat answers
  `minFreeDiskMb` as 25% of the PVC's size (the size admission reserved for it). The default is worked out when the
  answer is made and is not stored, so `Runner.minFreeDiskMb` and the auto-run disk gate still read the owner's
  setting.
- **Default floor for managed runners:** 25% of the budget (D5). On a 20 GiB volume that is 5 GiB, which covers the
  120 s measurement lag at the rate checkouts are created.
- **Lag compensation.** Between two channel measurements, the runner subtracts the bytes of checkouts it has removed
  since `measuredAt` (it measures each checkout before removing it). That way one sweep does not reclaim more than it
  needs to while the next measurement is pending. The other way round, it adds the bytes of every session checkout it
  finished making after `measuredAt` (it measures each one once made, `checkoutStorage.made`), so that a new checkout
  counts from the moment it exists rather than from the channel's next measurement. A measurement finished after the
  checkout was made counts it, and the runner drops it from its own count then. One finished while the checkout was
  still being written counts some of it at most, so the runner goes on counting all of it until a later one.
- **Before a new checkout** (owner decision, 2026-11-06). Under a budget with a floor, `addSessionCheckout` estimates
  what the new checkout will take before making it: the apparent size of the files its base commit tracks
  (`git ls-tree -r -l`), of the paths its sparse set keeps. git sorts the paths with the checkout's own patterns
  (`git sparse-checkout check-rules --no-cone`, git 2.42); an older git counts every path. If the free space as judged,
  less that estimate, would fall below the floor, the run loop's one sweeper runs first (`worktreeSweeper.makeRoom`),
  both halves as its schedule runs them, on a reading that counts the checkout as made already. So it takes every
  eligible checkout of an ended session, then resting sessions' checkouts by the rule below until the new one fits. The
  checkout is never refused for want of room: when nothing more can go, it is made all the same, and the log says how
  far short of the floor that leaves the budget. Every door that makes a session checkout (a new session, a pinned run,
  `restoreAbsentCheckout`) runs on the claim loop, as the sweep does. The room is made only once the sweeper is armed.
  Its look at resting checkouts does not wait out the hour that follows a look that found nothing
  (`resumableSweepWait`): a new checkout under the budget's floor is the change that wait assumes has not happened. It
  still goes through the one door to that half (`sweepResumable`) and within its 60-second budget, and a look of its own
  that finds nothing starts the wait for the schedule. Without a budget, a checkout is made as before.
- **Resting checkouts under a budget** (owner decision, 2026-11-06). Below a budget's floor (`underBudgetFloor`),
  `gcResumableCheckouts` may take a resting session's checkout however recently it was written, oldest last write
  first. A commit on the session's own branch counts as kept there, pushed or not: the branch and its commits stay in
  the repository when the checkout goes, and the checkout comes back from the branch, a park checkpoint undone as on any
  resume. That is the case of every resting session that did work, since the runner pushes no session branch. The rest
  of the rule stands. The control plane must answer that the session is resumable, nothing of the session may be at
  work on the runner, and no process or mount may be in the checkout. In `checkoutHasNothingToLose`, no operation may
  be half done, HEAD must be on the session's branch, the base ref must be there, the status must be clean apart from
  dependency and build output, no file may carry an assume-unchanged or skip-worktree mark but a sparse checkout's
  absent paths, and no repository may be nested in a dependency directory. All of this is asked again just before it
  goes. Its branch and base ref stay, and the sweep's 60-second budget holds. The checkout comes back on the session's
  next claim (`restoreAbsentCheckout`). Without a budget, two weeks unwritten (`resumableCheckoutIdle`) and a remote
  for every commit stand.
- **A session's branch while its checkout is away.** Nothing in the runner deletes or prunes a local branch. No call
  deletes a ref under `refs/heads/`. Its `git branch -f` calls move a merge target forward, to a commit that holds its
  old tip, or move an integration line. `git worktree prune` removes only the records of checkouts that are gone, and
  `git gc`, which git may start on its own, deletes no ref and prunes only objects nothing reaches. An agent or a person
  working in the same repository can delete a branch, though. git refuses `git branch -D` of a branch checked out in
  some worktree, and once the checkout is away it no longer does. The commits stay reachable from the absent ref
  (`refs/orbit-absent/<session>`), which points where the branch did when the checkout went. Every door that brings the
  checkout back puts a missing branch back there first (`restoreBranchOfAbsentCheckout`): a claim waking a supervisor,
  a claim, and a pinned claim. A restart does so too, and then leaves the checkout away as for any resting session.
  Without that, the session would be refused, or would start over on a new branch from HEAD, and a later sweep could
  move the absent ref off the old commits.
- **Self-registered runners:** unchanged. The owner's Keep free setting is the floor.

The channel's stop at the limit stays as the backstop. The runner should rarely reach it, because reclamation starts at
the floor.

## 6. Layer 2: repository-declared sparse checkouts

- **Declaration (D2).** The repository holds `.orbit/checkout-exclude`, one pattern per line in gitignore syntax, `#`
  comments allowed. The runner reads it from the session's base commit (`git show <base>:.orbit/checkout-exclude`), so
  it is versioned with the code and can differ per branch.
- **Creating a checkout.** If the declaration exists and git is 2.34 or later: `git worktree add --no-checkout …`, then
  `git sparse-checkout set --no-cone '/*' '!<pattern>' …` in the new worktree, then populate it (`git reset --hard` or
  the clone path of §7). This applies wherever the runner makes a session checkout: a new session, a source-pinned
  session (`setupSourceWorktree`), and recreation of a reclaimed checkout (`restoreAbsentCheckout`). Without the
  declaration, or with an older git, it is a full checkout as today, and the runner logs why.
- **Not sparse:** the workspace's own directory, and the scratch worktrees of integration and merge checks, which run
  test suites that may read anything.
- **Staging.** In a sparse checkout, every `git add -A` the runner runs on a session checkout gets `--sparse`, so that
  files an agent creates under an excluded path are committed rather than dropped with exit 1. The call sites are
  `stagedLiveDiff`, `commitWorktree` and `stageForFinalize` in `worktree.go`, and `discardWorktree` in
  `abandoned_checkout.go`. `initGitRepo` and `rescueWorkingTree` work on the workspace directory and are unaffected.
- **Agents.** The session's start note names the excluded paths and how to bring one in:
  `git sparse-checkout add <path>`. A path brought in stays for that checkout.
- **Diffs and finalize** are unaffected: excluded files keep their indexed content and never show as changes.
- **The Orbit repository's own list** is chosen by measurement, not guessed. Some evidence directories are test
  fixtures (`src/runner-go` tests read several `docs/evidence/*` directories; `src/web/ui-migration` reads
  `docs/evidence/base-ui-migration`). The list is accepted when the project merge check passes in a sparse checkout
  (D6).

## 7. Layer 3: copy-on-write checkout creation

**Capability probe.** At start, and when the worktrees root's filesystem changes, the runner clones a small temporary
file there and caches the answer per device. It uses `ioctl(FICLONE)` on Linux (XFS with `reflink=1`, btrfs, OpenZFS
2.2+ with block cloning enabled) and `clonefile(2)` on macOS (APFS). Neither needs any privilege.

**Template.** The template is the workspace's checkout, which sessions fork from. It must be on the same filesystem as
the worktrees root, or the clone fails with `EXDEV`.

**Creation** (replaces the populate step after `git worktree add --no-checkout`):

1. Copy the template's index into the new worktree's git dir (`$GIT_DIR/worktrees/<id>/index`).
2. For every tracked path in the checkout's sparse set that exists in the template: create its directories, then clone
   the file (preserving the mode), recreate symlinks, and skip gitlinks. Untracked and ignored files are not copied.
3. `git reset -q --hard <base>`. This rehashes the clones once, rewrites any file whose content differs (template edits
   in progress, a base other than the template's `HEAD`), and checks out anything missing. Correctness therefore never
   depends on the template being clean.
4. On any error, remove the partial checkout and fall back to `git worktree add` with a normal checkout. Report which
   path was taken in the runner log and in the session's isolation status.

**As implemented** (`src/runner-go/clone_checkout.go`; `addSessionCheckout` in `sparse_checkout.go`, which every door
above goes through). Two of the steps changed. Both changes were measured with git 2.47.3.

- **Step 1 builds the index instead of copying it.** A copy of the template's index carries the template's marks into
  the checkout: a file marked assume-unchanged keeps the mark, so the session's edits to it never show in status or
  reach the branch, and a file marked skip-worktree stays out of a full checkout while status reads clean. The runner
  writes the checkout's own index with `git read-tree HEAD`. In a sparse checkout it then marks the left-out entries
  with `git sparse-checkout reapply`, which writes no file.
- **Step 2 clones regular files only.** Symlinks have no data to share, and the reset writes them with git's guard
  against a path that leads through a symlink. A symlink the runner made before the clones could lead one out of the
  checkout: on a case-insensitive filesystem (APFS by default) a symlink `A` and a file `a/x` can be in one commit.
- **Step 3 refreshes before it resets.** `git reset --hard` rewrites every entry whose stat data does not match its
  file. That is every clone, so on its own the reset undoes the cloning. `git update-index -q --refresh` runs first.
  After it, the reset rewrites only the files that differ from the commit.
- **The reset is to the checkout's own `HEAD`.** That is the commit `git worktree add` put the checkout on. For a
  checkout recreated on an existing branch it is the branch's tip, not the session's fork point.
- **A failure after `git worktree add`** removes the checkout, which is then made again plainly. A branch the failed
  attempt made with `-b` is used as it stands. A failure of `git worktree add` itself is returned unchanged, since a
  plain checkout would fail the same way.
- **The probe** runs at start and before each checkout, once per device. A template on another device is not tried.
- **The log** names the path taken and why. The isolation status the runner reports stays `worktree`, the one value the
  control plane takes for a session with a checkout of its own. How the checkout was made is kept beside it, in the
  runner (`ClaimedSession.CheckoutCreation`).
- **On darwin** the clone is `unix.Clonefile` from `golang.org/x/sys` v0.30.0 (`docs/dependency-security.md`).

**Cost.** Step 3 rehashes the checked-out bytes: 15–17 s for the full Orbit tree in the experiments, and about 1 s with
the Orbit exclusion list in place. A later optimization can write the index stat data directly for files cloned from
clean template entries (§10).

**Platforms.** macOS on APFS works out of the box (verified). Linux works on XFS (reflink is the default of `mkfs.xfs`
since xfsprogs 5.1; check `xfs_info` for `reflink=1`), btrfs, and OpenZFS with block cloning (on by default in 2.3.9,
off by default in most 2.2.x releases). On ext4, exFAT and network filesystems, the runner falls back. There is no
Windows runner build.

**Implementation.** On Linux, `FICLONE` (`0x40049409`) goes through `syscall.Syscall`, with no new dependency. On
darwin, `clonefile` must be called through libSystem, which means adding `golang.org/x/sys/unix` (`unix.Clonefile`).
Shelling out to `/bin/cp -c` is the fallback design if a new dependency is not wanted.

## 8. Decisions for the owner

| # | Question | A | B | Recommended |
| --- | --- | --- | --- | --- |
| D1 | Where a Docker managed runner gets its budget | The apiserver relays the channel's measurement in the heartbeat; the runner compensates for removals since then | The channel passes the limit in the container environment and the runner walks its own volume | **A**: one measurement, the same one that enforces the limit, and no second walk of the volume |
| D2 | Where sparse paths are declared | `.orbit/checkout-exclude` in the repository | A workspace setting (API, database column, UI on every client) | **A**: versioned with the code, works on every runner, no client work. B can be added later as an override |
| D3 | Should the Docker limit count clones once | No: keep logical accounting; clones save host disk only | Yes: the channel measures physical extents (FIEMAP), at a higher cost per measurement | **A** for this project; revisit if hosts adopt XFS |
| D4 | Kubernetes PVC filesystem | Keep ext4 | Switch the StorageClass to `xfs` so that pods can clone | **A** for now: switching requires re-running the durability and power-cut drills |
| D5 | Default floor for managed runners | 25% of the budget | A fixed size (for example 4 GiB) | **A**: it scales with the budget |
| D6 | The Orbit repository's exclusion list | Start with `docs/mocks/` and the evidence directories that no test reads | Exclude all of `docs/evidence/` and fix tests to fetch fixtures | **A**, settled by the merge check in a sparse checkout |

## 9. Phases

| Phase | Work | Proves |
| --- | --- | --- |
| P1 | Layer 1: budget in `worktreeGCPressure`; the apiserver relays the channel's volume measurement; default floors for managed runners | A managed runner reclaims checkouts before the channel stops it |
| P2 | Layer 2: `.orbit/checkout-exclude`, sparse creation, `add --sparse`, the agent note; then the Orbit repository's own list | Sparse session checkouts everywhere, and new files under excluded paths still committed |
| P3 | Layer 3: probe, clone creation and fallback on Linux and macOS; operator documentation | A cloned checkout costs megabytes on capable filesystems and is indistinguishable to git |

P1 does not depend on P2 or P3. P3 benefits from P2 (smaller rehash) but does not need it.

## 10. Later, outside this project

- Write the index stat data for cloned clean entries directly, skipping the rehash.
- Clone ignored dependency directories (`node_modules` and the like) from a retained checkout with the same lockfile
  hash. The 32 retained checkouts are kept for these directories already.
- Physical accounting in the channel (D3 B), and `xfs` PVCs (D4 B).
- Default floors for self-registered runners.

## 11. Test plan

- **runner-go unit tests:** pressure with and without a budget, including lag compensation; sparse creation and
  `add --sparse` staging (a new file under an excluded path ends up in the session commit); the clone path with a
  simulated clone failure (`EOPNOTSUPP`, `EXDEV`) falling back to plain creation; the clone path asserting a clean
  status, no diff against the base, modes, symlinks, and an untouched template.
- **Managed runner lab** (`docs/managed-runner-lab.md`): fill a runner's volume past its floor with session checkouts and
  show reclamation before `VOLUME_OVER_LIMIT`.
- **Filesystems:** run the real creation path on an XFS-backed volume (Linux) and on orbit-macos (APFS), and record
  bytes and time against a plain checkout.
- **Orbit repository:** the project merge check passes in a sparse session checkout with the chosen list.

## 12. Risks

- **A template on another filesystem** (a repository on a data disk, `$ORBIT_HOME` on the system disk): clones fail
  with `EXDEV` and the runner falls back. The log says so; moving `$ORBIT_HOME` is the operator's fix.
- **Rehash time** grows with checked-out bytes. Sparse checkouts and the later index fast path address it.
- **Agents that need an excluded path** must add it. The start note says how, and a missing path shows up as a missing
  file rather than as a wrong result.
- **Page cache is not shared between clones,** so reading the same file in many checkouts costs memory as before. This
  does not change disk usage.

## Appendix A: measuring a cloned checkout

Run it in a scratch directory on the filesystem under test; it only reads the source repository.

```sh
git clone -q --no-checkout --shared <repo> repo && git -C repo checkout -q --detach <sha>   # the template
git -C repo worktree add -q --detach ../wt-plain <sha>                                       # baseline
git -C repo worktree add -q --no-checkout --detach ../wt-cow <sha>
cp repo/.git/index repo/.git/worktrees/wt-cow/index
# Linux: clone each tracked file
(cd repo && git ls-files -z | xargs -0 cp -d --preserve=mode,timestamps --reflink=always --parents -t ../wt-cow/)
# macOS: clone the tree, then put the worktree's own .git file back
#   cp -c -R repo wt-cow.tmp && rm -rf wt-cow.tmp/.git && mv wt-cow/.git wt-cow.tmp/.git && rmdir wt-cow && mv wt-cow.tmp wt-cow
git -C wt-cow update-index -q --refresh
git -C wt-cow status --porcelain | wc -l      # 0
git -C wt-cow diff --stat <sha> | wc -l       # 0
```

Compare `df` before and after each step, with `sync` first. On a shared volume, other writers make the clone's delta
noisy: a dedicated test filesystem gives a clean number.
