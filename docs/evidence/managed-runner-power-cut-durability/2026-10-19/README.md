# A managed runner's Git work and its engine's last turn through a node's power cut, before and after (2026-10-19)

Task T02c (34ieaGY94CxelffWA9q66) of project 34ZteKCnYMpKY46f63Leb, part of criterion 2. It handles two findings:

- T02's finding 2 ([its evidence](../../managed-runner-cross-node/2026-10-19/README.md#findings)): Git work of the last
  seconds before a node's power cut can leave a repository unreadable.
- T08x's finding ([its evidence](../../managed-runner-cross-node-accounts/2026-10-19/README.md#findings)): a turn
  answered seconds before the cut is missing from the engine's transcript.

The change is in `src/runner-go` (commits `0e894464e` and `5928c0e0a`). The approach, what it covers and what it costs are
in [the design record](../../../managed-runner-design.md#implementation-record-git-work-and-engine-sessions-through-a-power-cut).
On the lab's two nodes the same run was made twice: once with the project line's runner, once with this change. Times
are UTC.

**What these records cannot show.**

- Both VMs are on one physical machine, with one power supply, one HDD and one failure domain. Ceph is a single-host
  cluster in the first VM: three OSDs on one disk.
- "Powered off" means the second VM's qemu was killed on the host (`stop.sh --node 2 --hard`), with no shutdown inside
  the guest.
- No model was used. fake-model.py answered as a DeepSeek-preset key: its `FAKE-WRITE` makes Claude Code's own Bash tool
  commit a file, and its `FAKE-HOLD` keeps a turn open after that tool returns.
- The lab's storage is slow (three replicas on one HDD inside VMs), so the costs below are not a real cluster's.

## Where it ran

| Part | Value |
| --- | --- |
| Lab | Both VMs as L1 left them ([records/002](records/002-facts-host.json), [003](records/003-facts-cluster.json), [004](records/004-facts-ceph.json)): Ubuntu 26.04.1, kernel 7.0.0-34-generic, k3s v1.36.5+k3s1 and containerd 2.3.4-k3s1.36 on both nodes, `orbit-mr-lab` (10.77.0.1) and `orbit-mr-lab-2` (10.77.0.2). Ceph 20.2.4 Tentacle, pool `orbit-mr-rbd` size 3, `min_size` 2, 32 PGs. Ceph-CSI v3.18.0. Booted by `start.sh --nodes 2` at 16:38, healthy at 16:42 ([logs/00-start-both.txt](logs/00-start-both.txt)); off again at 17:52 ([logs/99-stop-both.txt](logs/99-stop-both.txt)). |
| Host | HPC (`workstation`): Debian 13, kernel 6.12.107, 24 CPUs, 15357 MiB. The VMs' units outside the runner's cgroup (`MemoryMax` 6656M and 3584M, `OOMScoreAdjust` 1000). Before the boot, another session's pg-spec matrix was waited out (it ended at 16:38:17); no dind host or other experiment ran. |
| The volume | StorageClass `runner-data`: `rbd.csi.ceph.com`, `mounter: rbd`, ext4, `Retain`, RWO. Inside the Pod: ext4 on `/dev/rbd*`, `rw,relatime`, with `delalloc`, `auto_da_alloc`, `barrier`, `data=ordered`, `commit=5` ([records/008](records/008-timing-git.json)). Git 2.47.3 in the runner image. |
| Test server | This checkout's apiserver (built at 16:20; this task changes no apiserver code, so it is the project line's `326f43dc0`), with its own PostgreSQL, TLS front and fake model on 127.0.0.1, in `LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t02c`. Its manager reached k3s through manager-lab.py's gate as the least-privilege ServiceAccount. The profile: a budget of two runners, 2 GiB volumes, `idleSeconds` 3600, the runner's `maxConcurrent` 2 ([records/011](records/011-on-prepare.json)). The admission webhook was installed for the run and removed at its end. |
| Images | Each is `deploy/managed-runner/image` with the lab CA layer, built by [kit/build-image.sh](kit/build-image.sh) and imported into both VMs' containerd. Nothing was pushed ([records/005](records/005-facts-images.json), [025](records/025-switch-image.json), [039](records/039-damaged-start.json)). |
| | **before**: the project line's runner, T02's build from `8055bb568` (no runner-go change since), `orbit-managed-runner-lab@sha256:6483cb75…` |
| | **after**: this change, `0e894464e`, `sha256:76635be1…` |
| | **final**: this change and its follow-up, `5928c0e0a`, `sha256:7b6b64fb…`, used for the damaged volume at the end |
| Driver | [scripts/managed-runner/lab/durability-lab.py](../../../../scripts/managed-runner/lab/durability-lab.py), in a transient unit (`MemoryMax=1G`). It writes one record per step ([steps.jsonl](steps.jsonl), [logs/run.txt](logs/run.txt)) and stops at the first failed check. A recorder sampled the database and k3s every second ([logs/timeline.jsonl](logs/timeline.jsonl)). |

**How the run went.** 41 steps were recorded with 204 checks. Four steps failed and were fixed or run again:

- `before/last` ([016](records/016-before-last.json)), with ann, stopped before its cut. The driver read the last turn
  by an id the answer to a new turn does not carry. ann's last turn and merge had run, so she was put to sleep, and the
  before run was done again from the start with a new account, amy ([017](records/017-before-ready.json) onward).
- `before/left` ([020](records/020-before-left.json)) read amy's copy but failed in its cleanup, since `rbd import-diff`
  leaves its snapshot on the copy. The snapshot of amy's own image was still there and nothing had been failed over, so
  the read was done again from it ([021](records/021-before-left.json)).
- `damaged/wake` ([036](records/036-damaged-wake.json)) waited 420 s in vain: the final teardown had stopped the
  manager's gate, which the epilogue did not start again.
- `damaged/wake` again ([038](records/038-damaged-wake.json)), on `0e894464e`: the runner refused the reclaimed session
  and then answered its next message anyway. `5928c0e0a` fixes that, and the wake was done again on its build
  ([040](records/040-damaged-wake.json)).

## The run

For each account (amy before the fix, bob after it), the driver did this:

1. **Ready.** The account signed in with the first node cordoned. Its runner ran on the second node: amy's
   `01a15527-25d2-…` on the before image, bob's `01a1552f-13b7-…` on the after image ([017](records/017-before-ready.json),
   [026](records/026-after-ready.json)).
2. **Sessions.** Two sessions, s1 and s2, each with a file the engine committed (`FAKE-WRITE`). An uncommitted file was
   left in s2's worktree.
3. **The last seconds** ([019](records/019-before-last.json), [028](records/028-after-last.json)):
   - The volume was synced in the runner container first, so that only these seconds were under test.
   - s3, a new session: its runner made the checkout, its engine committed, and the answer to that commit was held, so
     its turn was still running at the cut.
   - s2: the runner was asked to commit the uncommitted file, then to merge s2's branch into the workspace's `master`.
     The merge's answer came back when the runner had done it.
   - s1: a last turn whose engine committed a file and then answered.
   - Then the second VM's power was cut.
4. **What the cut left** ([021](records/021-before-left.json), [029](records/029-after-left.json)):
   - An RBD snapshot of the runner's image was taken while nothing mapped it, about 30 s after the cut.
   - The snapshot was copied into a new claim and read on the first node by a Pod of the runner image, as the runner's
     user, at the runner's path: the volume as the next node would find it, before any runner touched it.
   - The copy, its claim, PV and image, and the snapshot were then removed.
5. **The failover**, by the runbook as in T02: receipt, out-of-service taint, finalizer
   ([022](records/022-before-fence.json), [030](records/030-after-fence.json)).
6. **The resume** ([023](records/023-before-resume.json), [031](records/031-after-resume.json)): the next generation's log,
   its repositories, and a message to s1, whose model request shows what the engine resumed.
7. **The second node back** and the account asleep ([024](records/024-before-rejoin.json), [032](records/032-after-rejoin.json)).

| Seconds before the cut | Before (amy) | After (bob) |
| --- | --- | --- |
| The runner's merge returned | 0.0 | 0.0 |
| The last turn answered | 0.0 | 0.0 |
| The engine's commit in it (its result ingested) | 0.4 | 0.9 |
| The runner's commit reported | 1.5 | 2.3 |
| s3's engine commit, its turn still running | 2.3 | 4.3 |
| The cut | 17:13:54.395 | 17:22:46.722 |

### What the cut left, before and after

| | Before: the project line's runner | After: this change |
| --- | --- | --- |
| The workspace repository | Unreadable: `master` points at `22957bc…`, the runner's merge, whose object file is empty. `git fsck` exit 11 | Reads; `master` at the runner's merge `9ff3e72…`; `git fsck` clean |
| s1, the last turn's worktree | Unreadable: its branch points at the engine's last commit `8b58c46…`, whose object file is empty | Reads; its branch at the engine's last commit `88ea88c…`; clean |
| s2, the runner's commit | Unreadable: its branch points at `22957bc…` (empty) | Reads; its branch at the runner's commit `9ff3e72…` (also the merge); clean |
| s3, made in the last seconds | Its `.git` names no repository: the worktree's `HEAD`, `gitdir` and `commondir` are empty | Reads; its branch at the engine's mid-turn commit `d29da69…`; clean |
| Empty files | 9 loose objects, the three commits of the last seconds among them, `ORIG_HEAD`, a reflog, s3's base ref, s3's and a rebase scratch worktree's metadata | None |
| Locks left | None | None |
| s1's transcript | 30 lines; none of the last turn's | The last turn's message and its final answer are there |
| s3's transcript | 0 bytes | 28 lines |

The returned commits are the engine's last commit (its turn had ended), the runner's commit, and the runner's merge.
Before the fix all three were unreadable. After it all three were on their branches, and so was s3's commit, made in a
turn that was still running.

### The resumed session

| | Before | After |
| --- | --- | --- |
| The next generation's start | Nothing about the repositories | `volume check: 4 checkouts in 1 repositories after start; 0 stale lock files removed, 0 branches restored, 0 checkouts damaged` |
| The message after the takeover | Answered 1.6 s after it was sent, by the new generation | Answered 0.7 s after it was sent |
| What the engine resumed | 8 messages, the first turn's secret only: the last turn was gone | 14 messages, the first and the last turns' secrets |
| The repositories on the runner afterwards | Still unreadable; the session ran in its broken worktree | All read; `git fsck` clean |

### The damaged volume on the fixed runner

amy's volume, as the before run's cut left it, was woken on the final build `5928c0e0a` by a message to s1
([039](records/039-damaged-start.json), [040](records/040-damaged-wake.json)):

- The runner's start logged each repository with its reason, for example: `volume check: the Git repository at
  /var/lib/orbit/home/orbit-repos/default cannot be read: commit 22957bc…, where its branch master points, cannot be read`.
  The summary said `4 checkouts damaged`.
- The reclaimed sessions were refused: `not starting: REPOSITORY_DAMAGED: …`.
- The message's session ended `FAILED` with the reason as its error: `REPOSITORY_DAMAGED: the Git repository at
  /var/lib/orbit/home/orbit-repos/default cannot be read: commit 22957bc…, where its branch master points, cannot be
  read. The runner does not work in a damaged repository or start a new one over it: repair it, or move it aside to start
  afresh, then try again`.
- The fake model was never asked about that message.
- The workspace's `HEAD` still named `master`, and its objects were still the empty ones: no new repository was started
  over the broken one.

On `0e894464e` ([038](records/038-damaged-wake.json), [logs/run.txt](logs/run.txt)) the same wake showed a gap. The
runner refused the reclaimed session, but the claim that woke its supervisor brought a fresh payload without the
refusal. The engine then ran in the runner's own directory and answered. `5928c0e0a` carries the refusal across with
the checkout in `sessionPool.activatePrepared`, and unit tests cover it at the pool and through the supervisor.

## T07's leftover Pod

`mr-01a14db1-e2b6-7199-8613-d95d4616d6a7` (UID `52ed1c8a-1ba8-43b5-a563-347bb26f9038`) on `orbit-mr-lab` had been
`Terminating` since T08x's drain at 14:48:34, held by the stop-report finalizer. Whose it was:

- [logs/t07-database.txt](logs/t07-database.txt): T07's test server database, read in a copy
  (`test-server-t07/pgdata` copied, a temporary `postgres:16-alpine` with no network, both removed after).
  - Its `runner` row is `01a14db1-e2b6-…`, owner `t06-root@lab.invalid`.
  - Its `managed_runner` row names this Pod by name and UID, generation 1, `STARTING`, last updated 2026-10-18 06:29.
- [records/007](records/007-stuck-t07.json): the runbook's checks before release.
  - The Pod's annotations name that runner.
  - Its kubelet had reported the stop: `Failed`, every container terminated, on 2026-10-18.
  - Its node was `Ready`.
  - Its `DisruptionTarget` was `EvictionByEvictionAPI` (T08x's drain), not PodGC's or the taint manager's.
  - No VolumeAttachment; both lab apiserver units stopped.

The runbook's patch ("The stop-report finalizer", run as written with `R` set) released it at 16:44:58, and the object
was gone 0.9 s later.

## Git's own fsyncs and what they cost

- **What Git covers**, traced with strace on the host for Git 2.47.3, the image's version
  ([kit/git-fsync-coverage.py](kit/git-fsync-coverage.py), [records/git-fsync-coverage-host.json](records/git-fsync-coverage-host.json)):
  - With `core.fsync=all`, loose objects, refs, `packed-refs` and the index are fsynced before they are put in place.
  - `HEAD`, a worktree's `HEAD` and metadata, reflogs, config and checked-out files never are, and `git init` makes no
    fsync at all.
  - A command's last rename is left to the next journal commit: 10 of 15 ref writes and 4 of 11 index writes were not
    durable when their command returned.
  - With Git's defaults, nothing but packs and the commit-graph is fsynced.
- **What they cost** ([kit/git-commit-timing.py](kit/git-commit-timing.py)). Medians, in milliseconds unless marked s:

| Storage | Commit | Git's defaults | defaults, then `syncfs` | `core.fsync=all` | `all`, `fsyncMethod=batch` |
| --- | --- | --- | --- | --- | --- |
| Lab: ext4 on RBD, a claim of the runner class on the second node ([records/008](records/008-timing-git.json)) | 1 file | 49 | 299 | 893 | 1103 |
| | 200 files | 162 | 1039 | 59.2 s | 19.1 s |
| Host: ext4 on HDD, load 7–10 ([records](records/git-commit-timing-host-hdd.json)) | 1 file | 7 | 71 | 109 | 228 |
| | 200 files | 22 | 129 | 4.71 s | 192 |
| Host: ext4 on NVMe ([records](records/git-commit-timing-host-nvme.json)) | 1 file | 4 | 15 | 25 | 26 |
| | 200 files | 19 | 26 | 560 | 45 |

On the lab's volume a `syncfs` with nothing dirty took 0.1 ms, after 1 MiB written 0.78 s, and after 64 MiB 5.3 s.

## Findings

1. **The project line's runner loses the last seconds' Git work and turn, as T02 and T08x found, and keeps working on
   what is left.** Everything committed in the 2.3 s before the cut came back as empty objects behind refs that
   survived, so all four repositories were unreadable. The last turn was missing from the transcript and from the
   resumed session, and the session went on in a repository that fails `git fsck`.
2. **This change keeps it.** With the runner syncing its volume before every report and behind every tool:
   - every repository read and `git fsck` was clean after the same cut;
   - every commit that had returned was on its branch, the mid-turn one too;
   - the last turn was in the transcript and in the resumed session.
3. **A damaged repository is now said, not worked in.** The volume damaged before the fix, woken on the final build,
   was reported repository by repository at start, and its session failed with the reason. This took a follow-up
   (`5928c0e0a`): a reclaimed session's refusal was lost when a claim brought a fresh payload.
4. **Git's own fsyncs were not the answer here.** They leave `HEAD`, reflogs, worktree metadata and checked-out files
   out, and on the lab's volume they made a 200-file commit take 59 s instead of 0.16 s. A `syncfs` after it took 1.04 s
   and covers all of it.

## Not established here

- What a cut inside the background sync's own window (0.3–1 s after a tool on this storage) leaves. The start-time
  check's restore of an empty or missing branch was covered by unit tests, not by a cut in the lab.
- The Docker backend: the same runner code, but a volume that is a directory of the host's filesystem. A `syncfs` there
  writes back everything dirty on that filesystem; it was measured on the host's disks only, not on a Docker host under
  load.
- A real model, other engines than Claude Code in the lab (they share the tool-result path, covered by a unit test for
  Claude), availability across physical machines.

## Left in the lab

- `test-server-t02c`: ann, amy and bob SLEEPING on their claims, with their claims, PVs and images (`Retain`), and the
  receipt ConfigMaps of amy's and bob's failovers ([logs/90-inventory-before-stop.txt](logs/90-inventory-before-stop.txt)).
- amy's volume keeps the before run's damage, as test data.
- The snapshot copies (claims, PVs, images) and both snapshots were removed.
- The webhook was removed. The test server, its replica, the gate and the recorder were stopped, and both VMs were off at
  17:52.
- No record holds a credential: `durability-lab.py secret-scan` over this directory, against `test-server-t02c`, found
  none of 20 server credentials and 3 runner credentials in 63 files.

## Checks

- **The tip.** `origin/project/34ZteKCnYMpKY46f63Leb` (`326f43dc0`) and `origin/main` (`e7168b246`) were both already
  in the branch: `git merge --no-ff` of each said "Already up to date". `git merge-tree --write-tree e7168b246 HEAD` was
  clean and gave HEAD's own tree ([logs/merge-ritual.txt](logs/merge-ritual.txt)).
- **The gate.** [kit/gate.sh](kit/gate.sh) ran on the tip `09d69958b`, one step after another, in a transient unit
  outside the runner's cgroup (`MemoryMax=9G`), at a host load of 4–9
  ([logs/gate-steps.txt](logs/gate-steps.txt), [logs/gate-results.txt](logs/gate-results.txt)):

| Step | Result |
| --- | --- |
| `npm run test:compose-topology` | 16 of 16 |
| `npm run prisma:generate`, `npm run build` | exit 0 |
| `npm test -w @orbit/shared` | 491 of 491 (32 files) |
| `npm test -w @orbit/apiserver` | 5320 of 5320 |
| `npm test -w @orbit/web` | 5368 of 5368 (414 files) |
| managed-runner Python, `python3 -B -m unittest discover -s scripts/managed-runner -p '*test*.py'` | 233 tests OK, among them `DurabilityLabTest` (the driver's reading and judging of a volume) and fake-model.py's `FAKE-HOLD` |
| runner-go, `go test -count=1 ./...` (run, not read from the cache) | `ok orbit 308.5s` |

**runner-go's new behavior and its tests** (all in that run):

- The volume sync, only on a managed runner, bounded for storage that does not answer:
  `volume_durability_test.go`.
- The sync before the reports of a commit, a merge, an integration result and a session's checkout:
  `volume_durability_ops_test.go`.
- Through the real supervisor and a scripted Claude, `volume_durability_session_test.go`:
  - a sync behind the engine's tool and before the turn's end and the session's end are reported;
  - a session refused at reclaim stays refused when a claim wakes it.
- The real `syncfs`: `volume_syncfs_linux_test.go`.
- The start-time check, `managed_repo_recovery_test.go`:
  - locks no process holds removed, a held one kept;
  - an empty and a missing branch restored from their reflogs;
  - an unreadable commit left and reported;
  - each kind of damage worded;
  - a session in a damaged repository or worktree refused, with no new repository started over it;
  - a self-managed runner unchanged.
- The refusal carried across a claim: `session_pool_test.go`.

In this session, each of the turn's, the session end's and the tool's syncs, the claim-time refusal, the lock-holder
check and the refusal's carry-over was taken out once. Each time the test that covers it failed, and it passed again
with the code back.

**Not run, and why.** The apiserver's pg specs: no apiserver, shared or web code changed. The change is runner-go, lab
tooling under `scripts/managed-runner/lab/`, its offline tests, the design record, the lab page, the runbook and this
evidence.

This section, the gate's logs and the merge record, and nothing else, were added after the gate ran.
