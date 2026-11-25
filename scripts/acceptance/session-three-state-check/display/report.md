# Cross-client check on the merged tip 38d75a2d22 (2026-11-25)

Criterion 7: "Web, Mac, iPhone and Android agree, for every fixture case, on the state shown and on each mark shown, and the
membership of the Needs you and Working groups is the same as before this project."

**Answer.** It holds for the session list row (state, every mark, group), and for the two display functions on every
payload kind they read. It does **not** hold on the guest surfaces (Apple and Android guest view and Shared with me), and
the search surfaces draw the old seven states on all clients. Those are gaps G1 and G2 below; G3 to G5 are differences
between web surfaces and the board that no client disagrees with another about.

## Client work on the tip

The commits the task names landed rebased with identical patch ids: web c19357b8fe → 0b613ed33b, web test fix 7127773722 →
2ba5b5ce8d, Android 0e787ea088 → 38d75a2d22; Apple 475239dbc5 is an ancestor. All three display files exist.

## What was compared

Reference: `docs/mocks/session-display-three-states/capture/rules.mjs`, Disconnected drawn as Failed (owner, 2026-11-25).

| Check | Result |
|---|---|
| Table 1: 41 cases (18 fixture rows with facts, 23 server-built list rows) × 4 clients, state and 9 marks | all agree with the board ([display-table.md](display-table.md) §1) |
| 18 facts-absent fixture rows: words and run labels | each equals its client's legacy baseline; both functions answer null (§2) |
| Needs you / Working, 59 rows (36 fixture, 23 server) × 3 clients, tip against cf06a12e75 | identical on every row (§3) |
| Recorded groups (`../legacy-baseline.*.json`) | web, Apple, Android 18/18 equal |
| The two functions on 9 payload kinds (server-built) | clients agree on every payload ([surfaces.md](surfaces.md)) |
| Web real-stack walk, 22 cases × 7 surfaces | list row, header and link card match on all 22; 13 differences are the Background mark missing from some payloads (G3), and 1 is the settled landing container, which the session list does not list |
| Previous rig table (send, wait, word, run label) | send and wait columns equal the committed `../table.md`; word and run now say the state and marks; every flagged row is facts-absent and was flagged before ([table-send.md](table-send.md)) |
| `session-payloads-legacy.pg.spec.ts` | 1 pass, 0 skipped; golden file, spec and fixture identical to main |
| Named tests on the tip | web 56, Android 45 (incl. the Compose `SessionRow` draw test), OrbitKit 48, all pass |
| Apple compile | client.yml run 45550520773 on 475239dbc5 (workflow_dispatch): macOS build + test and iOS build green; `src/macos`, `src/ios`, `src/web`, `src/shared` do not differ from the tip |

The generator fails (exit 1) on a planted missing mark, a planted group change and the resulting client disagreement.

`../run-all.sh` now also builds the display table. Two lines of the previous drivers changed to read what the surfaces now
draw: Apple's word is `SessionHeader.headerWord` (it was `statusWord`), web's run label includes the marks beside the badge.

## Differences that are the board's own design

- iPhone and Android list rows draw two marks and "+N" (table 1 shows `+N` on the one three-mark case). Web and Mac rows,
  headers and task panels draw all.
- iPhone and Android conversation headers have no state word. Android has no link card.
- Rows F15, F27, F29: web puts them in Working, Apple and Android do not, as before.
- Row F21 (end never confirmed): with the facts no client puts it in Needs you; the recorded facts-absent row does, on all
  three. The commit before the display change answers the same, so this project did not move it.
- Sessions stored with a status no client knows (F33, F35) cannot be stored in the database, so only the fixture covers them.

## Gaps

**G1. Apple and Android guest surfaces still draw the old words.** `GuestSessionState.word` (OrbitKit `GuestSession.swift`)
and `GuestState.word` (Android `core/guests/GuestLogic.kt`) do not call the two display functions. On the server's own
guest row and shared head, 19 of 23 cases differ from web, and no mark is drawn: web `Idle` + `Finished` / `Failed` /
`Retrying`, native `Finished` / `Failed` / `Failed`; web `Running` for a background job or a sub-agent, native
`Awaiting reply`. Apple and Android agree with each other. The board asks these surfaces to follow the shared header's
rule. (Four cases read the same word, without the marks: queued, running, and the two approval cases.)

**G2. Search draws the old seven states on every client.** `GET /sessions/search` hits carry none of the six facts, so the
web palette (red cross, "Waiting for your reply"), the Apple search row and the Android search row use their legacy
readings, which also differ from each other (web "Finished" / Apple "Succeeded" / Android "SUCCEEDED"; web "Waiting for
slot" / Apple "Queued"). The board says the palette follows the row. The 22 cases with a hit are in surfaces.md.

**G3. The Background mark is missing where the payload does not carry its inputs.** `detail`, `session.created/updated`,
`session.ended` and a task's `sessions[]` send neither `activity` nor `runningBgCount`; the guest row and shared head send
`activity` but not `runningBgCount`. So on web: the task panel's run badge omits Background for a running job, a process
left up, and both mixed cases; the shared page, guest page and Shared with me omit it for a process left up and the mixed
cases. Native task run labels read the same payload and omit it too. Headers and list rows (which read the list row) draw
it. Server payload gap; no client re-derives it.

**G4. Web Tasks list pill.** It reads the task row's `running` / `queued` / `queuedOnHold`, so it says `Running` for runs
whose session is `Idle` with Will resume (watch armed, retry armed), and draws no mark but On hold (an approval's Needs
you is absent). Web only.

**G5. Web list row with three marks** (interrupted, process up, retry armed): at 1440 px the third chip is clipped at the
row's edge and the line text is gone (`row-interrupted-a-process-up-retry-armed.png`). The marks are in the DOM.

## Not run

- No SwiftUI view was drawn: Mac and iPhone columns are OrbitKit's functions on Linux (`swift:6.1`), Mac = all marks,
  iPhone = `phoneRowMarks`, as `AgentSessionRow` calls them. No Mac or iPhone screenshot was taken here.
- No Android device or emulator: Android is JVM tests under Robolectric, without new screenshots. Search rows, task rows
  and the guest page are read from their word functions (search: the line `DirectoryScreen` composes), not drawn.
- Full web, Android, OrbitKit and apiserver suites were not run; this task changes nothing under `src/`.
- Dark theme, and the macOS CI job on the tip itself (the tip's Apple code is that of 475239dbc5).
