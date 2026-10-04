# A03 authentication and session boundary

## Source and scope

The A03 worktree started at `ec10c8e8b34d6c5a4b152980f7e5ee3be16c02c1`. It did not
contain Android. A normal merge of the required A02 commit
`a6c43ddab6461d09700a7f0fabb35759b67799d4` produced
`9a4e8312331891cb71299908a3762ce3ef57f63c`, without conflicts or replacing either ancestor.
This is the server source used for implementation, not a deployed-server identity:

- `src/apiserver` tree: `f85f296c885f180c86b7c1ca99fdfebec64e4b64`.
- `src/shared` tree: `4542df34b1b1fb145090fbca3661d070ca024c04`.
- Auth endpoints/body/response: `src/apiserver/src/auth/{auth.controller,auth.service,dto}.ts`.
- Session capabilities: `src/shared/src/dto.ts`; wire vocabulary: `enums.ts`.
- `models.ts` was reviewed; model pickers/defaults are not needed by this auth slice and
  are not copied. No shared/backend/push contract is changed by A03.
- References: `src/web/src/api.ts` single-flight refresh/error body and OrbitKit's
  `Auth/TokenStore.swift`, `Net/APIClient.swift`, `Models/DTOs.swift`.

iOS source `946b7352b83c1c7251d1a386997310366d3f833b` remains an audit input. Its auth
store and the server auth/shared enum/model files above have no source delta against the
combination for the portions compared. Neither it nor the A01 matrix is represented as an
owner-confirmed installed build. A01/A15 still own device/interaction alignment.

The local tests use generated fixture accounts and a controlled HTTP server, not production
credentials or an isolated deployed account. A02's a6 CI and 631a emulator evidence prove
their recorded engineering input; they do not prove this new code or physical persistence.

## Interface for feature pages

`OrbitApplication.session` is the single `AuthSession` for the process. Activity recreation
shares it. `state` is a `StateFlow<AuthState>` containing only a user and an opaque
`SessionHandle`, never tokens. A page captures the signed-in handle and uses
`OrbitApi.request(handle, ApiRequest(...))`; `me`, `workspaces` and `sessions` are the initial
typed adapters. Extend DTOs as a feature consumes fields. Unknown object fields are ignored;
unknown enum strings remain readable. Missing/unknown capabilities grant no operations.
`canComplete` overrides the legacy `canArchive` alias even when false.

Requests use path segments relative to the selected instance's `/api`, encoded query pairs,
and an optional byte body. There is no caller-supplied absolute authenticated URL. The same
body (including a business `clientTurnId`) is used for the one explicit 401 retry. All calls,
including login/refresh/logout, send `X-Orbit-Client: android/<BuildConfig.VERSION_NAME>`.
Structured HTTP errors retain status, code, messages and complete JSON body. UI maps errors
to safe local text; exception messages/toString omit bodies, passwords and tokens. Do not
log `ApiError.body`, request bytes, credential fields or user input in future consumers.

Use `readData` / `writeData` on the same session handle for drafts/cache. The platform store
hashes the **canonical scheme + host + port + instance path**, plus the server user ID and
record key. The gate rejects old handles, including a new login as the same account. Key
feature UI/state by handle and discard it when auth state changes; do not retain an old
page's result in a global unscoped cache. A04 owns cache policy, SSE and state restoration;
A03 provides the scope/cancellation boundary, not a transcript cache implementation.

## Refresh and invalidation

Each login has its own coroutine job and identity. Requests and refresh calls belong to it.
Under a mutex, all 401s for one access-token version share one Deferred refresh. A late 401
for an older version uses the already rotated pair. Cancelling a page request cancels its
socket but leaves the shared refresh alive for other waiters. Successful rotation validates
the account ID, requires a new nonempty refresh token, and atomically persists/read-verifies
the entire pair before exposing it or retrying.

Logout, selecting an instance, beginning another login, and refresh failure cancel the old
job, clear credentials, and purge all local draft/cache namespaces. Only one active login
is retained. This intentionally forgets inactive-account drafts when switching; it never
restores another server/account's content. The instance address is retained without
credentials. Every response and storage mutation is checked against the current identity.
Cleanup completes with cancellation masked; a cancelled caller cannot leave half a session.

Refresh is never automatically retried. The server consumes a token once and replay can
revoke the account's entire live refresh family. Even a network failure might mean the
rotation succeeded but its response was lost, so Android signs out on **any** failed refresh.
A repeated 401 after the single explicit retry signs out only if the retry's token version
is still current. A delayed rejection after another committed rotation fails only that
request, without clearing the newer session or retrying again. Offline ordinary requests
do not sign out. Logout revocation is best-effort with a captured old server/token and a
five-second limit; local cleanup does not depend on it. A lost refresh response cannot
guarantee remote revocation of the newly issued token, but cannot restore local credentials.

OkHttp disables redirects and connection retries. Auth/mutation bodies are one-shot at the
transport layer, also preventing automatic HTTP 408/503 resubmission. The session layer
constructs a fresh request body only for its explicit 401 retry. There are no HTTP disk caches,
cookie stores or logging interceptors.

## Android storage and transport

The complete `StoredSession` (instance, account, access + refresh) is one AES-256-GCM record
using an AndroidKeyStore key, a new random 96-bit IV and 128-bit tag. Associated data binds
the record format/key alias to the application package. `AtomicFile` commits the encrypted
record and the store decrypts/read-verifies it. A save error prevents authenticated state.
Corruption, unavailable/lost keys, malformed records or mismatched selected instances fail
closed. Logout deletes both key and file, and purges account data. No password is persisted.
Debug and release use separate package identities and Keystore aliases.

All records are under credential-encrypted `noBackupFilesDir/orbit`; cloud backup and
device-transfer exclusions are explicit as well as `allowBackup=false`. Keystore work runs
on IO. This does not claim StrongBox or hardware-backed keys on every device; the device
test records actual `KeyInfo` security level. It does not require biometric prompts for
each request or introduce a direct-boot/background service.

Production addresses require HTTPS with platform certificate verification. Credentials,
queries and fragments in an instance address are rejected. `/api` suffixes and default
ports normalize to the same instance. A reverse-proxy path remains part of identity.
Debug alone permits HTTP on exact loopback hosts for fixtures; subdomains are excluded.
Remote cleartext HTTP and trust-all certificate managers are not supported.

Differences to the iOS audit input for A01/A15: full instance/account scoping instead of
host-only token keys; fail-closed lost-refresh handling; no pre-auto-refresh access-only
login compatibility (the project supports a fixed current server combination); Android
Keystore/private storage replaces Keychain. UI alignment and additional account-management
flows are outside this slice. HTTPS-only production address policy must be included in
the final supported-server matrix.

The current server `ClientVersionInterceptor` only records web/ios/macos; it ignores the
correctly emitted Android header. Backend Android version observability is an integration
follow-up for A14/the coordinator, not evidence that this slice's header is missing.

Primary implementation references:
[AndroidKeyStore](https://developer.android.com/privacy-and-security/keystore),
[AES-GCM key specification](https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec),
[backup exclusions](https://developer.android.com/identity/data/autobackup),
[serialization 1.9.0 / Kotlin 2.2](https://github.com/Kotlin/kotlinx.serialization/releases/tag/v1.9.0),
[coroutines 1.10.2](https://github.com/Kotlin/kotlinx.coroutines/releases/tag/1.10.2).

## Fixtures and automated checks

`core/src/test/resources/wire/sessions.json` ports the first two literal wire cases from
OrbitKit `ModelsCodableTests.testSessionDecodesCapabilitiesAndOldPayloadStillWorks`; the
remaining rows exercise its legacy capability alias and unknown-state cases. `auth.json`
uses the backend `tokenFor` shape, adding unknown fields and synthetic credentials.
`error.json` follows web `ApiError`'s structured-code/message-array contract. The old
OrbitKit login fixture without refresh is tested as rejected, documenting the fixed-server
boundary. No full-repository DTO generator or shared protocol rewrite is introduced.

The normal project gate remains unchanged:

```sh
env JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk bash src/android/gradlew -p src/android --no-daemon --max-workers=2 test lintDebug assembleDebug
python3 src/android/scripts/check-test-results.py src/android
```

Core tests barrier 20 requests at 401 and require exactly one refresh, then verify the next
rotation presents the new token. They cover late old-token 401s, waiter cancellation,
eight failure cases, repeated 401, late login/read/refresh across logout or switches,
same-account re-login, server/user isolation, persistence failures, and corrupt restore.
Real HTTP tests check paths, bearer/client headers, exact replay body, redirects, 503 and
socket cancellation. UI tests cover usable login/logout and activity recreation.

## Device and physical-phone evidence

Build both APKs from the same committed source before recording final evidence:

```sh
env JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk bash src/android/gradlew -p src/android --no-daemon --max-workers=2 :app:assembleDebug :app:assembleDebugAndroidTest
bash src/android/scripts/auth-device-test.sh 29 src/android/app/build/outputs/apk/debug/app-debug.apk src/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk /absolute/new/evidence-api29
bash src/android/scripts/auth-device-test.sh 36 src/android/app/build/outputs/apk/debug/app-debug.apk src/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk /absolute/new/evidence-api36
```

The script holds the A02 shared `flock /var/lib/orbit/android/ui.lock` for its entire device
run, reuses the API36 service or starts/stops only its own API29–35 AVD. A supplied serial
uses an already connected emulator/phone. It uses a dedicated, signed-out **debug** install
and synthetic accounts. It does not uninstall or clear a user's existing app. The UI test
refuses to run over an authenticated account; APK signature mismatches fail instead of
uninstalling. The loopback MockWebServer never sends credentials to a real deployment.

Eight device checks execute: actual AES-GCM/Keystore read/write, random IV and deletion;
tamper/key-loss cleanup; four server/user namespaces; four separate process phases
(seed, restart/rotate, restart/logout, restart/assert cleared); and actual login UI → HTTP
401/rotation → activity recreation → logout. The four process IDs must differ. The driver
requires positive test counts and rejects skips/failures, scans captured output/logcat for
fixture credentials, and exports APK hashes, signature, device build, key security level,
source SHA, phase records and signed-in/signed-out screenshots.

API29/API36 runs are emulator evidence until an actual phone serial/device record says
otherwise. No simulated result establishes the D09 R-min/R-ref/R-oem physical requirement.
The same script can collect physical evidence with local USB/paired ADB; do not open remote
ADB ports. A01/A15 retain the other required API/device combinations.

For a phone without a local test runner: install the exact handoff APK, save the system
and Build information identity (API/build/source SHA/package), sign in to an authorized
isolated HTTPS instance/account, force-stop/reopen, and verify the login survives. Sign out,
force-stop/reopen and confirm login is required. Switch between two supplied accounts and
two approved instances and confirm no previous account content reappears. Record outcomes
and screenshots without passwords/tokens. Secure-storage deletion/log leakage and automatic
rotation still require the instrumented or equivalent controlled evidence; these manual
steps alone do not establish all of criterion 3. Never place real credentials in source,
command arguments, screenshots, comments or evidence archives.

Physical devices, final deployed SHA/isolated accounts and any new public-source push/CI
authorization remain separately required inputs. Local implementation and emulator passes
do not close those evidence gaps or mark A03/A01/A02/A15 complete.
