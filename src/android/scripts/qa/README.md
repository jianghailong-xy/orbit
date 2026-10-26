# QA datasets DS0, DS1, DS2 and DS6 (A01 v1 §6)

A01 v1 §6 defines seven datasets for the Android acceptance work (A15) and asks for one copy that iOS and
Android both use. DS3, DS4 and DS5 are served by `../transcript-fixture.py`. This directory holds the other four:

| file | role |
| --- | --- |
| `datasets.py` | generates DS0, DS1, DS2 and DS6 from the seed `orbit-android-a01-v1`, and verifies a generated copy |
| `images.py` | the PNG, JPEG and WebP writers behind DS6's pictures (pure Python, so their bytes never depend on a library) |
| `datasets.sha256` | the SHA-256 of every generated file, as this commit generates them |
| `dataset-server.py` | serves one generated dataset over HTTP on 127.0.0.1, for `adb reverse` to a device |
| `stack.py`, `stack_runner.py` | seed a real Orbit server (the QA stack) with DS1, DS3 and the QA cards; see "Seeding a real stack" |

None of it is part of the app: Gradle never reads `scripts/`.

## Generate and verify

```bash
python3 src/android/scripts/qa/datasets.py generate /mnt/data/a01-datasets          # all four, about 7 s
python3 src/android/scripts/qa/datasets.py generate /mnt/data/a01-ds2 DS2           # just one
python3 src/android/scripts/qa/datasets.py verify /mnt/data/a01-datasets            # exit 0 when everything matches
```

The output directory must be new (or hold only other datasets). The four take about 210 MB, most of it DS6's
upload files. `verify` re-hashes every file, compares the result with the directory's own `SHA256SUMS`, and compares
that with `datasets.sha256` for the datasets present. Python 3.9 or later; nothing outside the standard library.

**Why two runs write the same bytes.** Every value is a function of the seed and of the value's own key through
SHA-256: never the clock, the host, the order things are made in, `random` or a dictionary's hash order. Ids are
UUIDv7, timed from the record's own creation time and keyed by its place in the dataset. Times are counted back
from a fixed "now", `2026-10-25T12:00:00.000Z`, so a reader sees the same ages whatever day it runs. The pictures
and the deflate inside the PNGs are written by `images.py`, not by zlib or Pillow, and DS6's PDF and ZIP use
fixed timestamps.

**manifest.json** (one per dataset) holds what A01 §6 asks for:

- `seed`, and `generator`: name, version, and for each source file its SHA-256 and git blob id. Find the commit
  of a blob with `git log --all --find-object=<gitBlob>`.
- `anchor`: the fixed "now".
- `files`: every file with its byte size and SHA-256, plus what the file holds: `rows`; for `api/events.jsonl` the
  event count, the UTF-8 bytes of the encoded events and the count per type; for pictures the format, width and height.
- `summary`: the dataset's counts. DS0, DS1, DS2 and DS6 also give `cachedDirectoryBytes`, the size of the directory
  as the Android client caches it (`RealtimeCache`). The generator refuses to write a dataset whose directory would
  not fit the cache's 8 MiB, because then a cold start could not draw it from the cache.

## Serve a dataset

```bash
python3 src/android/scripts/qa/dataset-server.py /mnt/data/a01-datasets/DS2 --port 18780
adb reverse tcp:18780 tcp:18780          # on the device the server is http://127.0.0.1:18780
```

On the device, set the server in the login page's Server dialog (triple-tap the Orbit logo), then sign in with an
account from the dataset's `accounts.json`. Every account's password is `orbit-a01-fixture`; it opens nothing
but this loopback fixture.

| dataset | accounts |
| --- | --- |
| DS0 | `member@ds0.orbit.test` (MEMBER), `admin@ds0.orbit.test` (ADMIN) |
| DS1 | `owner@ds1.orbit.test` (ADMIN) |
| DS2 | `owner@ds2.orbit.test` (MEMBER) |
| DS6 | `owner@ds6.orbit.test` (MEMBER) |

What the server does:

- Before serving, it checks every file against the manifest and refuses a changed copy.
- A GET with a file behind it answers that file's body as generated.
- The reads that depend on the request are cut from the files the way the apiserver cuts them. Those reads are pages (tasks with their
  base64url cursor, events with `tail`/`before`/`after`/`around` and `maxPayload`), filters, search, single records
  and both event streams (`/api/events` and a session's stream, framed `id:`/`data:` with a ping every 20 s).
- Sign-in, refresh rotation (a reused refresh token is refused) and logout behave like the apiserver's. Access
  tokens are signed with a key derived from the dataset, so restarting the server does not sign a device out.
- Uploads, downloads and sends follow the upload contract. The size limits, error statuses and bodies match the
  apiserver's, a turn is idempotent on `clientTurnId`, and an accepted turn is answered by a short reply a second later.
- The admin user list works for an ADMIN account.
- Any other write is answered as accepted and recorded, but not applied.
- An unknown route gets the apiserver's 404, and `GET /__stats` lists it under `unmodelled`, with the request log,
  the switches, uploads and turns.
- An ACTIVE watch is served with its evaluation clock moved to the present: clients file an ACTIVE watch evaluated
  more than 180 s ago as stale. Nothing else is changed at serve time.

`POST /__control` with a JSON object switches the scenarios; the answer echoes the switches:

| switch | effect |
| --- | --- |
| `{"expireAccess":true}` | every access token issued so far answers 401 `invalid token`; refresh works |
| `{"disable":[email]}` / `{"enable":[email]}` | the account's requests answer 401 `account disabled`, its refresh and login 403 `ACCOUNT_DISABLED` |
| `{"unreachable":true}` | every connection is dropped unanswered, as if the network were gone (`false` restores it) |
| `{"failures":false}` | turns off DS1's always-failing reads |
| `{"revokedWorkspace":true}` | DS2's permission change |
| `{"bulkStatus":true}` | DS2's bulk status change |
| `{"uploadDelayMs":250}` | uploads are read 64 KiB every 250 ms |
| `{"interruptDownloads":1}` | the next attachment download stops half way |

`--decoy-port N` adds a second listener that answers every request with an HTML page, which is how a server that is
not Orbit answers DS0's wrong-server case. The server listens on 127.0.0.1 only.

## The datasets

Times are in `manifest.json`. Each dataset's `scenarios.json` names the objects every case uses.

### DS0: accounts and sign-in

A01: an empty account in two roles, user and ADMIN; signed out, first sign-in, valid cache, expired token, revoked permission, wrong server.

Two empty accounts. Each has no workspace, session, task, project, wiki space or watch, only the seven system tags
an account always has; the two accounts' tag ids differ.

| case | how |
| --- | --- |
| signed out | a fresh install (or Sign out) shows the login page |
| first sign-in | sign in as `member@ds0.orbit.test`: the empty directory |
| valid cache | sign in and let the directory load, force-stop the app, `{"unreachable":true}`, cold-start: what it draws is its cache |
| expired token | `{"expireAccess":true}`: the next request is 401, one refresh, and the app stays signed in |
| revoked permission | `{"disable":["member@ds0.orbit.test"]}`: 401, then the refresh's 403 signs the app out; a new sign-in shows the disabled sentence |
| wrong server | `--decoy-port 18781`, reverse it, enter `http://127.0.0.1:18781`: sign-in says the answer was not an Orbit sign-in. A port nothing listens on says it could not reach the server |
| roles | `admin@ds0.orbit.test` has Settings › Account › Admin listing both accounts; `member@ds0.orbit.test` has no Admin row |

### DS1: daily

A01: 20 workspaces, 200 sessions, 100 tasks, 20 projects, 100 wiki entries, 20 watches; 200 durable events per session; no results, load failures and deep links to deleted objects.

The directory:

- **Runners and workspaces:** 3 runners (two online, one offline) and 20 workspaces. 17 workspaces have an online
  runner, 2 the offline one and 1 none; 12 have a sidebar position and 8 never had one (`position: null`); one is disabled.
- **Sessions:** 200 (140 open, 45 completed, 15 in Trash), each with exactly 200 durable events, 40,000 in all.
  A turn is a user message, an opening reply, 8 tool calls with their results, a closing reply and `turn_end`; a
  running session's last turn has one more call and no end.
- **Organisation:** 6 folders in 3 workspaces, 11 tags (7 system), 5 pinned sessions.

The rest:

- 100 tasks in 3 lists and 20 projects (14 open, 4 done, 2 cancelled), each open project with its coordinator
  conversation. Task runs are linked to their tasks.
- 100 wiki entries of every kind in 2 spaces, with fields per `contracts/wiki.contract.json`.
- 20 watches.

| case | how |
| --- | --- |
| no results | `zz-no-results` finds nothing in the session search, Tasks and the wiki search |
| load failure | these reads always answer 500 (`scenarios.json` → `failures`): the transcript of "DS1 · Load failure", one task, one project, one wiki entry |
| deep links to deleted objects | "DS1 · Links to deleted objects": its last reply links a session, task, project, list and wiki entry that do not exist (404) |

### DS2: large directory (P01, P09)

A01: 20 workspaces, 2,000 sessions, 2,000 tasks, 100 projects, 500 wiki entries, 100 watches; 25 folders across 5 workspaces; fixed sort and search words; page boundaries, permission change and bulk status change.

The directory:

- **Sessions:** 2,000 (1,400 open, 500 completed, 100 in Trash), 20 events each.
- **Organisation:** 25 folders (5 in each of 5 workspaces), 15 tags, 12 pinned sessions.
- **Cache size:** the directory caches at about 5.5 MB, under the 8 MiB the Android cache holds.

The rest: 2,000 tasks in 8 lists, 100 projects, 500 wiki entries in 3 spaces, 100 watches.

| case | how |
| --- | --- |
| P01 valid local snapshot | sign in with the network up and let the directory load, force-stop, cold-start: the cached directory is the content to report fully drawn |
| fixed sort and search words | sessions: `alpha` 40, `部署` 25, `zeta-77` 1, `nohit-ds2` 0. Tasks (`q=`): `kestrel` 120, `迁移` 30, `zeta-77` 1. The order is the server's (pinned first, then last activity) |
| page boundaries | tasks page 200 at a time over 2,000 rows, and the four tasks at positions 199–202 share one `createdAt`, so the cursor's id tie-break decides. Sessions "DS2 · 199/200/201/401 events" sit on the event pages' edges |
| permission change | `{"revokedWorkspace":true}`: one workspace and its sessions leave every list and the sessions answer 403 |
| bulk status change | `{"bulkStatus":true}`: 200 open sessions move to Completed and 300 tasks become DONE at once, announced on `/api/events` |

### DS6: attachments and input

A01: the 20 DS3 pictures, JPEG/PNG/WebP, legal and boundary file sizes (per the upload contract), interrupted and retried downloads; Chinese composition input, long drafts, sending, cancelling or process death before an upload finishes; one 20,000-character Markdown message.

One workspace on an online runner, and four sessions:

- "DS6 · Composer", to send into.
- "DS6 · Gallery", with the 20 pictures attached to its messages.
- "DS6 · 20,000-character Markdown".
- "DS6 · Files to download".

**Upload candidates** are under `files/`. Push them to the device with `adb push files/limits /sdcard/Download/`.

- `images/`: twenty 1440×2560 pictures, 7 PNG, 7 JPEG and 6 WebP, each showing its number and format.
- `limits/`: images of 5 MiB − 1, 5 MiB and 5 MiB + 1 bytes (PNG; JPEG at the limit and one over), files of 0, 1,
  25 MiB − 1, 25 MiB and 25 MiB + 1 bytes.
- `docs/`: Chinese Markdown, CSV, PDF and ZIP.

**The upload contract.** The apiserver accepts any file up to 25 MiB (26,214,400 bytes) and answers a larger one
413 and an empty one 400. The Android and iOS clients refuse an image picked from storage over 5 MiB, any file
over 25 MiB, and an empty file, before they upload.

| case | how |
| --- | --- |
| legal and boundary sizes | attach the `limits/` files: the at-limit ones upload, the over-limit and empty ones are refused by the client |
| send before an upload finishes, cancel, process death | `{"uploadDelayMs":250}` makes an upload take long enough to act during it |
| download interrupted and retried | `{"interruptDownloads":1}`, then open an attachment: the first download breaks half way, the retry gets it whole |
| Chinese composition, long draft, 20k Markdown | `inputs.json`: pinyin sequences and what they commit, a 6,000-character draft, the 20,000-character Markdown (also the reply in its session) |

## The wire shape

Bodies are what the apiserver sends, written from its code: `SessionsService.listRows` and `get`, `WorkspacesService`,
`RunnersService.runnerViews`, the task and project selects, the wiki entry view and `WATCH_VIEW_SELECT`. That includes:

- Every nullable column is sent as `null`.
- `PublicIdInterceptor`: each id leaves as base62 with its `publicId`/`*PublicId` twin, a null id with a null twin.
- `WorkspaceAliasInterceptor`: then `workspace*` is mirrored as `agent*`.
- Postgres jsonb objects keep jsonb's key order.

The transform was checked against the apiserver's own `addTwins` and the alias mirror on every kind of body, and the
results were byte for byte the same. The base62 ids match `@orbit/shared` `uuidToBase62`.

## Limits

- **iOS.** The server listens on 127.0.0.1, which an iPhone does not reach. For the same data on both platforms,
  "Seeding a real stack" below puts DS1 and DS3 on a real server that both reach.
- **Writes.** Uploads, sends and the admin user list change what the server answers. Other writes (rename, pin,
  move, task and project actions) are recorded in `/__stats` and answered as accepted, but the lists do not change.
- **Not modelled.** Approval and question cards, landings and merges, worktree bars and Markdown documents in the
  wiki are not in these datasets. The A08, A11 and A12 fixtures and stacks cover them.
- **Time.** The data is fixed at the anchor. Runner heartbeats, last-active times and recency groups age as real
  time passes, except the watch evaluation clock described above.

## Seeding a real stack (A02d)

`dataset-server.py` is a fixture. A real Orbit server stores a session's events only when a runner posts them, so
the same data on a real server, which both iOS and Android reach, needs a runner. `stack.py` is that seeding tool.
It works through the server's HTTP API only. Owner calls use the seeded ADMIN's login. Runner calls use three fake
runners (`stack_runner.py`) that speak the runner's door like the Go runner does, with no engine behind them. The
server writes every row itself; nothing touches its database. The target is the isolated QA stack,
`http://217.216.108.220:2087` (server 9a4bf087f, rehearsed on a local stack of the same source). The tool refuses
`orbitd.io` and the production port 2086. It configures no push.

What one `seed` makes, from an empty database (about 3–4 minutes on a local stack, 20 against the QA stack over the internet):

- **Accounts.** `owner@ds1.orbit.test` (ADMIN, DS1's account) holds everything below. `member@ds0.orbit.test`
  (MEMBER) stays empty, as in DS0. Their passwords are made at seed time and written only to
  `<state>/accounts.json` (mode 600, in a mode-700 directory, default `/root/orbit-qa`). Nothing prints them.
- **DS1**, from `datasets.ds1_world()` (the generator's own code, so the content is the manifest's):
  - 3 runners (old-laptop offline) and 20 workspaces.
  - 11 tags, 6 folders and 3 task lists.
  - 200 sessions with each one's 200 events: same seq, type and payload as `DS1/api/events.jsonl`.
  - 100 tasks, 20 projects (14 coordinated), 2 wiki spaces with 100 entries, and 20 watches.
- **DS3**: A06's 10,000-event "Long conversation" (`../transcript-fixture.py`, one turn per 20 events) in the
  workspace "DS3 · Reader fixture". Its image is uploaded. Its task, session and record links point at the stack's ids.
- **QA cards**: the workspace "QA · cards", the session "QA · cards (B01 B02 B03)" and the project "QA · coordinator
  questions (B15)" with its coordinator. These are tooling, not DS1.

`<state>/map.json` and `map.tsv` are the DS id → stack id table. For every object they give the manifest id, the
stack id, what the seed expected, what `verify` read back, and why the two differ from the manifest where they
must. Ids change with every reset, so the table is written by the tool rather than kept here.

### Commands

```bash
Q=src/android/scripts/qa/stack.py
python3 $Q rebuild --server http://217.216.108.220:2087  # after a reset: service stop, seed, verify, service start
python3 $Q seed --server http://217.216.108.220:2087     # the seed alone (the service must be stopped)
python3 $Q service start|stop|status   # the fake runner as transient systemd unit orbit-qa-fake-runner
python3 $Q card B01                    # tool permission card in "QA · cards (B01 B02 B03)" (--session ID for another)
python3 $Q card B02                    # question card; B03: plan card
python3 $Q card B15                    # coordinator question to the owner (--project ID for another project)
python3 $Q verify                      # re-read the stack, rewrite map.json/map.tsv; exit 1 if anything moved
python3 $Q status                      # health, accounts, session counts, runners, service (no password)
```

`--state DIR` (before the command) picks another state directory. Without one, the default holds the QA stack's.

- **Service.** It answers whatever reaches the fake runners after seeding:
  - It keeps DS1's 14 RUNNING sessions running. Stop interrupts one.
  - It raises a card when a message says `qa card B01`, `qa card B02` or `qa card B03`, in any session. It clears
    the session's workspace "always allow git push" first, so B01 is asked every time.
  - It acknowledges the owner's answer to a B15 question.
  - It answers any other message with an echo.
  - It runs from copies in `<state>/bin`; logs: `journalctl -u orbit-qa-fake-runner -f`.
- **B15** needs no service to be asked. The owner's answer reaches the coordinator as a turn, which the service
  acknowledges.

### Reset and clean-up

The database lives on the stack's host, so the reset runs there; on wikova the orbit-prod operator runs:

```bash
cd /root/orbit-qa && env -i PATH="$PATH" HOME="$HOME" docker compose -p orbit-qa down -v \
  && env -i PATH="$PATH" HOME="$HOME" docker compose -p orbit-qa up -d
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:2087/api/health   # 200 once it is up
```

Then one command, where the tool lives, rebuilds everything from the empty database:
`python3 src/android/scripts/qa/stack.py rebuild --server http://217.216.108.220:2087`.

To clean up the tool side, run `python3 stack.py service stop` and remove the state directory. Its passwords and
runner tokens are only for that database, which the reset discards.

### What a real server cannot hold

Each of these is written into the map row of the object it concerns.

| manifest | on the stack | why |
| --- | --- | --- |
| 3 sessions PENDING (queued at runner capacity) | AWAITING_INPUT | holding a queue means filling the runner, which would queue every session on it |
| 6 sessions INTERRUPTED | AWAITING_INPUT | a legacy status; an interrupted turn leaves AWAITING_INPUT today |
| 11 completed sessions AWAITING_INPUT | CANCELLED, completed | Complete ends a live session |
| session recaps | none | the server writes them with a model this stack does not have |
| branch names | the server's, from the title | only the server names a branch; sessions without one in the manifest have none |
| times | the seeding's, in the manifest's order | the server stamps sessions; the last activity follows the manifest's order |
| workspace model | none | the server no longer stores one |
| old-laptop position | 2 | a runner reorder places every runner |
| projects started with Automatic on | Automatic off | on, the server messages the coordinator about every task, adding turns to its DS1 transcript |
| PROJECT_BRANCH line | MAIN, no merge check | a project branch needs a repository the stack does not have |
| a coordinator's first message | the server's brief | the server writes it; the transcript's `user` event is still the manifest's |
| tasks DONE under EXECUTABLE or EVIDENCE_JUDGMENT with no run | DONE by owner confirmation, then the criterion | DONE is written by a confirmation or an evidence decision only; those with a run reach DONE through evidence and a decision |
| 4 of those outside projects | criterion OWNER_CONFIRMED | EVIDENCE_JUDGMENT outside a project needs a run to cite |
| EVIDENCE_JUDGMENT tasks outside projects | creator AGENT, filed from "QA · cards (B01 B02 B03)" | only a session may file them, and it decides their evidence |
| OPEN project tasks with autoRunWhenReady | off | on, the server would start them at once |
| task comment counts | no comments | the manifest gives counts, not comments |
| wiki: pinned, declared topic titles | not pinned; titles from the slug | no route writes either |
| wiki trust: principles not owner's; auto on recipe, pitfall, concept | owner; unreviewed | only the owner writes a principle; only a decision or convention quoting the owner reaches auto |
| wiki: the entry that supersedes another | trust owner | the owner's supersede writes it |
| watches whose condition already holds, or never can | MATCHED, or ACTIVE | a watch's state follows its targets; one that matches at once notifies instead of waking its observer |
| DS1 load failures (500) | load normally | a real server has no failure switch |
| DS3 `?at=` record | the turn holding seq 4900 (lands on 4881) | the API names no event by id |
