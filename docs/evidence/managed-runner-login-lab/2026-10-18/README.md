# Sign-in provisioning against the lab's real k3s (2026-10-17)

This is task T05 (34ZtjTxQPzZXT1O7XfUQZ) of project 34ZteKCnYMpKY46f63Leb, for criterion 5. It checks, on the lab's real k3s, that:

- a new account's sign-in provisions its default managed runner and workspace, and its first session runs;
- repeated and concurrent sign-ins add nothing;
- an account that already has workspaces keeps its landing and its deep links;
- a provisioning that fails can be retried, and the sign-in still works;
- with the switch unset or `false`, nothing managed happens for a new or an existing account.

The lab is the single-machine one ([docs/managed-runner-lab.md](../../../managed-runner-lab.md)): one node and one failure domain. Times are UTC, 2026-10-17. The apiserver logs print local time (UTC+8), so `7:36:30 AM` is 23:36:30.

**No model was used.** The owner's DeepSeek key file (`/mnt/data/managed-runner-lab/secrets/deepseek-api-key`) did not exist (task comment 34hjA3lzwqVYPZuawOQPo). Every session ran on a model key of the DeepSeek preset whose endpoint is the lab's [fake-model.py](../../../../scripts/managed-runner/lab/fake-model.py). That is the same provider kind, preset, runtime (Claude Code) and code path as the real key, with a different `baseUrl` and key, but its canned answers are not a model. The real DeepSeek first session is still to be done (see "Not shown here").

## Where it ran

| Part | Value |
| --- | --- |
| Lab | VM `orbit-mr-lab` as L0 built it (k3s v1.36.5+k3s1, Ceph 20.2.4, Ceph-CSI v3.18.0, StorageClass `runner-data`, namespace `orbit-mr-test`). Window 1: booted 23:03, healthy 23:05:11, off 23:15:38 ([records/start-1.txt](records/start-1.txt), [records/window1-end/vm-stop.txt](records/window1-end/vm-stop.txt)). Window 2: booted 23:33, healthy 23:35:00, off 23:51:24 ([records/w2/start-2.txt](records/w2/start-2.txt), [records/final/vm-stop.txt](records/final/vm-stop.txt)). |
| Test server | This branch's apiserver with its own PostgreSQL, TLS front and fake model, all on 127.0.0.1 and outside the runner's cgroup. State is in `LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t05`; the databases of T02a, T03 and T04 were not touched. Window 1 ran the project tip `46267447f` (before the change below), window 2 ran `baea95083`, which has it ([records/04-off-unset-start.txt](records/04-off-unset-start.txt), [records/w2/05-on-start.txt](records/w2/05-on-start.txt)). While the switch was on, replica B (`orbit-mr-lab-api-b`, port 13720) ran on the same database and profile. A second, fresh deployment (`test-server-t05b`, a new database) ran last, for its first user's bootstrap ([records/bootstrap/](records/bootstrap/)). |
| Image | T02a's lab image, still in the guest's containerd: `docker.io/library/orbit-managed-runner-lab@sha256:54441a07…aef98d`, which is the product image of 292b2eb43 plus the lab CA. No runner or image code changed since 292b2eb43, and nothing was built, imported or pushed. The runners reported Claude Code 2.1.300 and Codex 0.158.0 installed, both signed out ([records/w2/12-erin-provisioned-starting.json](records/w2/12-erin-provisioned-starting.json)). |
| Manager and profile | T04's identity (ServiceAccount `orbit-mr-manager`, least RBAC) and T02a's lab CA and webhook token, copied by `login-lab.py prepare` ([records/01-prepare.json](records/01-prepare.json)). The API server is the gate on 127.0.0.1:16444, `resourceProfileId` is `orbit-mr-lab-t05`, and the budget is three runners (1500m, 2304Mi, 3 Pods, 3 attachments, 3 users), which is what the node holds. `maxAttempts` 5, poll 5 s, startup deadline 12 h. |
| The gate | T04's [api-gate.py](../../../../scripts/managed-runner/lab/api-gate.py): the manager's only way to k3s. It logs one line per connection ([logs/api-gate.jsonl.gz](logs/api-gate.jsonl.gz), 2,105 connections). `login-lab.py gate-summary` tells a create from a read by the size of its request, using the sizes T04 measured: PVC create 1,623, Secret 1,669, Pod create 4,084, admission probe 4,111. |

The driver is [login-lab.py](../../../../scripts/managed-runner/lab/login-lab.py). It uses T04's manager-lab.py and T02a's single-writer.py for the gate, the replica, the admission guard and the cluster views. It adds commands for accounts and sign-ins, an existing account with its own runner, landing and deep links, the switch-off check, a model key, sessions, provisioning timelines, and a fault that refuses the sign-in's intent. The landing check runs the web client's own rule (`src/web/src/lib/workspaceOrder.ts`, `firstOpenableWorkspace`) under Node, over the list the server answers.

No record holds a credential. [kit/secret-scan.py](kit/secret-scan.py) looked for 46 of them in all 154 files here and found none: every owner's password and tokens, the self-managed runner's token, both servers' database, JWT and provider secrets, the webhook token, the manager's token and the lab admin's key.

## The finding, and the change (`baea95083`)

C5 made READY need a runtime **signed in on the runner itself** (`auth: yes`: a Claude, Codex, Kimi or Antigravity login). A model key configured on the server did not count, and the owner's DeepSeek key is exactly such a key. The engine sign-in relay is OAuth only, so a key cannot become that sign-in. Window 1, on `46267447f`, showed what that means for a new account whose only model is a key ([records/20–27](records/)):

- dora signed in, and its runner came up and heartbeated with Claude Code and Codex installed and signed out. The mapping stayed `STARTING` with `MODEL_UNAVAILABLE`.
- dora then added a DeepSeek-preset key (slug `deepseek`). 45 s later, with the manager passing every 5 s, it was still `MODEL_UNAVAILABLE`, `initialProvider` was still null, and the shared display said "Your managed runner needs a model" with `startsNewSession` false. So no client would offer the default workspace's first session ([records/23-dora-watch-after-key.jsonl](records/23-dora-watch-after-key.jsonl), [records/24-dora-status-key-prefix.json](records/24-dora-status-key-prefix.json)).
- A first session with nothing named was refused (409 `ENGINE_SIGNED_OUT`). One that named the key ran: it was claimed by dora's runner, Claude Code sent the prompt to the key's endpoint a second after the session was created, and the session answered ([records/25](records/25-dora-session-no-provider-prefix.json), [records/27](records/27-dora-session-key-named-prefix-result.json)).

The coordinator agreed to fix it here (task comment 34hjH9nku4wGWaphioiYA and its reply). The rule is the same on both backends:

- **Supply** (`managed-runner-supply.ts` `managedKeySupply`, read by the manager's STARTING step): when no runtime is signed in, the owner's own enabled model keys count. They are taken in the owner's order (`position`, unset last, then age). A key counts when the runner reported the engine it runs on installed (and advertised where the claim needs it); that engine needs no sign-in, because a session on a key brings its own credential. READY records the key's slug as `initialProvider`. These keys do not count:
  - another account's key;
  - a shared key (an administrator's);
  - a disabled key;
  - a key whose slug is a built-in runtime's name.
- **First session** (`workspace-provider.ts` `lastProviderByWorkspace`): a managed default workspace with no history, whose runner is READY on a key, starts on that key, on the engine the key's row names. A first session with nothing named therefore runs on it, and so does the default draft every client offers.
- **Words**: the `MODEL_UNAVAILABLE` sentence (the server's reason, the first-session refusal and the clients' fallback copy on web and OrbitKit) now says a model key also clears it. The shared state fixture gains "available: ready on one of the owner's model keys". The design doc's sign-in record says the same.

| Check | Result |
| --- | --- |
| Unit | `managed-runner-supply.spec.ts` (the owner's key in their order; not another's, disabled or built-in-named; the engine missing or unadvertised; a Cursor key and an unknown protocol) and `workspace-provider.spec.ts`: 31/31 with the status and fixture specs. Whole apiserver unit suite: 5,330/5,330 ([logs/unit-apiserver-summary.txt](logs/unit-apiserver-summary.txt)). |
| pg, Kubernetes | `managed-runner-sign-in.pg.spec.ts` (B8), on the whole AppModule over the fake cluster. Another account's key, a disabled key and a shared key leave a key-only owner `MODEL_UNAVAILABLE`. The owner's own key, added through `POST /providers/mine`, makes it READY on that slug. The default workspace then answers `lastProvider` = the slug and `lastEngine` = `claude`. A session with nothing named starts on the key, and the runner's claim carries the key's endpoint and the key ([logs/pg-sign-in-and-docker.txt](logs/pg-sign-in-and-docker.txt)). |
| pg, Docker | `docker-backend.pg.spec.ts` (13): the same rule through the restricted channel. |
| Controls | Undoing the manager's key supply turns exactly B8 and Docker (13) red ([logs/pg-control-supply.txt](logs/pg-control-supply.txt)). Undoing the seed turns B8 red (`lastEngine` null) ([logs/pg-control-seed.txt](logs/pg-control-seed.txt)). Every other case stays green. Each file was restored byte for byte ([kit/mutant.sh](kit/mutant.sh)). |
| All managed pg specs | 12 files, 121 cases, green on `baea95083` ([logs/pg-managed-all-summary.txt](logs/pg-managed-all-summary.txt)). |
| Clients | OrbitKit `swift test` in `swift:6.1`: 3,870 tests, 5 skipped (the Linux perf baselines), 0 failures ([logs/orbitkit-swift-test-summary.txt](logs/orbitkit-swift-test-summary.txt)). Web: `App.managedRunner`, `ManagedRunnerNotice`, `WorkspaceView.managedRunner` and `copyLanguage`: 50/50 ([logs/web-managed-tests-summary.txt](logs/web-managed-tests-summary.txt)). No navigation changed. |

## Results on real k3s

### 1. The switch unset, and `false`: the old sign-in, nothing managed

| Run | Accounts | Result |
| --- | --- | --- |
| Unset, `46267447f` | The deployment's first user (bootstrap, new) ([records/06](records/06-unset-bootstrap.json)). Then nora (new) and vera (existing: a self-managed runner, two workspaces she reordered, a session) ([records/10](records/10-unset-new-and-existing.json)). | Every sign-in 201, its token works (`GET /users/me` 200). `/auth/capabilities` and `/managed-runner` say `enabled: false`, and the shared display makes nothing of them, so no client shows managed UI. `ensure`, `retry`, `wake`, `sleep` and `delete` each answer 404 `MANAGED_RUNNER_DISABLED`. No mapping is written, no runner or workspace is created or changed (identity and placement columns compared), and the namespace is unchanged (every object's UID and resource version) for 60 s. The gate saw no connection at all: its first connection ever came at 23:12:24.364, when dora's provisioning began with the switch on. |
| `false`, `46267447f` | nell (new); vera, nora and the admin (existing) ([records/13](records/13-false-new-and-existing.json)). | The same, for 90 s. |
| `false`, `baea95083`, six mappings present | olga (new); erin and vera, whose mappings were asleep ([records/w2/82](records/w2/82-false-after-fix.json)). | The same, for 90 s. The mappings are unchanged, and the sleeping ones show no managed UI. |

vera's landing (the web's own rule over `GET /workspaces`) stayed her first workspace, `web`. Her deep links (`GET /workspaces/:id` ×2 and `GET /sessions/:id`) answered 200 with the same body after every one of these sign-ins ([records/11](records/11-vera-landing-unset.json), [records/14](records/14-vera-landing-false.json), [records/w2/83](records/w2/83-vera-landing-false-after-fix.json)).

### 2. A new account, from its sign-in to its first session

erin, on `baea95083` ([records/w2/10–19](records/w2/)):

| When (UTC) | What |
| --- | --- |
| 23:36:30.925 | `POST /auth/login`: 201 in 46.8 ms, token works. |
| 23:36:30.96 | The mapping, the runner row (OFFLINE, a credential nobody holds) and the default workspace are created in one transaction. The workspace is bound to that runner by `runnerId` and `targetRunnerId`, with workDir `/var/lib/orbit/home/orbit-repos/default` and position NULL. |
| 23:36:31 | PVC created and bound to a new PV (`rbd.csi.ceph.com`, ext4, image `csi-vol-bbab8bdb…`). |
| 23:36:35 / 23:36:36 | Bootstrap Secret (generation 1); Pod created, the admission guard asked first. |
| 23:36:46 / 23:36:47 | Init container done; the runner container starts. |
| 23:37:17.722 | The runner's first heartbeat: Claude Code and Codex installed, signed out. 23:37:22.4: `STARTING`, `MODEL_UNAVAILABLE`. |
| 23:37:22.8 | erin adds a DeepSeek-preset key (slug `deepseek-2`, fake endpoint). |
| 23:37:32.3 | **READY** with `initialProvider` = `deepseek-2`, usable, "Managed runner ready", `startsNewSession` true. The default workspace answers `lastProvider` = `deepseek-2` and `lastEngine` = `claude`, and the web's landing rule lands on it. |
| 23:37:41.4 | `POST /sessions` with the default workspace and a prompt, **nothing named**, as a client's first message sends it: 201 on `deepseek-2` and `claude`, assigned to erin's managed runner. |
| 23:37:41.8 → 23:37:43.8 | Claimed (RUNNING). Claude Code in the Pod sends the prompt to the key's endpoint (23:37:42, [logs/fake-model-t05.jsonl](logs/fake-model-t05.jsonl)); the answer and `turn_end` arrive; AWAITING_INPUT. |

Inside the Pod, `/var/lib/orbit` is `/dev/rbd2` ext4 (2 GiB). The default workspace is a Git repository whose baseline commit is authored by `Orbit Runner <runner@orbit.invalid>` (`autoInitGit`), and the first session's worktree is on the same volume. The runner runs as UID 10001 ([records/w2/19](records/w2/19-erin-volume-and-worktree.txt)). In k3s the gate saw one PVC create, one Secret create, one admission probe and one Pod create for erin ([records/final/gate-erin.json](records/final/gate-erin.json)).

The same chain ran three more times:

- **dora, the account from window 1.** After the VM restart the kubelet reported its old Pod stopped (exit 255), and the manager started generation 2 on the same volume (PVC `4ede0589…`). Generation 2's first heartbeat came at 23:36:07; 2 s later dora was READY on its own key `deepseek`. That is the window-1 mapping, with nothing redone ([records/w2/08](records/w2/08-dora-until-ready.json), [records/w2/09](records/w2/09-dora-provisioned-ready.json)).
- **The first user of a fresh deployment.** A new database with 0 users and the switch on. The bootstrap answered 201 in 75.6 ms (23:49:02.5). PVC, Secret and Pod followed at 23:49:02–07, the first heartbeat at 23:49:43, and READY on its key at 23:49:48. Its first session, with nothing named, ran on the key and answered at 23:49:53 ([records/bootstrap/](records/bootstrap/)).
- **ivy, jack and vera** below: each became READY on its key the same way.

### 3. Concurrent and repeated sign-ins add nothing

hank, a new account opened by the administrator, then signed in 16 times at once, alternating between replica A and replica B ([records/w2/20–33](records/w2/)):

- All 16 answered 201 (the slowest in 412 ms), and every token works.
- The result was one mapping, one runner and one workspace.
- The gate saw exactly one PVC create, one Secret create, one admission probe and one Pod create from the start of the race: no duplicate was even sent ([records/w2/24](records/w2/24-hank-gate-summary.json)). The database and k3s agree ([records/w2/25](records/w2/25-consistency-after-race.json)).

Once hank was READY, five more sign-ins (201, 38–49 ms) changed nothing. The mapping stayed at revision 13, there was still one mapping, runner and workspace, and the gate saw no create, only the managers' reads ([records/w2/28–33](records/w2/)). Every account that signed in with the switch on holds exactly one mapping, one managed runner and one default workspace ([records/w2/73](records/w2/73-owner-counts.txt)).

### 4. An existing account keeps its landing and its deep links

vera already had her own runner `vera-laptop` and two workspaces she had arranged as `web` above `api`, the reverse of the order she created them in. She also had a session. She signed in with the switch on, when the pool was full (dora, erin and hank READY) ([records/w2/34–44](records/w2/), [records/w2/74–76](records/w2/)):

- **Sign-in and wait.** The sign-in answered 201 in 50 ms. Her mapping went to `WAITING_CAPACITY` ("Waiting for capacity", retry in 30 s), and nothing was created in k3s (the gate saw only reads).
- **Admission.** When dora was put to sleep (DRAINING 23:39:58, SLEEPING 23:40:20, Pod gone), vera's mapping was admitted 4 s later and started.
- **Unchanged at every step** (waiting, starting, READY on a key, and later with the switch `false`):
  - her two workspaces, in her order;
  - the web landing, still `web`;
  - every deep link: 200, same body.
- **The new workspace.** The one addition was the managed default `Default`, with position NULL, sorted last. Nothing was matched by name.
- **Her own runner.** `vera-laptop` is unchanged beside the new `orbit-managed` runner.

### 5. A provisioning that fails, and its retry

| Case | What happened |
| --- | --- |
| The intent cannot be written: a trigger in the test database refuses every `managed_runner` insert ([records/w2/47–56](records/w2/)) | ivy's first sign-in answered 201 in 35.5 ms, and the token works. The server logged "managed runner intent not recorded at sign-in … an explicit ensure records it". Nothing half-made was left: no mapping, runner or workspace. Status was `NOT_PROVISIONED` with `canEnsure`, shown as "Set up a managed runner". With the trigger dropped, ivy's next sign-in (201, 48 ms) recorded the intent. Provisioning started 0.2 s later, and ivy was READY on its key at 23:42:12. |
| The cluster refuses to start it: the admission guard is removed ([records/w2/57–70](records/w2/)) | jack's first sign-in answered 201 in 31.9 ms, and the token works. The manager made the PVC and generation 1's Secret, its admission probe was admitted, and it stopped: `FAILED`, `ADMISSION_GUARD_MISSING`, retryable, no Pod. Clients show "Managed runner failed" with Retry. Another sign-in (201) left it FAILED at revision 9: a sign-in does not retry. With the guard back, the owner's retry (202, at revision 9) moved it to REQUESTED. It became READY on its key, with the same mapping, the same PVC (`d1075e02…`) and generation 1's Pod. |

### 6. The database against k3s, and the others' objects

- **The database against k3s.** At the end, `consistency` found no problem ([records/w2/71](records/w2/71-consistency.json), [records/bootstrap/15](records/bootstrap/15-consistency.json)). Each mapping's PVC is bound and is the recorded one. No check and no watch ever saw more than one Pod on a volume. A sleeping mapping has no Pod and no attachment.
- **The other tasks' objects.** The 14 objects of L0, T02a and T04 in the namespace kept their UIDs and resource versions ([records/w2/72](records/w2/72-foreign-check.json)).
- **What is left in the lab.** Every T05 runner was put to sleep, so no T05 Pod remains. The seven T05 PVCs stay as retained test data ([records/final/namespace-at-end.txt](records/final/namespace-at-end.txt)). The webhook configuration is removed, and the VM, both test servers, the replica, the gate and the recorder are off.

## Not shown here

- **A real DeepSeek first session.** The owner's key file does not exist, so every session ran against fake-model.py, which is not a model. The real one needs only the key on the account: `login-lab.py key NAME --key-file /mnt/data/managed-runner-lab/secrets/deepseek-api-key`, then `session NAME --prompt …` (nothing named) and `wait-session NAME ID --any-answer`. It goes through the same preset, runtime and path as the fake key, with `https://api.deepseek.com/anthropic` as the endpoint.
- **Clients.** No browser or native client was driven. The landing was evaluated with the web's own ordering code over the server's answers, and the display with `@orbit/shared`'s `managedRunnerDisplay`. Client rendering is criterion 7's (T07).
- **Several nodes.** This is one node and one failure domain. Nothing here needs a second node, but it shows nothing about one.
- **An unreachable cluster at sign-in.** Not repeated here. T04 showed that an API outage spends no attempt and the runner goes on afterwards.
- **The window-2 timeline.** The recorder unit failed at its start in window 2: PostgreSQL was not up yet, and `sql()` exits rather than raising an exception. It is fixed in login-lab.py. Every window-2 step kept its own timestamped `until` or `watch` record, quoted above. [logs/timeline-window1.jsonl](logs/timeline-window1.jsonl) covers window 1.
- **Observed, not changed.** On a managed runner, `ENGINE_SIGNED_OUT` still says "or run `claude auth login` on that machine", which an owner cannot do there ([records/25](records/25-dora-session-no-provider-prefix.json)). With the change, a default first session no longer meets it.
