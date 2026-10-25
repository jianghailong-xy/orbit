# Docker backend on real Docker — run 1017083206f4 (2026-10-17)

The managed runner's Docker backend (task D2), checked on the HPC host's real Docker (29.8.2, API
1.56, containerd image store, cgroup v2) by `scripts/managed-runner/docker-backend-it.py`, which ran
`src/apiserver/src/managed-runners/docker-backend.it.ts`:

- the whole apiserver in one process (`ORBIT_MANAGED_RUNNERS_ENABLED=true`, a Docker profile), D2's
  code at commit 5aef53c6b, listening only on the gateway address of a dedicated internal network
  (inter-container traffic off, no route out), over a disposable PostgreSQL;
- the restricted channel (`deploy/managed-runner/docker-channel/channel.py`) as a child process the
  test started, killed and started again; the only process that opened the Docker socket;
- the managed runner image built locally from T03's branch 08375121e plus the entrypoint change D2
  needs (198f6d6cc) and D2's runner-go log line (throwaway commit d1e0e2c99): image
  `sha256:1964876d4628…` ([image.txt](image.txt)), never pushed; the real runner in every container;
- everything labelled `orbit.test=d2-it-1017083206f4`, inside a `systemd-run --scope -p MemoryMax=6G`
  outside the Orbit runner's cgroup; every container with its own CPU (0.5), memory (512 MiB, no
  swap beyond it) and PID (512) limits; all of it removed afterwards ([cleanup.txt](cleanup.txt)).

No model was used: Codex was signed in inside the containers with a placeholder API key, and the
network reaches no model. The owner's DeepSeek key file did not exist; a real engine session is left
to D4.

Result: 14 of 14 ([it.tap](it.tap)). Every step's observations are in [steps.jsonl](steps.jsonl);
Docker's own record of every container and volume of the run is [docker-events.jsonl](docker-events.jsonl),
summarized in [lifecycle.md](lifecycle.md); the channel's request log (method, path, status, code;
no bodies) is [channel.log.gz](channel.log.gz).

| Case | What happened (times UTC) |
| --- | --- |
| (0) refusals | 24 requests refused by the real channel with nothing changed in Docker: no or a wrong token (401), `privileged`, `capAdd`, binds, the Docker socket as a mount, host network, PID and IPC, a device, a raw `HostConfig`, an environment, a user (`PARAMETER_REFUSED`); the Docker socket or `/etc` as the data volume (`NAME_REFUSED`); another image; another runner's volume; a second container name for a volume (`SINGLE_CONTAINER_GUARD`); limits above the ceiling; a volume without this instance's label read, adopted or removed, another instance's volume read, a container on an unlabelled volume. |
| (1) template | What Docker made: UID 10001, `Privileged` false, no added capabilities, `CapDrop ALL`, read-only root, the run's network, empty PID mode, private IPC, `no-new-privileges`, `NanoCpus` 500000000, memory = swap = 512 MiB, PIDs 512, exactly three mounts (`/var/lib/orbit`, `/run/orbit-bootstrap`, `/tmp`), no `docker.sock` anywhere; neither the credential nor the generation in its environment or its log. |
| (1) abnormal exit | The first container killed (SIGKILL) at 08:35:01: Docker's report (exit 137, FinishedAt) recorded as the stop proof, the runner FAILED `POD_TERMINATED`, its compute kept while the exited container was still there; the owner's retry removed it and started generation 2 on the same volume and runner. |
| (2) idle sleep | Data seeded (two random blobs, a note, SQLite in WAL with 5000 rows). After 60 s idle the runner drained (08:36:33), accepted and exited 0 at 08:37:03.33. With the manager held still, the exited-but-not-removed container still held its compute (1000m/1 GiB for two runners); once removed by UID the mapping slept (08:37:03.69) and only then did compute drop to one runner's. Storage stayed reserved; the volume stayed. |
| (3) message | A message to a parked session woke it (generation 3, same volume): checksums, `PRAGMA integrity_check` (ok) and rows as before the sleep. The woken runner claimed the turn 130 ms after its container started (Docker's events), before the mapping became READY (31 s after the message); with no model behind it, the run then ended FAILED. |
| (4) task | Run Now of a task assigned to the workspace woke it (generation 4); the woken runner claimed the task's run (RUNNING when the test ended it). |
| (5) scheduled | A due session wakeup, delivered by the scheduled-wakeup worker, woke it (generation 5); the runner claimed the wakeup's turn (which then ended FAILED, as in (3)). |
| (6) concurrent | Eight concurrent `/wake` requests while a second manager instance raced the application's own: one new generation (6), one container, never two on the volume. |
| (7) host restart | A SQLite writer running in the container; then the manager stopped, the channel SIGKILLed and the container SIGKILLed. All brought back: FAILED on Docker's report (137), retried, generation 7 on the same volume; files unchanged, `integrity_check` ok, 5242 rows (the writer's 242 committed rows kept). |
| (8) manager restart | The manager stopped mid-wake (STARTING, no container recorded yet) and started again: the wake finished with one container (generation 8). |
| (9) channel down | The channel killed during a wake: TRANSIENT, attempt 1; started again, the wake finished (generation 9). |
| (10) capacity | Room for two runners, both up: the third waited (`MANAGED_RUNNER_CAPACITY_UNAVAILABLE`, nothing made for it, past a capacity retry). Once Bob slept (08:44:46) Carol's container was created, with one other container live (Docker's events); her runner became READY at 08:50:18 after its first engine probe. |
| (11) disk limit | 300 MiB written into a 256 MiB volume: within one disk check the channel stopped the container ("its volume held 346105301 bytes, over its 268435456-byte limit"); the runner FAILED with that detail; a retry was refused `VOLUME_OVER_LIMIT` and no container was started. |
| inventory | The database's mappings and the channel's containers and volumes agree (a recorded container UID is the one Docker has; no container where none is recorded); at most one container per volume at every sample (every 250 ms) for all three runners; the apiserver process never connected to a Docker socket (a tripwire on every socket connect). |

[real-host-derived-budget.json](real-host-derived-budget.json) is the default budget this host would
get for 1-CPU, 2-GiB runners, from a channel's `/v1/info` read the same day
([real-host-channel-info.json](real-host-channel-info.json)): 18000m CPU and 11.25 GiB (a quarter
kept), five runners; storage 12.4 GiB usable against 91.5 GiB headroom (a tenth of the disk kept
free), so this nearly full shared disk admits no new volume until the profile states its storage —
which this run did.

What this run does not show is listed at the end of the Docker backend record in
[docs/managed-runner-design.md](../../../managed-runner-design.md).
