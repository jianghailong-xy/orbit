# Volume syncs of managed runners on one Docker host, 1 to 8 runners at once (2026-10-20, task D10)

Task D10 (34ilx9dqVOKBeYZObuIjI) of project 34ZteKCnYMpKY46f63Leb, criterion 12. T02c made a managed runner `syncfs` its
volume before every report and, in the background, behind every tool an engine runs
([design record](../../../managed-runner-design.md#implementation-record-git-work-and-engine-sessions-through-a-power-cut)).
On Kubernetes a runner's volume is an ext4 of its own on RBD. On the Docker backend it is a directory of the Docker
host's filesystem, so a `syncfs` there writes back everything dirty on that filesystem: the other runners' volumes, the
deployment's Postgres (`./data/postgres`) and its logs. These records measure what that costs with several runners
working at once, against the same load on the runner from before T02c, and then the Docker-only change that the
measurements called for. The bound, the conclusion and the change are in
[the design record](../../../managed-runner-design.md#implementation-record-volume-syncs-on-a-shared-docker-host); what
an operator can do about the cost is in [the Docker runbook](../../../managed-runner-docker-operations.md#volume-syncs-and-the-hosts-disk).
Times are UTC.

**What these records cannot show.**

- One test host on one spinning disk (the HPC host's `/dev/sdb`), shared with whatever else the HPC host ran: other
  sessions' CPU load (vLLM workers, test suites; load 8 to 27) and, now and then, their reads of that disk. Each round
  waited for the disk to be quiet first and records what else read and wrote it; the rounds of each kind were run
  more than once and interleaved, and the comparison pools them.
- The model is fake-model.py, which answers at once after a set think time; a real model's steps are slower and less
  regular. The tool loop is a stand-in for an engine's: edits, `git commit`s and builds that write 400 small files.
- An SSD or NVMe Docker host was not measured: there the same syncs cost less, and T02c's single-runner timings on the
  HPC host's NVMe give the scale.
- No power was cut here. On Docker the volume's durability through a power cut rests on the host's filesystem; how long
  a tool's work stays unsynced is computed from the traced syncs (below), not observed through a cut.

## Where it ran

| Part | Value |
| --- | --- |
| Test host | `d10-dind`, a `docker:29.8.2-dind` container on the HPC host ([kit/dind-up.sh](kit/dind-up.sh)): privileged for its own dockerd, its own network namespace and iptables, 8 GiB of memory without swap, 10 CPUs, `--oom-score-adj 1000`, labelled `orbit.test=d10-34ilx9dqVOKBeYZObuIjI`, outside the Orbit runner's cgroup (`system.slice/docker-<id>.scope`). dockerd under D9's supervisor, no TCP listener; the deployment's gateway published on the HPC host's 127.0.0.1:15086 only. |
| Its disk | Its Docker data root and its deployment's checkout are under `/mnt/data/tmp/34ilx9dqVOKBeYZObuIjI` on the HPC host: `/dev/sdb`, ext4 (`noatime`), a WDC WUH721816AL 16 TB spinning disk, `mq-deadline`, write cache on. The managed runners' volumes (Docker local volumes), the deployment's Postgres and the images' layers are one filesystem, as on a default host whose `/var/lib/docker` and checkout share its disk. |
| Versions | Docker 29.8.2 (API 1.56), Compose v5.6.0, overlayfs data root, kernel 6.12.107+deb13-amd64, cgroup v2; Postgres 16.15 (`synchronous_commit` on, `wal_sync_method` fdatasync, `shared_buffers` 128MB); Git 2.47.3 and Claude Code 2.1.300 in the runner image. |
| Deployment | `scripts/install-server.sh` with no flags at `1624dc7b1` (the project line with T02c): managed runners on, the Docker backend, the managed runners' firewall, which got one `allow` entry for the fake model ([kit/allow-model.sh](kit/allow-model.sh)). Runners were given 1 CPU and 1 GiB each in `profile.json` (the default 2 CPUs and 4 GiB would admit two in this budget), otherwise the install's profile. |
| Accounts | `probe`, the administrator, whose runner sleeps once its session exists, and `u1` to `u8`, created by the administrator. Each has a DeepSeek-preset key whose endpoint is fake-model.py in a network namespace behind the test host (`10.77.0.2:18080`, [kit/model-up.sh](kit/model-up.sh)), which is not a model. |
| Builds | The installed image and three images that differ from it only in `/usr/local/bin/orbit`, each built from a commit's `src/runner-go` the way the image's first stage builds it ([kit/binaries.sh](kit/binaries.sh), [kit/image.sh](kit/image.sh)); the deployment was switched between them as `/upgrade` switches an image, and every runner slept and woke onto it before a block of rounds. Nothing was pushed. |
| | **before**: `326f43dc0`, the project line just before T02c (`sha256:b0dedb92…`) |
| | **t02c**: `1624dc7b1`, the project line with T02c (`sha256:44283058…`) |
| | **d10**: `c0cb7e255`, this task's change (`sha256:99c89fb1…`) |

## How a round runs

[kit/d10.py](kit/d10.py) `round`, from the HPC host:

1. **The disk quiet.** Over 15 s, no more than 1 MB/s written and 1 MB/s read on `/dev/sdb` by anything but the test host
   and the disk's journal, and at most 15% utilisation; it waits otherwise. What it saw is the round's `quietBefore`.
2. **The probes**, for the whole round:
   - every `syncfs(2)` on the HPC host, through an ftrace instance of its own (`/sys/kernel/tracing/instances/d10`,
     the `mono` clock): its thread, the container it ran in and its duration (`syncfs.jsonl.gz`);
   - once a second (`samples.jsonl.gz`): `/proc/diskstats` (`sdb`: utilisation, writes, the device's cache flushes, write
     latency), `/proc/stat` (iowait), `/proc/pressure/io`, `/proc/meminfo`, the journal thread's writes, and the cgroups
     of the test host and of its runner, Postgres, apiserver and gateway containers (IO bytes, IO pressure, CPU,
     memory);
   - the Orbit API as an account sees it (`api-probe.jsonl.gz`): the probe account, 8 requests a second on one kept-alive
     connection through the gateway: its runner's status, its session, its session list, and a rename of the session
     (a write);
   - Postgres (`pgbench-transactions.txt.gz`): pgbench in the deployment's own Postgres, 10 transactions a second in a
     database of its own, half a one-row `INSERT` (a commit: one WAL flush), half a read; `pg_stat_statements` and
     `pg_stat_wal` reset at the start and read at the end;
   - the gateway's access log (`gateway.txt.gz`): every request's time, the runners' own among them.
3. **The load.** 15 s with the probes only, then each of `u1` to `u<n>` runs one session, turn after turn, until a
   120 s window ends. A turn is fake-model.py's `FAKE-LOOP 3 400 <think> <word>`: three cycles of an edit, a timed
   `git add` and `git commit`, and a build that writes 400 new files of 4 to 16 KiB (about 4 MB) under an ignored
   `build/`, then one more edit; each answer of the model waits the think time first. Once a turn is answered, the
   driver asks the runner to commit what it left (`POST /api/sessions/:id/commit`) and waits for `commit_status`, then
   sends the next turn. So every turn makes ten tool results and two of the runner's reports (the turn's end and the
   commit).
   - **Lockstep** (plans 1 and 2): every runner starts at once and every model step waits 2 s.
   - **Staggered** (plan 4): every runner starts at a random moment of a 25 s ramp before the window, and each turn's
     steps wait 1 to 3 s (drawn per turn), so the runners are out of step as different people's sessions are.
4. **The end.** No new turn after the window; the turns in flight end; every session is ended; the probes stop 10 s
   later. [kit/summarize.py](kit/summarize.py) turns the records into the round's `summary.json`,
   [kit/risk_window.py](kit/risk_window.py) into its `risk-window.json`, and [kit/pooled.py](kit/pooled.py) pools the
   rounds of a kind.

Every number below is over the rounds' 120 s windows.

## How the run went

All times UTC, on 2026-10-19 ([steps.jsonl](steps.jsonl) has every step; `plans/` the plans and their runners' output).

- **19:09–19:26** The test host and the default install (17 min, its images built cold: [install-default.txt.gz](install-default.txt.gz)).
  Accounts, keys and runners ready at 19:27; the probe session; the three images built and the runners moved onto
  `t02c`. Two short smoke rounds tried the kit out; they are not in these records.
- **19:47–20:29, plan 1** ([plans/plan-1.txt](plans/plan-1.txt)), in step: T02c's build and the build before it, 1, 4 and
  8 runners, twice each, in blocks a-b-a-b. Its runner stopped after the first round: `d10.py`'s `docker exec -i` read
  the rest of the plan as its input. Fixed (the plan on its own descriptor) and run from the second round
  ([plans/plan-1b.txt](plans/plan-1b.txt)).
- **20:29–20:59, plan 2** ([plans/plan-2.txt](plans/plan-2.txt)), in step: this change against the build before T02c.
- **21:01, plan 3** stopped in its first round, which was discarded: by then it was clear that runners in step make
  their syncs come in bursts of eight (eight syncs within 0.3 s, then none for 24 s), which no group of people does.
  The rounds in step are kept as the worst case of bursts.
- **21:04–22:20, plan 4** ([plans/plan-4.txt](plans/plan-4.txt)), staggered: the three builds, 1, 4 and 8 runners, twice
  each, in blocks d10-before-t02c-d10-before-t02c.
- **22:20–22:53, plan 5** ([plans/plan-5.txt](plans/plan-5.txt)), staggered, 8 runners: two more rounds of this change
  and of the build before T02c, and two of each without the runner's commits (one sync before a report per turn
  instead of two).
- **22:55** The test host stopped (its data kept), and the ftrace instance removed from the HPC host.

Every round waited for the disk first. What else the HPC host did meanwhile, round by round
([kit/tables.py](kit/tables.py) `rounds`): its load, what others wrote and read on `/dev/sdb` in the 15 s before, and
how much the test host had to read back from the disk in the window. The last is the mark of outside memory pressure:
undisturbed, the load reads almost nothing (the images and the repositories stay in the page cache), and the rounds
in which it read back more than 100 MB were the ones in which the HPC host's available memory had fallen
(`memAvailableMiB` in each round's `summary.json`, 904 MiB at the worst) and the test host's page cache had been
evicted (`pageCacheRefaults`). They happened to every build.

| Round | Build | Runners | Pattern | Window (UTC) | HPC load | Others on sdb before, MB/s | Test host re-read, MB | syncfs | API p99, ms | Postgres commit p99, ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| r01-a-n1 | t02c | 1 | in step | 19:47:49 | 11.56 | 0.014 w, 0.201 r | 264.4 | 53 | 80.6 | 49.8 |
| r02-a-n4 | t02c | 4 | in step | 19:51:10 | 11.68 | 0.009 w, 0.0 r | 159.9 | 212 | 84.3 | 325.2 |
| r03-a-n8 | t02c | 8 | in step | 19:55:49 | 13.40 | 0.006 w, 0.031 r | 296.3 | 344 | 236.2 | 548.0 |
| r04-b-n1 | before | 1 | in step | 20:01:15 | 13.18 | 0.01 w, 0.001 r | 64.4 | 0 | 37.1 | 34.4 |
| r05-b-n4 | before | 4 | in step | 20:04:03 | 6.29 | 0.03 w, 0.001 r | 28.5 | 0 | 51.3 | 69.4 |
| r06-b-n8 | before | 8 | in step | 20:07:11 | 8.68 | 0.028 w, 0.0 r | 54.3 | 0 | 117.7 | 173.6 |
| r07-a-n8 | t02c | 8 | in step | 20:11:18 | 11.47 | 0.01 w, 0.0 r | 225.6 | 400 | 299.4 | 837.6 |
| r08-a-n4 | t02c | 4 | in step | 20:14:33 | 16.41 | 0.063 w, 0.031 r | 272.4 | 181 | 155.9 | 457.6 |
| r09-a-n1 | t02c | 1 | in step | 20:17:26 | 19.18 | 0.055 w, 0.0 r | 33.6 | 59 | 39.2 | 42.7 |
| r10-b-n8 | before | 8 | in step | 20:21:22 | 9.17 | 0.01 w, 0.0 r | 30.8 | 0 | 68.9 | 154.8 |
| r11-b-n4 | before | 4 | in step | 20:24:12 | 7.31 | 0.034 w, 0.0 r | 32.7 | 0 | 51.0 | 60.7 |
| r12-b-n1 | before | 1 | in step | 20:26:59 | 8.97 | 0.038 w, 0.0 r | 176.7 | 0 | 62.8 | 60.4 |
| r13-d-n8 | d10 | 8 | in step | 20:31:22 | 14.42 | 0.015 w, 0.058 r | 8.4 | 72 | 81.3 | 289.4 |
| r14-d-n4 | d10 | 4 | in step | 20:34:16 | 9.85 | 0.002 w, 0.154 r | 3.5 | 36 | 45.9 | 97.5 |
| r15-d-n1 | d10 | 1 | in step | 20:37:02 | 8.49 | 0.044 w, 0.0 r | 37.5 | 9 | 39.0 | 44.2 |
| r16-b-n1 | before | 1 | in step | 20:41:02 | 10.05 | 0.002 w, 0.0 r | 63.5 | 0 | 49.9 | 55.1 |
| r17-b-n4 | before | 4 | in step | 20:43:52 | 8.45 | 0.025 w, 0.008 r | 87.4 | 0 | 70.5 | 172.1 |
| r18-b-n8 | before | 8 | in step | 20:46:50 | 8.92 | 0.037 w, 0.055 r | 111.7 | 0 | 98.3 | 176.4 |
| r19-d-n1 | d10 | 1 | in step | 20:50:55 | 15.87 | 0.005 w, 0.022 r | 163.8 | 9 | 36.5 | 60.2 |
| r20-d-n4 | d10 | 4 | in step | 20:53:52 | 10.29 | 0.022 w, 0.01 r | 89.5 | 36 | 77.9 | 78.3 |
| r21-d-n8 | d10 | 8 | in step | 20:56:44 | 13.48 | 0.031 w, 0.0 r | 303.5 | 56 | 180.9 | 444.8 |
| s01-d-n8 | d10 | 8 | staggered | 21:07:34 | 9.75 | 0.006 w, 0.0 r | 34.4 | 74 | 103.2 | 194.9 |
| s02-d-n4 | d10 | 4 | staggered | 21:12:46 | 13.66 | 0.013 w, 0.008 r | 19.0 | 39 | 44.2 | 122.0 |
| s03-d-n1 | d10 | 1 | staggered | 21:17:50 | 12.69 | 0.009 w, 0.001 r | 23.5 | 10 | 32.7 | 29.8 |
| s04-b-n1 | before | 1 | staggered | 21:22:14 | 8.94 | 0.003 w, 0.0 r | 173.8 | 0 | 60.7 | 81.0 |
| s05-b-n4 | before | 4 | staggered | 21:25:34 | 9.14 | 0.032 w, 0.0 r | 96.4 | 0 | 73.5 | 490.9 |
| s06-b-n8 | before | 8 | staggered | 21:29:05 | 10.81 | 0.034 w, 0.0 r | 13.5 | 0 | 42.0 | 59.2 |
| s07-a-n8 | t02c | 8 | staggered | 21:33:41 | 10.04 | 0.002 w, 0.0 r | 29.6 | 463 | 127.2 | 224.0 |
| s08-a-n4 | t02c | 4 | staggered | 21:37:21 | 7.59 | 0.062 w, 0.0 r | 178.5 | 228 | 148.2 | 585.8 |
| s09-a-n1 | t02c | 1 | staggered | 21:41:35 | 7.60 | 0.009 w, 0.008 r | 1.1 | 72 | 32.8 | 34.1 |
| s10-d-n1 | d10 | 1 | staggered | 21:46:04 | 7.51 | 0.002 w, 0.0 r | 2.8 | 6 | 37.0 | 24.2 |
| s11-d-n4 | d10 | 4 | staggered | 21:50:01 | 12.76 | 0.004 w, 0.0 r | 32.2 | 39 | 56.6 | 57.5 |
| s12-d-n8 | d10 | 8 | staggered | 21:53:26 | 10.72 | 0.005 w, 0.011 r | 1.1 | 74 | 78.5 | 166.5 |
| s13-b-n8 | before | 8 | staggered | 21:58:14 | 10.37 | 0.002 w, 0.0 r | 51.9 | 0 | 64.8 | 62.2 |
| s14-b-n4 | before | 4 | staggered | 22:01:43 | 9.49 | 0.013 w, 0.132 r | 77.6 | 0 | 35.6 | 48.1 |
| s15-b-n1 | before | 1 | staggered | 22:05:21 | 7.08 | 0.009 w, 0.0 r | 0.1 | 0 | 33.7 | 39.2 |
| s16-a-n1 | t02c | 1 | staggered | 22:09:43 | 6.17 | 0.002 w, 0.0 r | 0.0 | 71 | 34.2 | 28.1 |
| s17-a-n4 | t02c | 4 | staggered | 22:13:14 | 4.91 | 0.039 w, 0.0 r | 2.5 | 223 | 38.3 | 62.9 |
| s18-a-n8 | t02c | 8 | staggered | 22:17:33 | 5.82 | 0.02 w, 0.0 r | 323.8 | 379 | 261.4 | 974.7 |
| p01-d-n8 | d10 | 8 | staggered | 22:22:27 | 9.01 | 0.002 w, 0.049 r | 168.4 | 76 | 138.9 | 290.2 |
| p02-d-n8c0 | d10 | 8 | staggered, turns only | 22:26:02 | 9.41 | 0.065 w, 0.679 r | 77.1 | 41 | 145.2 | 277.4 |
| p03-b-n8 | before | 8 | staggered | 22:30:48 | 9.07 | 0.002 w, 0.0 r | 416.8 | 0 | 334.5 | 941.2 |
| p04-b-n8c0 | before | 8 | staggered, turns only | 22:34:15 | 35.49 | 0.02 w, 0.025 r | 129.0 | 0 | 83.0 | 152.8 |
| p05-d-n8c0 | d10 | 8 | staggered, turns only | 22:39:02 | 6.02 | 0.005 w, 0.0 r | 3.1 | 39 | 120.7 | 199.3 |
| p06-d-n8 | d10 | 8 | staggered | 22:42:34 | 5.38 | 0.064 w, 0.0 r | 201.4 | 68 | 187.6 | 744.1 |
| p07-b-n8c0 | before | 8 | staggered, turns only | 22:47:23 | 8.75 | 0.006 w, 0.229 r | 24.0 | 0 | 45.6 | 54.8 |
| p08-b-n8 | before | 8 | staggered | 22:50:56 | 5.19 | 0.002 w, 0.583 r | 1.8 | 0 | 39.1 | 55.4 |

## Results, staggered (the comparison)

Each cell is the rounds of that kind in the order of their names (`p` before `s`), one value each, or one line each
where a cell has two values. The rounds' own files hold more ([kit/summarize.py](kit/summarize.py)).

**1 runner** (rounds: Without syncs (before) s04-b-n1, s15-b-n1; T02c s09-a-n1, s16-a-n1; This change (d10) s03-d-n1, s10-d-n1)

| | Without syncs (before) | T02c | This change (d10) |
| --- | --- | --- | --- |
| syncfs calls in the 120 s | 0 / 0 | 72 / 71 | 10 / 6 |
| syncfs p50 / p99, ms | - / -<br>- / - | 36.8 / 141.1<br>36.8 / 150.6 | 49.7 / 167.2<br>43.9 / 112.1 |
| sdb utilisation, mean % | 18.0 / 20.3 | 13.3 / 12.1 | 12.7 / 15.3 |
| sdb written, MB/s | 0.65 / 0.88 | 1.2 / 1.3 | 0.87 / 0.77 |
| sdb cache flushes, per s | 16.4 / 17.8 | 19.8 / 19.3 | 16.9 / 17.4 |
| host CPU iowait, mean % | 1.2 / 0.99 | 0.67 / 0.56 | 0.64 / 0.77 |
| host IO pressure (some), mean % | 1.1 / 1.0 | 0.39 / 0.2 | 0.25 / 0.89 |
| Postgres container IO pressure (some), mean % | 2.6 / 2.0 | 2.1 / 1.7 | 1.7 / 2.0 |
| API probe p50 / p99, ms | 10.4 / 60.7<br>9.1 / 33.7 | 8.2 / 32.8<br>13.0 / 34.2 | 10.8 / 32.7<br>11.6 / 37.0 |
| API probe's write (rename) p99, ms | 78.7 / 36.3 | 37.2 / 32.6 | 34.5 / 41.8 |
| runners' writes at the gateway p50 / p99, ms | 20.0 / 202.0<br>16.0 / 39.0 | 19.0 / 93.0<br>20.0 / 49.0 | 20.0 / 48.0<br>19.0 / 49.0 |
| Postgres one-row commit p50 / p99, ms | 4.9 / 81.0<br>5.2 / 39.2 | 4.9 / 34.1<br>5.0 / 28.1 | 4.8 / 29.8<br>5.0 / 24.2 |
| Postgres read p99, ms | 118.0 / 4.2 | 8.8 / 5.0 | 3.7 / 2.9 |
| runner's commit, asked to committed, p50 / max, ms | 833.0 / 3408.0<br>623.0 / 629.0 | 722.0 / 875.0<br>682.0 / 831.0 | 738.0 / 820.0<br>692.0 / 936.0 |
| engine's `git commit` in the runner p50 / p99, ms | 8.2 / 148.1<br>4.6 / 26.5 | 4.6 / 28.1<br>4.6 / 21.9 | 7.5 / 80.3<br>4.6 / 84.2 |
| build of 400 files in the runner p50, ms | 23.5 / 23.5 | 24.1 / 23.1 | 23.4 / 23.2 |
| turns answered; p50 message to answer, s | 5; 27.47 / 6; 17.99 | 7; 17.97 / 7; 18.07 | 6; 16.94 / 5; 29.88 |
| a tool's work on the disk after its result p50 / p99, s | no syncfs (50 results) / no syncfs (60 results) | 0.04 / 0.14<br>0.04 / 0.15 | 9.6 / 26.3<br>11.5 / 30.2 |

**4 runners** (rounds: Without syncs (before) s05-b-n4, s14-b-n4; T02c s08-a-n4, s17-a-n4; This change (d10) s02-d-n4, s11-d-n4)

| | Without syncs (before) | T02c | This change (d10) |
| --- | --- | --- | --- |
| syncfs calls in the 120 s | 0 / 0 | 228 / 223 | 39 / 39 |
| syncfs p50 / p99, ms | - / -<br>- / - | 60.0 / 554.3<br>42.5 / 199.1 | 103.8 / 392.6<br>76.6 / 328.5 |
| sdb utilisation, mean % | 29.6 / 16.0 | 40.0 / 22.9 | 19.6 / 22.4 |
| sdb written, MB/s | 1.9 / 2.4 | 3.4 / 3.4 | 3.2 / 2.8 |
| sdb cache flushes, per s | 22.5 / 23.5 | 27.4 / 28.5 | 24.4 / 24.2 |
| host CPU iowait, mean % | 2.4 / 0.88 | 3.5 / 1.2 | 1.1 / 1.3 |
| host IO pressure (some), mean % | 2.5 / 0.63 | 4.8 / 0.68 | 0.7 / 1.2 |
| Postgres container IO pressure (some), mean % | 3.4 / 2.0 | 4.9 / 2.7 | 2.6 / 2.4 |
| API probe p50 / p99, ms | 7.7 / 73.5<br>7.8 / 35.6 | 9.9 / 148.2<br>10.5 / 38.3 | 8.8 / 44.2<br>8.4 / 56.6 |
| API probe's write (rename) p99, ms | 143.4 / 54.4 | 189.9 / 64.6 | 111.9 / 97.2 |
| runners' writes at the gateway p50 / p99, ms | 16.0 / 141.0<br>15.0 / 69.0 | 23.0 / 368.0<br>21.0 / 86.0 | 16.0 / 118.0<br>17.0 / 91.0 |
| Postgres one-row commit p50 / p99, ms | 5.8 / 490.9<br>4.8 / 48.1 | 7.1 / 585.8<br>5.9 / 62.9 | 5.0 / 122.0<br>5.0 / 57.5 |
| Postgres read p99, ms | 315.3 / 7.9 | 539.5 / 15.0 | 35.6 / 12.0 |
| runner's commit, asked to committed, p50 / max, ms | 719.0 / 952.0<br>669.0 / 872.0 | 744.0 / 5618.0<br>674.0 / 735.0 | 770.0 / 976.0<br>783.0 / 1167.0 |
| engine's `git commit` in the runner p50 / p99, ms | 6.3 / 272.1<br>4.7 / 49.6 | 12.4 / 722.8<br>4.6 / 45.6 | 4.7 / 51.3<br>5.7 / 77.8 |
| build of 400 files in the runner p50, ms | 23.8 / 24.0 | 23.6 / 23.3 | 23.7 / 24.9 |
| turns answered; p50 message to answer, s | 22; 25.04 / 24; 23.7 | 23; 23.82 / 22; 25.08 | 23; 23.4 / 25; 23.49 |
| a tool's work on the disk after its result p50 / p99, s | no syncfs (220 results) / no syncfs (240 results) | 0.07 / 0.75<br>0.04 / 0.2 | 3.2 / 13.2<br>5.4 / 21.8 |

**8 runners** (rounds: Without syncs (before) p03-b-n8, p08-b-n8, s06-b-n8, s13-b-n8; T02c s07-a-n8, s18-a-n8; This change (d10) p01-d-n8, p06-d-n8, s01-d-n8, s12-d-n8)

| | Without syncs (before) | T02c | This change (d10) |
| --- | --- | --- | --- |
| syncfs calls in the 120 s | 0 / 0 / 0 / 0 | 463 / 379 | 76 / 68 / 74 / 74 |
| syncfs p50 / p99, ms | - / -<br>- / -<br>- / -<br>- / - | 93.0 / 414.7<br>125.0 / 1061.6 | 227.9 / 1114.5<br>185.0 / 1825.3<br>196.0 / 697.2<br>157.5 / 732.2 |
| sdb utilisation, mean % | 54.0 / 20.6 / 22.5 / 29.7 | 59.0 / 75.3 | 45.7 / 54.2 / 35.9 / 28.6 |
| sdb written, MB/s | 3.0 / 4.7 / 4.2 / 4.5 | 6.8 / 5.6 | 6.1 / 5.4 / 6.1 / 6.1 |
| sdb cache flushes, per s | 24.8 / 32.6 / 32.8 / 31.3 | 39.5 / 30.4 | 30.9 / 28.9 / 30.9 / 32.1 |
| host CPU iowait, mean % | 2.1 / 1.0 / 1.1 / 1.4 | 4.8 / 10.9 | 3.2 / 5.0 / 2.9 / 2.4 |
| host IO pressure (some), mean % | 12.5 / 0.66 / 0.46 / 1.5 | 5.0 / 14.6 | 4.6 / 8.1 / 2.4 / 1.9 |
| Postgres container IO pressure (some), mean % | 12.1 / 2.6 / 2.6 / 3.2 | 6.3 / 10.8 | 5.8 / 7.7 / 4.3 / 3.7 |
| API probe p50 / p99, ms | 13.7 / 334.5<br>9.6 / 39.1<br>8.3 / 42.0<br>8.6 / 64.8 | 11.0 / 127.2<br>12.8 / 261.4 | 9.5 / 138.9<br>9.9 / 187.6<br>9.2 / 103.2<br>9.1 / 78.5 |
| API probe's write (rename) p99, ms | 357.4 / 57.5 / 84.9 / 73.1 | 162.8 / 361.1 | 280.1 / 243.5 / 168.2 / 134.7 |
| runners' writes at the gateway p50 / p99, ms | 18.0 / 1705.0<br>13.0 / 78.0<br>14.0 / 75.0<br>16.0 / 78.0 | 29.0 / 217.0<br>54.0 / 717.0 | 22.0 / 251.0<br>23.0 / 459.0<br>18.0 / 184.0<br>17.0 / 128.0 |
| Postgres one-row commit p50 / p99, ms | 16.6 / 941.2<br>4.7 / 55.4<br>4.9 / 59.2<br>5.7 / 62.2 | 12.1 / 224.0<br>36.8 / 974.7 | 7.3 / 290.2<br>11.5 / 744.1<br>5.7 / 194.9<br>5.1 / 166.5 |
| Postgres read p99, ms | 841.8 / 18.1 / 14.6 / 18.3 | 174.2 / 1007.2 | 176.2 / 1122.6 / 114.1 / 91.7 |
| runner's commit, asked to committed, p50 / max, ms | 636.0 / 51791.0<br>629.0 / 773.0<br>676.0 / 903.0<br>679.0 / 1054.0 | 891.0 / 1593.0<br>929.0 / 18803.0 | 926.0 / 6357.0<br>873.0 / 24658.0<br>883.0 / 1418.0<br>822.0 / 1090.0 |
| engine's `git commit` in the runner p50 / p99, ms | 4.8 / 1960.3<br>4.5 / 44.9<br>6.3 / 58.2<br>11.8 / 122.4 | 22.3 / 263.2<br>29.2 / 2053.9 | 11.2 / 180.2<br>6.3 / 396.8<br>13.0 / 190.2<br>4.6 / 68.4 |
| build of 400 files in the runner p50, ms | 23.0 / 23.2 / 23.4 / 24.1 | 23.5 / 23.7 | 23.9 / 23.8 / 23.5 / 23.4 |
| turns answered; p50 message to answer, s | 30; 24.89 / 49; 23.02 / 51; 21.68 / 46; 25.12 | 49; 24.34 / 40; 27.49 | 45; 24.1 / 44; 24.94 / 45; 23.56 / 47; 23.48 |
| a tool's work on the disk after its result p50 / p99, s | no syncfs (300 results) / no syncfs (490 results) / no syncfs (510 results) / no syncfs (460 results) | 0.09 / 0.38<br>0.11 / 0.77 | 1.6 / 8.2<br>1.8 / 14.5<br>1.7 / 9.3<br>1.5 / 9.0 |

**Without the runner's commits** (8 runners, staggered: one sync before a report per turn, at the turn's end).

**8 runners** (rounds: Without syncs (before) p04-b-n8c0, p07-b-n8c0; This change (d10) p02-d-n8c0, p05-d-n8c0)

| | Without syncs (before) | This change (d10) |
| --- | --- | --- |
| syncfs calls in the 120 s | 0 / 0 | 41 / 39 |
| syncfs p50 / p99, ms | - / -<br>- / - | 218.7 / 1397.7<br>247.6 / 740.5 |
| sdb utilisation, mean % | 41.3 / 22.7 | 44.5 / 28.8 |
| sdb written, MB/s | 4.8 / 3.4 | 6.2 / 6.1 |
| sdb cache flushes, per s | 27.4 / 30.1 | 29.6 / 29.0 |
| host CPU iowait, mean % | 3.4 / 1.4 | 3.7 / 2.3 |
| host IO pressure (some), mean % | 3.7 / 1.0 | 4.2 / 1.9 |
| Postgres container IO pressure (some), mean % | 4.6 / 2.8 | 5.0 / 4.1 |
| API probe p50 / p99, ms | 8.1 / 83.0<br>10.5 / 45.6 | 8.4 / 145.2<br>10.4 / 120.7 |
| API probe's write (rename) p99, ms | 133.8 / 72.7 | 184.9 / 179.7 |
| runners' writes at the gateway p50 / p99, ms | 17.0 / 166.0<br>13.0 / 73.0 | 17.0 / 227.0<br>15.0 / 179.0 |
| Postgres one-row commit p50 / p99, ms | 6.4 / 152.8<br>5.1 / 54.8 | 8.0 / 277.4<br>5.1 / 199.3 |
| Postgres read p99, ms | 90.8 / 20.4 | 142.8 / 163.0 |
| runner's commit, asked to committed, p50 / max, ms | - / -<br>- / - | - / -<br>- / - |
| engine's `git commit` in the runner p50 / p99, ms | 7.0 / 191.2<br>4.8 / 209.5 | 4.8 / 262.2<br>4.6 / 161.3 |
| build of 400 files in the runner p50, ms | 24.0 / 23.1 | 24.0 / 23.3 |
| turns answered; p50 message to answer, s | 46; 23.17 / 49; 23.73 | 50; 22.38 / 48; 22.32 |
| a tool's work on the disk after its result p50 / p99, s | no syncfs (460 results) / no syncfs (490 results) | 2.5 / 9.7<br>2.3 / 9.6 |

## Results, in step (the worst case of bursts)

**1 runner** (rounds: Without syncs (before) r04-b-n1, r12-b-n1, r16-b-n1; T02c r01-a-n1, r09-a-n1; This change (d10) r15-d-n1, r19-d-n1)

| | Without syncs (before) | T02c | This change (d10) |
| --- | --- | --- | --- |
| syncfs calls in the 120 s | 0 / 0 / 0 | 53 / 59 | 9 / 9 |
| syncfs p50 / p99, ms | - / -<br>- / -<br>- / - | 48.3 / 167.0<br>38.5 / 136.6 | 40.6 / 187.1<br>52.8 / 126.7 |
| sdb utilisation, mean % | 14.9 / 24.1 / 15.5 | 31.1 / 16.4 | 11.8 / 19.2 |
| sdb written, MB/s | 0.69 / 0.74 / 0.8 | 0.92 / 1.0 | 0.79 / 0.87 |
| sdb cache flushes, per s | 17.4 / 16.5 / 17.4 | 18.1 / 17.8 | 17.5 / 17.8 |
| host CPU iowait, mean % | 0.87 / 1.1 / 0.89 | 2.4 / 1.2 | 0.58 / 1.2 |
| host IO pressure (some), mean % | 0.77 / 1.9 / 0.66 | 3.3 / 1.1 | 0.34 / 0.87 |
| Postgres container IO pressure (some), mean % | 1.6 / 2.3 / 2.1 | 2.4 / 2.0 | 1.8 / 2.2 |
| API probe p50 / p99, ms | 9.3 / 37.1<br>10.7 / 62.8<br>10.3 / 49.9 | 9.9 / 80.6<br>9.2 / 39.2 | 12.8 / 39.0<br>9.1 / 36.5 |
| API probe's write (rename) p99, ms | 37.7 / 82.4 / 69.3 | 69.2 / 44.4 | 54.8 / 49.3 |
| runners' writes at the gateway p50 / p99, ms | 19.0 / 65.0<br>20.0 / 71.0<br>20.0 / 107.0 | 24.0 / 134.0<br>22.0 / 70.0 | 19.0 / 64.0<br>21.0 / 68.0 |
| Postgres one-row commit p50 / p99, ms | 5.0 / 34.4<br>5.3 / 60.4<br>5.1 / 55.1 | 5.7 / 49.8<br>5.2 / 42.7 | 4.8 / 44.2<br>5.0 / 60.2 |
| Postgres read p99, ms | 5.0 / 12.6 / 18.6 | 11.9 / 6.4 | 15.1 / 21.7 |
| runner's commit, asked to committed, p50 / max, ms | 621.0 / 732.0<br>1709.0 / 3993.0<br>673.0 / 737.0 | 1853.0 / 3011.0<br>720.0 / 1348.0 | 726.0 / 6117.0<br>784.0 / 3943.0 |
| engine's `git commit` in the runner p50 / p99, ms | 4.9 / 28.2<br>21.5 / 101.9<br>24.7 / 61.0 | 20.7 / 421.6<br>16.9 / 96.5 | 4.5 / 4.8<br>13.6 / 105.7 |
| build of 400 files in the runner p50, ms | 23.3 / 26.3 / 23.1 | 26.3 / 23.4 | 23.5 / 23.6 |
| turns answered; p50 message to answer, s | 5; 22.82 / 5; 23.95 / 5; 23.01 | 5; 24.03 / 5; 22.88 | 5; 22.89 / 5; 22.97 |
| a tool's work on the disk after its result p50 / p99, s | no syncfs (50 results) / no syncfs (50 results) / no syncfs (50 results) | 0.06 / 0.19<br>0.04 / 0.14 | 12.4 / 23.6<br>10.6 / 21.8 |

**4 runners** (rounds: Without syncs (before) r05-b-n4, r11-b-n4, r17-b-n4; T02c r02-a-n4, r08-a-n4; This change (d10) r14-d-n4, r20-d-n4)

| | Without syncs (before) | T02c | This change (d10) |
| --- | --- | --- | --- |
| syncfs calls in the 120 s | 0 / 0 / 0 | 212 / 181 | 36 / 36 |
| syncfs p50 / p99, ms | - / -<br>- / -<br>- / - | 91.2 / 661.9<br>181.7 / 1238.5 | 113.6 / 526.4<br>134.8 / 442.2 |
| sdb utilisation, mean % | 28.9 / 29.0 / 39.1 | 37.5 / 73.2 | 27.3 / 34.8 |
| sdb written, MB/s | 2.2 / 2.5 / 2.1 | 3.1 / 2.8 | 2.3 / 2.2 |
| sdb cache flushes, per s | 22.7 / 21.2 / 20.7 | 23.6 / 19.8 | 20.8 / 21.1 |
| host CPU iowait, mean % | 2.0 / 1.7 / 4.0 | 3.9 / 7.2 | 1.7 / 1.6 |
| host IO pressure (some), mean % | 2.4 / 1.7 / 4.4 | 4.7 / 10.9 | 1.6 / 2.5 |
| Postgres container IO pressure (some), mean % | 2.9 / 2.7 / 4.0 | 4.1 / 7.3 | 3.0 / 3.5 |
| API probe p50 / p99, ms | 11.7 / 51.3<br>12.6 / 51.0<br>10.9 / 70.5 | 9.8 / 84.3<br>13.2 / 155.9 | 11.4 / 45.9<br>10.5 / 77.9 |
| API probe's write (rename) p99, ms | 74.3 / 67.0 / 135.5 | 155.4 / 212.3 | 112.7 / 118.7 |
| runners' writes at the gateway p50 / p99, ms | 19.0 / 77.0<br>18.0 / 129.0<br>22.0 / 176.0 | 33.0 / 275.0<br>64.0 / 372.0 | 15.0 / 135.0<br>20.0 / 143.0 |
| Postgres one-row commit p50 / p99, ms | 5.5 / 69.4<br>5.0 / 60.7<br>6.5 / 172.1 | 6.7 / 325.2<br>20.9 / 457.6 | 5.6 / 97.5<br>6.0 / 78.3 |
| Postgres read p99, ms | 15.5 / 10.7 / 90.1 | 173.5 / 218.3 | 28.5 / 34.6 |
| runner's commit, asked to committed, p50 / max, ms | 670.0 / 727.0<br>723.0 / 1892.0<br>716.0 / 1160.0 | 1292.0 / 8235.0<br>1954.0 / 3210.0 | 802.0 / 1022.0<br>893.0 / 1218.0 |
| engine's `git commit` in the runner p50 / p99, ms | 4.5 / 49.9<br>4.5 / 113.7<br>18.4 / 483.0 | 9.4 / 366.6<br>82.6 / 735.8 | 4.5 / 82.7<br>7.1 / 229.2 |
| build of 400 files in the runner p50, ms | 23.2 / 23.5 / 23.4 | 29.6 / 58.1 | 23.3 / 24.1 |
| turns answered; p50 message to answer, s | 24; 22.9 / 20; 22.94 / 20; 23.19 | 20; 23.85 / 16; 25.03 | 20; 23.15 / 20; 23.41 |
| a tool's work on the disk after its result p50 / p99, s | no syncfs (240 results) / no syncfs (200 results) / no syncfs (200 results) | 0.09 / 0.64<br>0.21 / 1.2 | 10.9 / 21.1<br>10.8 / 21.3 |

**8 runners** (rounds: Without syncs (before) r06-b-n8, r10-b-n8, r18-b-n8; T02c r03-a-n8, r07-a-n8; This change (d10) r13-d-n8, r21-d-n8)

| | Without syncs (before) | T02c | This change (d10) |
| --- | --- | --- | --- |
| syncfs calls in the 120 s | 0 / 0 / 0 | 344 / 400 | 72 / 56 |
| syncfs p50 / p99, ms | - / -<br>- / -<br>- / - | 204.6 / 1907.3<br>228.7 / 1881.2 | 234.3 / 784.0<br>239.0 / 1421.9 |
| sdb utilisation, mean % | 27.8 / 22.4 / 34.0 | 62.4 / 61.3 | 23.1 / 48.6 |
| sdb written, MB/s | 3.8 / 3.7 / 4.4 | 5.1 / 5.7 | 4.0 / 3.7 |
| sdb cache flushes, per s | 24.8 / 26.3 / 26.1 | 24.3 / 26.0 | 24.1 / 22.0 |
| host CPU iowait, mean % | 2.3 / 2.2 / 2.4 | 7.3 / 7.0 | 2.1 / 8.8 |
| host IO pressure (some), mean % | 2.8 / 2.0 / 3.1 | 12.9 / 10.1 | 1.5 / 11.8 |
| Postgres container IO pressure (some), mean % | 3.7 / 3.1 / 4.2 | 8.2 / 8.5 | 3.5 / 6.9 |
| API probe p50 / p99, ms | 9.6 / 117.7<br>10.9 / 68.9<br>9.2 / 98.3 | 13.2 / 236.2<br>12.4 / 299.4 | 10.0 / 81.3<br>11.1 / 180.9 |
| API probe's write (rename) p99, ms | 117.7 / 139.2 / 106.8 | 270.4 / 322.1 | 208.2 / 207.0 |
| runners' writes at the gateway p50 / p99, ms | 17.0 / 421.0<br>16.0 / 160.0<br>19.0 / 217.0 | 83.0 / 1001.0<br>65.0 / 619.0 | 24.0 / 212.0<br>27.0 / 364.0 |
| Postgres one-row commit p50 / p99, ms | 5.0 / 173.6<br>5.0 / 154.8<br>5.7 / 176.4 | 17.6 / 548.0<br>18.6 / 837.6 | 5.4 / 289.4<br>8.4 / 444.8 |
| Postgres read p99, ms | 66.5 / 38.4 / 126.4 | 517.5 / 661.6 | 225.3 / 204.8 |
| runner's commit, asked to committed, p50 / max, ms | 2362.0 / 3993.0<br>770.0 / 1130.0<br>915.0 / 5225.0 | 4038.0 / 17912.0<br>2600.0 / 9210.0 | 1081.0 / 1335.0<br>1458.0 / 4271.0 |
| engine's `git commit` in the runner p50 / p99, ms | 4.7 / 101.2<br>4.6 / 96.3<br>6.9 / 277.9 | 63.6 / 759.6<br>34.2 / 596.5 | 4.8 / 133.1<br>26.5 / 636.5 |
| build of 400 files in the runner p50, ms | 23.6 / 23.5 / 23.8 | 36.9 / 28.8 | 24.0 / 26.2 |
| turns answered; p50 message to answer, s | 40; 23.57 / 40; 23.02 / 40; 23.45 | 32; 28.0 / 40; 25.03 | 40; 23.8 / 32; 24.52 |
| a tool's work on the disk after its result p50 / p99, s | no syncfs (400 results) / no syncfs (400 results) / no syncfs (400 results) | 0.2 / 1.9<br>0.2 / 1.9 | 10.8 / 21.7<br>12.5 / 24.3 |

## Against the bound

[kit/pooled.py](kit/pooled.py) pools every round of a kind and compares each build with the build without syncs at the
same count and pattern: the API probe's p99 at most 25% over (or 10 ms), Postgres's commit p99 at most 50% over (or
10 ms), Postgres's IO pressure at most 5 points over, the runner's commit p50 at most 1 s over
([pooled-all.json](pooled-all.json), [pooled-undisturbed.json](pooled-undisturbed.json)).

All rounds:

| Build | Runners | Pattern | API p99, ms | Postgres commit p99, ms | Postgres IO pressure, % | Runner's commit p50, ms | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| d10 | 1 | in step | 37.21 vs 50.98 (≤ 63.7) ok | 56.022 vs 50.007 (≤ 75) ok | 1.98 vs 2 (≤ 7) ok | 741 vs 729 (≤ 1729) ok | within |
| t02c | 1 | in step | 58.1 vs 50.98 (≤ 63.7) ok | 45.611 vs 50.007 (≤ 75) ok | 2.2 vs 2 (≤ 7) ok | 775 vs 729 (≤ 1729) ok | within |
| d10 | 4 | in step | 67.83 vs 57.57 (≤ 72) ok | 86.385 vs 114.531 (≤ 171.8) ok | 3.28 vs 3.18 (≤ 8.18) ok | 844 vs 687 (≤ 1687) ok | within |
| t02c | 4 | in step | 130.02 vs 57.57 (≤ 72) **over** | 341.447 vs 114.531 (≤ 171.8) **over** | 5.71 vs 3.18 (≤ 8.18) ok | 1789 vs 687 (≤ 1687) **over** | **over** |
| d10 | 8 | in step | 147.49 vs 106.84 (≤ 133.6) **over** | 375.142 vs 172.426 (≤ 258.6) **over** | 5.24 vs 3.65 (≤ 8.65) ok | 1138 vs 857 (≤ 1857) ok | **over** |
| t02c | 8 | in step | 272.69 vs 106.84 (≤ 133.6) **over** | 676.04 vs 172.426 (≤ 258.6) **over** | 8.35 vs 3.65 (≤ 8.65) ok | 3960 vs 857 (≤ 1857) **over** | **over** |
| d10 | 1 | staggered | 32.86 vs 44.83 (≤ 56) ok | 27.041 vs 71.191 (≤ 106.8) ok | 1.85 vs 2.29 (≤ 7.29) ok | 731 vs 629 (≤ 1629) ok | within |
| t02c | 1 | staggered | 33.56 vs 44.83 (≤ 56) ok | 32.44 vs 71.191 (≤ 106.8) ok | 1.89 vs 2.29 (≤ 7.29) ok | 720 vs 629 (≤ 1629) ok | within |
| d10 | 4 | staggered | 54.15 vs 49.46 (≤ 61.8) ok | 93.287 vs 156.405 (≤ 234.6) ok | 2.47 vs 2.7 (≤ 7.7) ok | 773 vs 679 (≤ 1679) ok | within |
| t02c | 4 | staggered | 85.71 vs 49.46 (≤ 61.8) **over** | 430.56 vs 156.405 (≤ 234.6) **over** | 3.79 vs 2.7 (≤ 7.7) ok | 721 vs 679 (≤ 1679) ok | **over** |
| d10 | 8 | staggered | 132.71 vs 137.36 (≤ 171.7) ok | 314.399 vs 399.888 (≤ 599.8) ok | 5.37 vs 5.13 (≤ 10.13) ok | 873 vs 671 (≤ 1671) ok | within |
| t02c | 8 | staggered | 224.89 vs 137.36 (≤ 171.7) **over** | 758.866 vs 399.888 (≤ 599.8) **over** | 8.53 vs 5.13 (≤ 10.13) ok | 906 vs 671 (≤ 1671) ok | **over** |
| d10 | 8 | staggered-turns-only | 128.61 vs 68.81 (≤ 86) **over** | 236.659 vs 119.562 (≤ 179.3) **over** | 4.54 vs 3.68 (≤ 8.68) ok | - | **over** |

Undisturbed (without the rounds in which the test host read back more than 100 MB):

| Build | Runners | Pattern | API p99, ms | Postgres commit p99, ms | Postgres IO pressure, % | Runner's commit p50, ms | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| d10 | 1 | in step | 39.04 vs 39.84 (≤ 49.8) ok | 44.183 vs 45.831 (≤ 68.7) ok | 1.78 vs 1.86 (≤ 6.86) ok | 726 vs 670 (≤ 1670) ok | within |
| t02c | 1 | in step | 39.2 vs 39.84 (≤ 49.8) ok | 42.668 vs 45.831 (≤ 68.7) ok | 1.99 vs 1.86 (≤ 6.86) ok | 720 vs 670 (≤ 1670) ok | within |
| d10 | 4 | in step | 67.83 vs 57.57 (≤ 72) ok | 86.385 vs 114.531 (≤ 171.8) ok | 3.28 vs 3.18 (≤ 8.18) ok | 844 vs 687 (≤ 1687) ok | within |
| d10 | 8 | in step | 81.29 vs 107.31 (≤ 134.1) ok | 289.405 vs 167.232 (≤ 250.8) **over** | 3.53 vs 3.38 (≤ 8.38) ok | 1081 vs 783 (≤ 1783) ok | **over** |
| d10 | 1 | staggered | 32.86 vs 33.72 (≤ 43.7) ok | 27.041 vs 39.192 (≤ 58.8) ok | 1.85 vs 1.97 (≤ 6.97) ok | 731 vs 623 (≤ 1623) ok | within |
| t02c | 1 | staggered | 33.56 vs 33.72 (≤ 43.7) ok | 32.44 vs 39.192 (≤ 58.8) ok | 1.89 vs 1.97 (≤ 6.97) ok | 720 vs 623 (≤ 1623) ok | within |
| d10 | 4 | staggered | 54.15 vs 49.46 (≤ 61.8) ok | 93.287 vs 156.405 (≤ 234.6) ok | 2.47 vs 2.7 (≤ 7.7) ok | 773 vs 679 (≤ 1679) ok | within |
| t02c | 4 | staggered | 38.33 vs 49.46 (≤ 61.8) ok | 62.856 vs 156.405 (≤ 234.6) ok | 2.72 vs 2.7 (≤ 7.7) ok | 674 vs 679 (≤ 1679) ok | within |
| d10 | 8 | staggered | 95.08 vs 52.08 (≤ 65.1) **over** | 184.094 vs 59.17 (≤ 88.8) **over** | 4 vs 2.81 (≤ 7.81) ok | 846 vs 671 (≤ 1671) ok | **over** |
| t02c | 8 | staggered | 127.23 vs 52.08 (≤ 65.1) **over** | 224.041 vs 59.17 (≤ 88.8) **over** | 6.29 vs 2.81 (≤ 7.81) ok | 891 vs 671 (≤ 1671) ok | **over** |
| d10 | 8 | staggered-turns-only | 128.61 vs 45.62 (≤ 57) **over** | 236.659 vs 54.841 (≤ 82.3) **over** | 4.54 vs 2.78 (≤ 7.78) ok | - | **over** |

**Where the slow commits come from.** Postgres commits over 100 ms in the pooled rounds, and how many of them overlapped a
`syncfs` (any runner's) at some moment. In the control there is no sync to overlap. With this change the syncs that are
left ran 5 to 10% of the time, yet nearly every slow commit ran during one.

All rounds:

| Build | Runners | Pattern | Rounds | Syncs a minute | Commits over 100 ms, a minute | Of them during a sync |
| --- | --- | --- | --- | --- | --- | --- |
| before | 1 | in step | r04-b-n1, r12-b-n1, r16-b-n1 | 0 | 0.8 | 0 of 5 |
| d10 | 1 | in step | r15-d-n1, r19-d-n1 | 4.5 | 0.8 | 0 of 3 |
| t02c | 1 | in step | r01-a-n1, r09-a-n1 | 28 | 0 | 0 of 0 |
| before | 4 | in step | r05-b-n4, r11-b-n4, r17-b-n4 | 0 | 4 | 0 of 24 |
| d10 | 4 | in step | r14-d-n4, r20-d-n4 | 18 | 2.2 | 5 of 9 |
| t02c | 4 | in step | r02-a-n4, r08-a-n4 | 98.2 | 24.2 | 86 of 97 |
| before | 8 | in step | r06-b-n8, r10-b-n8, r18-b-n8 | 0 | 8.2 | 0 of 49 |
| d10 | 8 | in step | r13-d-n8, r21-d-n8 | 32 | 22.7 | 38 of 91 |
| t02c | 8 | in step | r03-a-n8, r07-a-n8 | 186 | 61.2 | 207 of 245 |
| before | 1 | staggered | s04-b-n1, s15-b-n1 | 0 | 1.5 | 0 of 6 |
| d10 | 1 | staggered | s03-d-n1, s10-d-n1 | 4 | 0 | 0 of 0 |
| t02c | 1 | staggered | s09-a-n1, s16-a-n1 | 35.8 | 0 | 0 of 0 |
| before | 4 | staggered | s05-b-n4, s14-b-n4 | 0 | 3.5 | 0 of 14 |
| d10 | 4 | staggered | s02-d-n4, s11-d-n4 | 19.5 | 2.7 | 11 of 11 |
| t02c | 4 | staggered | s08-a-n4, s17-a-n4 | 112.8 | 11 | 33 of 44 |
| before | 8 | staggered | p03-b-n8, p08-b-n8, s06-b-n8, s13-b-n8 | 0 | 17.1 | 0 of 137 |
| d10 | 8 | staggered | p01-d-n8, p06-d-n8, s01-d-n8, s12-d-n8 | 36.5 | 24.6 | 138 of 197 |
| t02c | 8 | staggered | s07-a-n8, s18-a-n8 | 210.5 | 54 | 186 of 216 |
| before | 8 | staggered-turns-only | p04-b-n8c0, p07-b-n8c0 | 0 | 4 | 0 of 16 |
| d10 | 8 | staggered-turns-only | p02-d-n8c0, p05-d-n8c0 | 20 | 17 | 64 of 68 |

Undisturbed:

| Build | Runners | Pattern | Rounds | Syncs a minute | Commits over 100 ms, a minute | Of them during a sync |
| --- | --- | --- | --- | --- | --- | --- |
| before | 1 | in step | r04-b-n1, r16-b-n1 | 0 | 0.8 | 0 of 3 |
| d10 | 1 | in step | r15-d-n1 | 4.5 | 0 | 0 of 0 |
| t02c | 1 | in step | r09-a-n1 | 29.5 | 0 | 0 of 0 |
| before | 4 | in step | r05-b-n4, r11-b-n4, r17-b-n4 | 0 | 4 | 0 of 24 |
| d10 | 4 | in step | r14-d-n4, r20-d-n4 | 18 | 2.2 | 5 of 9 |
| before | 8 | in step | r06-b-n8, r10-b-n8 | 0 | 7.5 | 0 of 30 |
| d10 | 8 | in step | r13-d-n8 | 36 | 14 | 20 of 28 |
| before | 1 | staggered | s15-b-n1 | 0 | 0.5 | 0 of 1 |
| d10 | 1 | staggered | s03-d-n1, s10-d-n1 | 4 | 0 | 0 of 0 |
| t02c | 1 | staggered | s09-a-n1, s16-a-n1 | 35.8 | 0 | 0 of 0 |
| before | 4 | staggered | s05-b-n4, s14-b-n4 | 0 | 3.5 | 0 of 14 |
| d10 | 4 | staggered | s02-d-n4, s11-d-n4 | 19.5 | 2.7 | 11 of 11 |
| t02c | 4 | staggered | s17-a-n4 | 111.5 | 2 | 4 of 4 |
| before | 8 | staggered | p08-b-n8, s06-b-n8, s13-b-n8 | 0 | 0.2 | 0 of 1 |
| d10 | 8 | staggered | s01-d-n8, s12-d-n8 | 37 | 12.8 | 51 of 51 |
| t02c | 8 | staggered | s07-a-n8 | 231.5 | 23 | 46 of 46 |
| before | 8 | staggered-turns-only | p07-b-n8c0 | 0 | 0 | 0 of 0 |
| d10 | 8 | staggered-turns-only | p02-d-n8c0, p05-d-n8c0 | 20 | 17 | 64 of 68 |

## How long a tool's work stays off the disk

[kit/risk_window.py](kit/risk_window.py): for every tool result of a round (the runner's own stamp on the event), the
time until the end of the first `syncfs` on the test host's filesystem that started after it, whichever runner made
it. A sync started up to 20 ms before the stamp counts: the runner nudges its sync just before it stamps the event,
and the tool had finished before the engine reported it. Each round's numbers are in its `risk-window.json`, with the
results' times it used.

| Runners | Pattern | T02c | This change | Without syncs |
| --- | --- | --- | --- | --- |
| 1 | staggered | p50 0.04 s, p99 0.14–0.15 s | p50 9.6–11.5 s, p99 26–30 s | no sync: the kernel's writeback only |
| 4 | staggered | p50 0.04–0.07 s, p99 0.2–0.8 s | p50 3.2–5.4 s, p99 13–22 s | the same |
| 8 | staggered | p50 0.09–0.11 s, p99 0.4–0.8 s | p50 1.5–1.8 s, p99 8–15 s | the same |
| 8 | in step | p50 0.2 s, p99 1.9 s | p50 10.8–12.5 s, p99 22–24 s | the same |

With this change, a tool's work waits for this turn's end or for any runner's report. The more runners are at work,
the sooner one comes; in step they all come at once, so the window is as long as a turn. No result waited past 30 s
but one (30.2 s, one runner): about where the kernel's own writeback (dirty data older than 30 s, written at the
flusher's next 5 s pass) takes over, which the trace does not see.

## The change

`c0cb7e255` ([the design record](../../../managed-runner-design.md#implementation-record-volume-syncs-on-a-shared-docker-host)):
the runner reads, from `/proc/self/mountinfo`, the mount that holds `ORBIT_HOME`. A mount whose root is not `/` is a
directory of a filesystem it shares, a Docker local volume; then the sync behind every tool does nothing, and every
sync before a report stays. `4aa01a1be` changed only that file's comment. The measured binary was built from
`c0cb7e255`; `git diff c0cb7e255 4aa01a1be -- src/runner-go` is comment lines only.

- Each runner of this change in the test host said so at start (`docker logs`, after the switch at 20:30):

  ```text
  [orbit-runner 2026-10-19T20:30:42.480Z] volume check: 6 checkouts in 1 repositories after start; 0 stale lock files removed, 0 branches restored, 0 checkouts damaged
  [orbit-runner 2026-10-19T20:30:42.480Z] volume syncs: before reports only; the volume is a directory of /dev/sdb (ext4), which it shares, so a sync behind every tool would write back the whole filesystem
  ```

  and the mount it read, inside a runner container:
  `2005 1991 8:16 /tmp/34ilx9dqVOKBeYZObuIjI/dind/docker/volumes/mr-data-01a155a1-d3c3-…/_data /var/lib/orbit rw,noatime master:478 - ext4 /dev/sdb rw`.
- In the trace, this change's runners made 4 to 37 syncs a minute against T02c's 36 to 231 (the tables above), all of
  them before reports.
- Unit tests (`src/runner-go`): `volume_shared_linux_test.go` reads mountinfo tables as a Docker runner and a Kubernetes
  Pod see them (the volume shared or not, the visible one of two mounts at a point, escaped names, an unreadable table
  keeps T02c's syncs) and the start's line; `volume_durability_test.go` has a shared volume synced before a report and
  not behind tools; `volume_durability_session_test.go` runs the real supervisor and a scripted Claude through a turn
  whose engine commits, on a volume of its own and on a shared one: a sync right before the turn's report and the
  end's in both, and one behind the tool only on the volume of its own.

## Kubernetes unchanged: T02c's power cut, after the fix, on this change

The runner change, though it acts only on a volume that shares its filesystem, is in the runner every backend runs.
So the part of T02c's power cut comparison it touches, the run after the fix, was done again on the lab's two nodes
with this change: [lab/](lab/), by `scripts/managed-runner/lab/durability-lab.py run --from again`, the phase this task
added (T02c's steps, with a new account, `cyd`, and two checks of its own).

- **The lab window.** The lab was off and free (`status.sh` just before). Both VMs were booted at 22:58:24 with 9.6 GiB
  of the HPC host's memory available, and were healthy at 23:01:50 ([lab/logs/00-start-both.txt](lab/logs/00-start-both.txt));
  Ceph's 33 placement groups were active+clean before the run; both VMs were off again at 23:14:40
  ([lab/logs/99-stop-both.txt](lab/logs/99-stop-both.txt)). The test host of the measurements above had been stopped
  first. Other sessions ran a web test suite and the resident vLLM workers meanwhile.
- **The image.** This change at `4aa01a1be`, built by T02c's `kit/build-image.sh` and imported into both VMs' containerd
  ([lab/image.txt](lab/image.txt)); the test server `test-server-t02c` with this checkout's apiserver, as T02c ran it.
- **The run** ([lab/steps.jsonl](lab/steps.jsonl), [lab/report.json](lab/report.json)): 15 steps, 90 checks, none
  failed, 397 s, 23:07:07–23:13:44.

| Step | What it showed |
| --- | --- |
| `syncs` ([006](lab/records/006-again-syncs.json)) | The runner on the second node: `volume syncs: before reports and behind every tool; the volume is /dev/rbd0 (ext4), a filesystem of its own`, its mount `643 628 251:0 / /var/lib/orbit rw,relatime - ext4 /dev/rbd0 rw,stripe=1024` (root `/`). |
| `last` ([008](lab/records/008-again-last.json)) | The second node's power cut (`stop.sh --node 2 --hard`) 0.0 s after the runner's merge returned and the last turn was answered, 0.8 s after the engine's commit in that turn, 1.8 s after the runner's commit was reported, and 3.4 s after an engine commit in a turn still running (s3). T02c's own after-run: 0.0, 0.9, 2.3 and 4.3 s. |
| `left` ([009](lab/records/009-again-left.json)), `s3` ([010](lab/records/010-again-s3.json)) | A copy of the volume's snapshot, read before anything mounted the volume again: every repository reads, `git fsck` clean, no empty Git file, no lock; every commit that had returned is on its branch; the last turn, its message and its answer, is in the engine's transcript. s3's mid-turn commit, made 3.4 s before the cut, is on its branch: the sync behind its tool ran. |
| `fence`, `resume` ([011](lab/records/011-again-fence.json), [012](lab/records/012-again-resume.json)) | The runbook's failover: FENCING 11.4 s after the taint, READY on the first node 80 s after the cut. The next generation logged `volume check: 4 checkouts in 1 repositories after start; 0 stale lock files removed, 0 branches restored, 0 checkouts damaged` and `volume syncs: before reports and behind every tool; the volume is /dev/rbd1 (ext4), a filesystem of its own`; the session resumed with its last turn, and every repository read and passed `fsck` on the runner. |
| `rejoin`, `checks` ([013](lab/records/013-again-rejoin.json), [014](lab/records/014-again-checks.json)) | The second node back; the database and k3s agree; never more than one Pod on the claim or one attachment of its PV over the timeline; Ceph `HEALTH_OK`. |

The same as T02c's after-run on `0e894464e`, so on an RBD volume this change keeps every sync T02c made. The scan of
these records for the run's credentials found none.

## The HPC host

- **Touched:** the test host's container and its data under `/mnt/data/tmp/34ilx9dqVOKBeYZObuIjI`; an ftrace instance of
  this task's own (`/sys/kernel/tracing/instances/d10`, two syscall events of it enabled for each round), removed at
  22:55; the lab's VMs and its test server, as the lab's scripts run them; a build of the lab image in the capped
  buildx builder `t03-capped`.
- **Not touched:** the HPC host's firewall, network and Docker daemon (never restarted); `deploy/managed-runner/image`.
  Nothing was deployed or pushed.
- **Left:** the stopped test host `d10-dind` with its data, and the lab image archive, under
  `/mnt/data/tmp/34ilx9dqVOKBeYZObuIjI`; in the lab, `test-server-t02c` has the account `cyd` asleep on its claim
  beside T02c's.

## Files

- `rounds/<round>/`: `meta.json` (the round's settings, phases, containers and cgroups), `summary.json`,
  `risk-window.json`, `turns.jsonl`, `commits.jsonl`, `sessions.jsonl`, `quiet.jsonl` when the disk was waited for,
  `pg-stat-statements.tsv`, `pg-stat-wal.tsv`; gzipped: `samples.jsonl.gz`, `syncfs.jsonl.gz`, `api-probe.jsonl.gz`,
  `pgbench-transactions.txt.gz`, `gateway.txt.gz`.
- `pooled-all.json`, `pooled-undisturbed.json`: [kit/pooled.py](kit/pooled.py)'s output.
- `fake-model.jsonl.gz` (every model request, the tool results' timings among them), `steps.jsonl` (the driver's setup
  steps and rounds), `status-transitions.jsonl.gz`, `install-default.txt.gz`, `inventory-final.txt`.
- `plans/`: each plan and its runner's output.
- `kit/`: the test host ([dind-up.sh](kit/dind-up.sh), [supervise-dockerd.sh](kit/supervise-dockerd.sh),
  [repo-sync.sh](kit/repo-sync.sh), [checkout.sh](kit/checkout.sh), [host-run.sh](kit/host-run.sh),
  [model-up.sh](kit/model-up.sh), [allow-model.sh](kit/allow-model.sh)); the builds ([binaries.sh](kit/binaries.sh),
  [image.sh](kit/image.sh)); the driver ([d10.py](kit/d10.py), [matrix.sh](kit/matrix.sh)); the analysis
  ([summarize.py](kit/summarize.py), [risk_window.py](kit/risk_window.py), [pooled.py](kit/pooled.py),
  [tables.py](kit/tables.py)); [pack.sh](kit/pack.sh), which put these records here.
- `lab/`: the lab run above.
