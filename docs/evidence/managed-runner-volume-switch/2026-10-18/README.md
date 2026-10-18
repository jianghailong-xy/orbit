# A restored volume put back under its runner (T08b)

Task T08b (34i56C5JtAxTbj1iN8Glu) of the managed-runner project, 2026-10-18: an administrator's switch of a Kubernetes
runner's data volume to a restored one, verified by the manager and recorded, and a run of it on the single-machine lab's
real k3s. T08 found the gap: a restored volume had no way back under an account's runner, and a runner whose volume was
lost stayed `FAILED` `PVC_MISSING` for good. The runbook's procedure is
[Put a restored volume back under its runner](../../../managed-runner-kubernetes-operations.md#put-a-restored-volume-back-under-its-runner);
the design's record is [Implementation record: a restored volume back under its runner](../../../managed-runner-design.md#implementation-record-a-restored-volume-back-under-its-runner);
the lab page's section is [A restored volume back under its runner (T08b)](../../../managed-runner-lab.md#a-restored-volume-back-under-its-runner-t08b).

## What changed

| Commit | What |
| --- | --- |
| `a03147a29` | `POST /api/admin/managed-runners/:id/volume-switch` (`managed-runner-admin.controller.ts`, behind JwtAuthGuard, the managed switch and AdminRoleGuard, no personal access token); the manager's `switchVolume` and `commitSwitch` (the checks under the mapping's lease, then one transaction with the audit row); the Kubernetes reads `readReplacement` and `recordedVolumeHolders`; the state rule and the refusal checks (`managed-runner-volume-switch.ts`); the DTO, the write inventory entry, the census's reading by hand, unit specs, and the route in the off specs |
| `09dbfd04f` | `managed-runner-volume-switch.pg.spec.ts` |
| `22bbc0d31` | `scripts/managed-runner/lab/switch-lab.py` and its offline test in `lab_test.py` |
| `eccae61cd` | The lab's finding fixed: a replayed switch is answered from a read, not refused while a manager pass holds the lease |

No migration: the audit record is an `activity` row (type `managed_runner.volume_switched`). Nothing under
`deploy/managed-runner/image` or `src/runner-go` changed, and no client changed.

## The run

One command, `scripts/managed-runner/lab/switch-lab.py run`, ran every phase in order at `eccae61cd` (on the project tip
`a444c703a`; record 001) against a fresh database (`test-server-t08b`), and stopped at nothing: **22 steps, 78 checks, all
passed, 2026-10-18 15:18:39–15:26:40 UTC (8.0 minutes)**. It ran as a transient systemd unit outside the Orbit runner's
cgroup. `steps.jsonl` has each step's time and checks, `records/NNN-*.json` each step's full result, `report.json` the
intervals quoted here (`switch-lab.py report`), and `secret-scan.json` the scan of the run's records for every credential of
the run (`acceptance-lab.py secret-scan`): none found.

| Phase | Steps | Checks | Seconds | What |
| --- | --- | --- | --- | --- |
| facts | 5 | 7 | 6.5 | versions, topology and resource limits: T08's lab, unchanged ([its evidence](../../managed-runner-acceptance/2026-10-18/README.md#the-environment)) |
| setup | 2 | 5 | 102.2 | the shared lab units restarted for this directory, the gate, no webhook yet; the administrator signed up with the switch unset, so it has no runner |
| on | 3 | 3 | 13.4 | the lab profile (a budget of two runners, idle after 90 s), the switch on, the admission guard installed |
| account | 2 | 3 | 32.9 | ann signs in, READY on a fake-model key; a first session with an attachment and a file the engine commits in its worktree |
| backup | 3 | 16 | 200.3 | data on the volume while a turn keeps the runner up, a snapshot of it; ann disabled and asleep; her RBD image exported out of the VM and checked there |
| loss | 2 | 10 | 11.1 | her claim, PV and RBD image deleted; enabled, a message: the wake fails `PVC_MISSING` |
| restore | 1 | 8 | 18.4 | the runbook's restore into a new claim under the runner's name; the guard keeps a check Pod off it; the manager adopts nothing |
| switch | 1 | 9 | 0.4 | refusals first, then the administrator's switch and its audit row; a replay |
| wake | 1 | 11 | 51.9 | the waiting message wakes ann on the restored claim; her data, SQLite and engine session as backed up |
| final | 2 | 6 | 44.5 | consistency, the timeline, Ceph; ann asleep; the window closed |

### Before the loss (records 011–015)

- ann signed in (the switch on); her mapping, claim and Pod were made and she was READY on a fake-model key
  (`initialProvider` `deepseek`). Her first session carried an attachment, and the engine committed a file in the
  session's worktree with its own Bash tool (`FAKE-WRITE`).
- With a 150 s turn keeping the runner up, the probe wrote 8 MiB of random bytes, 150 SQLite rows in WAL mode with
  `synchronous=FULL` (`integrity_check` `ok`) and a Git commit under `/var/lib/orbit/home/t08-probe/b152114`, and a snapshot
  recorded every upload, worktree file, engine transcript and SQLite file on the volume with its checksum.
- Disabled by the administrator, she was asleep 28.4 s later: no Pod, no attachment, no RBD watcher.
- Her 2 GiB image `csi-vol-1e64aa21-…` was exported out of the VM to `/mnt/data/managed-runner-lab/backups/t08b-20261018T152419Z`
  in 8.2 s (18.2 MB gzip; raw SHA-256 `37be4e5b…`) and copied to the host in 0.2 s. There it was checked with no cluster in
  4.4 s (`debugfs`): ext4 clean, the probe's bytes, rows and commit, every upload, the engine's commit, every SQLite file
  `ok`, `git fsck` clean, ann's runner identity and her transcripts.

### The loss (records 016–017)

- The claim `mr-data-01a14f99-caed-762f-92e2-6291c6d5ab95` (UID `be5549db-…`) was deleted, then its PV (Released, kept by
  `Retain`), then its RBD image (`rbd rm`). The backup is all that is left of the data.
- ann enabled again and signed in; a message to her session. The wake failed `PVC_MISSING` 0.6 s after the message, not
  retryable: no claim was made in its place, and the mapping still recorded the lost volume. The message waited
  (`PENDING`). Every client shows "Managed runner failed" with the reason's sentence.

### The restore (record 018)

- A claim under the runner's name, from the runbook's manifest (`switch-lab.py restore_claim_manifest`, held by
  `lab_test.py` to the repository's PVC template): the owner and runner annotations, `runner-data`, `ReadWriteOnce`,
  `Filesystem`, 2Gi. It was `Bound` at once to a new PV `pvc-92140165-…` (UID `44cad2a0-…`) and image `csi-vol-9bce2a80-…`.
- The backup went into that image as T08's restore writes it (a scratch import, `export-diff | import-diff`, the scratch
  removed), and the image read back with the backup's SHA-256 (`37be4e5b…`). The claim, its binding and the write took
  17.1 s, the step 18.4 s.
- A check Pod on the claim was refused by the admission guard: `orbit-managed-runner-admission: NOT_THE_MANAGER: only the
  managed runner manager may create a Pod that uses a managed runner volume`. No such Pod existed afterwards.
- The manager, looking at the failed runner each pass, adopted nothing. The reason stayed `PVC_MISSING`, with the detail
  "a PVC under its name is not the recorded one: PVC_CONFLICT: the PVC under this name has a different UID from the one
  recorded".

### The switch (record 019)

- ann's own request: 403. The administrator naming another UID: 409 `VOLUME_NOT_VERIFIED`. A stale revision: 409
  `MANAGED_RUNNER_REVISION_CONFLICT` with the current revision. Nothing switched, and no audit row.
- The administrator's switch, with the claim's UID and the current revision: 200 in 0.4 s, at 15:25:04.219Z.
  `managementState` `SLEEPING`, `desiredState` `RUNNING` (the waiting message's demand), generation 2;
  `from` claim `be5549db-…`, PV `0da9bf74-…`, handle `…-1e64aa21-…`; `to` claim `92140165-…`, PV `pvc-92140165-…`
  (`44cad2a0-…`), handle `…-9bce2a80-…`.
- One `activity` row, `managed_runner.volume_switched`: `actor_id` the administrator, `credential_kind` `LOGIN`, created
  15:25:04.219, and in its payload the mapping, owner, runner, backend, cluster and namespace, generation 2, the state
  before (`FAILED`, `RUNNING`, `PVC_MISSING`), `from` and `to`, `retired` null, `confirmedReplacement` false, the reason
  given and the idempotency key.
- The same request again, at once: 200 `replayed`, no second row.

### The wake (record 020)

| When (UTC) | What |
| --- | --- |
| 15:25:04.219 | the switch |
| 15:25:04 | the generation's bootstrap Secret and the runner's Pod `mr-01a14f99-…` created |
| 15:25:18 | the runner container started |
| 15:25:27.794 | the waiting message answered (23.7 s after the switch), on ann's runner |
| 15:25:48.670 | the runner's engines reported |
| 15:25:55.101 | READY (51 s after the switch) |

- The same runner ID (`01a14f99-caed-…`) and workspace; the claim name kept, its UID, PV, handle and image the restored
  ones. Generation 2, the one the switch left reserved; the backed-up volume had last run generation 1. The Pod's
  `orbit.dev/pvc-uid` annotation was the restored claim's UID, its one claim the runner's. The image's entrypoint
  recorded the volume for this instance (`managed-instance.json`: generation 2, the new Pod's UID).
- The engine resumed the session: its next request carried the earlier conversation, from the volume.
- The probe written before the backup: the same random bytes, the same 150 rows and row hash, the same Git commit,
  `integrity_check` `ok`. Every upload, worktree file and transcript as in the snapshot taken before the backup, the
  runner ID the same, every SQLite database on the volume `ok`, `/var/lib/orbit` an ext4 RBD device.

### At the end (records 021–022)

The database and k3s agreed. The recorder's timeline (sampled every second, 31 changes written) never showed more than one
Pod on the runner's volume name. Ceph was `HEALTH_OK`, the lost image gone and the restored one there. ann was put to sleep
on the restored claim. The webhook was removed and the test server and gate stopped; then the VM was stopped.

## The trial run

The first full run (2026-10-18 14:57–15:04, at `22bbc0d31`; `trial/`) passed every step up to the switch, whose last check
failed: the same request sent again right after the switch was refused `409 MAPPING_BUSY` (`trial/records/019-switch-switch.json`).
The switch kicks the manager, whose wake pass held the mapping's lease when the replay came. A replay of an applied switch
is read-only, so it is now answered from a read before the lease is taken (`eccae61cd`), and the pg spec replays while
another holder has the lease. Continued from its wake phase, the trial passed every check of the wake but one of the
driver's own: it judged the woken generation against the identity read after the sleep, which already names the next one
(`trial/records/020-wake-restored.json`); the driver now judges it against the last generation that ran on the volume. Its
directory is `test-server-t08b-dev`. A run before it stopped at its first Ceph check, Ceph still `HEALTH_WARN` right
after the VM booted.

## Tests

The code's own tests are `managed-runner-volume-switch.pg.spec.ts` (each case listed in the design's record), the unit
specs `managed-runner-volume-switch.spec.ts` and `managed-runner-disabled.spec.ts`, the route in
`managed-runner-boot.pg.spec.ts`, the census's reading by hand, and `lab_test.py`'s check of the restored claim's
manifest. The final tip's checks (the project's merge check, the managed-runner Python tests, all fourteen managed-runner
pg specs and both tenant-isolation censuses) are recorded with the task's evidence rather than here, so that the tip they
ran on is the one that carries this file.

## Left in the lab

`test-server-t08b` (ann SLEEPING on her restored claim `mr-data-01a14f99-…`) and the trial's `test-server-t08b-dev` (its
ann SLEEPING on its own restored claim `mr-data-01a14f86-…`); both restored claims with their PVs and images, as retained
test data; the backups `backups/t08b-20261018T150259Z` (the trial's) and `backups/t08b-20261018T152419Z` (0700). The lost
volumes' claims, PVs and images were deleted, as the test required. The webhook is removed, the test server, gate and
recorder are stopped, and the VM is off.

## Not established here

- Anything across nodes: the lab has one node. A switch whose restored claim attaches on another node than the lost one's
  is for a multi-node cluster (T08x).
- That no Ceph client maps an old image: the manager cannot see Ceph clients, so the runbook makes it the operator's check
  (`rbd status`). In this run the old image had been deleted.
- A runner that failed `PVC_MISSING` while fencing: refused, and not reached here.
- A real model: fake-model.py stood in for the owner's DeepSeek key, whose file did not exist.
