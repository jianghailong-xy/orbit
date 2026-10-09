# Session reading (A06)

The unified `SESSION` destination now reads the actual transcript with the A03 account handle
and A04 store. Navigation retains A05's caller/return stack, including record links. There is
no production fixture, new authentication path, or second SSE subscription. A07 owns composing
and sending, and the corresponding feature tasks own actionable approval/request/project cards.

## Inputs and responsibilities

Development merged the exact A05 input `3c286987d99a7e3429c216ab67657a53b40fe3b0` into this
independent task branch with an ordinary, conflict-free merge. The combination is
`4f13b50b9a9713590dc4d50ca424dcf980abcca1`, retaining the A02/A03/A04 ancestors. This does not
change A05's SEND_BACK verdict or establish that A05 has landed. The verified input archive
SHA256 is `de22acffb52495e895bda7a93a6417284d9f34bf07f4dac3a7273e1d8b7feb28`.

Behavior follows shared `Views/Console/ConsoleView.swift`, `MarkdownView.swift`,
`Console/SelectableText.swift`, OrbitKit's Markdown/Transcript sources, and A01's source matrix.
The installed iOS version and the final cross-platform matrix remain unfrozen. A06 adds reading
behavior; it does not claim completion of the larger project criterion's input/send coverage.

`SessionReaderModel` owns a cancellable route/account lifetime and a reading window.
`RealtimeStore` remains the owner of foreground/network control, session authority and replay.
`MainActivity` and `RealtimeDirectory` observe directory/revision changes independently of the
stream so each text delta does not rebuild directory projections. A transient delta retains
the durable event list's identity; row projection runs only when durable content changes.
Rows have stable sequence keys, fold results into their calls, and retain orphaned results and
subagent messages when the launching call lies outside the current page.

Authoritative session 403/404 removes the transcript, details, links and cached reading content. SSE
cannot repopulate denied state; successful authority recovery loads a fresh tail. Network/5xx
failures keep explicitly stale reading content. Session mutations still require both fresh
session and directory state and the captured auth handle. No auth rotation logic was changed.
Ordinary tail/before/after 404 is session-scoped. An around/full 404 can instead mean one missing
record: a session detail read distinguishes that case before revoking the session. An unavailable
authority check keeps stale content and reports its failure; it does not invent a denial.

`ReadingCache` persists a session-wide access revision in A03's account namespace. Rejection
invalidates every default/record bookmark, including late saves and cold process restoration.
Old bookmark bytes cannot restore under the new revision. The store also persists rejection when
no reader is mounted; a fresh authoritative snapshot is required to release it. In-flight page,
full-content and authority responses cannot revive content after rejection. These are additive
reading/cache APIs; auth, wire DTOs, the unified destination and A07/A08 interfaces are unchanged.

## Reading and content

- First paint uses the newest 200 events. Explicit earlier/newer controls page 200 records.
  `around=<record-id>` uses the existing server record resolver and preserves both cursors.
  A missing record reports an error while keeping the existing messages.
- The independent window holds at most 2,000 events. Trimming drops the far edge, preserves the
  reader's near edge and exposes a newer cursor. An unread gap is never silently joined to the
  live tail. Page requests are single-flight; replacing a target cancels and fences old reads.
- Position is a durable row sequence plus pixel offset, not a list index. Earlier insertion,
  a folded child/result anchor, recreation and cache restoration use that identity. The offset
  deliberately excludes the content-padding origin. A touch pauses following for selection;
  scrolling to the bottom or Jump to latest resumes it. Historical reading stays in place.
  A linked record has its own saved position, so reading it does not replace the return source's
  bookmark. Recreating an already-open record restores its current position. Connection notices
  share a fixed-height status row so reconnecting does not displace the transcript.
- Saved reading windows use account-scoped storage, at most 200 events and 1 MiB. Large windows
  shrink around the anchor. If even one event exceeds that limit, only position metadata is
  stored and restoration pages to its sequence; offline failure offers Retry rather than
  substituting the latest messages. Cached content can be read offline unless access was revoked.
- CommonMark/GFM uses the pinned `commonmark-java` 0.25.1 parser and tables, strikethrough,
  task-list and autolink extensions. Native Compose text supports selection, headings, lists,
  quotes, inline emphasis/code and links. HTML is literal text. Tables scroll horizontally.
  A linked image retains its outer destination via Open link, alongside image viewing/Open image;
  both destinations use the existing safe link handler.
- Code/diff/output previews collapse after 24 lines or 4,000 characters. Full output uses lazy
  32-line chunks, horizontal scrolling and Copy all. Tool payloads marked truncated are fetched
  from the existing full-event endpoint when expanded. Text/thinking drafts stay separate from
  durable rows; completed Markdown blocks remain parsed while the unfinished suffix streams.
  Single lines split into bounded display continuations without splitting surrogate pairs.
  Copy/Save always use the original text; beyond 200,000 UTF-16 units the UI offers partial
  selection or Save text rather than sending an oversized clipboard transaction. Copy message
  fetches truncated payloads first, so a collapsed preview is not silently copied as full output.
- Tool inputs/results, error status, live snapshots, subagent records and background jobs remain
  readable. Background REST fields are `toolUseId`, `shellId` and `latestOutput`, with live whole
  snapshots overlaid. Session details include branch/base/worktree state, changed files, diff,
  and related task/project/session routes. Interactive cards remain their feature tasks' work.
- An unexplained failed `turn_end` has a readable, copyable notice at its original sequence.
  Success/completed, absent subtype, authoritative status and already explained outcomes do not
  add that notice. A page starting mid-turn does not infer that an off-page reply was missing.
- Authenticated attachment and same-session legacy artifact images use the existing API. Other
  HTTPS images use a separate client with no auth or redirects. Images are sampled to at most
  1440×2560 within a fixed preview area to avoid late layout shifts; a dialog allows zoom/pan.
  File links use Android's document destination chooser. Images/downloads are bounded to the
  server's 25 MiB upload limit; opt-in full-event responses are bounded to 40 MiB. These bounds
  do not alter default REST/auth requests.

Compatibility observation for A01: web also accepts old `payload.images`; the referenced iOS
reducer uses `attachments` and does not establish that legacy format as a confirmed iOS requirement.
This repair does not expand that format's support or change the S1 deployment baseline.

`text/MarkdownText.kt` and `text/ReaderLinks.kt` are the deliberately small reuse surface for
Wiki and detail pages. They share native text, code, images and link routing, without a general
rendering framework. `ObjectDestination` uses them for descriptive text. `ReaderResources` must
always be constructed from the current auth handle; session artifact links also need its ID.

## Reproducible checks

The original project gate remains `test lintDebug assembleDebug` with Java 21 and
`--max-workers=2`. `scripts/verify.sh` cleans first and collects the exact APK, source identity,
JUnit census and lint results. Build `:app:assembleDebugAndroidTest` for device checks. Unit
regressions cover streaming identity, 20 history pages/caps/gaps, result/parent/record mapping,
GFM parsing, resource scope, saved/offline positions, stale page cancellation, full response
bounds and permission withdrawal/recovery.

`scripts/transcript-fixture.py --manifest NEW_DIR` deterministically hashes untruncated JSONL:
DS3 has 10,000 events with the D09 mix, 20 long Markdown messages, ten 30×8 tables, ten 500-line
code blocks and twenty image references. DS4 has 100,000 events, about 120 MiB encoded JSONL
and a 512 KiB tool output. The loopback server generates requested pages, checks fixture bearer
auth, serves binary images/full payloads/diffs, and can return 403, disconnect, replay duplicates
or send resync. It is a controlled protocol boundary, not a deployed server or real account.

```sh
bash src/android/scripts/reader-device-test.sh 36 \
  src/android/app/build/outputs/apk/debug/app-debug.apk \
  src/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk /absolute/new/evidence
```

The driver accepts API29–36 and an optional existing serial. It holds
`/var/lib/orbit/android/ui.lock` for the complete install/interaction/capture/cleanup, records
APK/device identities, starts only its fixture, restores changed emulator settings, and stops
only an emulator it started. `A06_FONT_SCALE=2.0` and `A06_NIGHT=yes` select large-text/dark runs.
`A06_STREAM_SECONDS=600` runs the extended stream. `A06_TEST` selects one instrumentation case;
the default runs the complete reading class. Use a new evidence directory on every run.

Device cases enter through actual login, directory and MainActivity. They cover partial native
selection/Copy, GFM and images, 500-line output Copy all, around links/Back, twenty DS4 prepends,
ten directory/session switches, recreation, permission withdrawal/recovery, subagents,
background work and worktree diff. Native finger holds advance the Compose test clock while
held. The check clears old clipboard data, clicks the platform's floating Copy action by its
Android framework resource ID, and verifies the newly copied substring.
Selection gestures pause following without consuming the native selection gesture.
Recreation compares window coordinates plus the window's screen origin; Compose's root origin
can change with Android 15 insets even when the message stays at the same screen position.

The instrumentation streaming case samples process PSS once per loop and HWUI `TOTAL_DURATION` via
`Window.OnFrameMetricsAvailableListener`, including dropped callback counts. These are emulator
instrumentation diagnostics, not D09's real-device `frameDurationCpuMs`/`frameOverrunMs` or a
pass against those thresholds. The Compose test clock also controls recomposition; wall-clock
rendering evidence must use the standalone app without that test clock. The final evidence
package includes the standalone native-UI driver, wall-clock samples and raw HWUI diagnostics.
The server emits 20 deltas/sec while connected, duplicates five
records and disconnects after each 1,200 deltas, and sends resync at 6,000. Capture actual wall
duration/count/reconnect gaps; do not relabel this as an exact lossless 12,000-delta transport run.

The fixed external gaps are recorded once in the task: installed same-data iOS, R-min/R-ref/OEM
physical Android phones, approved deployed instance/isolated role accounts, and full TalkBack
traversal/spoken feedback. Synthetic emulator checks do not close those gaps or lower S1/D09.
Use the final task evidence envelope for candidate-specific results, hashes and remaining gaps;
exploratory failures stay in their original artifact directories.

## Revision 1 repair checks

The independent SEND_BACK review of `b0c142296b3dbb328beea043877796afb451ec5c` identified four
reading defects. `*Review*Test` first ran with the unchanged b0 product: 12 checks, seven expected
failures across all four findings. The exact three test files then passed unchanged after repair.
Additional cases cover late page/full/authority responses, cold auth/store restoration, cache
revision writes, unrelated namespaces and partial-turn boundaries. The old evidence archive and
its 600-second stream diagnostic remain intact; this increment does not rerun that sampling.

The fixture's separate `REVIEW` dataset has 420 records; DS3/DS4 are unchanged. It independently
controls ordinary page denial, around/full denial and session detail status. Four instrumentation
methods named `review…` exercise actual login/directory/reader routes, copying the failure notice,
linked-image zoom/task navigation and the exact HTTPS ACTION_VIEW URI (intercepted before launch).
They also check removal of all Copy message controls, offline route reentry/recreation, missing
records and fresh authority recovery. Select these with comma-separated `A06_TEST` method names.
Candidate hashes, raw red/green results and affected device checks live in the incremental repair
package and task comment. This code repair does not resubmit a completion envelope with unchanged
external gaps, pass A05 as a whole, or authorize A07/A08 to start.

Parser reference: [commonmark-java 0.25.1](https://github.com/commonmark/commonmark-java/tree/commonmark-parent-0.25.1).

## A06c: increments since c6792d4bf and the baseline gaps

A01b's list (part 2/6, A06) and the four gaps its part 1/6 named, ported from the iOS sources at 4f695a286.
Each is a projection in `reader/` beside the A06 rows, not a second renderer.

- **Engine stderr and transient errors** (`EngineErrors.kt`, `TranscriptRows.kt` `EngineReading`): a `system`
  event's `notice`, or stderr whose `diagnostic` is recoverable/degraded (A06-1; a persisted codex 401
  `token_invalidated` line is matched by the legacy rule), is a notice row. Other stderr is an error row: ANSI
  stripped, the two known provider-noise lines dropped, repeats folded `×N`, verification continuations joined,
  and an apply_patch/parser failure settles the unresolved call it names. A reply or `error` event that is the
  provider failing becomes an `auto_retry` row (`variant` quota/apiError, `stale`, `afterUserMsg`) or an error
  row, classified by the copy of @orbit/shared `events.ts` that `EngineErrorsParityTest` reads back — Codex's
  exhausted 429 budget is transient (A06-2). The countdown/Retry card itself is A07c's.
- **Sticky "↑ Your question" header** (`StickyQuestions.kt`): the newest question above the item that owns the
  list's top line; card turns are named by their card's words and a background job's news is not a question.
  Both answers go through `StickyQuestionHold` (A06-4). It folds away while a phone's composer is focused.
- **Tail pinning on resize** (`TailPinning.kt`, A06-5): the list's own measure asks `followsResize`.
- **Workflow progress** (`TaskProgress.kt`, `TaskProgressViews.kt`): `task_progress` frames, or the end's
  `progress` (background_task / REST background list), drawn as phases, agent rows and totals on Agent/Workflow
  calls and in Session details' background list; `TaskProgressCopyParityTest` reads the shared golden table.
  Agent rows open to model, error and the Agent call's nested activity (A06-6).
- **Orbit context card** (`AttachedNote.kt`, A06-9) and the bubble split at `controlPlaneNote`.
- **Image file rows** (`text/MarkdownFileRef.kt`, A06-3) for links the session can serve as an image.
- **Worktree bar** (`Worktree*.kt`, `MergeRecovery*.kt`) above the composer: Commit/Merge/Resolve/Retry/Adopt,
  the target caret, merge recovery's row and review, the changed files with diffs, a binary file's current bytes
  (A06-7, `GET sessions/:id/worktree-file`), and a coordinator's integration line (A06-8). Outcomes are said in
  the bar until the app has a toast host (A05-4).

`transcript-fixture.py` mode `A06C` (28 events, worktree detail, merge/commit/resume POSTs, diff, worktree-file,
artifacts and background reads) backs `TranscriptDeviceTest#a06cReaderIncrements`:

```sh
A06_TEST=io.orbitd.android.reader.TranscriptDeviceTest#a06cReaderIncrements bash src/android/scripts/reader-device-test.sh 36 \
  <app-debug.apk> <app-debug-androidTest.apk> <new evidence dir> emulator-5554
```

`WorktreeRealStackDeviceTest` commits and merges a real worktree on the A11 isolated stack (its runner and the
stand-in engine that writes `A11_STACK_NOTES.md`), through `tasks-projects-stack-device-test.sh` with
`A11_TEST=io.orbitd.android.reader.WorktreeRealStackDeviceTest` and the args file from `tasks-projects-stack-args.py`.
