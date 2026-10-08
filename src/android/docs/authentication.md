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
credentials, and so is each server's last signed-in email (below). Only a successful sign-in
records either, so a mistyped server or a refused email never sticks (iOS `fdeb033ad`).
Every response and storage mutation is checked against the current identity.
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

The login page prefills the email of the last successful **password** sign-in on its server.
This is a deliberate change to A03's original "no email on disk": the coordinator decided for
A03c to follow iOS `fdeb033ad`, which remembers the email and keeps it through sign-out. The
emails are one JSON map (canonical server → email) in its own AES-256-GCM record
(`orbit/emails.bin`, its own Keystore key, the same format, location and backup/transfer
exclusions as the credentials). Sign-out and session expiry leave it, as iOS does; the next
successful sign-in on a server replaces that server's email; it disappears only with the app's
data (uninstall or clear storage). A Google sign-in records no email, and a store that cannot be
read or written costs only the prefill, never the sign-in. The page prefills only the current
server's email: switching servers swaps in that server's email or clears a prefilled one, and
keeps an email typed by hand.

All records are under credential-encrypted `noBackupFilesDir/orbit`; cloud backup and
device-transfer exclusions are explicit as well as `allowBackup=false`. Keystore work runs
on IO. This does not claim StrongBox or hardware-backed keys on every device; the device
test records actual `KeyInfo` security level. It does not require biometric prompts for
each request or introduce a direct-boot/background service.

Production addresses require HTTPS with platform certificate verification. Credentials,
queries and fragments in an instance address are rejected. An address typed without a scheme
(the login page's default `orbitd.io`) is HTTPS. `/api` suffixes and default
ports normalize to the same instance. A reverse-proxy path remains part of identity.
Debug alone permits HTTP on exact loopback hosts for fixtures; subdomains are excluded.
Remote cleartext HTTP and trust-all certificate managers are not supported.

Differences to the iOS audit input for A01/A15: full instance/account scoping instead of
host-only token keys; fail-closed lost-refresh handling; no pre-auto-refresh access-only
login compatibility (the project supports a fixed current server combination); Android
Keystore/private storage replaces Keychain. UI alignment and additional account-management
flows are outside this slice. HTTPS-only production address policy must be included in
the final supported-server matrix.

The server `ClientVersionInterceptor` records authenticated Android requests alongside
web/ios/macos in `client_version`, keyed by user and client kind. An unchanged version
is written at most hourly; a changed version is recorded immediately. Login requests
are unauthenticated, so version observation begins with the next authenticated request.

Primary implementation references:
[AndroidKeyStore](https://developer.android.com/privacy-and-security/keystore),
[AES-GCM key specification](https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec),
[backup exclusions](https://developer.android.com/identity/data/autobackup),
[serialization 1.9.0 / Kotlin 2.2](https://github.com/Kotlin/kotlinx.serialization/releases/tag/v1.9.0),
[coroutines 1.10.2](https://github.com/Kotlin/kotlinx.coroutines/releases/tag/1.10.2).

## Google sign-in (D1)

The contract is `docs/google-sign-in-design.md` (§3.2, §4, §8.3); the server runs the whole OAuth
flow. The login page asks its server `GET /api/auth/methods` when the page appears and again when
the Server dialog changes the server, and offers **Continue with Google** only when `google` is
true, with the sign-up hint when `googleSignup` is also true. An older server's 404, an unreachable
instance or an address the app would refuse leaves the password form exactly as before. The lookup
is sent up to three times through network failures: the transport never retries, and a pooled
connection the server has since closed (idle keep-alive) fails once when a GET reuses it.

`GoogleSignIn` (`:core`) makes a 32-byte PKCE verifier and state for the instance and answers
`<instance>/api/auth/google/start?client=native&code_challenge=S256(verifier)&client_state=state`.
The app opens it in a Custom Tab of the default browser when that supports them, else of another
browser that does, else in the default browser; with no browser at all it says so and forgets the
attempt. The verifier and state live only in that process-wide object, never on disk or in saved
state: any app can declare `orbit://`, and a ticket another app catches cannot be exchanged
without the verifier.

`GoogleSignInRedirectActivity` receives `orbit://auth/google` (VIEW + BROWSABLE) and forwards it to
`MainActivity` with `NEW_TASK | CLEAR_TOP | SINGLE_TOP`, which closes the browser tab above it. Its
empty task affinity keeps it from rooting a task. The answer is used only when its `state` equals
the waiting sign-in's, and only once: a ticket is exchanged with the verifier through
`AuthSession.loginWithGoogleTicket`, which shares `login`'s switch (old session revoked, fenced
and purged, tokens saved and read back, then `SignedIn`); an `error` shows that code's sentence. A
different state uses nothing and leaves the sign-in waiting. When the process was killed while the
browser was open, the answer finds no verifier and the page asks to try again; the ticket is never
exchanged and expires unused.

One Google sign-in at a time (iOS `fbe1c83af`): while one is open in the browser or its ticket is
being exchanged, Continue with Google shows a spinner and takes no press — a press that reaches the
page before it redraws is ignored too — and Sign In waits for it. Back in the app without an answer
(the tab was closed, as closing iOS's sheet ends its sign-in), Google can start again; the closed
tab's answer, should it still come, belongs to a sign-in that is no longer waiting.

Messages read a server `code` before the HTTP status, so `ACCOUNT_DISABLED` or a Google refusal is
never shown as a wrong password; a Google exchange never blames the password at all (429 without a
code is the exchange's rate limit). Every code's sentence is iOS `LoginFailure`'s, including /start's
`GOOGLE_SIGN_IN_BUSY` and `GOOGLE_BAD_REQUEST` (`56a2c8024`).

## Login page (A03c)

The page follows iOS `LoginView` (`fdeb033ad`): the app icon, "Welcome back" / "Sign in to continue to
Orbit", Email and Password with standing labels (the password can be shown and hidden again), one
full-width Sign In capsule that fades while it cannot be pressed, and Continue with Google under
it. While a field has focus with the keyboard up, the brand folds into one row so the keyboard
never covers the form. The server is off the page: `orbitd.io` until a sign-in elsewhere is
remembered; three taps on the logo, or its "Change server" accessibility action, open the Server
dialog, which keeps only an address the app would sign in to and offers "Reset to orbitd.io".
Android differences, on purpose: the Server sheet is an Android dialog; Sign In keeps Material's
ripple; "Cancel sign in" stays while a sign-in is under way; the Build information link (A02)
stays under the form; the password field is emptied when it is sent; and an address without a
scheme is HTTPS only (iOS takes `http://` for a bare `localhost`).

Password sign-in failures read as iOS `LoginFailure` says them (`40a70be24`): 400, 401, 403 and 422
without a code the app knows are a wrong email or password; an unreachable server, a 5xx and an
answer that is no Orbit sign-in each have their own sentence. `LoginCopyParityTest` reads the
Swift sources, so the two clients' words cannot drift apart silently.

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
`GoogleSignInTest` covers the start URL, the RFC 7636 challenge and callback parsing (ticket, error,
another or repeated state, no sign-in waiting, other addresses); `AuthSessionTest` and
`HttpTransportTest` cover the ticket login and `auth/methods`; `GoogleSignInFlowTest` drives the
button's visibility, the Custom Tab or default-browser launch, the redirect activity and each
callback outcome through `MainActivity`; `AuthMessagesTest` pins every code's message.

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

Eleven device checks execute: actual AES-GCM/Keystore read/write, random IV and deletion;
tamper/key-loss cleanup; four server/user namespaces; the encrypted per-server email record,
which outlives cleared credentials; four separate process phases
(seed, restart/rotate, restart/logout, restart/assert cleared); actual login UI → HTTP
401/rotation → activity recreation → logout; and the A03c login page once with the system light
and once dark (the Server dialog through three real taps, a refused password that records
nothing, a sign-in that records the server and its email, sign-out back to them; the dark process
first finds the light one's email remembered). The script sets and restores the emulator's night
mode around those two runs. The four persistence process IDs must differ. The driver
requires positive test counts and rejects skips/failures, scans captured output/logcat for
fixture credentials, and exports APK hashes, signature, device build, key security level,
source SHA, phase records, signed-in/signed-out screenshots and twelve login page screenshots
(`login-screenshots/`: server, server-invalid, login, typing, refused, remembered × light, dark).

`LoginRealStackDeviceTest` runs the same page against a real server, the A11 isolated stack
(`scripts/a11-stack`, a bootstrapped admin, Google sign-in on with a placeholder client), through
`tasks-projects-stack-device-test.sh` with `A11_TEST=io.orbitd.android.auth.LoginRealStackDeviceTest`
and an args file of base64 `server`, `ownerEmail`, `ownerPassword`: the stack's `auth/methods`, its
400 for an email it cannot read, an unreachable server, its 401, its `/start` refusal
(`GOOGLE_BAD_REQUEST`, handed to `MainActivity.onNewIntent` as the redirect activity hands it on: a
compose test loses its page once the activity pauses) with a second press ignored, and
a sign-in that is remembered through sign-out.

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
