# Android composer and attachments (A07)

Development input: A04 project line, A05 `3c286987d`, A03 `8647533`, A06
`d6a61511d6830237271f3216e0668702d0e64462`, and its reviewed partial-steer repair
`5df1d1d57111bd607b36c8089ef855e4b2f4dc43`. Both A06 commits were absorbed by ordinary
merge, preserving ancestry. A07 does not modify TranscriptRows or A08's cards/TranscriptRowView.
A08's fixed discussion contract `08b204c6274b6a3201169f31e7c82315ac379523` and attachment-only
rendering fix `4fd1b3b0549943ea38e3c40deb28f4396c9acbc8` are ordinary-merge integration inputs.

## Wire and storage

`OrbitApplication.composer` holds one model per canonical session id and login epoch. New
drafts also include workspace/folder. AuthSession's DRAFT storage supplies the full canonical
server and stable user namespace, atomic app-private writes, cancellation and sign-out wiping.
Activity recreation preserves in-flight uploads. Cold restoration reads text, selection,
attachment bytes/configuration and the outbox; an interrupted upload offers an explicit retry.
IME composition stays in TextFieldValue, not durable storage. Enter inserts a newline;
Ctrl/Meta+Enter sends only outside composition. A bounded scroll area keeps Send above the IME.

| Action | Existing endpoint / behavior |
| --- | --- |
| New session | POST /sessions with workspace/folder, prompt and attachmentIds |
| Send / shell | POST /sessions/:id/turns with clientTurnId, content, kind, attachmentIds |
| Resume | POST /sessions/:id/resume, retaining selected configuration |
| Stop | POST /sessions/:id/interrupt |
| Queue withdrawal | DELETE /sessions/:id/turns/:turnId |
| Queue for next turn | Send held while a turn runs on Claude or Codex: POST /sessions/:id/turns with intent NEXT_TURN |
| Steer a queued message | POST /sessions/:id/turns/:turnId/steer; 409 CURRENT_WORK_UNAVAILABLE leaves it queued |
| Retry failed message | POST /sessions/:id/retry-message, server recovers sender and attachments |
| Cancel automatic retry | DELETE /sessions/:id/auto-retry |
| Model / runtime-compatible provider | PATCH /sessions/:id/config; terminal selection saved for resume |
| Account | PATCH /sessions/:id/account; runner account-move/v1 capability required |
| Upload | POST /attachments multipart field file; sessionId omitted for new draft |
| Download | Authenticated GET /attachments/:id or session artifact path |

The tray above the composer (docs/mocks/steer-tray, decided 2026-10-16; `composer/PendingTray.kt`) holds the reader's own
messages nothing has read yet, one row each in send order: a steer into the running turn (Sending…, Waiting to be read,
Withdrawing…) and a message queued for the next one (Queued for next turn). The conversation leaves such a steer out until a
`user_delivery` settles it (`reader/SteerDelivery.kt`, `place`): acknowledged, it is drawn after the output written before the
reading; failed or unconfirmed — or settled by the active listing's durable receipt — where that became known; withdrawn, never;
requeued, it waits as queued until it arrives as a message of its own. A window short of the live tail draws steers where they
were sent. What Orbit queued keeps its card in the transcript's tail. Withdraw returns the words under any draft; Steer is offered
on a queued, non-shell row while a turn runs on Claude or Codex.

Under each of the reader's steers the conversation draws, a line says how it came out, in the web's and iOS's words
(`SteerDelivery.label`): Read in this turn, Not delivered, Couldn't confirm it was read — the last two in the warning tone, the
runner's reason a long press away. Not delivered offers Put back in the composer: the words return under any draft, and nothing is
sent. A steer known only from the active listing's receipt (no echo, no runner's word) is drawn at the end of the queued tail with
why it did not land, in the sender's words (`SteerDelivery.failureExplanation`); its Put back returns the words, then discards the
turn (DELETE /sessions/:id/turns/:turnId), and a refusal is said as "Couldn't discard the message".

Before the first turn/resume POST, persist an immutable clientTurnId, endpoint, JSON body and
attachments. Duplicate taps are gated. A lost reply keeps that record, even while a new draft
is edited. Explicit retry uses exactly the saved request across process death and status/model
changes. Acknowledgement is persisted before the retry disappears. Uploads use two slots;
Send waits for them, and a failed upload must be retried or removed. Removal cannot be undone
by a late upload reply. Upload progress reports actual multipart socket writes, not acceptance.

POST /sessions has **no public idempotency key contract** in the fixed backend. An ambiguous
creation remains visible with its content and instructs the user to inspect workspace sessions;
it cannot be blindly replayed. Definite validation/permission rejection restores the draft.
This API limitation is separate from same-clientTurnId retry for existing sessions.

A failed pre-POST draft write restores editable text and attachments. A definite first-POST
400/403/404/409/413/422 rejection does the same, so the next send re-reads capabilities and can resume.
An uncertain delivery keeps its immutable outbox even if a later retry is refused. A successful
create response keeps its known session id when local acknowledgement storage fails; the UI
retries that write without another POST and navigates only after it succeeds. If the process is
lost before that write succeeds, the saved create is still uncertain and is never blindly replayed.
Create Automatic omits the provider account; Default/slot use codexAccount or claudeAccount.
Existing-session account PATCH still sends `automatic`. Draft Usage follows the selected account;
Automatic and unreported accounts show unknown. Changing provider clears the prior engine's slot.

Catalogs use GET /runners (there is no GET /runners/:id), /providers, /providers/pools and
/providers/shared-pools. Model values, reasoning levels, fast mode, root/Auto permission and
account availability consume the existing capability contracts. Configured providers retain
their own model space unless modelsFromRuntime is explicit. Command/Skill menus use that
runner's agent/runtime-scoped catalog; local /status consumes no turn. No settings management
screen or new server protocol is added. Context uses reported transcript tokens/window and the
selected model's reported contextWindow; unknown windows show a count. Usage reads the billed
provider/account's snapshot, preserving fetched/reset timestamps and never substituting another
login's quota. A08 owns question/approval/evidence reply targets. Its ordinary card discussion
callback appends context to the existing durable draft and focuses the input without sending.
The A01 matrix's # reference picker was not found in the fixed Swift input; reference text is sent unchanged, with that
matrix discrepancy returned to A01 rather than inventing an endpoint.

## Entry-specific attachment contract

The fixed Swift ComposerView / FileHandoff / Attachments and backend MAX_UPLOAD_BYTES differ:

| Entry | Conversion and limit |
| --- | --- |
| File (SAF) | Reject empty; PNG/JPEG/WebP/GIF <=5 MiB; other MIME <=25 MiB |
| Photos | Android picker max five; decode and encode PNG; backend <=25 MiB |
| Pasted image URI | Decode and encode PNG; backend <=25 MiB |

Do not silently apply the File 5 MiB cap to Photos/Paste. Boundary tests preserve that difference.
Photo/Paste conversion first reads dimensions, then samples oversized images to at most 4 Mi pixels
and a 4096-pixel side before allocating ARGB pixels. It normalizes all EXIF rotations and mirrors
before PNG encoding. Ordinary images keep their dimensions. The bitmap budget is at most 16 MiB
plus one orientation copy per import (two concurrent slots); encoded buffers/codec workspace are
additional. File upload bytes are unchanged. Previews use the same orientation decoder with a
2560-pixel side bound. This does not change either entry's encoded-byte limit.
Persistable grants are taken where offered, bytes are copied into the account's private storage,
and grants are released. Sign-out also releases grants left by an interrupted process; restoring
the same login preserves them for a pending import. Older system file-picker photo fallbacks
explicitly retain the five-photo selection limit. Temporary clipboard/provider grants also work. Failed private-copy
access requires reselecting the URI; a network upload retry uses the private copy.

Image previews are sampled, zoomable and share the same action dialog as transcript files.
Previous/Next browses the staged images or attachment images in the loaded reading window.
Download uses ACTION_CREATE_DOCUMENT; Save image uses scoped MediaStore. Open/Share hand off
only cache/handoff files through a nonexported FileProvider and read-only URI grants/ClipData.
Copy places a content URI on the clipboard. Login changes revoke and remove these temporary
handoffs and clear only Orbit's own clipboard URI. Reader access withdrawal closes the dialog;
each remote action checks the current auth handle and reader access before and after fetching.

## Reproduction and boundaries

Run `scripts/verify.sh <empty-evidence-dir>` with Java 21 and the SDK; it uses clean plus the
unchanged project gate `test lintDebug assembleDebug`, always `--max-workers=2`.
Build instrumentation using `:app:assembleDebugAndroidTest`, also with `--max-workers=2`.

```
bash scripts/composer-device-test.sh 36 app/build/outputs/apk/debug/app-debug.apk \
  app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk /tmp/a07-device
A07_COLD_PROCESS=1 A07_TEST=io.orbitd.android.composer.ColdComposerDeviceTest#prepare \
  bash scripts/composer-device-test.sh 36 app/build/outputs/apk/debug/app-debug.apk \
  app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk /tmp/a07-cold
```

The script holds `/var/lib/orbit/android/ui.lock` for the entire workflow, records identity,
APK hashes, HTTP requests/final state, screenshots and receiver/export digests, then restores
display/font/night/handwriting settings, removes reverse ports and releases the device. API29
starts and stops its own emulator; API36 uses the shared emulator. `A07_FONT_SCALE=2.0` and
`A07_NIGHT=yes` select additional conditions. The cold workflow force-stops between separate
instrumentation invocations and records both PIDs. The 100-group test injects two lost replies
after acceptance per key (300 HTTP attempts, 100 accepted turns), restoring from private
storage between attempts. Its model recreation is distinct from the separate cold-PID test.

These are controlled loopback HTTP and debug-emulator results, not a deployed backend or a
physical phone. The fixture implements the inspected endpoints and records accepted state;
it does not independently prove PostgreSQL deduplication or runtime execution. Actual frozen
iOS installation/matrix, R-min/R-ref/R-oem devices, deployment/role accounts and full
TalkBack/S1/D09 remain required. Pilot failures are retained with their original dirty-build
identity; only final runs identify the final clean SHA. No public push/deployment/release
signing is part of this change.
