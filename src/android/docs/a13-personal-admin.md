# A13 personal, administrator and share settings

Scope: Kotlin + Compose on Android 10–16 / minSdk 29. This slice adds only
`management/PersonalSettings.kt`, `AdminSettings.kt`, `SharingSettings.kt`, their tests and this
mapping. AuthSession, composer/account selection, directory navigation, back-stack and existing
Swift/API implementations are inherited rather than reimplemented.

## Source identity and contract

The starting approved dependency for the slice is A07 `51bbcc303cec3c64dfb217316afce9498add760d`.
A13's ordinary merge was `eb036ba258238898eea3f92128cdcc97ccf59579`; the coordinator subsequently
absorbed the fixed A10 interface in `afb311c3becdf940ea728fcc859d9a96cb342cbf`. Neither is an iOS
installation identity or a deployed-server identity. See the root A13 report for the final combination,
initial task SHA and verification artifact identities.

The static sources read for this slice are:

* `src/macos/OrbitApp/Sources/OrbitApp/Views/SettingsSheet.swift`, `SettingsAdminView.swift`,
  `ShareSheet.swift`;
* `src/macos/OrbitKit/Sources/OrbitKit/App/SettingsHome.swift`, `SharedLinksList.swift`,
  `SharePanel.swift`, `AgentDefaults.swift`, and `Models/ShareLinks.swift`;
* `src/apiserver/src/users/{users.controller,admin.controller,admin-role.guard,dto,avatar}.ts`,
  `auth/auth.controller.ts`, `share-links/{share-links.controller,dto}.ts`;
* existing Swift contract fixtures in `ProfileAPIClientTests.swift`, `SettingsHomeTests.swift` and
  `SharePanelTests.swift`; permission values in `src/shared/src/enums.ts`.

These are a static correspondence, not a frozen or installed iOS same-data acceptance matrix.
No existing shared JSON fixture covers personal/admin/share settings; the controlled HTTP cases use
those fixed API shapes. Android notification fixture and device setup are A10's separate evidence.

## Baseline correspondence

| iOS baseline item | Android implementation / exact endpoint | Behavior and evidence scope |
| --- | --- | --- |
| Profile name; account email and role | `PersonalSettings`, `GET/PATCH users/me` | Trim name, reject blank and >80 characters; immutable email/role shown; response and fresh GET establish the saved account. |
| Avatar, library/camera/files, crop, removal | `PersonalSettings`, `GET/PUT/DELETE users/me/avatar` | Uses system providers; ImageDecoder handles orientation and bounds decode to 1024; crop zoom 1–5 and x/y positioning; square 512 JPEG multipart `file`. Authenticated GET never leaks bearer through an image URL. |
| Profile Save partial failure | `PersonalSettings` | Stage cropped photo/removal until Save profile, require a nonblank name, photo first then rename. Clear each pending step only when its response succeeds; failed writes require a read refresh. |
| Default permission | `PATCH users/me/preferences` | All six server `PermissionMode` values; missing preference reads `auto`, matching server floor. This account preference is distinct from a session/runner's supported runtime capability. ComposerModel/ComposerData remain inherited. |
| Session orchestration | Same preference endpoint, only `enableOrchestration` key | Missing means on; server accepted response and re-read precede displayed change. Does not accidentally write theme/model/notification drafts. |
| Appearance | Same preference endpoint, only `theme` key | System/light/dark; callback to root only after server acceptance and refresh. Root AccountAppearance also follows SSE invalidation; late old-theme reads cannot overwrite an acknowledged theme change. |
| Email and instance | `PersonalSettings` | Signed-in email; canonical instance root including reverse-proxy prefix is visible and selectable. Instance switching/sign out remain existing auth-shell actions. |
| Change password | `POST auth/change-password` | Current/new/confirmation, minimum 6 characters; no save-state persistence. Clear fields only after accepted write and refresh. |
| Account notification preferences | `NotificationsPreferences`, partial preference PATCH | `notifySessionFinished` and `notifyAgentMessage`; missing means on; always-sent classes listed. This does **not** assert permission/FCM registration/delivery. Device component comes from A10. |
| Administrator entry and list | `AdminSettings`, `GET users/me` then `GET admin/users` | Only current `ADMIN` asks for list. MEMBER cannot select management controls. AdminRoleGuard checks current DB role again on every admin request. |
| Create user and one-time generated password | `POST admin/users` | Email and optional name, no force/reset extension beyond iOS baseline. Password only held in memory, shown once, dismissible and cleared on pause; preserves acknowledged password if follow-up list read fails. |
| Change role | `PATCH admin/users/:id/role` | Explicit target/role confirmation; server owns last-admin prevention and live role revocation. No optimistic role changes. |
| Delete user | `DELETE admin/users/:id` | Target confirmation; disables self-deletion; server refuses last admin / owned-resource conflict. No production mutation used for testing. |
| Shared links list | `SharingSettings`, `GET share-links` | Active/Paused/Ended plus an explicit unknown-state fallback; root title, kind, state/reason, view/expiry data. Paused links explain Trash restoration. |
| Copy/share public URL | Existing link token + canonical instance prefix + `/s/<token>` | Active and freshly loaded links only. Native clipboard and Android system share chooser. No bearer placed in public URL. |
| Turn off public link | `POST share-links/turn-off {shareLinkIds}` | Owner list supplies ids; asks before revocation; Active/Paused only. Server ownership filtering remains authoritative. |
| Resource share/permissions entry | `ShareResourceSettings(api,revision,kind,id)` | Minimal reusable entry for SESSION/TASK/PROJECT; `GET/PUT/DELETE {sessions\|tasks\|projects}/:id/share`. Caller/root owns destination hookup. |
| Public access and included layers | Same resource endpoint | Only you / Anyone with link; root overview/messages always included; session tool output, task comments/files+conversations, project task pages+nested layers. Parent-off disables nested switches. Only returned supported layers are editable. |
| Expiry, counts, live updates | Partial share PUT | Never option sends explicit JSON null; 1/7/30 days send ISO timestamp. Returned expiration/counts shown. Conversation warning retained. Turning access off asks first. |

The Android list uses Compose forms rather than reproducing the iOS sheet's exact visual grouping.
The crop uses accessible position/zoom sliders rather than a touch-only crop gesture. Camera uses Android's full-resolution `TakePicture` contract with a temporary FileProvider URI in
`cache/handoff/avatar-<UUID>/capture.jpg`, then bounded ImageDecoder decode and the same 512px crop.
The existing handoff provider configuration is reused without changing attachment implementation.
Completion/cancellation/failure/page disposal revokes read/write grants and deletes the camera file;
the pending capture belongs to the current handle. Cold-start/account clearing also removes the
existing handoff root; after process death the user takes a new photo rather than restoring a URI
across accounts. The shared-links page exposes the resource permission panel directly from
existing links; new-link creation comes through the reusable resource entry.

## Authority, stale state and recovery

`PersonalRecord` marks itself stale at the start of each refresh and mutation. Controls remain
unavailable until the response and any required follow-up GET succeed. No mutation automatically
retries after an ambiguous network failure. The user refreshes authoritative state first.

Every page refreshes on revision and lifecycle resume; pause invalidates pending reads. Generation
checks prevent a pre-pause response from enabling edits. A 401/403/404 failure clears the retained
object, including old administrator rows. AuthSession retains account/instance epoch, rotating-token
and logout authority; this slice never reads a bearer itself. A live role revoked between `/me` and
an admin request is still refused by the server guard.

| Actor / state | Personal preferences | Administrator users | Own shared resources | Other owner's link |
| --- | --- | --- | --- | --- |
| MEMBER, fresh | Own read/write | No list request/control | Owner endpoints allow read/write | Server 404; clear retained state |
| ADMIN, fresh | Own read/write | Current-role gate; guarded requests | Same owner scope as MEMBER | No admin ownership bypass added |
| Role changed after read | Personal unaffected | Server refusal clears snapshot; refresh required | Owner scope unchanged | Same refusal |
| Stale/background/network failure | Display retained data as stale; writes disabled | Same, sensitive object cleared on access denial | No copy/revoke/edit from stale data | No synthetic success |
| Expired auth / changed account | Existing AuthSession refresh or sign-out behavior | Same account epoch guard | Same account epoch guard | Same account epoch guard |

## Local checks and remaining evidence

Added `PersonalSettingsTest` covers eight cases: stale/in-flight rejection and late-response
invalidation, ambiguous write/read recovery, accepted-write/failed-refresh distinction, controlled
MEMBER/ADMIN HTTP reads and live 403, actual multipart avatar and partial preference/share HTTP
contracts plus owner 404, link-state/expiry/nested-layer rules, and malformed/wrong-resource share response rejection. `PersonalAvatarTest` checks crop
bounds and 512px output at zoom/position extremes plus full-resolution capture output URI and cleanup on Robolectric API 29. The root runs Gradle and
records actual results; merely adding these tests is not a passing-test claim.

Required follow-up when resources exist: use two controlled deployed MEMBER/ADMIN accounts and a
controlled remote Runner; install identified iOS and Android builds against the same data; compare
profile/avatar round-trip, preference propagation, notification preference vs FCM device state,
role revocation/last-admin/conflict rejection, own vs other-user share permissions, public view and
revocation/expiry/Trash behavior. Capture actual requests/screenshots and restore test settings and
resources. No live iOS install, real-device Android 10–16 matrix, deployed roles, real FCM delivery or
production destructive results are established by these local fixtures.
