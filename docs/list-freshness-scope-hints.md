# Scope hints: an Open list reads only when its own scope may have moved

Status: design, nothing built · 2026-11-22 · task 351lKeumGIjTw8S8IoUzt (list-freshness project 34tKYCMLgan4tpcxkUn44)

Built since: §9 task 0 (migration 1428), task 1 (§5.0), and tasks 4–6 (Option A: migration 1464, `hints=list_scopes`, the web filter), task 3527hS20sC7Fl5tmSIfvp, 2026-11-23.

Builds on:
- [list-freshness-design.md](./list-freshness-design.md): §3 (hints), P2 and P4.
- [realtime-control-plane-stream.md](./realtime-control-plane-stream.md): §4.8 (`sessions.list_changed`) and §4.9 (the opt-in precedent).
- [postgres-lock-order.md](./postgres-lock-order.md): §4, the `open_list_epoch` row.

Where the numbers come from. Every production number below cites one of these sources:
- **[P1]** The production profile of the owner's web tab, 2026-11-21 17:15–18:57Z. It is the comment of 2026-11-21 19:04Z on task 351V4gGnbPbm9hlmbKNjq (raw output bgj_ae9428e95e83), and the coordinator's restatement in the description of task 351lKeumGIjTw8S8IoUzt.
- **[P2]** The coordinator's answer to this task's data request: comment 351mC0Y46yEh1zrPyOlsE on task 351lKeumGIjTw8S8IoUzt, answering comment 351lYRQ8sgXZOKTqhO67F. Production was read only, through orbit-prod run 351lzHC55tOwGNNvU6cjR.
- **[P3]** The production sampler of §7.2, 2026-11-22 03:10:29–03:25:28Z. It is the script in comment 351mPKYtcAvGEc5X1xqr0, run read-only on production by the coordinator. The verbatim output and the gateway-log cross-check are comment 351mslR2LUQZDmpEeKqSr on task 351lKeumGIjTw8S8IoUzt.

Every local number cites one of two bg_run jobs. Each ran one throwaway pg spec through `scripts/run-pg-spec.sh` on PostgreSQL 16.15 with all 618 migrations applied. Neither spec was committed; their sources are attached to the task's evidence.
- **[L1]** `bgj_f755bfb42470`: the measurements (spec sha256 `f9bf64aa87e2064cde833d82568bae5691fb69f494daf9975ca23ff8de17ea2e`).
- **[L2]** `bgj_3a84f4f54bc5`: a check of the [P3] sampler on the real schema (sampler sha256 `4a64cf3dba1b486626964dbb11bdce8a08bcfb7b9f04c8da3f313f368b4d7d55`).

Local timings come from a small database on a shared build host. They show how options compare with each other. They are not production latencies.

Paths in this doc are shortened. Each starts under one of these roots:

| Prefix | Root |
|---|---|
| server paths | `src/apiserver/src/` (migrations under `src/apiserver/prisma/migrations/`) |
| web paths | `src/web/src/` |
| `OrbitKit/…` | `src/macos/OrbitKit/Sources/` |
| `OrbitApp/…` | `src/macos/OrbitApp/Sources/` |
| Android `core/…` | `src/android/core/src/main/kotlin/io/orbitd/android/`; the `core/` is part of the path |
| Android `app/…` | stands for `src/android/app/src/main/kotlin/io/orbitd/android/`, so `app/directory/DirectoryScreen.kt` is `…/io/orbitd/android/directory/DirectoryScreen.kt` |

---

## 1. Summary

- **Today, one hint goes to the whole account, and every client then reads every Open list it shows.**
  - The owner's column read nothing new in 870 of 2,180 reads on 2026-11-21 [P1].
  - It read nothing new in 183 of 394 reads on 2026-11-22 [P3].
- **Measured, the main cause is not other workspaces.** A heartbeat's directory probes rewrite the runner's workspace rows on every beat (§2.2). The workspace trigger counts these writes, yet no list draws them.
  - In a 15-minute production sample, the `workspace` counter moved in 184 of 900 seconds. In the same 15 minutes the tab got 183 nothing-new answers [P3].
  - The coordinator is filing the fix separately: a 1420-style compare in that trigger.
- **The presence clock tick matters only when the account is quiet.** It sent 4 hints a minute with nothing written [L1], but only 6 in 418 hints in a busy window [P3].
- **Per-workspace keys save little in the measured windows.** In both, the owner watched the workspace doing the work:
  - orbit-ws01 ran 66 of the 80 turns on 2026-11-21 [P2];
  - here, its sessions moved in 279 seconds against 39 for every other workspace [P3].

  Replayed conservatively, the keys alone removed 1 hint in 418. Even after the workspace fix, at most a fifth more of the hints could go. For a column of a quiet workspace, the keys would remove almost every hint the busy workspaces cause there [L1].
- **Only the web reads a workspace's own Open list.** Apple and Android read one account-wide list and filter it on the device (§3), so per-workspace hints cannot reduce their reads.
- **Recommendation, in order** (§8.1):
  0. The workspace trigger fix (filed separately).
  1. **(S)** A hint token without heartbeats, whose runner part is `steady`. The poller then stops reading the version on seconds in which only counters moved.
  2. **(S)** Stop hinting on the five sources only LANDING rows read.
  3. **(S)** Re-measure with the same sampler.
  4. **Only if** hints from outside a column's workspace are then still material: per-workspace keys inside `open_list_epoch` **(L)**, `scopes` on the hint for streams that declare `hints=list_scopes` **(M)**, and the web column filtering by them **(S)**. This needs no DDL and keeps 0487's no-wait bump. Apple and Android need nothing.
- **Freshness stays at about a second** under every step: every drawn write still moves a counter in its own transaction, and every hint still goes out within one tick.

## 2. How a hint and a read work today

### 2.1 The counters (write side)

- **The sources.** Thirty-one tables carry three statement-level triggers each:
  - 29 tables from 0484 (`prisma/migrations/0484_open_list_epoch`);
  - `session_scheduled_wakeup` and `watch` from 0641.
- **The bump.** Each trigger bumps its owner's `(owner_id, source)` counter in the writing transaction. 0487 replaced the bump with `open_list_bump(o, src)` (`0487_open_list_epoch_shards/migration.sql:51-69`):
  - it takes `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1` over the owner's rows keyed `src` or `src#<n>`;
  - it adds one to the row it got;
  - when every such row is held by another transaction, it inserts `src#<nextval>` instead.

  So a bump never waits for another transaction and adds no edge to any wait graph (`postgres-lock-order.md` §4).
- **Writes that no longer bump.** 0512, 0641 and 1420 drop writes no list draws:
  - a landing's lease renewal;
  - a watch's clock columns;
  - `session` and `conversation_turn` UPDATEs that change only `OPEN_LIST_UNDRAWN_SESSION_COLUMNS` or `OPEN_LIST_UNDRAWN_TURN_COLUMNS` (`sessions/open-list-version.ts:196-217`).
- **How the owner is found.** There are four paths:
  - the row's own `owner_id` (23 sources, `watch` among them, through its own function from 0641);
  - via `project_id` (3);
  - via `session_id` (`approval`, `conversation_turn`, `session_tag_link`, `scheduled_wakeup`);
  - the session's own row, CONVERSATION only.
- **How a `since=` read classes the sources** (`sessions/sessions.service.ts:535-563`):
  - **Row sources** are found row by row: `session`, `conversation_turn`, `task`, `project`, `coordinator_wake`, `workspace`, `watch`.
  - **Overlay sources** make the read re-read every row's cards and decisions: approvals, requests, decisions, confirmations, evidence, criteria, ratified actions, standard sets, criterion definitions and task status counts.
  - **The five sources once called LANDING-only** are `promotion`, `integration_job`, `project_open_item`, `merge_receipt` and `codebase`. A LANDING row's summary reads them, and the project page's `includeLanding=1` Open list draws LANDING rows, but flat-list rows read them too, through `listOverlay` on every coordinator conversation (readOwnerDecisionsBySession, readOwnerDecisionSignals, readOwnerItemSignals in `projects/owner-decision-signal.ts`): `project_open_item` (OPEN items assigned to OWNER: `pendingApprovals`, `waitingKind`, `ownerItems`); `promotion` and `integration_job`, through `openItemsNoLongerOwed` and `openItemOwed` (a PROMOTION_APPROVAL is owed only while its promotion is READY, a LANDING_LEASE_EXPIRED only while its job is RUNNING at that claim generation); `codebase` (the item's `mainBranch`); and `merge_receipt`, through `openItemOwed`'s LANDING_UNOBSERVED branch and `taskLandingSql` (`projects/project-criterion-landing.ts`). So the comment at `sessions.service.ts` `OPEN_LIST_OVERLAY_SOURCES` was wrong, and none of the five can leave the hint token (§5.4).
  - **Whole-build sources** send a `since=` read to a whole build: `session_tag`, `session_tag_link` and `scheduled_wakeup`.

### 2.2 The poller

`realtime/open-list-hints.ts` keeps one tick chain per apiserver process. Each tick starts 1 s after the previous one ended.

1. One statement sums `open_list_epoch` per owner for every account with a declared stream on this process (`:114-118`).
2. The version is read (`readOpenListVersion`, one statement) when any of these holds (`:130-131`):
   - an account's sum moved;
   - 15 s have passed since the last clock tick;
   - a stream has not been told anything yet.
3. Every stream whose last-told version differs gets `sessions.list_changed {version}` (`:134-145`).

Besides the counters, the version hashes these (`sessions/open-list-version.ts:94-157`):
- the runner rows (`ctid:xmin`);
- **every runner's `runner_presence` row (`ctid:xmin`, `:120`)**;
- the share links, and the foreign running turns a queued row waits behind;
- a count of each clock threshold.

Every heartbeat upserts the runner's presence row (`runners/runner-presence.ts:152`; `RUNNER_HEARTBEAT_EVERY_MS` = 30 s, `:28`). `markRunnersChanged` rewrites it too (`:175`), and a durable beat rewrites the runner row every 5 min (`:47`). So the 15 s clock tick almost always finds a new version, even when no row of any list moved.

A heartbeat also writes the `workspace` source. When the beat carries directory probes, it rewrites the row of every workspace it probed on the beating runner (`WHERE w.id = v.agentId AND w.runner_id = …`):
- the link path does this in `directoryProbesSql` (`runner-api/link-heartbeat.ts:830`);
- the HTTP path does it in `runner-api/runner-api.controller.ts:2706`.

The columns are `work_dir_exists`, `work_dir_is_git`, `work_dir_free_bytes`, `work_dir_total_bytes` and `repo_url`, with `work_dir_probed_at` set to now on every beat. 0484's workspace trigger bumps on every UPDATE, so these beats move a counter. Yet the list row reads only a workspace's name, model and effort (the probe's `workspaces` map, `sessions.service.ts:4632-4633`). These are writes no list draws, the class 1420 removed for `session` and `conversation_turn`. In [P3] the `workspace` counter moved in 184 of 900 seconds.

### 2.3 The read

`GET /sessions?view=open&…&since=<cursor>` goes to `SessionsService.listOpenSince` (`sessions.service.ts:4393`). It runs in three steps:

1. **The version check.** It reads the version's parts. If the cursor's snapshot was built at the version that stands now, it answers an empty delta and builds nothing (`:4432-4434`).
2. **The row-by-row path.** If the version moved, but the runners' names, statuses and liveness (`steady`) did not, and every source that moved is row- or overlay-local, then `openListFromBase` (`:4492`) does three things:
   - it probes every row of the list: two statements, the row tokens and a few account-wide maps (`:4556`);
   - it re-reads the overlay where its rules say so;
   - it builds only the rows whose token moved, plus queued rows.
3. **Otherwise**, a whole build.

So a read that finds nothing new costs a version read plus a probe of the whole list. Measured locally [L1], on a 550-row column whose version moved through a write in another workspace, it cost a median of **13.9 ms** (60 reads, 0 rows built). Its parts measured alone:
- the version read: 2.6 ms;
- the probe: 4.0 ms.

The rest is the overlay re-read and Prisma's own overhead.

Snapshots live in the process that built them (16 per owner, 15 min).

### 2.4 Several apiservers

With `gateway/several-apiservers/` mounted, the gateway spreads only some routes over every apiserver (`http/upstreams.conf`, `server/routes.conf`):
- the per-session transcript streams;
- guest and shared streams;
- runner link tokens.

`GET /api/events` and every REST read stay on the first apiserver (`first/fallback.conf`). So an account's control streams and its `since=` reads share one process. The exceptions are a two-stage handover and the fallback to another apiserver; then two processes each poll for their own streams.

Writes come from every process, including runner ingest over the link. They reach every poller through the counters, which live in the database, not in any process.

## 3. The scopes the clients show

| Scope | Read | Client | Follows the hint today | Gains from per-scope hints |
|---|---|---|---|---|
| A workspace column | `GET /sessions?runnerId=R&workspaceId=W&view=open&since=` (`WorkspaceView.tsx:3004-3011`). With a page limit it is a plain read with the version ETag (`queries.ts:402-406`). | Web. One `WorkspaceView` per tab (`WorkspaceConsole.tsx:139`). | Yes. Every hint refreshes every active Open-list query (`useControlPlane.tsx:296-299`), one read in flight per list, 1 s window (`:14`). A hidden tab reads nothing until it is back in view (`:240-241`). | **Yes.** The main case. |
| The same column with a tag filter | Adds `tagId=` (a subset of W). | Web | Yes | Yes, as the column |
| A workspace's settings page | `workspaceId=W&view=open`, no runner (`settings/WorkspaceSettingsPage.tsx:283`) | Web | Yes, while open | Yes |
| A workspace view (Mac, iPhone) | No read of its own. The flat Open list below, filtered on the device: `SessionFilter.forAgent` over the Open snapshot (`OrbitApp/AgentsModel.swift:553-567, 598-622`). | Apple | Through the flat list | No: it reads nothing of its own. |
| A workspace view (Android) | No read of its own. The flat Open list, filtered on the device (`app/directory/DirectoryScreen.kt:104-134`). | Android | Through the flat list | No: it reads nothing of its own. |
| The flat Open list | `GET /sessions?view=open&since=<cursor>`, no workspace (Apple: `OrbitKit/Net/APIClient.swift:280-290`, `OrbitKit/App/OpenListReader.swift:60`; Android: `core/realtime/RealtimeRest.kt:61-62`, with no ETag) | Apple, Android | Yes. Apple reads at most once per 4 s on hints and drops a hint whose version it already took on this connection (`OrbitKit/App/PollSchedule.swift:18-20, 54-57, 131, 177-191`). Android reads at once on a hint, gathers further hints for 1 s, and never compares versions (`core/realtime/RealtimeStore.kt:248-255`). | **No.** Every workspace is in its scope. It gains from §5.0 and §5.4 (D1) alone. |
| Project pages | `GET /sessions?projectId=P&view=…[&includeLanding=1]`, built every time, no version (`sessions.controller.ts:266-273`) | Web: `project.changed`, session events naming the project, and `task.changed` (≥ 5 s; `useControlPlane.tsx:385-405, 526-529`). Apple: `view=open\|completed&projectId=&includeLanding=1`, one project at a time (`OrbitApp/AppModel.swift:3451, 3466-3481`). Android: the same query (`app/directory/SessionProjectPage.kt:463-464`). | No | None. A per-project hint would need its own key (project sources plus membership). That is not designed here. |
| The Scheduled runs folder | `…&scheduled=1`, a plain read, never a delta (`sessions.controller.ts:232-234`) | Web polls it every 30 s (`WorkspaceView.tsx:3623-3626`). Apple reads `workspaceId=&scheduled=1` as a plain array (`OrbitKit/Net/APIClient.swift:218-228`), polled with its workspace pane (`OrbitApp/Views/AgentsView.swift:432-436, 585-587`). Android reads the same (`core/net/DirectoryApi.kt:22-28`). Android also makes two one-off `workspaceId=&view=open` reads, which are not polled: when worktree isolation is switched off (`app/management/WorktreeIsolation.kt:65`), and when the Move-to-a-worktree sheet opens (`app/reader/MainCheckoutModel.kt:87, 117-122`). Besides those, this is the only workspace-scoped session read the native clients make. | No | The folder gains nothing. Its sessions (`run_source = 'SCHEDULE'`) are in no Open list (`sessions.service.ts:4311-4318`), yet today their writes move the account's `session` counter and hint every Open list. The keys of §5.1 stop that. |
| A token confined to workspaces | `confinedTo` narrows every list (`sessions.service.ts:4272-4274`) | Any | Yes | Yes, as the column |

The rule a client applies is simple:
- A list with a workspace filter reads when its workspace is among the moved scopes.
- A list without one reads on every hint.

## 4. What the "nothing new" reads are

In [P1], the tab read the Open list 2,180 times in 102 minutes, and every read named the same workspace. 870 of those reads found nothing new: 364 answered 304 and 506 were empty 200s. A 304 here is a `since=` read whose cursor came back unchanged a second time in a row. The browser revalidated the same URL, and the empty delta's bytes matched. An empty 200 is the first such answer after a change.

A nothing-new read has one of five causes, and only one of them, a write elsewhere, is a workspace question:

| Cause | Mechanism | Reads it, today | Removed by |
|---|---|---|---|
| **A write no list draws that still moves a counter** | A heartbeat's directory probes rewrite the runner's workspace rows (§2.2), and the workspace trigger bumps on every UPDATE. This is the class 1420 removed for sessions and turns. | Measured [P3]: the `workspace` counter moved in 184 of 900 seconds, while the tab had 183 nothing-new answers in those 15 minutes. | A 1420-style compare in the workspace trigger. The coordinator files it separately ([P3]); it is not part of this design. |
| **Heartbeat only** | The 15 s clock tick reads a new version because a presence row was rewritten. Nothing a `since=` read compares moved: its fingerprint drops `lastHeartbeatAt` (`sessions.service.ts:4440-4441`), no row token holds a beat, and `steady` holds runners' names, statuses and liveness, not their beats. | Measured [L1]: 4 hints/min with 3 runners beating, 2/min with 1, 0 with none. All 12 reads they caused were empty, 0 rows built, median 20 ms. In [P3]'s busy window, only 6 of 418 hints, because a counter moved nearly every second and each such hint already took the beat. | §5.0, for every client |
| **A write elsewhere** | Another workspace's rows, a source this column's rows do not read, or a session in no Open list (a scheduled run, a completed session). | Measured [L1]: one drawn write a second in workspace B gave 60 hints a minute. All 60 reads of A were empty (0 rows built, median 13.9 ms), and 59 of B's 60 reads carried the row. | §5.1–§5.4, for scoped lists |
| **A write in scope that changes nothing drawn** | A drawn column rewritten with the delta's fingerprint unchanged; a write the previous read already picked up. | — | No hint design can remove these. |
| **Not hint-driven** | The 60 s safety read, a tab coming back into view, a reconnect. | — | Nothing. The safety read comes back more often once hints thin out (§7). |

**The 2026-11-21 window, split by what was in flight [P2].**

The tab showed one column, orbit-ws01, which has 521 Open rows, all on runner workstation-gpu. All 2,180 reads named that workspace and that runner.

Turns in flight per workspace during the window:

| Workspace | Turns |
|---|---:|
| orbit-ws01 | 66 |
| wikova-data | 10 |
| orbit-macos | 2 |
| orbit-ws02 | 2 |

The coordinator classed each nothing-new read by the turns in flight in the 2 s before it:

| Class | Nothing new | Of which within 3 s of a read at the same cursor | Found something |
|---|---:|---:|---:|
| (a) an orbit-ws01 turn in flight | 735 | 201 | 1,204 |
| (b) only another workspace's turn in flight | 18 | 11 | 2 |
| (c) no turn in flight | 117 | 19 | 104 |
| All | 870 | 231 | 1,310 |

What this does and does not show:

- **Other workspaces explain few of these reads.** Only 18 reads (2% of 870) came while another workspace had a turn in flight and orbit-ws01 had none. The tab's own workspace did most of the account's work. So the premise that the 870 came from other workspaces does not hold for this window.
- **Class (a) cannot tell writes from waiting.** One orbit-ws01 turn ran from 15:50:29 to 18:11:12. Every read before 18:11 therefore counts as "own workspace in flight", whether or not anything in orbit-ws01 was being written. Other workspaces' writes, heartbeats and account-wide sources during that turn all land in (a).
- **Class (c): 117 reads in the 26 minutes after 18:30:48, about 4.5 a minute, with no turn in flight anywhere.**
  - All 8 runners were beating [P2]. With that many, the clock tick finds a fresh beat almost every time, which is about 4 hints a minute (L1: 4 a minute with three runners).
  - The gaps between these reads do not cluster at 15 s. And 104 reads in the same stretch found something. So writes outside turns were moving too. The heartbeats' workspace writes, which [P3] measured later (§2.2), fit this exactly: they come with every beat, turn or no turn.
- **The 231 same-cursor repeats are not a second tab.** Every read that found something got a new cursor: 1,310 of them, which with the first read makes the 1,311 distinct `since=` values. None of the 231 found anything. They are runs of empty reads at one cursor, while hints arrive every second or two. This is the signature of hints that carry nothing for the column, not a separate cause.

The turn proxy cannot split (a) and (c) further. §7 measures that directly.

## 5. Options

The question each option answers: how a stream learns which scopes moved.

§5.0 applies under every option. §5.1–§5.4 are the alternatives the task names. §5.5 compares them.

### 5.0 A hint token that leaves heartbeats out (prerequisite)

**What.** The poller stops comparing the list's version. It compares a hint token instead, made of two parts:
- **The counter sums.** These come from the statement the poller already runs every second.
- **The clock part.** It is read only on the 15 s clock tick and for a new stream, and cached in between. It holds the version's other inputs, minus the heartbeats:
  - for the runners, `steady`: each runner's id, name and status, and whether it reads online. This is exactly what the `since=` read compares before it builds row by row (`open-list-version.ts:181-184`; `sessions.service.ts:4453`). It is not the runner row: in [P3] the runner rows changed at 25 of the window's 60 clock ticks, through columns other than the beat. A token that hashed those columns hinted 434 times where today's poller hinted 418 (§7.2);
  - share links and foreign running turns;
  - every clock-threshold count: runners offline, fences gone stale, live share links, deadlines passed, jobs still fresh.

  It leaves out the `runner_presence` hash.

The list version itself stays as it is. It is still what the plain read's ETag and the `since=` read's `unchanged` check compare.

**Why it is safe.** A heartbeat changes nothing any reader shows through these lists, and neither does a runner column outside `steady`:
- **A `since=` read.** Its fingerprint drops the beat. Its row tokens hold neither beats nor runner columns. Its `steady` check is the token's runner part, so what moves one moves the other. L1 shows it: every read after a beat-only hint was an empty delta.
- **A plain read.** It sends the row's runner fields, `lastHeartbeatAt` among them. A client that reads the plain list on a hint therefore refreshes those less often. A runner's name, status and liveness still move the token. The plain readers today are the web's paged column and Apple's fallback; everything else reads `since=`.

The inputs that are not counters (`steady`, share links, foreign turns) are picked up on the clock tick, within 15 s. Today a counter move happens to read them sooner; when no counter moves, today waits for the clock tick too.

**Costs.**
- **Per write:** none.
- **Per tick:** lower than today. A second in which only counters moved no longer reads the version. Today's poller reads it on every such second (`open-list-hints.ts:130-131`). Measured [L1]: 60 version reads for 60 one-a-second writes, median 6.8 ms each inside the poller.
- **0487 and DDL:** unaffected.
- **Several processes:** unchanged.

**Removes** the heartbeat-only reads for every stream, old clients included. They simply get fewer hints, and the hints they no longer get were all answered empty.

### 5.1 Option A: counters keyed by workspace, bumped by the existing triggers

**Mechanism.** Same table, same `open_list_bump`, new keys.

**The keyed sources.** These sources hang on one session or one workspace:
- the session's own row;
- `conversation_turn`, `approval`, `session_tag_link`, `scheduled_wakeup` (via `session_id`);
- `watch` (via its observer session);
- `workspace` (the workspace row).

Each bumps `<source>@<scope>`, where `<scope>` is one of two values:
- `w:<workspace uuid>` for a row that is in an Open list on either side of the statement: CONVERSATION, not completed, archived or deleted, not a scheduled run or a schedule-change conversation, not an Ask (`sessions.service.ts` listShape);
- `c:<workspace uuid>` otherwise.

Shards keep their suffix after the key, as in `session@w:…#12`. Every other source keeps its plain account-wide key, as today.

**Four rules cover what a row reads from outside its own workspace.** They come from the row token and its "always" rule (`sessions.service.ts:4664-4694`):

1. **Root rule.** An Open row reads its root session's kind and the projects of the root's tasks (`sessions.service.ts:4590-4611`). The root can sit in another workspace. So a session UPDATE that changes `kind`, `task_id`, `context_task_id`, `root_session_id` or `workspace_id` also bumps the account-wide `session` key. These writes are rare and are a column compare on the transition rows.
2. **Request rule.** A `session_request` row bumps the scopes of both of its sessions, the asker and the recipient. That is a join to `session` on `from_session_id` and `to_session_id`, as `open_list_bump_via_session` already joins. An open request also shows the peer session's title on both rows (`SessionRequestPeer`, `shared/src/session-request.ts:90-94`).
3. **Dependency map** (poller side). Two things make one workspace's list depend on another workspace's rows:
   - a held question reads the recipient's row and its delivery turn (`questions`, `sessions.service.ts:4644-4654`);
   - an open request shows the peer's title.

   So the poller keeps, per account, the pairs (asker workspace, recipient workspace) of the account's OPEN requests. A move in a recipient's scope (`w:` or `c:`) also moves the asker's scope, and the other way round. A pair whose peers sit in one workspace W is kept too: a peer outside every Open list (completed, archived, a scheduled run, an Ask) moves only `c:W`, and the Open peer beside it still draws it. The map is one small statement on `session_request`'s partial OPEN indexes (`0350_session_request`). As built, it is part of the poller's statement on every tick (about 0.1 ms on production's account).
4. **Always-rebuilt rows.** A `since=` read rebuilds a PENDING row, and a row whose root is a landing, on every read, whatever its token says (`always`, `:4693`). A queued row's gate counts other sessions on its runner, in any workspace. So the workspaces that hold an Open PENDING row move whenever any scope moves. The poller reads them with the dependency map: the owner's Open PENDING rows, through `(owner_id, status, task_id)` (`prisma/schema.prisma:2593`). It re-reads them on every tick in which a `session` key moved, because PENDING is the session's own status.

   A row rooted in a LANDING session is left out, as built. Neither its root's writes nor the landing's progress needs it: a LANDING session's own writes move no counter (`open_list_bump_session` counts CONVERSATION rows only), so no poller ever hinted for them, and a landing's progress writes integration sources, which stay account-wide and give a hint with no scopes. Reading those rows would only let them ride along with unrelated moves in other workspaces. Nothing indexes them, either: on production's account (11,471 sessions, 1,520 LANDING) that read was a sequential scan of 12.96 ms returning no rows, nearly all of a 13.6 ms tick.

**What stays account-wide.** Everything a row reads by task or project:
- `task`, `project`, `coordinator_wake`, `criterion_definition`, `task_status_count`;
- the decision, confirmation, evidence, criteria, ratified and standard-set sources;
- `session_tag` (a tag's name and colour show on every row that carries it).

A task write could be traced to workspaces: by `task_id` (`project_event_session_task_provider_idx`, 0118), by `context_task_id` (`session_context_task_id_idx`, 0131), and by roots' children through `(root_session_id, status)`. That is a few index probes per task statement. Task statements are not on the ingest path, but this trace is not measured here, so the first cut keeps `task` account-wide. §5.4 (D3′) takes it up if the profile shows task writes matter.

**The read side does not change.** The probe and the version add counters up per base source, `split_part(split_part(source, '#', 1), '@', 1)`. Their `epochs`, the version hash and `openListMovesAreRowLocal` then see exactly what they see today.

**The poller.** It reads per `(owner, scope, source)` in one statement for every watched account. For each account and tick:
- An account-wide key, a clock threshold, the token's runner part, or a new stream moved: hint with no scopes, meaning anything may have moved.
- Otherwise, if any `w:` scope moved, directly or through the dependency map: hint with those scopes.
- Otherwise: no hint. That covers a `c:` scope with no dependants.

The token is §5.0's: the counters plus the clock part cached at the last clock tick.

**Cost per write on the hot ingest path, measured** [L1]. Per-statement trigger time under `EXPLAIN ANALYZE`, median of 400:

| Statement | Today | Keyed by workspace | Keyed, account with 456 counter rows |
|---|---:|---:|---:|
| `UPDATE session SET title` (a drawn column) | 0.553 ms | 0.638 ms (+0.085) | 0.744 ms (+0.191) |
| `UPDATE conversation_turn SET delivered_at` | 0.464 ms | 0.589 ms (+0.125) | 0.547 ms (+0.083) |

- **The statement shape stays.** The transition-table scan, 1420's compare and one bump per statement for a write in one workspace are all as today. A statement that writes sessions in k workspaces makes k bumps where today it makes one.
- **The largest share of today's 0.55 ms is the compare.** 1420 diffs the row's JSON against its old version, and that is unchanged.
- **The 456-row case** is 30 workspaces × 5 sources × 3 shards plus today's keys. The bump's `SKIP LOCKED` scan walks the owner's counter rows in key order, so more keys cost about 0.1 ms. The total stays well under a millisecond.
- **The prototype differs slightly from the design.** It keyed a row in an Open list as `<source>@<workspace>` and left every other row on the account key. The design's `c:` keys come from the same compare on the same transition rows, so they add no statement.

**Cost per tick per account, measured** [L1]. The counter statement reading 456 keys took 0.29 ms (15 shared buffers), against 0.10 ms for today's per-owner sum. The dependency map adds two small statements:
- the open requests, read when requests move;
- the owner's Open PENDING rows, read on ticks where a `session` key moved (landing-rooted rows are not read; see rule 4).

Both run on partial or prefix indexes; they are not measured here. They come on top of §5.0's saving: no version read on a second in which only counters moved.

**0487's guarantee holds.** `open_list_bump` is unchanged; only the keys it is called with change:
- it skips any row another transaction holds;
- it updates a row this transaction already holds;
- otherwise it inserts a key from the sequence that nobody else can be inserting.

So no bump waits and none adds a wait edge. Two transactions that take the session and turn keys in opposite orders still cannot deadlock, because each takes a row nobody else holds.

Measured [L1], with the prototype installed and `lock_timeout = 300ms` in every transaction:
- a second writer of workspace A's session counter, while the first transaction held it, finished in 6.4 ms;
- the same for the turn counter, in 2.4 ms;
- a writer of workspace B, in 6.0 ms.

None waited. The counters moved by exactly the 5 committed statements. A's keys ended as `session@A#5` (801) and `session@A#7` (1), the second created because the first was held, and the same pair for turns.

**DDL: none.** The migration replaces the trigger functions only, as 0487, 0512 and 1420 did. The table, its primary key `(owner_id, source)` and every trigger stay. A statement already inside the old function finishes on it.

0487 avoided DDL for these reasons (`0487_open_list_epoch_shards/migration.sql:36-43`):
- altering `open_list_epoch`'s key takes ACCESS EXCLUSIVE on a table that every writer of the 31 source tables writes from its trigger, so all of them would queue behind the ALTER;
- a statement already inside the old function would fail its `ON CONFLICT (owner_id, source)` arbiter;
- an apiserver still on the old probe reads every row anyway.

A separate table, such as `open_list_scope_epoch`, would need no ALTER either. But every bump would then write two tables: the account key that old pollers and probes read, and the scope key. That doubles the lock-and-update work on the hot path for as long as old code exists. Encoding the scope in `source` keeps one bump per statement.

**Several processes.**
- The counters live in the database, so a bump reaches every poller whichever process wrote it, and each process polls only for its own streams. Nothing crosses between processes.
- During a two-stage handover, the old process's probe sees the `@` keys as unknown sources. `openListMovesAreRowLocal` then sends its `since=` reads to whole builds until it stops. That costs time, not correctness: the sum still moves with every bump.
- The old poller sums every row and hints as it does today.

**Rollback.** Returning to code from before A needs a migration that restores 1420's functions. Old code that meets A's keys builds every `since=` read whole.

**Precision.**
- Exact for a row's own writes; 1420's compare is kept, so an undrawn write bumps nothing.
- Over-hints in three places: a task or project write (all scopes), a move between dependants (both scopes), and a root change (all).

**What it asks of later changes.** Every new input of the list row must be classed as per scope, account-wide or a dependency. §8 pins that classification the way `open-list-version.pg.spec.ts` pins sources today.

### 5.2 Option B: work out at tick time which workspaces' rows moved

**Mechanism.** Nothing changes on the write side. When a tick's counters show a row source moved, the poller probes the account's whole Open set: the same `openListProbe` a `since=` read runs, with no workspace filter. It keeps each row's token from the previous tick in memory and maps the rows whose token moved to their workspaces. Overlay sources, deadlines or a changed `questions` digest give a hint with no scopes.

**Costs.**
- **Per write:** none.
- **Per tick:** an account-wide probe on every second something moved. Measured [L1]: 5.2 ms for the account's 730 Open rows, against 4.0 ms for one 550-row column. It is shared by every stream of the account on the process. But it is paid whether or not any client shows a list that moved, and the production account is larger than this fixture.
- **0487:** untouched; it only reads. **DDL:** none.
- **Several processes:** each process probes for its own accounts, so the work is duplicated only while one account's streams sit on two processes.

**Precision.**
- A row's token is its row version (`ctid:xmin`), so the writes 1420 keeps out of the counters still move it: the context gauge every 20 s per running session, and every session's worktree snapshot on a runner's beat. B therefore over-hints a workspace for every such write. It does so whenever a drawn write anywhere starts a tick: at most once per tick per scope, but often.
- On the other hand, cross-workspace inputs (task, root, project, peers) are already in the tokens, so B needs no dependency map.

**Verdict.** For an account that shows few lists, the owner's included, B spends about one column's empty read on every busy second to save one empty read per out-of-scope hint. It adds load where A removes it.

### 5.3 Option C: moved workspace ids on `session.*` events

**Mechanism.** A client reads a workspace's list only when an event names a session there. The envelope's `agentId` is the session's workspace (`realtime.service.ts:1524`). The web already routes session events this way before its first hint (`lib/sessionReach.ts`; `useControlPlane.tsx:932-935`).

**Costs.**
- Per write and per tick: nothing in the database. Events go out after the commit through `pg_notify`.
- Several processes: the notify bridge reaches every process, at most once.
- 0487 and DDL: none.

**Why it fails the goal.**
- Many writes the list draws publish no event (list-freshness-design.md §2.1): previews and tool lines, engine phases, background tasks, dequeue, pin, config, merge status, share links, cascades, open items, and every clock threshold.
- Events are at most once: a process that dies between the commit and the notify loses them. They can also arrive out of order.
- The envelope's `agentId` is the cached workspace until `forgetSessionOwner` runs.

A list driven by events alone would miss those changes until its 60 s safety read. Keeping the account hint as the backstop would remove nothing.

**Verdict.** Rejected as the source of the hint. Event workspace ids stay a latency shortcut where clients already use them.

### 5.4 Option D: a cheaper split for the sources that are not per workspace

The account-keyed sources fall into three groups:

| Group | Sources | Treatment | Per write | Per tick |
|---|---|---|---|---|
| **D1: read only by LANDING rows (withdrawn)** | `promotion`, `integration_job`, `project_open_item`, `merge_receipt`, `codebase` | **Withdrawn.** The premise is false: flat-list coordinator rows read all five (§2.1), so taking them out of the token would delay a new merge approval to the 60 s safety read and a done request to the next 15 s clock read, against the 2 s of criterion 1. The most it could have removed was 1 hint in 418 (§7.3). `list-changed-hints.pg.spec.ts` carries a guard: an OPEN owner item on a flat-list coordinator conversation changes the row and sends a hint within 2 s. | none | none |
| **D2: keyed by a session** | `approval` (its session), `session_request` (both peers) | Per scope, as in §5.1. `open_list_bump_via_session` already joins the session. | as §5.1 | as §5.1 |
| **D3: keyed by a task or a project** | `task`, `project`, `coordinator_wake`, `criterion_definition`, `task_status_count`, `owner_decision`, the confirmation, evidence, criteria, ratified and standard-set sources, `session_tag` | Account-wide in the first cut. | as today | as today |
| **D3′: `task` traced to workspaces** (follow-up) | `task` | The trigger finds the Open sessions that carry the written tasks: by `task_id` (0118's `project_event_session_task_provider_idx`), by `context_task_id` (0131), and roots' children by `(root_session_id, status)`. It bumps `task@w:…` for each. It bumps only when a column a row reads changed (the token reads the title and the project, `sessions.service.ts:4674-4683`), with a compare like 1420's. | a few index probes per task statement (not measured) | as §5.1 |

D1 is withdrawn for the reason in its row. A landing renewal already moves nothing (0512).

D3′ is worth building only if the profile after §5.1 shows task writes among the remaining out-of-scope hints. Its soundness rests on the row token naming every task column a row shows, which is P4's own invariant.

### 5.5 Comparison

| | 5.0 token | A: keyed counters | B: tick-time probe | C: events | D1 |
|---|---|---|---|---|---|
| Per write (hot path) | 0 | +0.08–0.19 ms per statement [L1] | 0 | 0 (notify after commit) | 0 |
| Per tick per account | the version read on moved seconds goes (6.8 ms median in the poller [L1]) | +0.2 ms counter statement [L1], plus the dependency statements | +1 account probe on every moved second (5.2 ms for 730 rows [L1]) | 0 | 0 |
| 0487 no-wait | untouched | holds: same function, measured [L1] | untouched | n/a | untouched |
| DDL on `open_list_epoch` | none | none (keys in `source`) | none | none | none |
| Several processes | as today | as today; whole `since=` builds on a pre-A process during handover | duplicate probes per process | at most once | as today |
| Exactness | exact | exact for own rows; over-hints via task/project/roots | over-hints undrawn writes | misses silent writes | exact |
| Removes | heartbeat-only reads | writes elsewhere, for own-row sources | writes elsewhere, less precisely | — | writes elsewhere, for landing sources |

## 6. Compatibility and rollout

**The hint value.** A stream declares `hints=list_changed,list_scopes`. The new value is `CONTROL_HINT_LIST_SCOPES`, next to `CONTROL_HINT_LIST_CHANGED` and `CONTROL_HINT_OWNER_REQUESTS` in `shared/src/realtime.ts:143-148`. Such a stream gets the same `sessions.list_changed` events, whose `data` gains one field:

```ts
interface ControlListChanged {
  version: string;   // opaque, as today: compared only with a previous hint's
  /** With `hints=list_scopes` only: the public ids of the workspaces whose Open lists may read
   *  differently since the previous hint to this stream. Absent: any list may. */
  scopes?: string[];
}
```

- **When `scopes` is absent.** It is absent on four occasions:
  - the first hint after a connect;
  - a move of any account-wide source;
  - a clock threshold flip;
  - a runner change.
- **The client rule.** When `scopes` is present, read an Open list only if it has no workspace filter, or its workspace is in `scopes`. Union the scopes over the 1 s window. A hint without `scopes` reads every list, as today.
- **Streams that do not declare `list_scopes`** get exactly today's data. A client with a strict decoder therefore never sees the field. Neither shipped native client would break on it anyway. Apple decodes `data` with plain Codable, which ignores unknown keys (`OrbitKit/Models/ControlEvent.swift:94-97, 331-335`; an unknown key is pinned by `ControlEventCodableTests.swift:17`). Android never decodes `data` for this type, and parses envelopes with `ignoreUnknownKeys = true` (`core/realtime/RealtimeStore.kt:330-332`; `core/protocol/Wire.kt:13`).
- **`version` becomes the §5.0 token.** It stays opaque: the field's contract already says a client compares it with nothing but a previous hint's (`shared/src/realtime.ts:151-157`).
- **Old servers.** A server ignores a `hints=` value it does not know: "unknown values are ignored" (`shared/src/realtime.ts:143-144`). A new client on an old server gets no `scopes` and reads every list. So the order of releases never matters for correctness, only for when the saving starts.

**Rollout order.**

0. **Server: the workspace trigger fix** (task 0, filed separately). No client changes.
1. **Server: §5.0.** (D1 is withdrawn, §5.4.) No client changes. Every client, every flat list and every shipped app gains at once.
2. **Measure** (§8.4). The next three steps follow only if hints from outside the column's workspace are still material (§8.1).
3. **Server: Option A.** This is the migration, the read-side aggregation by base source, the poller per scope, the dependency map and `hints=list_scopes`. It ships alone. No client declares the hint yet, so nothing changes on the wire except the token.
4. **Web.** It ships in the same image as the server, so it can ride step 3's release. It declares `list_scopes` and filters its column, tag and settings reads.
5. **Apple and Android: nothing to ship.**
   - Their only Open-list read is the flat list (§3), whose scope is every workspace, and their workspace views filter it on the device. Filtering by `scopes` would therefore read exactly as often as today.
   - They keep declaring `hints=list_changed` alone, and they gain from steps 0 and 1 without a release.
   - If a native client ever reads a workspace's own Open list, it declares `list_scopes` then, with the web's rule.

**Mixed fleets** are always correct, because no `scopes` means today's behaviour.

## 7. Estimate of the reads removed

### 7.1 What the 2026-11-21 window can bound [P1, P2]

| Step | Nothing-new reads it would have removed (of 870) | Why no tighter |
|---|---|---|
| Workspace trigger fix (task 0) | Unknown from [P2]. [P3] suggests most, with the same 8 runners beating. | The turn proxy cannot see writes outside turns. |
| §5.0 token | Somewhere from 0 to one per clock tick. Clock ticks are at least 15 s apart (`open-list-hints.ts:121`), so at most 408 in 102 minutes. These reads are all empty [L1], and all 8 runners were beating [P2]. | Whether a tick found a beat no counter move had already covered is not in the gateway log or the turn data. |
| §5.1 + web scopes | At most the 18 of class (b) that turns can place on other workspaces; their hint may still have come from a heartbeat. Plus an unknown share of (a) and (c). | The 2 h 20 m orbit-ws01 turn puts every read before 18:11 in (a). |
| D1 | Unknown. | The turn proxy cannot see landing-source writes. |

So for that window, turns place only 18 of 2,180 reads (0.8%) clearly on other workspaces, and leave the rest of the 870 (40%) unresolved. Pinning it down needs each input's moves second by second, which §7.2 measures.

### 7.2 A fresh window, input by input [P3]

The window is 2026-11-22 03:10:29–03:25:28Z: 900 one-second samples, every gap 1.00 s. The column is orbit-ws01's, as in [P1].

**What moved, in seconds out of 900:**

| Input | Seconds |
|---|---:|
| `session` counter | 281 |
| row versions of orbit-ws01's sessions (undrawn writes included) | 279 |
| `runner_presence` rows | 263 |
| `workspace` counter | 184 |
| `conversation_turn` counter | 40 |
| row versions of other workspaces' sessions | 39 |
| each other source | at most 4 (`coordinator_wake` and `completion_evidence` 4 each, `integration_job` 3, `watch`, `scheduled_wakeup`, `task` and `project_open_item` 2 each, five more 1 each) |

**The four policies replayed over these samples:**

| Policy | Hints = reads | A minute | What it is |
|---|---:|---:|---|
| `now` | 418 | 27.9 | Today's poller. Causes: 408 counter moves, 6 presence-only clock ticks, 2 runner-row clock ticks, 1 LANDING-only move, 1 first hint. |
| `p0` | 434 | 29.0 | §5.0 as first drafted, comparing the runner rows without their beat, not `steady`. |
| `p0d1` | 433 | 28.9 | `p0`, plus D1 (withdrawn, §5.4). |
| `pA` | 417 | 27.8 | `p0d1`, plus per-workspace keys. This replay is conservative: it counts `workspace`, approvals, tag links, scheduled wake-ups and watches as the column's own, because the sampler cannot attribute them. Causes: 385 this workspace, 25 runner-row clock ticks, 7 account-wide sources. |

**Cross-check against the tab.** The owner's tab made 394 Open-list reads in the same 15 minutes, 26.3 a minute:
- 87 answered 304;
- 96 were empty 200s;
- 211 found something.

So 183 reads (46%) found nothing new. The `now` replay's 418 is within 6% of the 394 real reads.

**What the replay shows:**
- **`p0` hinted more than today, not less.** The runner rows changed at 25 of the 60 clock ticks, through columns other than the beat. Today's poller folds those changes into hints it sends for counter moves anyway. A token that compares those columns only on clock ticks hints for them separately. Hence §5.0's runner part is `steady`, not the row.
- **Per-workspace keys alone save one hint in 418.** In this window the column's own workspace moved in 279 seconds; other workspaces' sessions moved in 39.
- **The one input that moved about as often as the tab read nothing new is the `workspace` counter** (184 seconds against 183 answers): the heartbeat's directory probes (§2.2).

### 7.3 The estimate

Hints removed for the orbit-ws01 column in [P3], step by step:

| Step | Hints removed (of 418) | From |
|---|---|---|
| The workspace trigger compares drawn columns (filed separately by the coordinator, [P3]) | At most 184: the seconds in which `workspace` moved, less those in which another source moved as well | the seconds counted above |
| §5.0 with `steady` | 6 presence-only ticks, and the 2 runner-row ticks unless they moved `steady`. In a stretch with no counter moves it is about 4 a minute [L1]. | `now`'s causes |
| D1 (withdrawn) | 1 | `now`'s causes |
| §5.1 with web scopes | At most 84 (20%): the 39 seconds in which other workspaces' sessions moved, the 40 in which a turn moved anywhere, and the 5 of watches, scheduled wake-ups and approvals. All of these overlap with orbit-ws01's 279 seconds, and the conservative replay removed 1. | the seconds counted above, and `pA` |

**For the tab's reads, the estimate:**
- In a busy window like [P3], up to the 183 nothing-new reads (46% of the column's reads) can go.
- Nearly all of them belong to the steps outside the scope split. Only the workspace counter moved as often as the empty answers came.
- Per-workspace keys add at most 84 of the 418 hints, a fifth. The conservative replay found 1. They add so little because the owner watched the workspace doing the work:
  - orbit-ws01 ran 66 of the 80 turns on 2026-11-21 [P2];
  - here, orbit-ws01's sessions moved in 279 seconds against 39 for every other workspace [P3].
- A column of a quiet workspace is the opposite case. Per-workspace keys remove nearly every hint that busy workspaces cause there: [L1] measured 60 empty reads out of 60.

**The 2026-11-21 window has the same profile.** All 8 runners were beating, the column's own workspace was busy, and only 18 of its 870 nothing-new reads were in class (b) [P2]. Its likely main cause is the same workspace writes. [P2] cannot show it, because the turn proxy does not see writes outside turns.

**Freshness is unchanged under every step.**
- Every drawn write still moves a counter in its own transaction (0487).
- The poller still hints within one tick.
- The web's 1 s window and 60 s safety read stay.
- Where the steps remove hints, the safety read comes back at most once a minute per list; it never fired in [P3], because hints came every two seconds.

## 8. Recommendation and test plan

### 8.1 Recommendation

0. **The workspace trigger's drawn-column compare comes first**, because it is the one fix sized to the measured problem (§7.3). It is the 1420 approach applied to the workspace trigger, and the coordinator is filing it on its own ([P3]). It is not part of this design. It changes no protocol and helps every client.
1. **§5.0 with `steady`.** (D1 is withdrawn, §5.4.) It is server-only and small. No client has to ship, and every list benefits, the flat lists included.
   - §5.0 removes the presence ticks. They are few in a busy window but about 4 a minute in a quiet one.
   - Its `steady` runner part keeps runner-row churn from turning into hints once the workspace writes stop masking it.
   - Comparing only on the clock tick also removes the poller's version read on every busy second.
2. **Re-measure (§8.4)** with the [P3] sampler on the same column, after 0 and 1.
3. **Build Option A with web scopes only if that re-measurement shows hints from outside the column's workspace are still material.** A working threshold is 10% of the column's reads or 2 hints a minute.
   - [P3] cannot decide it. The conservative replay removed 1 hint, but the ceiling is 84 (5.6 a minute), because the workspace writes mask the rest. The re-measure after task 0 decides.
   - If it is built, it comes with its four rules (root, request, dependency map, always-rebuilt rows) and D2. It is exact for a session's own writes, costs a fraction of a millisecond per statement [L1], needs no DDL and reuses 0487's bump unchanged.
4. **Not B.** Its tick-time probe charges about a column read on every busy second, whatever the clients show, and it over-hints the writes 1420 excluded.
5. **Not C.** Silent writes publish no event.
6. **D3 stays account-wide.** Revisit it (D3′) only if the re-measurement shows task writes among what remains.

### 8.2 pg specs

**Trigger side: `sessions/open-list-scope-keys.pg.spec.ts` (new).**
- One table-driven case per source, against the trigger catalogue, as `open-list-version.pg.spec.ts` pins them today: a write bumps exactly the key its class says (`w:`, `c:` or account-wide). An unclassed source fails.
- The Open and closed edges:
  - completing an Open session bumps `w:W`;
  - a write to a completed one bumps `c:W`;
  - a scheduled run's write bumps `c:W`;
  - a move between workspaces bumps both;
  - a change of `kind`, `task_id`, `context_task_id` or `root_session_id` bumps the account key.
- `session_request` bumps both peers' scopes.
- 1420's undrawn columns move no key. Extend `open-list-undrawn-writes.pg.spec.ts`.
- **No waits**, extending the no-wait cases of `open-list-version.pg.spec.ts`:
  - two writers of one workspace's session key while one holds it;
  - two transactions that take the session and turn keys of two workspaces in opposite orders.

  `lock_timeout` must never fire and no deadlock may occur. The sums must move by exactly the committed statements (the shape of [L1]'s check).
- **Rollout:** the old aggregation (`split_part(source, '#', 1)`) still sees every bump, and the new per-base-source `epochs` equal the old ones.

**Poller side: `realtime/list-scope-hints.pg.spec.ts` (new).** It goes through `EventsController`, like `list-changed-hints.pg.spec.ts`. Each case must hold within 2 s:
- Heartbeats alone send no hint after the first, and neither does a runner-row write outside `steady`. A runner going offline or being renamed does send one. This is §5.0, for declared and undeclared streams alike, and it is [L1]'s case 1 turned into an assertion.
- A drawn write in workspace B: a `list_scopes` stream gets `scopes: [B]`, and a plain `list_changed` stream gets today's data shape.
- A task title write gives a hint without `scopes`.
- An OPEN RUN_QUESTION from an A session to a coordinator in B: a write to the coordinator's turn gives `scopes ⊇ [A, B]`.
- A runner going offline by the clock alone gives a hint without `scopes` within 20 s, as `list-changed-hints.pg.spec.ts` (b) does.
- ~~A write to an integration job (D1) gives no hint.~~ Withdrawn: an owner item on a flat-list coordinator row sends a hint within 2 s (the guard in `list-changed-hints.pg.spec.ts`).
- The first hint after a subscribe has no `scopes`.
- **The soundness property that makes skipping safe.** For a seeded random sequence of writes over every source and three workspaces: whenever a tick sends no hint naming W, a `since=` read of W's column at that tick is an empty delta. Seeded, so a red reproduces.

**Kept green:** `list-changed-hints.pg.spec.ts`, `open-list-since-scope.pg.spec.ts`, `open-list-delta.pg.spec.ts`, `open-list-version.pg.spec.ts`.

### 8.3 Client tests

- **Web: `lib/useControlPlane.listScopes.test.tsx`.**
  - The stream URL carries `hints=list_changed,owner_requests,list_scopes`.
  - A hint with `scopes: [other]` reads no Open list; `scopes: [mine]` reads mine once; no `scopes` reads every list.
  - Scopes are unioned over the 1 s window, and a hint that arrives mid-flight is read once the fetch lands.
  - The 60 s safety read still runs, and a hidden tab still reads nothing until it is back.
  - Extend `useControlPlane.listChanged.test.tsx` for an old server that sends no `scopes`.
- **Apple and Android.** No client change, so no new client test. Their existing hint tests pin that a hint they no longer receive was never needed:
  - Apple: `ControlEventRouteTests`, `ListFreshnessWiringTests`, `PollScheduleTests` with its version de-duplication;
  - Android: `RealtimeStoreTest`.

  Add one decode case each to show that a `sessions.list_changed` carrying only `version`, the shape an undeclared stream keeps getting, is still read as today.

### 8.4 Measurement after each step

Re-run the [P3] sampler (`scope-sampler.py`, read-only, 15 minutes, the same column) after tasks 0–2, and after tasks 4–6 if they are built. Before the first re-run, add two inputs to it:
- the drawn columns of the workspace rows (name, model, effort) as their own digest;
- `steady` in place of the runner rows.

Set the gateway log beside it, as task 351V4gGnbPbm9hlmbKNjq read it:
- Open-list reads a minute;
- 304, empty-200 and changed-200 counts;
- the gaps between reads.

## 9. Implementation tasks

| # | Task | Size |
|---|---|---|
| 0 | Outside this design, filed by the coordinator ([P3]): the workspace trigger bumps only when a column a list draws changed, the 1420 approach. Pinned the way `open-list-undrawn-writes.pg.spec.ts` pins sessions and turns. | — |
| 1 | Server: a hint token without heartbeats, whose runner part is `steady`, read on the clock tick only (§5.0). With the poller-side pg case: beats alone, and runner-row writes outside `steady`, send no hint. | S |
| 2 | ~~Server: D1, the LANDING-only sources out of the hint token.~~ Withdrawn: flat-list coordinator rows read all five (§2.1, §5.4). | none |
| 3 | Production re-measure after tasks 0–2: the [P3] sampler on the same column, read-only, and the gateway log. It decides whether tasks 4–6 are built. | S |
| 4 | Only if task 3 shows out-of-scope hints above the threshold: the keyed counters (§5.1). This is the migration replacing the session, via-session, owner and watch bump functions with the scope and root rules, plus the read-side aggregation by base source. It brings `open-list-scope-keys.pg.spec.ts`, extensions of the undrawn-writes and no-wait specs, and `postgres-lock-order.md` §4. | L |
| 5 | With task 4: the poller per scope, the dependency map, `hints=list_scopes` and `scopes` in the shared types; `list-scope-hints.pg.spec.ts`; `realtime-control-plane-stream.md` §4.10. | M |
| 6 | With task 5: web declares `list_scopes` and filters Open-list reads by scope, with tests. | S |
| 7 | Apple and Android: none for scopes (flat list only, §6 step 5). The one decode case of §8.3 each. | S |
| 8 | After each of tasks 1–2 and 4–6: the same production profile (§8.4). | S |
| 9 | Only if a re-measure shows task writes among the remaining out-of-scope hints: D3′, `task` traced to workspaces in its trigger, with a 1420-style compare of the task columns rows read. | M |

Tasks 1 and 2 are independent of each other and of task 0. Task 3 waits on tasks 0–2. Tasks 4–6 wait on task 3's numbers; 5 depends on 4. Task 6 can ship before task 5, since an old server sends no `scopes`. Task 7 is independent. Task 9 waits on a re-measure.
