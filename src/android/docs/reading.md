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

Authoritative 403/404 removes the transcript, details, links and cached reading content. SSE
cannot repopulate denied state; successful authority recovery loads a fresh tail. Network/5xx
failures keep explicitly stale reading content. Session mutations still require both fresh
session and directory state and the captured auth handle. No auth rotation logic was changed.

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
  substituting the latest messages. Cached content can be read offline without fresh authority.
- CommonMark/GFM uses the pinned `commonmark-java` 0.25.1 parser and tables, strikethrough,
  task-list and autolink extensions. Native Compose text supports selection, headings, lists,
  quotes, inline emphasis/code and links. HTML is literal text. Tables scroll horizontally.
- Code/diff/output previews collapse after 24 lines or 4,000 characters. Full output uses lazy
  32-line chunks, horizontal scrolling and Copy all. Tool payloads marked truncated are fetched
  from the existing full-event endpoint when expanded. Text/thinking drafts stay separate from
  durable rows; completed Markdown blocks remain parsed while the unfinished suffix streams.
- Tool inputs/results, error status, live snapshots, subagent records and background jobs remain
  readable. Background REST fields are `toolUseId`, `shellId` and `latestOutput`, with live whole
  snapshots overlaid. Session details include branch/base/worktree state, changed files, diff,
  and related task/project/session routes. Interactive cards remain their feature tasks' work.
- Authenticated attachment and same-session legacy artifact images use the existing API. Other
  HTTPS images use a separate client with no auth or redirects. Images are sampled to at most
  1440×2560 within a fixed preview area to avoid late layout shifts; a dialog allows zoom/pan.
  File links use Android's document destination chooser. Images/downloads are bounded to the
  server's 25 MiB upload limit; opt-in full-event responses are bounded to 40 MiB. These bounds
  do not alter default REST/auth requests.

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
held; separate wall-clock manual evidence is needed for the floating system Copy toolbar.
Selection gestures pause following without consuming the native selection gesture.

The streaming case samples process PSS once per loop and HWUI `TOTAL_DURATION` via
`Window.OnFrameMetricsAvailableListener`, including dropped callback counts. These are emulator
instrumentation diagnostics, not D09's real-device `frameDurationCpuMs`/`frameOverrunMs` or a
pass against those thresholds. The server emits 20 deltas/sec while connected, duplicates five
records and disconnects after each 1,200 deltas, and sends resync at 6,000. Capture actual wall
duration/count/reconnect gaps; do not relabel this as an exact lossless 12,000-delta transport run.

The fixed external gaps are recorded once in the task: installed same-data iOS, R-min/R-ref/OEM
physical Android phones, approved deployed instance/isolated role accounts, and full TalkBack
traversal/spoken feedback. Synthetic emulator checks do not close those gaps or lower S1/D09.
Use the final task evidence envelope for candidate-specific results, hashes and remaining gaps;
exploratory failures stay in their original artifact directories.

Parser reference: [commonmark-java 0.25.1](https://github.com/commonmark/commonmark-java/tree/commonmark-parent-0.25.1).
