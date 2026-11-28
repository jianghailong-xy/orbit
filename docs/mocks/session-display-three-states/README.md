# Board: a session shows three states, and every other fact as its own mark

Project 353SgnUjvamRr06Sho0EZ, task 353SkINXFNNI5hCtCBHKl. Design only: nothing under `src/` changes here.

Pictures (one per client, each with every surface that draws a session's state, before and after, on the
comparison rig's fixture rows):

| Client | Picture | Before is read from |
|---|---|---|
| Web | [web.png](web.png) | the web's own functions, run on every fixture row (`capture/web-rows.sh` → `capture/web-rows.json`) |
| Mac | [mac.png](mac.png) | OrbitKit and OrbitApp source at main 9f94177875, read row by row (`capture/native_reading.py` → `capture/native-before.json`) |
| iPhone | [iphone.png](iphone.png) | same as Mac (OrbitKit is shared) |
| Android | [android.png](android.png) | Android source at main 9f94177875, read row by row (same script) |

The native before is a reading of the source, not a run: no Swift or Kotlin was executed for this board. The web before
was executed. Regenerate: `capture/web-rows.sh` (needs node_modules), `python3 capture/native_reading.py`, then
`node capture/board.mjs all`.

The after column of every picture comes from one file, [`capture/rules.mjs`](capture/rules.mjs): one function for the
state, one for the marks. Each client task implements those two functions in its own language and every surface calls
them.

## Fixture

[`fixture.json`](fixture.json) is the 36-row table of the previous project's comparison rig
(`scripts/acceptance/session-three-state-check/fixture.json` at commit 7e6ceb4848, which no branch keeps): 18 cases,
each once with the six facts and once without them (an older server). One field was added: row 27 ("parked, engine
started its own turn") carries `engineTurnActive: true`, which the server's list row sends for that case
(`sessions.service.ts:4741`) and the rig had left out. The pictures draw the 18 cases with facts; the rows without
facts are drawn by today's code, unchanged, and each picture says so in its "Older server" strip.

## The rule

**State: `phase` alone.** Exactly three, on every surface:

| `phase` | Word | Icon | Colour |
|---|---|---|---|
| `PENDING` | Queued | clock | grey |
| `RUNNING` | Running | spinner (turning) | blue on web and Mac; muted on iPhone and Android, as today |
| `IDLE` | Idle | speech bubble (*amended 2026-11-28 by the owner: the empty circle read as an unticked checkbox; see [session-idle-icon](../session-idle-icon/board.png)*) | grey |

**Marks: one per fact,** drawn after the state word in this order. A mark never replaces the state icon.

| Mark | Read from (the server's fact; nothing re-derived) | Colour |
|---|---|---|
| Needs you | `waitingOn` PERSON (`pendingApprovals` > 0) | amber |
| Failed | released, `lastTurnOutcome` FAILED, no `endReason` (decision D9's reading) | red |
| Retrying | the same failure with `waitingOn` WAKE (a retry is armed) | grey |
| Disconnected | the same failure whose error says the runner went offline (today's split, kept) | grey |
| On hold | `waitingOn` HOLD | grey |
| Interrupted | held, `phase` IDLE, `lastTurnOutcome` INTERRUPTED | grey |
| Background | `activity` BACKGROUND_JOB, or background processes left up | grey |
| Will resume | held, `waitingOn` WAKE (a watch or a scheduled wake-up) | grey |
| Finished | `workFinished` | green |
| Ended | released, not finished, not a failure | grey |

What words the row's second line says (the tool in flight, "Waiting for approval", "Runner is updating", the recap) does
not change: that line is content, not state.

**Older server.** A payload without `phase` and `released` draws exactly what it draws today, on every surface. The
rows without facts in the fixture are that case.

## The four questions

**1. What is an ended session's icon?** The Idle icon, the grey speech bubble: released is not an activity, and a
released session is always `phase` IDLE. Beside it, the grey **Ended** mark (or green **Finished** when the work
finished, or red **Failed** when the release was a failure). Today it is a grey check, which reads as success.

**2. How does a failure stay noticeable in the list without being a state?** By the red **Failed** mark, the only red
thing left on a session row, and by its place: a failure nobody is retrying sits in the **Needs you** group at the top
of the list, as today. The state icon of a failed session is the grey Idle speech bubble; the red has moved from the icon to
the mark. A failure the server is retrying wears the grey **Retrying** mark and stays in **Working**, as today.

**3. Do the Needs you and Working groups keep their membership?** Yes, on every fixture row and every client. The
group functions do not change (web `sessionNeedsOwner` / `sessionIsWorking` in `lib/sessionGrouping.ts`, Apple
`SessionTimeGrouping`, Android `DirectoryModels` buckets) and read the same facts as before. Each picture has a "Group"
column with the group before and after per row; they are equal on all 18 cases. After the change:
- **Needs you** = a **Needs you** mark, or a red **Failed** mark (a failure no retry is armed for). True on every client.
- **Working** on web = state **Queued** or **Running**, or a **Retrying** mark. Mac, iPhone and Android read Working
  from the legacy run status, so rows 15 (a background job), 27 (the engine's own turn) and 29 (a sub-agent) draw
  Running but stay outside Working there, exactly as today, while web puts them in Working. That difference predates
  this project; the board keeps it because membership must not change. Aligning it is a separate decision.
Membership is not re-derived from the marks; the marks only make visible why a row is where it is.

**4. What is colour left to mean?** Four meanings, each on one thing:
- **blue**: running. The Running spinner is the only coloured state icon on web and Mac; the phones keep their muted
  spinner (the row's value says it), as today.
- **amber**: the person has to act (the Needs you mark, and the row line that says what is asked).
- **red**: a failure nobody is retrying (the Failed mark).
- **green**: the work finished (the Finished mark).
Everything else is grey: Queued, Idle, Ended, Interrupted, On hold, Background, Will resume, Retrying, Disconnected.
A grey row is one nobody has to look at.

## Decisions on the board

- **Completed** (the lifecycle, where a session is filed) is not a state. Today it replaces the state word in web's
  shared and guest headers (`sessionStateWord`), Apple's guest view (`GuestSession.swift:97`) and Apple's project
  coordinator pill (`ProjectPage.swift:1065`); the Mac header already keeps it apart ("Ended · Completed · 3m ago",
  `SessionHeader.swift:168`). After: everywhere as the Mac does it, the state word first, then Completed as the filing
  word after it (an outlined tag where there is no sentence). Lists show Completed as its own view, so rows draw nothing.
- **Starting** (the engine has not spoken yet) is Running: the header word is Running, the row's second line keeps
  "Starting…".
- **Waiting for your reply / Awaiting reply / Waiting for owner** go: a parked conversation that asked for nothing is
  Idle with no mark (the server's `waitingOn` null).
- **A sub-agent or the engine's own turn** is Running with no mark: the session itself is working. Only a background
  job or a process left up gets the Background mark.
- **Dimming released rows** (the owner's first sketch) is not taken: Ended and Finished already say it, and dimming
  would also grey out good news (Finished).
- **Phone rows** keep the state icon in today's slot (first line, before the time: iOS `SessionLiveIndicator`, Android
  `SessionLiveMark`). Today that slot draws nothing for Idle, finished, ended or interrupted rows; after, it always draws
  one of the three icons. The marks go to the right end of the second line, as on web and Mac. Phone rows draw at most two marks, in the order above, with "+N" for the rest; the header and the task panel
  draw all of them. In the fixture no case has more than one mark.
- **Tasks list pill** keeps the task's own lifecycle words (Open, In progress, Done, Failed, Cancelled) and, for a task
  with a live run, the run's state word (Queued or Running) with the run's marks beside it; "On hold" becomes a mark
  beside "Queued" instead of a third pill word.
- **Shared Markdown** writes the state word and the marks separated by " · ", e.g. `- Idle · Finished · Nov 24 ·
  orbit-ws01`.

## Surfaces per client

Drawn per fixture row in the pictures:
- **Web**: session list row, session header (`statusLabel`), task panel run badge (`sessionStatusMeta`), Now card and
  Tasks list pill (strip under the table), link card (`orbitLinkStateWord`), shared and guest page header
  (`sessionStateWord`), task Markdown Runs line. The search palette (`SessionSearch.tsx`) uses the row's icon and
  header word and follows them.
- **Mac**: sidebar row (`StatusGlyphView` + `SessionLine`, the orange approval count capsule unchanged), header word in
  the status bar (`SessionHeader.headerWord`), task run label (`SessionRef.resolvedRunState`), session link card
  (`OrbitLinkCard.statusWord`), shared Markdown (`ShareMarkdown.runLabel`).
- **iPhone**: list row (`SessionLiveIndicator`), row VoiceOver value (`statusWord`), conversation header (no state word
  today: the centre is a capsule; none after), task run label, link card, shared Markdown.
- **Android**: list row (`SessionLiveMark`), row TalkBack value (`statusWord`), conversation header (no state word, as
  iOS), task run label (`TaskLogic`), copied task Markdown. Android has no link card.

Not drawn per row, and how they follow:
- **Workspace rail / Mac menu bar / drawer counts** (Apple `WorkspaceNavigationStatusLogic`, Android `DrawerChrome`,
  `DirectoryScreen`): they count Needs you and show a spinner when any session runs. Counts are the group rules
  (unchanged); the spinner is the Running state icon.
- **Project coordinator pill** (web `ProjectCoordinatorCard`, Apple `ProjectPage.swift:1055-1065`, Android
  `ProjectPage.kt:510-517`): "Needs you" / "Working" are group words and stay; "Completed" there moves after the state
  word as above.
- **Apple guest view** (`GuestSession.swift:97`): the shared header's rule.

## Found while drawing (not changed here)

- Rows 15, 27, 29: web puts them in Working, Apple and Android do not (their Working reads the legacy status).
- Apple's session link card reads only the legacy fields (`LinkPreviews.swift:117-120`): it says "Succeeded" and
  "Waiting for your reply" where every other Apple surface reads the facts.
- Rows 10, 24 (older server, SUCCEEDED): Apple and Android say "Succeeded" in the list and "Finished" as a task run.
- Rows 34, 36 (older server, unknown status): Android's task run label is "—", Apple's "Ended".
