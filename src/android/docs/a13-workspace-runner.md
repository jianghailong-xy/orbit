# A13 · Workspace and remote Runner management

This slice implements Kotlin/Compose management on Android 10–16, minSdk 29. The phone never
hosts a Runner. It uses authenticated owner-scoped HTTP through the existing AuthSession handle.
The public entry points are `WorkspaceManagement` and `RunnerManagement`; directory rendering,
ObjectId canonicalization, routes, back stack, login/instance cleanup and composer are inherited.

## Version and baseline identity

The required fixed dependency is A07 `51bbcc303cec3c64dfb217316afce9498add760d`, absorbed by
ordinary merge. The combined working identity observed while implementing this slice was
`afb311c3becdf940ea728fcc859d9a96cb342cbf` (including the coordinator's fixed A10 boundary).
The final root A13 evidence records the initial, merge and final SHA identities and changed paths.
No deployed backend, installed iOS app or real Runner identity is implied by these source SHAs.

Static sources read:

* `src/macos/OrbitApp/Sources/OrbitApp/Views/AgentsView.swift` (`AgentFormContent`),
  `SkillsRunnersView.swift`, `RunnerPageParts.swift`, `RunnerEnginePage.swift`,
  `RunnerNamePage.swift`, `RunnerSignInView.swift`, `AddRunnerSheet.swift`;
* `src/macos/OrbitKit/Sources/OrbitKit/App/RunnerAttention.swift`, `RunnerPageFormat.swift`,
  `RunnerPageCopy.swift`, `Models/Runners.swift`;
* `src/apiserver/src/workspaces/{workspaces.controller,workspaces.service,dto,workspace-provider}.ts`;
* `src/apiserver/src/runners/{runners.controller,runners.service,dto}.ts`,
  `common/runner-repo-health.ts`, `common/account-pause.ts`, `common/antigravity-readiness.ts`,
  `runner-api/runner-api.controller.ts`, `tasks/model-routing.ts` and Prisma relations;
* shared `src/shared/src/dto.ts` Runner engine/account/login state definitions, and inherited
  A07 `ComposerCatalog.usage` / Automatic account semantics.

This is a source correspondence, not a frozen A01 inventory or an installed iOS same-data matrix.

## Item correspondence

| Swift baseline / API contract | Android implementation | Boundary / recovery |
| --- | --- | --- |
| Existing workspace name, enabled, instructions, directory, effort | Workspace form; `GET/PATCH workspaces/:id` | Only changed values sent. As `AgentFormContent`, blank instructions/directory mean preserve. Default effort sends empty string to clear. Current effort retained when runtime choices are unknown. |
| Smart selection on task runs | `modelRouting` and `modelRoutingProviders` via workspace PATCH | Additional engines are the backend whitelist Claude/Codex. No write through agent tools; no per-session model default invented. |
| Environment | Read-only workspace environment | Matches the current Swift form; no environment-editing feature added. |
| Codex / Claude workspace account | `codexAccount` / `claudeAccount` PATCH | JSON null = Automatic; `default` is a separate explicit choice. No machine path accepted. Expired, unknown-auth and paused reported slots cannot be newly selected. Missing pinned accounts remain visible until explicitly changed. |
| Workspace permission grants | `GET workspaces/:id/permission-rules`; confirmed DELETE of one rule | Owner scope; explains effect on later dispatches and existing running processes. |
| Checkout attention / cleanup | `repoHealth`, `repoCleanup`; confirmed `POST workspaces/:id/repo-cleanup` | Exact blocking states: unmerged/merge/rebase/cherry-pick/revert. Re-read workspace then Runner before dispatch. Show rescue branch/outcome, never claim queued work completed. |
| Delete workspace | Confirmed `DELETE workspaces/:id` | Sessions retained; project coordinator conflicts are returned by server and shown. |
| Add workspace | Remote-register guidance, existing workspace selector | Swift Runner page explicitly assigns creation to web/remote registration. No extra Android creation form was introduced. |
| Runner overview / About | Name, host, version, heartbeat, registration, repos folder, root/non-root, active capacity | Unknown reporting stays unknown. Root explains Bypass unavailability. UUID deep links match Base62 API IDs through inherited ObjectId.same. |
| Runner capacity / name | Partial `PATCH runners/:id` for `displayName`, `maxConcurrent`, `minFreeDiskMb` | 1–64 sessions; positive MB or explicit null to clear. Server-held labels/capacity remain editable offline. Dirty field conflicts with newly loaded values disable Save until reset. |
| Disk state | Workspace `workDirFreeBytes` / `workDirTotalBytes` | Reads actual workspace fields, not a nonexistent repoHealth.disk child. |
| Engine health / model catalog | Reported install/auth/version/update/drift/model list | Unreported installation and authentication are never rendered as successful. Account-specific quota uses A07 ComposerCatalog.usage unchanged. |
| Install / update / refresh model lists | Confirmed `POST runners/:id/install`, `POST .../engine-update`, `POST .../refresh-models` | Fresh GET before dispatch; offline, stale/unknown heartbeat and draining disable remote work. Antigravity install uses server `antigravity.supported`. Pending/running engine operation can be cancelled with DELETE install. |
| Engine/account sign-in / renewal | `GET/POST/DELETE runners/:id/login`, `POST .../login/code` | Existing flow replacement asks first; HTTPS provider link, device code, paste-back code, pending/failure/success text. Antigravity login requires server googleLogin=available. No OpenCode login flow invented. |
| Account add, rename, pause/resume, remove | Real per-engine account endpoints | Default cannot be removed. Removal requires exact codex-account-remove/v1 or claude-account-remove/v1 capability, re-read before write. Rename/pause are server-side settings and can work offline. Pause initially exposes one hour plus explicit resume. |
| Rotate Runner credential | Confirmed `POST runners/:id/rotate-token` | Explains immediate old-token invalidation and remote config/restart. Raw result only in memory, displayed once, cleared on dismiss/background. |
| Remove Runner | Confirmed `DELETE runners/:id` | Confirmation accurately says Runner **and workspaces** are removed (Prisma Cascade / Swift footer), not detached. No production removal tested. |
| Add remote Runner | Instance installer command + device lookup/approval | `GET runners/device/:code`, `POST .../approve`; shows machine name/hostname and name-conflict credential replacement warning before approval. Installer is displayed for a remote computer, never executed on Android. |
| Workspace/Runner association links | Optional onRunner/onWorkspace callbacks | Root A13 owns minimal integration into inherited A05 destinations. Skills/catalog management remains in the separate Providers/Skills slice. |

## Role and state matrix

| Caller / state | Server settings and owner resources | Remote engine / credential-directory work |
| --- | --- | --- |
| MEMBER, own current resource | Real owner-scoped GET/PATCH/DELETE | Online heartbeat + declared engine-specific capability, server final authorization |
| ADMIN, own current resource | Identical owner scope to MEMBER | Identical restrictions; no admin override manufactured |
| Another owner's resource / 403 / 404 | Clear retained object and disable writes | No synthesized success or optimistic role bypass |
| Offline / missing or >90-second heartbeat | Fresh server-held rename/capacity/label settings remain available | Disabled; fresh list re-read before each effect |
| Draining | Server-held settings available | Disabled until ready |
| Expired account | Authentication displayed as signed out/expired; cannot newly pin it | Renewal remains available if Runner is online and relay supported |
| Background / changed revision / failed refresh | Retained data labelled stale; writes disabled | Pending confirmation cleared; in-flight management job cancelled, no replay |
| Return to foreground / reconnect | Read current authoritative state before re-enabling | Old requests cannot re-enable controls after generation change |
| Mutation 400/409/network failure | Persistent error and retained draft; explicit retry after refresh | No silent retry; ambiguous request outcome is resolved by subsequent read |

A client preflight narrows accidental stale operations; it is not a server-side authorization or
transaction guarantee. The backend remains authoritative between the read and mutation.

## Verification artifacts and limitations

`WorkspaceRunnerTest.kt` contains nine focused tests, including real loopback HTTP over the existing
OkHttp/AuthSession stack: MEMBER/ADMIN share the same owner-scoped routes; each remote effect reads
current Runner state; capabilities withdrawn between screen read and confirmation cause no write;
offline cleanup does not dispatch; 403/404 are errors; expired authorization signs out; recovery
reads again; UUID/Base62 deep-link lookup works. Pure contract tests cover 90-second heartbeat,
unknown/draining state, Default non-removal, invalid account IDs, explicit Automatic null, Swift
blank-field semantics and account quota identity. The fixture is an HTTP contract simulation, not
a real API deployment or actual credential deletion on a controlled Runner.

The root `ManagementDeviceTest` additionally targets real product navigation, workspace PATCH,
Runner offline → online model-refresh action and canonical deep links on the controlled emulator.
The root report supplies actual commands, pass/fail results, APK/source identity and screenshots;
this mapping itself is not a statement that those checks have passed.

Remaining evidence: installed iOS and Android same-data comparisons; Android 10–16 physical-device
coverage and TalkBack operation; real deployed MEMBER/ADMIN cross-owner refusals; an isolated remote
Runner's actual install/sign-in/expiry/account pause/delete/rotation/checkout relay outcomes. Those
must use test accounts and a disposable non-production remote Runner, retain server/Runner/iOS/APK
versions, compare pre/post state across clients and restore all fixtures. No destructive operation
on production resources was attempted or authorized. The phone implementation cannot establish
FCM registration/delivery or release credentials; A10 owns that boundary.

## Slice-owned paths

* `src/android/app/src/main/kotlin/io/orbitd/android/management/WorkspaceRunnerActions.kt`
* `src/android/app/src/main/kotlin/io/orbitd/android/management/WorkspaceRunnerScreens.kt`
* `src/android/app/src/test/kotlin/io/orbitd/android/management/WorkspaceRunnerTest.kt`
* `src/android/docs/a13-workspace-runner.md`

The common ManagementApi, Settings entry integration, device test, build scripts, and A07/A10 merge
files are owned/reported separately by the coordinator. No Swift, backend, ComposerModel,
ComposerData, authentication, reader, cards or core realtime implementation was changed by this slice.
