# Runner image in the lab (task T03)

The records behind [docs/managed-runner-lab.md, "Runner image (T03)"](../../managed-runner-lab.md#runner-image-t03):
the optional runner image built on the host, imported into the single-machine lab's k3s, and run on
a Ceph RBD claim through its standalone enrollment path, plus one managed first session for T05.
Environment: the authorized lab (one KVM VM, k3s v1.36.5+k3s1 single-node mode, Ceph 20.2.4,
Ceph-CSI v3.18.0, StorageClass `runner-data`, namespace `orbit-mr-test`), the isolated test control
plane on the host's 127.0.0.1 (`test-server.sh`), reached by Pods at `https://10.0.2.2:13711`. No
production server, image registry or other Kubernetes context was used.

| Round | When | Model | Image |
| --- | --- | --- | --- |
| 1 | 2026-10-17 06:43–08:12 UTC | none: a closed endpoint and `fake-model.py`, which is not a model | r2 `2126ea728` → r3 `99aafcd61` → r4 `6bfe0a871` |
| 2 | 2026-10-20 22:16–22:40 UTC (lab window) | the owner's DeepSeek key, `deepseek-v4-pro` | r5 `6d597ec38` (project line and main merged; R1's runner fix) |

Image digests are in `records/metadata-*.json`; r5's version record is
`records/round2-2026-10-21/tool-versions-r5.json`. The key went only into the test servers' provider
store (`provider t03 --key-file`, `login-lab.py key --key-file`); it appears in no record here.
A scan of this directory before it was committed found none of the key, the test servers' secrets
or the accounts' tokens and passwords, and no credential-shaped string.

## Records

| Path | What it shows |
| --- | --- |
| `records/t03-lab-state.json` | Runner t03's lab state: its public id and UUID, every start (Pod, image, PVC, RBD image, first heartbeat, the volume's own identity) and stop (exit code, times, log marks), and the state snapshots; no credential. |
| `records/round1-2026-10-17/` | First start, six recreations (two image upgrades), the refused public-id start (`pod-refused-public-id.json`), snapshots 0–9, idle/60 s/150 s drains, the landing killed at the 240 s grace before R1 (`drain-integration.log`, `integration-job-watch.jsonl`), the git identity and least-privilege checks, imports, events and per-Pod runner logs. |
| `records/round2-2026-10-21/snapshot-r2-*.json` | The volume after the r4 → r5 start (equal to round 1's last), after the real turn, after its recreation (equal), at the end. |
| `records/round2-2026-10-21/events/34jQVdG6XLGfbeqCTBRit.json` | The real session: reading the attachment, `REAL.md` written and committed (`be34204`), the answer; after the recreation the same engine session's answer without tools; the 40 s Bash call during the stop and its answer. |
| `records/round2-2026-10-21/{start,stop}-*.json`, `heartbeats-*.jsonl` | Each stop and start, and the runner's heartbeats once a second: the gap from the old process's last beat to the new one's first (42.3, 37.4 and 8.7 s). |
| `records/round2-2026-10-21/drain-integration-r1.log`, `r1-jobs.jsonl`, `r1-scratch*`, `runner-logs/t03-runner-afc08368-*.log` | R1 re-tested: the merge check running at SIGTERM, the job's heartbeat through the stop, the hand-back to `QUEUED` 1 min 40 s in, exit 0, the next Pod's claim and landing, the scratch worktree gone. |
| `records/round2-2026-10-21/build-probe-*.log`, `build-probes.txt` | D6: the image rebuilt for one more commit, before (84.1 s) and after (9.7 s) moving the source SHA argument below the slow steps. |
| `records/round2-2026-10-21/managed-t05b/` | T05's item: `test-server-t05b` prepared with the r5 lab image, the gate, admission, the new account `deepkey` through `MODEL_UNAVAILABLE` to `READY` with `initialProvider` its key's slug, the first session with nothing named and DeepSeek's answer, its provisioning record, sleep, admission removed. `t05-view-before.json` shows why T05's own database was not used (six sleeping claims fill its storage budget). |
| `records/round2-2026-10-21/managed-runner-python-*.log` | `python3 -B -m unittest discover -s scripts/managed-runner -p '*test*.py'` on the D2 hand-over commits. |

## Re-running

The commands are in the lab doc's section. Round 2's helper scripts outside the repository (the
heartbeat, job and scratch watchers, the build probe) only poll the test server, kubectl and the
builder; the records above are their output.

## Not covered

- Cross-node mounting, migration and takeover: this single-node run proves none of it (T02 and T08x
  cover them on the lab's two nodes).
- The managed path beyond T05's item (the manager's generations, admission and fencing): T02a, T04
  and later tasks.
- `image-smoke.py` end to end: it needs an isolated Docker endpoint, not the host's default socket.
- DeepSeek's own usage and cost were not read. Claude Code's `costUsd` in `turn_end` comes from its
  own price table, not DeepSeek's.
