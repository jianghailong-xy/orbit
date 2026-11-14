# Clean-host install and first-task record — 2026-11-13

**Result:** isolated fresh deployment, first administrator, Workspace, Runner heartbeat, and first
Task **PASS** with Claude Code. The initial Codex attempt **FAILED** authentication; it is not a pass.
This record supersedes the [2026-09-29 attempt](clean-install-2026-09-29.md) as the current install
record while preserving that historical quota-blocked result.

The [2026-11-14 follow-up](clean-install-2026-11-14.md) is now the current record: it adds fresh
isolated Codex authentication, a public-document CLI rerun, and subsequent deletion of the test data.

## Scope and source

The operator used the authorized non-production Debian 12 workstation, a clean session worktree,
a fresh database and independent data directory, Compose project `orbit-clean-703e402f`,
project-scoped network and socket volume, and independently tagged application images. The existing
Nextcloud, qBittorrent and k3s services were outside this test and were not changed. The base checkout
was not modified. Only loopback ports `22087` (web/API), `22088` (link), and `22089` (metrics) were
published; `22090` remained unused. No production deployment was accessed.

The validation source was the latest fetched project integration baseline,
**`540cd964ae3559ee31f05565b16d19ac65df3b22`**, with a clean worktree before preparation.
The coordinator required this landed documentation baseline rather than an older `main` checkout.
The source SHA was passed explicitly to the web/runner and link image builds. This is a test of that
commit, not a claim about a later release or main revision.

Followed [first-run](../first-run.md) and [onboarding](../onboarding.md), with the isolation adaptations
below. This was an automated API/CLI exercise, not a new browser walkthrough or screenshot capture.
The host already had runtime binaries and credentials; it was deployment-clean, not credential-clean.
API request construction also consulted the repository controllers/DTOs, so this exercise alone does
not establish that a new operator can complete every API request using public prose alone.

## Evidence to retain

All timestamps are UTC on 2026-11-13. Credentials, private host paths and account identities are omitted.

| Evidence | Observed value / UTC timestamp |
| --- | --- |
| Server OS / architecture; runner OS / architecture | Same Debian 12 workstation; Linux `6.1.0-52-amd64`, x86_64; 335 GiB available at preflight, 15:22:16 |
| Docker Engine and Compose versions | Engine/client `29.7.2`; Compose `v5.5.0` |
| Release tag and full source SHA | No release tag selected; reviewed integration commit `540cd964ae3559ee31f05565b16d19ac65df3b22` |
| Start/end of build; container health result | Link build 15:22:55–before 15:23:51; API/web build 15:25:05–before 15:27:34; boot 15:27:34–15:28:13; health-checked services healthy, pgbackup/wiki worker running |
| Setup before/after; first administrator created (no identity/credential) | `needsSetup: true` at 15:28:13; administrator bootstrap succeeded and `needsSetup: false` at 15:28:41 |
| Managed runners on or off; the first administrator's runner state | Off; manually enrolled independent foreground runner; ONLINE |
| Runner/runtime versions; heartbeat age; authentication result | Runner `0.1.257-beta.1`; Claude Code `2.1.323`, model `opus[1m]`; heartbeat 15:29:54.215 → 15:30:23.742 → 15:34:59.572; last sample about 20 seconds old at 15:35:19. Claude real execution passed; Codex `0.169.0` login-status exited 0 but real execution failed HTTP 401 |
| First task result and completion evidence | Task `34wwZNh4xU099irfruwu0`: **DONE**, updated 15:34:35.301; `EXECUTABLE`, expected exit 0; successful session `5AbzOz8fzT7HKhAZffkwxU`: SUCCEEDED |
| Backup/restore check and off-host copy | Sidecar completed initial 4.2 MiB base backup 15:27:46–15:27:47; restore drill and off-host copy **not exercised**; no claim of disaster-recovery readiness |
| Sanitized API/runner log excerpts with timestamps | Selected observations below; raw private logs are not committed |
| Any blocked gate, limitation, and next action | Codex auth failed; use the proven Claude path or repair Codex credentials and rerun. Long runner-home path disabled background-job sockets; use a shorter private runner home for a separate background-job check. Browser enrollment, fresh runtime login, TLS, restore and off-host copy remain untested here |

## Timeline and completion proof

| UTC | Observation |
| --- | --- |
| 15:22:16 | Docker server/Compose available, sufficient disk, no listeners on 22087–22090 |
| 15:27:34–15:28:13 | Fresh Compose stack booted; PostgreSQL, API, web, gateway, link and NATS healthy; `/healthz` returned `ok`; setup was required |
| 15:28:41 | First administrator created, setup closed; enrollment token minted privately |
| 15:29:12 | Isolated web service recreated with project-local `orbit-web` DNS alias; public download path repaired |
| 15:29:37 | Runner downloaded from this deployment and registered successfully with one-time token; no service installation |
| 15:29:53.859 | Runner log: link connection to `ws://127.0.0.1:22087/runner-link` established |
| 15:30:23.742 | Advancing heartbeat confirmed; Runner `34wwYA4ZveXID7325Ykny` ONLINE |
| 15:30:26 | Disposable Git repository initialized and committed; Workspace `34wwZNbiW3QJAGNcjJldl` created; task dispatched on Codex |
| 15:30:41–15:30:42 | Codex session `62aKdDUs3HkxSdwDRJu9ko` FAILED: HTTP 401, missing authentication; no completed task claimed |
| 15:31:37 | Same task explicitly switched to Claude and started again |
| 15:31:48–15:33:57 | Claude requested the exact `smoke.txt` write; operator verified its path/content and allowed the request |
| 15:34:03–15:34:31 | Operator allowed the read/check action; persisted tool result contains `Orbit first task passed` and `exit=0` |
| 15:34:35.301 | Task became DONE through executable completion; successful session changed only `smoke.txt` (one added line) |
| 15:35:19 | Independent API read confirmed DONE / EXECUTABLE, session SUCCEEDED, and advancing ONLINE heartbeat |

The task requested: create `smoke.txt` containing `Orbit first task passed` and verify it with
`cat smoke.txt`. Its executable completion declaration was:

```bash
test "$(cat smoke.txt)" = 'Orbit first task passed'
```

Expected exit code: `0`. The transcript's read/check action printed the requested line and `exit=0`.
The runner subsequently evaluated the task's executable criterion and the server recorded DONE;
this was not a direct status override. Only `smoke.txt` appeared in the successful session's changed
files. Task, Workspace, Runner and session identifiers above belong to the disposable deployment,
not the public production service.

## Isolation adaptations and limitations

- Used the documented manual secret-generation alternative, with independent random secrets in a
  mode-0600 environment file. Built the link gateway under an independent tag and captured its
  generated link secrets privately. The install script's fixed shared link-image tag was avoided.
- Generated a private Compose configuration from the pinned source: independent container names,
  application image tags, data paths, project network/volume, and loopback port mappings. Managed
  runners stayed off. The disabled managed-runner mount is the repository's read-only `/dev/null`
  placeholder; an initial overly strict assertion rejected it before being corrected.
- Renaming the web container initially caused `/dl/` to return 502: gateway nginx expects
  `orbit-web`. Adding that alias **only within the isolated project network** restored downloads.
  This was a test-configuration correction, not a repository code change.
- Used the public bootstrap/enrollment APIs and the downloaded CLI's one-time-token registration
  with `--no-service`, then supervised `orbit run` with a separate `ORBIT_HOME`. Did not overwrite
  the host's existing runner configuration or install another system service.
- Existing runtime login material stayed on the runner. Claude's successful task proves usable
  authentication/quota for this small run; it does not guarantee future quota. Codex's login-status
  output alone was insufficient, as its actual failed attempt demonstrated.
- The deeply nested runner home exceeded the background-job Unix-socket path limit (140 > 100).
  Foreground engine tools and executable completion worked. Background-job operation is not
  established by this record; a shorter dedicated runner home is the next check.
- No browser-driven setup/device approval or fresh runtime login was exercised. Public pages,
  installer and runner download were HTTP-checked. Existing onboarding screenshots are unchanged.
- This loopback test does not establish production TLS, external networking, upgrades, restore,
  off-host backup delivery or an SLA. Consult [configuration](../configuration.md),
  [API reference](../api-reference.md), [self-hosting](../self-hosting.md),
  [backup/restore](../postgres-backup-restore.md), [release/upgrade](../release-process.md),
  [security](../../SECURITY.md) and [support](../../SUPPORT.md) before production use.

## Retained evidence and redaction

Orbit retains the command outputs under this task's session; raw output is not copied into Git.
The principal recorded job references are `bgj_7b2697e769ea` (prerequisites), `bgj_127e4d050143`
(source/container inventory), `bgj_6f78b0288df9` (isolation and image build), `bgj_51fa6b80980c`
(boot/setup), `bgj_27893e29adbf` (runner enrollment), `bgj_4ac68a75ce33` (heartbeat/workspace/task),
`bgj_73554b58c60c` (failed Codex diagnosis), `bgj_41cb29852dcf` (health/backup/public pages), and
`bgj_a1945f4200bf` (authoritative completion and transcript summary).

Only synthetic repository content and sanitized summaries are included here. No tokens, cookies,
keys, real administrator identity, private origin, private host path, or user repository content is
included. No screenshots were created during this run.

## Documentation validation and shutdown

`npm run docs:check` passed: 37 public Markdown files, zero lint issues and zero local link/anchor
errors. `npm run test:docs` passed all five tests, including the Compose/environment reference
coverage. The dated evidence report was additionally checked with the same lint and link helpers:
zero issues. `git diff --cached --check` passed. A staged-diff comparison against the generated
secrets found no deployment secrets, administrator session tokens or runner credentials.
These checks are recorded as `bgj_34e58b76e5ef` and `bgj_06d228c987cc`.

After evidence collection, the supervised runner was stopped and only this test's Compose services
were stopped. At 15:37:26 the existing Nextcloud and qBittorrent containers were still running;
no existing container, volume or network was removed. The isolated test's private data remain
uncommitted under the session's ignored data directory. Shutdown is recorded as `bgj_1379c55fa865`.
