# The three clients against the lab's test server: Web live, iPhone and Mac replayed (2026-10-18)

Task T07 (34ZtjU1QDQiBnGYXTVbNl) of project 34ZteKCnYMpKY46f63Leb, criterion 7: Web, macOS and iOS show the managed
runner's preparing, available, asleep, failed and retry states the same way, and keep their navigation. C7 (task
34bWD1WvmVQzcUAughzli) built the three clients against the shared state fixture only; this task puts them in front of
the lab's real test server and real k3s, and of the host's real Docker for the states only that backend has. It fixes
what that showed and makes the server say what a first session starts on before READY
([design record](../../../managed-runner-design.md#implementation-record-the-three-clients-against-the-lab),
[lab page](../../../managed-runner-lab.md#the-three-clients-t07)).

**What is live and what is replayed.** The web ran live: this checkout's build in headless Chromium on the HPC host,
same-origin with the test server on 127.0.0.1, every page the server's. The iPhone and Mac apps cannot reach the host,
and the coordinator chose replay over a tunnel (task comment 34hsa5wd3tguMmM5fPn11 and its answer): their pictures come
from the real apps fed the test server's **recorded** answers on GitHub's macos-26. The recorder asked what those apps ask,
as each account, at least as often as they do; the apps' own writes (a first session from the draft, a message, Retry)
were sent by the recorder in their request shapes and are the scenes' actions, which the apps had to send again in the
replay, with the same key fields. What replay cannot show is listed under Gaps.

No model was used: the owner's DeepSeek key file still did not exist, and every session ran on fake-model.py as a
DeepSeek-preset key (T05's way). Its answers quote the message's marker ("Answering: T07-…").

## Where it ran

- **The lab** (L0's single-machine k3s + Ceph VM, `orbit-mr-lab`), booted at 05:51:02Z and stopped at 06:29:49Z. A fresh
  test server directory, `test-server-t07` (T03–T06b's databases untouched), on 127.0.0.1: PostgreSQL, this checkout's
  apiserver (built at eaf89abdb; the client fix 54044973d changed no server file), the TLS front for the Pods and
  fake-model.py. Profile: T06's budget of **one** runner and 60 s idle, with the runner's memory limit lowered to 1Gi so a
  real out-of-memory kill is cheap (`kit/t07lab.py profile`). Image: T06b's lab image (deploy/managed-runner/image at
  ebf54ab8d plus the lab CA layer), already in the guest; runner-go has not changed since. Nothing was pushed.
- **The host's Docker** (Docker 29.8.2), as D2's integration test runs it (`kit/t07docker.py`): a second test server on
  127.0.0.1:13730 with the Docker backend, D8's restricted channel holding the Docker socket, its cap
  `limits.maxContainers` 1 under a budget of two runners, the runners on an internal network with no inter-container
  traffic, reaching the apiserver and their own fake-model.py through two relays bound to that network's gateway
  (172.18.0.1) only. Image: T06b's product image loaded from its archive (`sha256:9844c08e…`, revision ebf54ab8d).
  Everything labelled `orbit.test=t07-docker` and removed afterwards.
- **macos-26** (GitHub Actions), branches `probe/t07-managed-runner-replay` and `…-landing`, never merged. The
  iPhone app (`CompactShell`) ran on the newest iPhone simulator and the Mac app (`MainView`) beside it. Both were
  built from this tree's shared sources and played every scene against `replay.py`, in three rounds (below). The same
  pushes ran client.yml's compile gates: OrbitKit `swift test` and OrbitApp `swift build` on macOS, and the iOS app
  for the simulator.

## What the lab showed, and what changed

- **The status says what a first session starts on before READY** (eaf89abdb). T06b queues a new account's first
  session on the owner's key while the runner waits for capacity or starts. C7's clients offered no draft until
  `initialProvider` existed, so on the lab the web said "Waiting for capacity" with the composer closed while the server
  would have taken the session. `GET /api/managed-runner` now carries `firstSessionProvider`:
  - `initialProvider` once READY has been recorded;
  - before that, the owner's first key such a session is queued on, while the runner has not reported its engines or
    has reported that key's engine installed;
  - null when the create would refuse the session `MODEL_UNAVAILABLE`.

  The status read uses the create's own rule (`managedFirstSessionProvider`, beside
  `assertManagedFirstSessionRuntime`). A table test checks that the two agree, a pg spec runs on both backends (4/4),
  and the shared fixture has four new cases that the apiserver, shared, web and Swift tests all read. The field is
  additive, so the contract version stays 1; the clients read `initialProvider` from a server that predates it. On the
  lab the web draft opened on the key ("DeepSeek V4 Pro") 3.4 s after the key was added (wen 003). The first session sent
  from it with nothing named queued while the runner waited for capacity, and was answered once the runner was up
  (wen 005–007, nia 004–006, eve 004–006).
- **The draft follows the key** (eaf89abdb). The draft's provider and model come from the workspace list
  (`lastProvider`, which the server derives). That list went stale when the key arrived, so a draft opened by the status
  would have offered Claude Code's floor and its model. The web now reads the list again when the first-session
  provider changes, and the native apps reload their workspaces.
- **Waking shows at once** (54044973d). A message woke a runner that had been asleep for 15 s, and was answered 4.4 s
  later, while the web kept saying "Managed runner asleep" until its next 30 s read (wen 013–014). Web and native read
  the managed status again after a send only when the runner row read offline, but a just-slept runner's row still
  reads online for up to 90 s after its last beat. Both now read it again whenever the managed status is not
  "available". After the fix: "Waking your managed runner" 0.7 s after the send (wen 019).

Seen on the lab and reported rather than changed (not one of this task's clients):

- **The restart reason is lost after the volume detach wait (Kubernetes).** In wen's crash loop the notice went from
  "…being started again on the same data volume" (`POD_RESTARTING`, wen 021) to "…still detaching" (`VOLUME_STILL_ATTACHED`,
  022) and then to the generic "It is starting again" (023), until the next kill set the reason again (024).
  `restartReason` (src/apiserver/src/managed-runners/managed-runner-manager.ts:1150) keeps a restart reason only while it
  is still the stored one, so the detach wait replaced it and the next step cleared it. The clients showed what the
  server said.

Two behaviours from before this task, noted as they showed:

- **A Retry pressed on another client shows at the next settled read.** The native recorder pressed Retry for eve at
  06:40:05, the runner was READY about five seconds later, and R1's answer reached the web through the event stream at
  06:40:07. The web kept "Managed runner failed (Retry)" until its next read at 06:40:32 (eve 025–029). Both clients
  read a settled status every 30 s (`MANAGED_RUNNER_STATUS_POLL_SECONDS`, OrbitKit `pollSeconds`); a Retry pressed in
  the same client shows at once (wen 029, iPhone and Mac scene 10).
- **The web composer under a failed notice, within 90 s of the last beat.** The web closes the composer with the
  notice's title when the runner row reads offline and the status does not accept work. On k3s nia had been asleep for
  two minutes when her volume vanished, and the composer said "Managed runner failed" (nia 038). On Docker eve had slept
  39 s earlier, her row still read online, and it said "Reply…" (eve 024). The server accepts and queues such a message
  either way, and the notice is the same.

## The web, live

Every picture is in `web/<account>/shots/`, and `web/<account>/web.jsonl` has a line for each: the managed notice's kind,
title, sentence and buttons, the composer's placeholder, engine and model, the answers on the page, and every write the
page sent (sign-in bodies left out). Generated tables: [web/TABLES.md](web/TABLES.md) (`kit/websummary.py`). None
of the 120 changes the observers recorded caught the page loading, and none shows "Register your own machine".

| State the server reported | Backend | Account, picture | What the web showed |
| --- | --- | --- | --- |
| Switch unset | k3s | root-unset 003, 005, 007 | Root's own workspace draft on Claude Code; the deep link to its session; Infrastructure. No managed notice, no registration prompt. |
| Switch `false` | k3s | root-false 003, 005 | The same. |
| Capability route missing (a server from before it, 404) | k3s | root-missing 003, 005 | The same. |
| Waiting for capacity, no key | k3s | wen 002, nia 002 | "Waiting for capacity", with the sentence that names what is missing; the composer closed. |
| Waiting for capacity, with a key | k3s, Docker | wen 003, nia 003, eve 003 | The draft offered on the key's engine and model ("DeepSeek V4 Pro"), the notice still above it. |
| First session queued while waiting | k3s, Docker | wen 005, nia 004, eve 004 | The new session's console, the notice above it ("Reply…"). |
| Preparing | k3s | wen 006, nia 005, eve 007 | "Preparing your managed runner". |
| Preparing, at the Docker host's cap (`CONTAINER_LIMIT`) | Docker | eve 005 | "Preparing…", "The Docker host has as many runner containers as it allows…". |
| READY on a key | k3s, Docker | wen 009, nia 008, eve 008 | No notice; the first session answered (fake-model's "Answering: T07-…"). |
| Going to sleep | k3s, Docker | wen 010, nia 009, eve 014 | "Managed runner going to sleep". |
| Asleep | k3s, Docker | wen 011, nia 010, eve 009 | "Managed runner asleep"; the composer open (a message wakes it). |
| Waking after a message | k3s | wen 019, nia 011 | "Waking your managed runner", 0.7 s after the send (wen 019). |
| Waking at the Docker host's cap (`CONTAINER_LIMIT`) | Docker | eve 010 | "Waking…", the cap's sentence. |
| Waking, the namespace quota has no room (`KUBERNETES_QUOTA_EXCEEDED`) | k3s | nia 022 | "Waking…", "The cluster's resource quota for managed runners has no room…". |
| Waking, the volume in use (`VOLUME_IN_USE`) | k3s, Docker | nia 030, eve 017 | "Something else is using this runner's data volume, such as a backup…". On k3s a VolumeAttachment left behind; on Docker a stopped container holding the volume. |
| Restarting (`POD_RESTARTING`) | k3s | wen 021, 024 | "The runner instance stopped, so it is being started again on the same data volume…". |
| Restarting, out of memory (`POD_RESTARTING_OUT_OF_MEMORY`) | k3s | nia 015 | "The runner ran out of memory and stopped…". |
| Failed, restarts used up (`POD_TERMINATED`) | k3s | wen 027 | "Managed runner failed", "…stopped too often…", Retry. Pressed on the web: waking at once (029), then READY (030). |
| Failed, out of memory too often (`POD_OUT_OF_MEMORY`) | k3s | nia 016 | "…kept running out of memory…", Retry. Pressed by the iPhone's request (recorder): waking (017). |
| Failed, volume gone (`PVC_MISSING`) | k3s, Docker | nia 038, eve 024 | "This runner's recorded data volume is gone…", no Retry. |
| Failed, volume restored (`PVC_RESTORED`) | Docker | eve 025 | "This runner's data volume is back as it was recorded. A retry starts the runner on it.", Retry. Pressed by the iPhone's request: answered (027), the notice gone at the next read (029). |
| Asleep, the environment unusable (`MANAGED_RUNNER_UNAVAILABLE`) | k3s | wen 033 | "…not configured correctly…", the composer closed. |
| Switch on, an account with its own runner | k3s | root-on 004, 006, 008, 010 | Its own workspace's draft and deep link as before; Infrastructure; the managed Default workspace (added last) says "Your managed runner needs a model", with "Open Infrastructure". |

## The iPhone and Mac apps, replayed

The probe ran on GitHub's macos-26 (branches `probe/t07-managed-runner-replay`, `…-landing` and `…-scene20`, never
merged). Each round built from this tree's code at 54044973d plus the probe directory.

| Round | Run, probe commit | Scenes | iPhone | Mac |
| --- | --- | --- | --- | --- |
| 1 | 39103921488, b1f3309b5 | 01–11 (14 tests) | 12 passed, 2 failed (04, 08) | 13 passed, 1 failed (08) |
| 2 | 39106161441, 453f53cac | 01–20 (23 tests), the replay's rule for slower lists added | 23 passed | 22 passed, 1 failed (20: the app was gone soon after it launched; see round 4) |
| 3 | 39106580109, 34781f27e | 21–22, each app landing by itself | 2 passed | 2 passed |
| 4 | 39108904091, e759e9d8a | 19–20 again, with the system's crash reports kept | 2 passed | 2 passed |

Round 1's and round 2's compile gates passed on the same tree. OrbitKit's `swift test` ran 3,873 tests with 0 failures, and OrbitApp
and the iOS app built.

**What round 1's failures were.** In scenes 04 and 08 a new account's key is added while the app shows the draft. The
draft has to move from Claude Code's floor to the key's engine and model, as the web's does. The recorder read the
workspace list every 2 s but the provider list only every 15 s. So for 7 s (scene 04: 39.0–46.1 s; scene 08:
39.1–46.2 s) the recording held a workspace list that already named the key (`lastProvider`) and a provider list
without it. The server never gave that pair: one database state serves both reads, and the apps'
`AgentsModel.load()` reads them back to back.

When the app's refresh, which the managed status's new `firstSessionProvider` triggers, fell in that gap, the draft
was rebuilt for the key's provider but found no such provider, so it kept Claude Code's model. On the iPhone in scene
04 this happened at clock 40.1–40.7 s. On the Mac in scene 04 the refresh came at 46.7 s, and the draft showed
"DeepSeek V4 Pro". In scene 08 both apps' drafts sent `model: claude-opus-5` where the recording had
`deepseek-v4-pro`, and the replay failed the test on that key field. The Mac picture `08b` shows the cause: the
sidebar row reads "Claude Code via deepseek-3", the raw slug, because the provider list still lacked the key.

The fix was to the replay, not the apps. A request the recorder read only every 15 s or 30 s is now served its next
recorded answer once the clock is within that interval of it, never past a write the app has not sent. The recorded
answers themselves are unchanged: round 2's scenes are round 1's, byte for byte, apart from that rule. The self-test
checks the rule, and fails without it or without its stop at an unsent write.

**Round 2's Mac failure in scene 20.** The Mac app launched and made its first requests, which are in the replay
log at 07:38:09–11. It then stopped answering the test's accessibility queries for 25 s, its streams closed at
07:38:54, and it was gone when the test next looked: `20a` shows the empty desktop. The scene showed nothing that
scenes 18 and 19 had not: a sleeping status with the runner row still online, on the same session. Round 4 played
scenes 19 and 20 again, keeping the system's crash reports, and both passed on both platforms. Scene 20 ran in full
on the Mac: asleep, the message, the volume gone without Retry, then back with Retry, the press, and the answer. No
crash report was written. Round 2's runner was gone by then, so why its app exited is not known; it did not recur.

### Round 2: all scenes

| Scene | iPhone | Mac | Pictures (iPhone · Mac) |
| --- | --- | --- | --- |
| 01-off-unset-compose | **passed** (78 s), 53 requests, 0 violations | **passed** (33 s), 25 requests, 0 violations | 01-off-unset-compose [iPhone](native/round-2/ios/01-off-unset-compose.png) [Mac](native/round-2/mac/01-off-unset-compose.png) |
| 01-off-unset-session | **passed** (28 s), 61 requests, 0 violations | **passed** (29 s), 37 requests, 0 violations | 01-off-unset-session-deep-link [iPhone](native/round-2/ios/01-off-unset-session-deep-link.png) [Mac](native/round-2/mac/01-off-unset-session-deep-link.png) |
| 02-off-false-compose | **passed** (29 s), 50 requests, 0 violations | **passed** (29 s), 25 requests, 0 violations | 02-off-false-compose [iPhone](native/round-2/ios/02-off-false-compose.png) [Mac](native/round-2/mac/02-off-false-compose.png) |
| 02-off-false-session | **passed** (22 s), 52 requests, 0 violations | **passed** (29 s), 36 requests, 0 violations | 02-off-false-session-deep-link [iPhone](native/round-2/ios/02-off-false-session-deep-link.png) [Mac](native/round-2/mac/02-off-false-session-deep-link.png) |
| 03-off-missing-compose | **passed** (20 s), 35 requests, 0 violations | **passed** (33 s), 26 requests, 0 violations | 03-off-missing-compose [iPhone](native/round-2/ios/03-off-missing-compose.png) [Mac](native/round-2/mac/03-off-missing-compose.png) |
| 03-off-missing-session | **passed** (15 s), 45 requests, 0 violations | **passed** (31 s), 36 requests, 0 violations | 03-off-missing-session-deep-link [iPhone](native/round-2/ios/03-off-missing-session-deep-link.png) [Mac](native/round-2/mac/03-off-missing-session-deep-link.png) |
| 04-wen-first-session-offered | **passed** (50 s), 86 requests, 0 violations | **passed** (53 s), 63 requests, 0 violations | 04a-waiting-no-key-no-first-session [iPhone](native/round-2/ios/04a-waiting-no-key-no-first-session.png) [Mac](native/round-2/mac/04a-waiting-no-key-no-first-session.png)<br>04b-key-added-first-session-offered [iPhone](native/round-2/ios/04b-key-added-first-session-offered.png) [Mac](native/round-2/mac/04b-key-added-first-session-offered.png) |
| 05-wen-preparing-answered | **passed** (121 s), 131 requests, 0 violations | **passed** (119 s), 96 requests, 0 violations | 05a-first-session-queued-waiting [iPhone](native/round-2/ios/05a-first-session-queued-waiting.png) [Mac](native/round-2/mac/05a-first-session-queued-waiting.png)<br>05b-preparing [iPhone](native/round-2/ios/05b-preparing.png) [Mac](native/round-2/mac/05b-preparing.png)<br>05c-answered [iPhone](native/round-2/ios/05c-answered.png) [Mac](native/round-2/mac/05c-answered.png)<br>05d-ready [iPhone](native/round-2/ios/05d-ready.png) [Mac](native/round-2/mac/05d-ready.png) |
| 06-wen-sleep-wake | **passed** (105 s), 125 requests, 0 violations | **passed** (104 s), 95 requests, 0 violations | 06a-going-to-sleep [iPhone](native/round-2/ios/06a-going-to-sleep.png) [Mac](native/round-2/mac/06a-going-to-sleep.png)<br>06b-asleep [iPhone](native/round-2/ios/06b-asleep.png) [Mac](native/round-2/mac/06b-asleep.png)<br>06c-woken-by-a-message-answered [iPhone](native/round-2/ios/06c-woken-by-a-message-answered.png) [Mac](native/round-2/mac/06c-woken-by-a-message-answered.png) |
| 07-wen-restarts-failed-retried | **passed** (263 s), 268 requests, 0 violations | **passed** (259 s), 201 requests, 0 violations | 07a-restarting [iPhone](native/round-2/ios/07a-restarting.png) [Mac](native/round-2/mac/07a-restarting.png)<br>07b-failed-stopped-too-often [iPhone](native/round-2/ios/07b-failed-stopped-too-often.png) [Mac](native/round-2/mac/07b-failed-stopped-too-often.png)<br>07c-retried-by-another-client [iPhone](native/round-2/ios/07c-retried-by-another-client.png) [Mac](native/round-2/mac/07c-retried-by-another-client.png) |
| 08-nia-first-session | **passed** (188 s), 196 requests, 0 violations | **passed** (167 s), 142 requests, 0 violations | 08a-waiting-no-key-no-first-session [iPhone](native/round-2/ios/08a-waiting-no-key-no-first-session.png) [Mac](native/round-2/mac/08a-waiting-no-key-no-first-session.png)<br>08b-key-added-first-session-offered [iPhone](native/round-2/ios/08b-key-added-first-session-offered.png) [Mac](native/round-2/mac/08b-key-added-first-session-offered.png)<br>08c-first-session-queued-waiting [iPhone](native/round-2/ios/08c-first-session-queued-waiting.png) [Mac](native/round-2/mac/08c-first-session-queued-waiting.png)<br>08d-preparing [iPhone](native/round-2/ios/08d-preparing.png) [Mac](native/round-2/mac/08d-preparing.png)<br>08e-answered [iPhone](native/round-2/ios/08e-answered.png) [Mac](native/round-2/mac/08e-answered.png) |
| 09-nia-sleep-wake | **passed** (130 s), 146 requests, 0 violations | **passed** (116 s), 106 requests, 0 violations | 09a-going-to-sleep [iPhone](native/round-2/ios/09a-going-to-sleep.png) [Mac](native/round-2/mac/09a-going-to-sleep.png)<br>09b-asleep [iPhone](native/round-2/ios/09b-asleep.png) [Mac](native/round-2/mac/09b-asleep.png)<br>09c-waking-after-the-message [iPhone](native/round-2/ios/09c-waking-after-the-message.png) [Mac](native/round-2/mac/09c-waking-after-the-message.png)<br>09d-answered [iPhone](native/round-2/ios/09d-answered.png) [Mac](native/round-2/mac/09d-answered.png) |
| 10-nia-out-of-memory-retry | **passed** (194 s), 206 requests, 0 violations | **passed** (189 s), 163 requests, 0 violations | 10a-restarting-out-of-memory [iPhone](native/round-2/ios/10a-restarting-out-of-memory.png) [Mac](native/round-2/mac/10a-restarting-out-of-memory.png)<br>10b-failed-kept-running-out-of-memory [iPhone](native/round-2/ios/10b-failed-kept-running-out-of-memory.png) [Mac](native/round-2/mac/10b-failed-kept-running-out-of-memory.png)<br>10c-retried-waking [iPhone](native/round-2/ios/10c-retried-waking.png) [Mac](native/round-2/mac/10c-retried-waking.png)<br>10d-ready-again [iPhone](native/round-2/ios/10d-ready-again.png) [Mac](native/round-2/mac/10d-ready-again.png) |
| 11-nia-quota-wait | **passed** (112 s), 135 requests, 0 violations | **passed** (116 s), 108 requests, 0 violations | 11a-asleep [iPhone](native/round-2/ios/11a-asleep.png) [Mac](native/round-2/mac/11a-asleep.png)<br>11b-waking-quota-has-no-room [iPhone](native/round-2/ios/11b-waking-quota-has-no-room.png) [Mac](native/round-2/mac/11b-waking-quota-has-no-room.png)<br>11c-answered-once-there-was-room [iPhone](native/round-2/ios/11c-answered-once-there-was-room.png) [Mac](native/round-2/mac/11c-answered-once-there-was-room.png) |
| 12-nia-volume-in-use | **passed** (94 s), 118 requests, 0 violations | **passed** (94 s), 94 requests, 0 violations | 12a-asleep [iPhone](native/round-2/ios/12a-asleep.png) [Mac](native/round-2/mac/12a-asleep.png)<br>12b-waking-volume-held [iPhone](native/round-2/ios/12b-waking-volume-held.png) [Mac](native/round-2/mac/12b-waking-volume-held.png)<br>12c-answered-once-free [iPhone](native/round-2/ios/12c-answered-once-free.png) [Mac](native/round-2/mac/12c-answered-once-free.png) |
| 13-nia-volume-deleted | **passed** (49 s), 84 requests, 0 violations | **passed** (46 s), 59 requests, 0 violations | 13a-asleep [iPhone](native/round-2/ios/13a-asleep.png) [Mac](native/round-2/mac/13a-asleep.png)<br>13b-failed-volume-gone-no-retry [iPhone](native/round-2/ios/13b-failed-volume-gone-no-retry.png) [Mac](native/round-2/mac/13b-failed-volume-gone-no-retry.png) |
| 14-wen-environment-unavailable | **passed** (14 s), 44 requests, 0 violations | **passed** (28 s), 35 requests, 0 violations | 14a-asleep-environment-unavailable [iPhone](native/round-2/ios/14a-asleep-environment-unavailable.png) [Mac](native/round-2/mac/14a-asleep-environment-unavailable.png) |
| 15-root-on-own-workspace | **passed** (26 s), 56 requests, 0 violations | **passed** (31 s), 26 requests, 0 violations | 15-on-own-workspace-draft [iPhone](native/round-2/ios/15-on-own-workspace-draft.png) [Mac](native/round-2/mac/15-on-own-workspace-draft.png) |
| 16-root-on-session | **passed** (20 s), 48 requests, 0 violations | **passed** (29 s), 37 requests, 0 violations | 16-on-session-deep-link [iPhone](native/round-2/ios/16-on-session-deep-link.png) [Mac](native/round-2/mac/16-on-session-deep-link.png) |
| 17-docker-first-session-then-at-the-cap | **passed** (173 s), 181 requests, 0 violations | **passed** (178 s), 129 requests, 0 violations | 17a-waiting-for-capacity [iPhone](native/round-2/ios/17a-waiting-for-capacity.png) [Mac](native/round-2/mac/17a-waiting-for-capacity.png)<br>17b-first-session-offered [iPhone](native/round-2/ios/17b-first-session-offered.png) [Mac](native/round-2/mac/17b-first-session-offered.png)<br>17c-first-session-queued [iPhone](native/round-2/ios/17c-first-session-queued.png) [Mac](native/round-2/mac/17c-first-session-queued.png)<br>17d-preparing-at-the-container-cap [iPhone](native/round-2/ios/17d-preparing-at-the-container-cap.png) [Mac](native/round-2/mac/17d-preparing-at-the-container-cap.png)<br>17e-answered [iPhone](native/round-2/ios/17e-answered.png) [Mac](native/round-2/mac/17e-answered.png) |
| 18-docker-wake-at-the-cap | **passed** (98 s), 124 requests, 0 violations | **passed** (102 s), 100 requests, 0 violations | 18a-asleep [iPhone](native/round-2/ios/18a-asleep.png) [Mac](native/round-2/mac/18a-asleep.png)<br>18b-waking-at-the-container-cap [iPhone](native/round-2/ios/18b-waking-at-the-container-cap.png) [Mac](native/round-2/mac/18b-waking-at-the-container-cap.png)<br>18c-answered [iPhone](native/round-2/ios/18c-answered.png) [Mac](native/round-2/mac/18c-answered.png) |
| 19-docker-volume-in-use | **passed** (119 s), 142 requests, 0 violations | **passed** (116 s), 109 requests, 0 violations | 19a-asleep [iPhone](native/round-2/ios/19a-asleep.png) [Mac](native/round-2/mac/19a-asleep.png)<br>19b-waking-volume-held [iPhone](native/round-2/ios/19b-waking-volume-held.png) [Mac](native/round-2/mac/19b-waking-volume-held.png)<br>19c-answered-once-free [iPhone](native/round-2/ios/19c-answered-once-free.png) [Mac](native/round-2/mac/19c-answered-once-free.png) |
| 20-docker-volume-restored-retry | **passed** (92 s), 119 requests, 0 violations | **failed** (189 s); 20-docker-volume-restored-retry-00: "Managed runner asleep" never showed in 120.0 s; 20-docker-volume-restored-retry-01: no composer to type into | 20a-asleep [iPhone](native/round-2/ios/20a-asleep.png) [Mac](native/round-2/mac/20a-asleep.png)<br>20b-failed-volume-gone-no-retry [iPhone](native/round-2/ios/20b-failed-volume-gone-no-retry.png)<br>20c-restored-retry-offered [iPhone](native/round-2/ios/20c-restored-retry-offered.png)<br>20d-retried [iPhone](native/round-2/ios/20d-retried.png)<br>20e-answered [iPhone](native/round-2/ios/20e-answered.png) |

### Round 3: where each app lands by itself

| Scene | iPhone | Mac | Pictures (iPhone · Mac) |
| --- | --- | --- | --- |
| 21-root-on-home | **passed** (85 s), 53 requests, 0 violations | **passed** (33 s), 22 requests, 0 violations | 21-on-launch-landing [iPhone](native/round-3/ios/21-on-launch-landing.png) [Mac](native/round-3/mac/21-on-launch-landing.png) |
| 22-nia-new-account-home | **passed** (20 s), 31 requests, 0 violations | **passed** (29 s), 22 requests, 0 violations | 22-new-account-launch-landing [iPhone](native/round-3/ios/22-new-account-launch-landing.png) [Mac](native/round-3/mac/22-new-account-launch-landing.png) |

### Round 4: scenes 19 and 20 again

| Scene | iPhone | Mac | Pictures (iPhone · Mac) |
| --- | --- | --- | --- |
| 19-docker-volume-in-use | **passed** (143 s), 127 requests, 0 violations | **passed** (115 s), 105 requests, 0 violations | 19a-asleep [iPhone](native/round-4/ios/19a-asleep.png) [Mac](native/round-4/mac/19a-asleep.png)<br>19b-waking-volume-held [iPhone](native/round-4/ios/19b-waking-volume-held.png) [Mac](native/round-4/mac/19b-waking-volume-held.png)<br>19c-answered-once-free [iPhone](native/round-4/ios/19c-answered-once-free.png) [Mac](native/round-4/mac/19c-answered-once-free.png) |
| 20-docker-volume-restored-retry | **passed** (104 s), 117 requests, 0 violations | **passed** (118 s), 103 requests, 0 violations | 20a-asleep [iPhone](native/round-4/ios/20a-asleep.png) [Mac](native/round-4/mac/20a-asleep.png)<br>20b-failed-volume-gone-no-retry [iPhone](native/round-4/ios/20b-failed-volume-gone-no-retry.png) [Mac](native/round-4/mac/20b-failed-volume-gone-no-retry.png)<br>20c-restored-retry-offered [iPhone](native/round-4/ios/20c-restored-retry-offered.png) [Mac](native/round-4/mac/20c-restored-retry-offered.png)<br>20d-retried [iPhone](native/round-4/ios/20d-retried.png) [Mac](native/round-4/mac/20d-retried.png)<br>20e-answered [iPhone](native/round-4/ios/20e-answered.png) [Mac](native/round-4/mac/20e-answered.png) |

Every scene's pictures and notes are under `native/round-N/<platform>/`, along with the verdict the replay gave
(`verdict-<scene>.json`: requests answered, violations, fields an app's write sent differently outside its key fields)
and the replay's log of every request (`replay.log.txt`). The pictures were recompressed without loss
(`kit/pngpack.py`). All 140 were compared with the runs' originals afterwards: the pixels are identical. Round 1 keeps
only scenes 04 and 08's pictures; its other scenes are round 2's, unchanged.

## How the iPhone and Mac apps were held to the recording

- **Recording** (`kit/t07rec.py`, on the host, against the live test server). As each account, the recorder asked
  every request the two apps make on these screens, at least as often as they do:
  - the capability, and the managed status every 2 s while the capability offers it;
  - workspaces, runners and open sessions (the delta list, `since`) every 2 s;
  - runner and workspace details every 5 s, and the key balance every 30 s;
  - each session's console reads, with its event stream and the global event stream kept open and their events timed.

  Every answer is stored with the instant it came. When told to, the recorder sent the apps' own writes in their
  request shapes:
  - a first session from the draft: `POST /api/sessions` with `{prompt, agentId, model, permissionMode, effort}`, no
    engine or provider named;
  - a message: `POST /api/sessions/:id/turns` with `{clientTurnId, content, kind: "message"}`;
  - Retry: `POST /api/managed-runner/retry` with `{idempotencyKey, revision}`.

  Right after each write it read the managed status and the open sessions again.
- **Scenes** (`kit/scenes.py`, `probe/scenes/*.json.gz`). Each scene is a window of one recording, with the screen the
  app opens on (a new session's draft in a workspace, or a session's console by its deep link) and the steps the test
  plays: wait for words, type, send, press, words gone, words absent, take a picture.
- **Replay** (`probe/replay.py`, on 127.0.0.1 of the macOS runner). The probe apps show the apps' own shells
  (`CompactShell` on the iPhone, `MainView` on the Mac) for the instance `-orbit.instance http://127.0.0.1:8765`,
  without the login screen. The replay checks no credential and none is sent.
  - A read gets the latest recorded answer to the same method, path and query at or before the scene's clock. The
    session list's `since` cursor is the only part ignored.
  - The two event streams play their recorded events at their recorded times, and a session's stream starts from the
    `sinceSeq` the app names.
  - The clock runs from the window's start and stops just before each recorded write until the app sends that write:
    the recorded world waited for it.
  - A read within 3 s after a write gets the first answer recorded after it.
  - Every timestamp in an answer is moved by one constant, so heartbeat ages and "updated" lines read as they did live.
    Nothing else is changed.
- **What counts as a failure.** A request the scene does not hold is a violation, answered 404, and so is a write that
  is not the next recorded one (method and path). So is a write whose key fields differ from the recorded write:
  - the first session's `agentId`, `prompt`, `engine`, `provider` and `model`;
  - a message's `content` and `kind`;
  - Retry's `revision`.

  Other fields that differ are noted. The idempotency key and the client turn id are new on every press. Each test
  ends by asking the replay for its violations, and fails on any. A step whose words do not show in time fails too.

## Checks

On 54044973d, the last code commit, each check ran outside the runner's cgroup with a memory cap, at TZ=UTC:

| Check | Result |
| --- | --- |
| The project's merge check: compose topology, `prisma:generate`, `build`, then the shared, apiserver and web suites | Topology 14/14. Shared 491, apiserver 5,340 and web 5,374 tests (414 files), all passed. |
| The managed-runner Python tests (`unittest discover -s scripts/managed-runner`) | 154 passed. |
| The managed-runner pg specs and both tenant-isolation specs (`scripts/run-pg-spec.sh`) | 15 spec files against PostgreSQL 16.15, none skipped: the 13 managed-runner specs (126 tests), tenant-isolation-runner (725) and tenant-isolation (827), all passed. |
| OrbitKit `swift test` on Linux (`swift:6.1`), as CI's Swift core job | 3,873 tests, 5 skipped (PerfBaselineTests), 0 failures. |
| OrbitKit `swift test` and OrbitApp `swift build` on macOS, and the iOS app for the simulator, in the probe runs | 3,873 tests with 0 failures; both apps built. |

The final tip is the merge of origin/main into this branch. Its code tree is 54044973d's, as the trial merge showed.
The merge check and the Python tests ran again on it; that run is cited in the task's evidence. The first-session pg
spec with this task's cases also passed 4/4 on both backends when the server field was added.

## Gaps

What this evidence does not show:

- **The iPhone and Mac apps were replayed, not live.** No tunnel was opened; the coordinator chose replay. The apps saw
  the test server's answers as the recorder sampled them: every 2 s for the lists and the managed status, every 15 s
  for the slower lists such as the providers. The replay's clock stands in for the live server's timing. It holds
  before each recorded write until the app sends it, a read right after a write gets the next sample, and a slower
  list's sample is served from the start of its interval. So the apps' timing against a live server is not shown:
  how soon a change reaches them, or a race between two of their reads. What they showed for each answer, and what
  they sent, is.
- **No model ran.** Every session ran on fake-model.py as a DeepSeek-preset key; the owner's DeepSeek key file did not
  exist.
- **Native navigation outside the scenes.** The probe opens a named workspace's draft, a session by its deep link, or
  (scenes 21–22) wherever the app lands by itself. Notifications, sign-in and the native Infrastructure page were not
  replayed; their code did not change. The iPad's split layout was not run, only the iPhone simulator and the Mac app.
- **One physical machine.** Cross-node mounting, migration between nodes and takeover after a node fails cannot be
  shown on the single-node lab and are not claimed.
- **States from elsewhere.** `CONTAINER_LIMIT` was produced by a container of the instance that no runner records
  (D7's second case), not by many runners. `PVC_RESTORED` was shown on Docker only, by the runbook's restore
  (`scripts/managed-runner/volume-backup.sh`). On k3s the deleted claim was left deleted. Removing and deleting a runner exist in the fixture only, since the server has no deletion
  flow yet. "Your managed runner needs a model" was shown, but no runtime was signed in from Infrastructure to clear it.
- **Reported, not fixed:** the restart reason lost after the detach wait on Kubernetes (above). Also noted from
  before this task: a Retry pressed on another client shows at the next 30 s read, and the web composer's placeholder
  can read "Reply…" under a failed notice for up to 90 s after the runner's last beat.
- **The web ran in headless Chromium only**, at one window size.

## Files

- `kit/`: everything that ran:
  - the lab steps (`t07lab.py`, `step-*.sh`, `env.sh`) and the Docker phase (`t07docker.py`, `env-docker.sh`,
    `step-dock-*.sh`);
  - the web observer and its server (`t07web.mjs`, `serve-web.mjs`);
  - the recorder (`t07rec.py`), the replay and its self-test (`replay.py`, `replay_selftest.py`, 16 checks);
  - the scene plan (`scenes.py`), the tables (`websummary.py`, `nativesummary.py`), the picture recompression
    (`pngpack.py`), `secret-scan.py`, `push-probe.sh`, `pg.sh`, and `selfhost-beat.py` (root's own runner beating for
    the switch-off scenes).
- `records/lab/`, `records/docker/`: every step's answer, numbered in order, and the marker times the scenes were cut
  at. `08-eve-limit.json` is missing: the first Docker attempt, which waited for `CONTAINER_LIMIT` by the budget alone,
  was stopped (the budget caps runners at the channel's cap) and replaced by `step-dock-cap.sh`.
- `web/<account>/`: `web.jsonl`, the pictures in `shots/`, and the presses in `cmd/`. [web/TABLES.md](web/TABLES.md)
  has the tables.
- `recordings/<account>/recording.jsonl.gz`: the recorder's full record, every exchange and stream event with its time,
  and its actions in `cmd/`.
- `probe/`: the probe as round 2 pushed it, plus round 3's scenes 21–22. The scenes are in `scenes/*.json.gz`;
  gunzip them before running `run.sh`. `probe/round-3/` and `probe/round-4/` hold those rounds' workflow and README.
- `native/round-1/` to `native/round-4/`: each run's pictures, notes, verdicts, replay logs and test summaries.
  The compile gates' summaries for rounds 1 and 2 are in `gate-*`.
- `secret-scan.json`: the scan of this directory.
