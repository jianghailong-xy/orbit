# A restart's reason through the waits on its way (T07b)

Task T07b (34hxIkHX88JTlUqKDOJdn) of the managed-runner project, 2026-10-18. It fixes the finding T07 reported
([T07's evidence](../../managed-runner-clients-lab/2026-10-18/README.md), "Seen on the lab and reported"): on Kubernetes,
a runner restarting by itself said `POD_RESTARTING`, then `VOLUME_STILL_ATTACHED` while its stopped Pod's volume
detached, and then the generic "It is starting again" for the rest of the restart. The out-of-memory notice was gone
the same way. The record of the rule is in [the design](../../../managed-runner-design.md#implementation-record-a-restarts-reason-through-the-waits-on-its-way),
and the lab run in [the lab page](../../../managed-runner-lab.md#the-restart-reason-through-the-detach-wait-t07b).

## The change

`managed-runner-manager.ts` (commit 293082fde):

- `waitReason` writes the reason of each wait that ends by itself while a runner is being started:
  `VOLUME_STILL_ATTACHED` (the gate), `VOLUME_IN_USE`, `CONTAINER_LIMIT` and `KUBERNETES_QUOTA_EXCEEDED` (`waitForRoom`),
  and `TRANSIENT` (`backoff`, `unreachable`). On an automatic restart's way it carries the restart's own reason in
  `lastError.restart`. The status read and the demand hook's answer still give clients only `code`, `message` and
  `retryable`, so every client shows the wait while it lasts.
- `restartReason` gives back the restart's reason whether it is stored itself or carried. So do the two places where a
  wait ended by clearing the reason: a held volume freed (`starting`) and a create that a cap held back (`roomMade`).
  The gate's advance, admission and the move to STARTING already wrote `restartReason`.
- Nothing else writes the carried reason, so READY, a failure, a fence, a sleep, a disabled owner and an owner's retry
  drop it with the reason they replace. No migration, and no client change.

## The pg spec: `managed-runner-recovery.pg.spec.ts` (11)–(15)

| Case | Backends | What it holds |
| --- | --- | --- |
| (11) a restart after a stop | Kubernetes | Its stopped Pod's volume stays attached (`autoDetach` off). The gate removes the Pod by UID and waits: `VOLUME_STILL_ATTACHED` read by the owner, nothing spent, no next generation, no startup deadline, nothing written pass after pass. Detached: `POD_RESTARTING` through admission, provisioning and the start, with the restart's sentence, attempt 1 and the deadline from admission. Then READY with no reason, on the same volume and runner. |
| (11) a restart after running out of memory | Kubernetes | The same, with `POD_RESTARTING_OUT_OF_MEMORY` and its sentence. |
| (11) an owner's retry | Kubernetes | A FAILED `POD_TERMINATED` runner retried through the same wait: the wait is said, and then no reason until READY. |
| (12) a transient error | both | When the restart is due, the backend answers 503 (an attempt spent, as before), then cannot be reached (nothing spent): `TRANSIENT` each time. The next pass makes the next instance, `POD_RESTARTING` again, then READY. |
| (13) a backup's helper at the gate | Docker | A container outside the instance holds the volume when the gate looks: (11)'s wait, then `POD_RESTARTING`. |
| (14) the environment's cap | both | The next instance refused at Docker's cap on containers, or by a Kubernetes quota on Pods: `CONTAINER_LIMIT` or `KUBERNETES_QUOTA_EXCEEDED`, nothing spent, no deadline. Once there is room, `POD_RESTARTING`, the deadline from then. |
| (15) a volume held at the create | both | `VOLUME_IN_USE`, then `POD_RESTARTING` once it is free. A wake through the same wait has no reason once it is free. |

On the previous manager (bfebc8381's file, the spec of this change), 9 of the 10 new cases fail, each at the reason
after its wait: `STARTING:null` or `code: null` where `POD_RESTARTING` (or its out-of-memory form) belongs. The tenth,
the owner's retry, passes on both. (15)'s last part, the wake, runs only once its restart part has passed, so on the
change alone. All 17 earlier cases pass on both. With the change, all 28 tests pass (27 cases and the file's own). The
control was run by putting the previous manager file in place and back, with the diff's hash checked unchanged.

The fake cluster's attach/detach controller removes every attachment of a volume that no stored Pod uses whenever a
Pod goes, so a held volume at the gate (13) is shown on Docker, where it is a helper container. On Kubernetes the gate's
wait is (11)'s own attachment.

## The lab's real k3s

One runner (`amy`), T06b's runner image (`…@sha256:cdb090148c19…`, already in the guest), T07's profile (a one-runner
budget, the runner's memory limit 1Gi, `maxAttempts` 5, backoff 5–60 s, a 5 s poll) with the idle interval raised to
an hour so that sleep stayed out of the way, and fake-model.py as the owner's DeepSeek-preset key. The test apiserver
ran this checkout's build (`source 293082fde`); for the control run it ran a build of the previous manager file
(`records/lab/15-control-dist-old.txt`: 0 mentions of `waitReason` in the built manager, against 7 for the change).
Each run began with the runner READY for 125 s, twice `backoffMaxSeconds`, so every stop counted from attempt 1.

`kit/t07b.py watch` read `GET /api/managed-runner` as the owner every 0.5 s, together with the mapping row (the stored
reason's code and the restart it carries). `kit/t07b.py sequence` cuts the samples into runs of the same state and
reason, and computes for each the display the three clients draw (`managedRunnerDisplay` from `src/shared`). A run's
seconds are from its first sample to its last.

| Run | Stop | Detach | The status read, in order |
| --- | --- | --- | --- |
| 1, the change | `orbit run` SIGKILLed while READY (exit 137) | the cluster's own | READY → REQUESTED `POD_RESTARTING` 4.5 s → PROVISIONING `POD_RESTARTING` → STARTING `POD_RESTARTING` 20.0 s → READY |
| 2, the change | the same | the cluster's own | READY → REQUESTED `POD_RESTARTING` 5.0 s → STARTING `POD_RESTARTING` 14.5 s → READY |
| 3, the change | run out of memory while READY (exit 137, `OOMKilled`) | the cluster's own | READY → REQUESTED `POD_RESTARTING_OUT_OF_MEMORY` 4.5 s → PROVISIONING `POD_RESTARTING_OUT_OF_MEMORY` → STARTING `POD_RESTARTING_OUT_OF_MEMORY` 15.0 s → READY |
| 4, the change | `orbit run` SIGKILLed while READY | held | READY → REQUESTED `POD_RESTARTING` 4.5 s → REQUESTED `VOLUME_STILL_ATTACHED` (carrying `POD_RESTARTING`) 15.0 s → STARTING `POD_RESTARTING` 4.5 s → READY |
| 5, the change | run out of memory while READY | held | READY → REQUESTED `POD_RESTARTING_OUT_OF_MEMORY` 4.5 s → REQUESTED `VOLUME_STILL_ATTACHED` (carrying it) 15.0 s → STARTING `POD_RESTARTING_OUT_OF_MEMORY` 15.0 s → READY |
| 6, the previous manager | `orbit run` SIGKILLed while READY | held | READY → REQUESTED `POD_RESTARTING` 4.5 s → REQUESTED `VOLUME_STILL_ATTACHED` 15.0 s → STARTING, no reason, 20.0 s → READY |
| 7, the change | `orbit run` SIGKILLed while a woken runner started | the cluster's own | the kill came 1.0 s before READY, which the watch ended on. The recorder's timeline then has REQUESTED `POD_RESTARTING` → STARTING `POD_RESTARTING` on generation 9 |

What the clients show for each, by the shared rule: "Waking your managed runner" throughout, with the reason's
sentence: "The runner instance stopped, so it is being started again on the same data volume. Messages sent meanwhile
wait for it." (`POD_RESTARTING`), "The runner ran out of memory and stopped, …" (out of memory), "The previous instance
has stopped and its data volume is still detaching. The next instance starts once it is detached."
(`VOLUME_STILL_ATTACHED`). In run 6, after the wait, it was "It is starting again. Messages sent meanwhile wait for it
and run once it is up.": T07's finding, on the same lab with the same image, profile and hold. Then "Managed runner
ready". The out-of-memory sentence stayed until READY in runs 3 and 5.

**The detach on this VM.** In runs 1, 2, 3 and 7 the stopped Pod's VolumeAttachment was gone 3.3–6.1 s after the Pod
failed (`*.attachments.jsonl`; for run 1, the recorder's `timeline.jsonl`). That was before the gate looked, which is
one poll and one backoff after the stop (3.75 s at attempt 1). So the wait did not happen, and the restart's reason
stood throughout, as it did before the change. To see the wait on the real cluster, runs 4–6 kept the stopped Pod's
own attachment: `kit/t07b.py detach-hold` put a finalizer of the kit's on it while the Pod ran. Once the Pod had stopped,
the cluster detached the volume (`attached: false`, the deletion stamped) 0.4–6.1 s after the Pod failed, before the gate
looked.
The object stayed, as a slow detach keeps it, until the kit removed its finalizer, 10 s after the stored reason became
`VOLUME_STILL_ATTACHED`. The attachment was gone 0.05–0.06 s later, and the gate went on at its next poll. T07 saw the natural
wait in a crash loop of a runner that was still starting (wen 021–023). Run 7 tried that timing and lost the race the
other way: the woken runner's startup beat had made it READY first.

In every sample of the recorder's timeline the runner had one Pod at most (its name comes from the runner's ID), each
restart counted attempt 1, and no wait spent one. Generations 1 to 9 all ran on the same PVC (UID `3d7239dd…`, made at
09:02:39) and PV (`records/lab/20-snapshot-amy.json`).

## Reproduce

```sh
export LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t07b
W=scripts/managed-runner/lab/wake-lab.py; K=docs/evidence/managed-runner-restart-reason/2026-10-18/kit
sudo scripts/managed-runner/lab/status.sh && sudo scripts/managed-runner/lab/start.sh
python3 $W prepare --image docker.io/library/orbit-managed-runner-lab@sha256:cdb090148c194e536fe86c22f1507b45f74f2aa6929df26f7360747604102312
python3 $K/t07b.py profile                       # the runner's memory limit 1Gi; then idleSeconds 3600 in the profile
python3 $W gate start && sudo -E scripts/managed-runner/lab/test-server.sh start && python3 $W account root
sudo systemctl stop orbit-mr-lab-api && sudo -E scripts/managed-runner/lab/test-server.sh start --managed
python3 scripts/managed-runner/lab/single-writer.py admission install && python3 $W record start
python3 $W account amy && python3 $W key amy && python3 $W until amy READY
$K/run.sh OUT 4-kill-held kill held              # kill|oom, natural|held; the status read every 0.5 s until READY again
$K/run-starting.sh OUT 7-kill-starting           # sleep, wake, and a kill while the woken runner is still STARTING
python3 $W action amy sleep && python3 $W until amy SLEEPING && python3 $W record stop
python3 scripts/managed-runner/lab/single-writer.py admission remove
sudo -E scripts/managed-runner/lab/test-server.sh stop && python3 $W gate stop && sudo scripts/managed-runner/lab/stop.sh
```

## Files

- `kit/t07b.py`: the profile, the status watch, the out-of-memory stop, a kill while starting, the detach hold, an
  attachment watch, the READY wait and the sequence. `kit/run.sh` and `kit/run-starting.sh` drive one run.
  `kit/secret-scan.py` is T07's scan with this task's directory.
- `records/runs/`: per run, `LABEL.jsonl` (each sample), `LABEL.sequence.json`, `LABEL.attachments.jsonl`,
  `LABEL.stop.json` (the kubelet's report as watched), `LABEL.hold-on.json` and `LABEL.hold-off.json` (the hold's times),
  `LABEL.ready-before.json`; `timeline.jsonl` is wake-lab.py's recorder for the whole window.
- `records/lab/`: each step of the window, from `status.sh` before it to `status.sh` after it.
- `secret-scan.json`: no credential the window handled appears in these files.

## Left behind

The lab VM is stopped (`records/lab/28-stop.txt`, `29-status-after.txt`), the admission webhook removed, the gate and
the test server stopped. `test-server-t07b` is kept, with `amy` SLEEPING, its PVC kept. The leftovers of earlier tasks
were left as they were: L0's smoke Pod and T07's root Pod (`Unknown`, of T07's database).

## Not shown here

- The natural detach wait on this VM: the cluster detached faster than the gate looked. The wait shown is the stopped
  Pod's own attachment kept by a test finalizer after the cluster had detached the volume.
- The host's real Docker: the Docker waits ran against the fake channel only (pg spec).
- A model: fake-model.py stood in for the owner's DeepSeek key, and no session ran. Nothing crossed nodes.
