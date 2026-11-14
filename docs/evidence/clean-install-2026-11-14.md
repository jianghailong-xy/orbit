# Clean-host first task with fresh isolated authentication — 2026-11-14

**Result: PASS** for the affected public-document/CLI path and one minimal Codex Task using a fresh,
owner-completed device login. Task `34xBtvYIjVQJUPMrtx4H2` reached **DONE** through executable acceptance.
The accepted installation, administrator, Workspace and Runner evidence from the
[2026-11-13 record](clean-install-2026-11-13.md) is reused, not represented as a second fresh installation.
That record's initial Codex 401 and successful Claude run remain historical facts.

## Source and public-document-only procedure

The reused application/runner baseline is **`540cd964ae3559ee31f05565b16d19ac65df3b22`**.
The documentation supplement `bad06ef6a` added the fresh isolated runtime-home procedure to
[first-run](../first-run.md#fresh-codex-login-in-an-isolated-runtime-home). This follow-up additionally
puts the exact minimal task CLI recipe in [first-run step 5](../first-run.md#5-complete-a-small-task).
These documentation changes become public when Orbit lands the task branch; they are not claimed to
have already been published on main.

Only public first-run, onboarding, the API route reference, the linked public CLI guide and the CLI's
advertised capabilities were used for this affected rerun. No DTO/controller or other internal
implementation source was consulted. The original bootstrap/Workspace creation evidence was accepted
for reuse; it was not repeated. The CLI alternative avoids inventing JSON bodies from the API table.

The owner completed the documented device login in a private interactive terminal, outside Orbit's
captured tools. The coordinator reported completion at **2026-11-14T01:49:16.530Z**. No verification
address, one-time code, account identity, login output or credential content was requested or retained.

The metadata-only discovery found exactly one matching temporary runtime directory: root-owned,
mode 0700, created **01:48:10 UTC**, 66 seconds before the owner completion signal. Its Codex directory
was mode 0700; its configuration specified file credential storage. `auth.json` was a regular,
nonempty, root-owned mode-0600 file. Its contents were **not opened, printed, hashed or copied** by
these checks. Only the runtime itself consumed the new login during the authorized smoke run/logout.

The supervised Runner was launched through `env -i`, with only PATH, the new HOME/CODEX_HOME and its
separate test ORBIT_HOME. No inherited provider key, token, endpoint, host configuration or keychain
was supplied. The installed CLI binaries were reused; their existing credentials were not.

## Evidence to retain

All follow-up times below are UTC on 2026-11-14. Original deployment times are UTC on 2026-11-13.

| Evidence | Observed value / timestamp |
| --- | --- |
| Server and Runner OS / architecture | Reused authorized non-production workstation: Debian 12, Linux `6.1.0-52-amd64`, x86_64 |
| Docker Engine and Compose | Reused Engine/client `29.7.2`, Compose `v5.5.0` |
| Release tag and full source SHA | No tag; integration baseline `540cd964ae3559ee31f05565b16d19ac65df3b22` |
| Build / initial container health | Reused: link build began 11-13 15:22:55; API/web build 15:25:05–before 15:27:34; initial boot healthy by 15:28:13. No rebuild for this follow-up |
| Fresh setup / first administrator | Reused: setup true at 11-13 15:28:13, administrator created and setup false at 15:28:41 |
| Managed runners / first Runner | Off; reused manually enrolled Runner `34wwYA4ZveXID7325Ykny`, version `0.1.257-beta.1` |
| Workspace / heartbeat | Reused Workspace `34wwZNbiW3QJAGNcjJldl`; original heartbeat advanced 15:29:54.215 → 15:30:23.742 → 15:34:59.572; follow-up Runner claimed and executed the new task |
| Fresh runtime authentication | Owner performed new Codex device login; isolated credential metadata passed at 01:53:26; Codex task model `gpt-6.1-sol`; real task completion proves usable authentication/quota for this run |
| First affected Task and completion proof | Exactly one new task `34xBtvYIjVQJUPMrtx4H2`; DONE / EXECUTABLE, updated 01:56:06.246; expected exit 0 |
| Session and resulting file | Session `45NXDZyWqcptA25gj8gi83`; no error, turn ended AWAITING_INPUT; transcript reports `cat smoke.txt` exit 0. Changed files: only `smoke.txt`, one added line. Task itself is DONE |
| Backup/restore and off-host copy | Reused initial base-backup success; restore/off-host copy not rerun. Public backup runbook reachability verified; no recovery-readiness claim |
| Sanitized API/Runner evidence | Selected task fields and transcript summary retained in recorded job `bgj_ebaeea947696`; private logs/credentials not committed |
| Blocked gates, limitations and next action | No auth/quota gate blocked this rerun. Local logout/removal does not prove provider-side session revocation. Browser-only onboarding and background-job path behavior were not retested |

## Follow-up timeline and completion

| UTC | Observed result |
| --- | --- |
| 01:49:16.530 | Coordinator reports owner's private isolated device login completed |
| 01:53:26 | Exactly one candidate and required file/config metadata validated without reading credential content |
| 01:53:56–01:54:19 | Existing isolated stack configuration/ports revalidated; eight services resumed without build; healthy |
| 01:54:42 | Documented CLI read confirmed the accepted prior Task DONE and its reusable Workspace |
| 01:55:10 | Public CLI recipe created exactly one Codex smoke task |
| 01:55:31 | Supervised test Runner started with env -i and fresh isolated runtime paths |
| 01:55:35 | Single task start accepted; no second start or alternate-credential retry |
| 01:56:06.246 | Server recorded the new task DONE under executable completion |
| 01:56:13 | Independent public CLI task/session reads confirmed DONE, expected acceptance, cat result and only smoke.txt changed |
| 01:56:48 | Supervised test Runner stopped |
| 01:56:53 | Same-home Codex logout exited 0; isolated auth file absent; exact verified runtime directory removed |
| 01:57:28 | Only eight label-verified test containers, their Compose network/socket volume and four exclusive test data directories removed; unrelated running containers remained |

The task requested the same minimal synthetic file as the public checklist. Its declared acceptance was:

```bash
test "$(cat smoke.txt)" = "Orbit first task passed"
```

Expected exit code: **0**. The successful turn reports creating the requested line followed by a newline
and verifying it with `cat`; the server's executable criterion produced DONE. No direct DONE status
write was used. A session ending at AWAITING_INPUT is not itself treated as task completion: the
separate authoritative task read confirmed DONE.

## Public operational entry points

Unauthenticated requests returned HTTP 200 for all nine referenced documents at the pinned baseline,
recorded as `bgj_b03ef1ad7d20`. First-run/onboarding differ locally only because this task updates them;
the other seven downloaded documents matched the baseline checkout. Local navigation/anchors are
checked by the public documentation checker.

| Required entry | Public document and navigation | Scope verified by reading the public text |
| --- | --- | --- |
| Configuration | [Configuration reference](../configuration.md), linked from first-run and onboarding | Types, defaults, requirements, secret handling, Compose/environment variables, ports, storage and retention |
| API | [HTTP API reference](../api-reference.md) and [CLI guide](../runner-cli.md), linked from onboarding | Public/user/runner authentication boundaries and route inventory; documented capability discovery gives executable CLI arguments used here |
| Upgrade | [Self-hosting: Upgrading](../self-hosting.md#upgrading), reached from first-run's self-hosting link; [release process](../release-process.md) | Backup before upgrade, reviewed revision, rebuild/recreate behavior, runner-link caveats, rollback and support window |
| Backup | [Backup and restore](../postgres-backup-restore.md), linked from first-run/onboarding | Base backups/WAL, off-host copy, secrets/files, replacement-host restore and isolated verification drill |
| Security | [Security policy](../../SECURITY.md), linked from first-run and repository README | Latest release receives best-effort fixes; older versions unsupported; private vulnerability reporting and secret redaction |
| Support | [Support](../../SUPPORT.md), reached from repository README | Pre-1.0 community best effort, no guaranteed response/emergency channel, safe diagnostics and operator incident/backup responsibilities |

Public URL pattern used for the unauthenticated check:
`https://raw.githubusercontent.com/jianghailong-xy/orbit/540cd964ae3559ee31f05565b16d19ac65df3b22/<document-path>`.
This establishes document access and stated boundaries; it does not claim upgrade, restore or production
hardening execution in this follow-up.

## Cleanup, privacy and evidence references

Logout ran only against the same validated temporary HOME/CODEX_HOME with a clean environment; its
output was discarded, not printed or saved. Only its exit status and subsequent auth-file absence
were reported. The directory identity was checked again before deleting exactly that directory.
This proves **local** logout/removal, not server-side session revocation. The owner must use provider
account controls if server-side revocation or restoring a device-login setting is required.

All deployment removal was restricted to the task's exact Compose project labels and session-local
data paths. No existing workstation runtime login, base checkout, unrelated container, service,
volume or network was modified. Private test logs, local server tokens and disposable database data
were deleted with the verified test directories. Raw output remains in Orbit's recorded job rows;
no credential-bearing logs or screenshots are committed.

| Recorded job | Evidence |
| --- | --- |
| `bgj_425e58dd6d89` | Candidate/config and credential metadata validation |
| `bgj_59b68a61fdac` | Isolation recheck and resume without rebuild |
| `bgj_6e60fffe7586` | Public CLI access and accepted Workspace reuse |
| `bgj_54ab86014b00` | One public-document CLI task creation |
| `bgj_594861cfec1c` | Clean-env supervised Runner invocation |
| `bgj_c6f8a390d71e` | Single task start |
| `bgj_ebaeea947696` | Authoritative DONE and sanitized completion summary |
| `bgj_cc94f46d2147` | Same-home logout, auth-file absence and exact runtime-directory removal |
| `bgj_0449ccb66026` | Verified isolated deployment/data removal |
| `bgj_ac146150db61` | Exact three task-specific application images removed without shared-resource pruning |
| `bgj_1ea87ba21e5d` | Public documentation lint/link checks and five documentation tests passed |

The original accepted build/bootstrap/registration evidence remains linked in the preceding dated
record. No production access, repository push, release or publication was performed by this run.

Final validation (`bgj_788804138e50`): 37 public Markdown files with zero lint/link errors,
all five documentation/reference tests passed, and both dated evidence records independently passed
lint and local-link checks. No credential file was opened for this validation.
