# Cross-client check, revision 2: project tip b0e9924cb1 (2026-11-25)

Criterion 7: "Web, Mac, iPhone and Android agree, for every fixture case, on the state shown and on each mark shown, and the
membership of the Needs you and Working groups is the same as before this project."

**Answer.** It now holds on the session list row, the guest view and Shared with me (every state and mark, all four
clients), and on the groups. It still does **not** hold on search (G1, G2) or for the Background mark on three Apple
surfaces (G3). G4 and G5 are narrower.

## Fixes on the tip

web e28fe934ab (and the follow-up c43dbbe301, the Queued clock in the Tasks list pill) and Android 1e40021b32 are
ancestors; Apple 30b8b4251a landed as b2dde67dac and server dd1f34e4a9 as 40030b7fe4, with identical patch ids.

## Results

Reference: `docs/mocks/session-display-three-states/capture/rules.mjs`, Disconnected drawn as Failed. The expected answer
of a case on any surface is its list row's.

| Check | Result |
|---|---|
| Table 1: 41 cases (18 fixture, 23 server-built list rows) × 4 clients, state and 9 marks | all agree with the board ([display-table.md](display-table.md) §1) |
| Shared / guest head and Shared with me, 23 cases × 2 surfaces × 4 clients | all agree, state and every mark (§1b) |
| Search, 22 cases × 4 clients | differs: G1, G2, G3 (§1b) |
| Web real-stack walk: list row, header, task run, link card, shared page, guest page, Shared with me, 22 cases each | all match; the Background mark is now on every one |
| The Background mark on every payload kind (server-built) | every kind carries it: web's reading of each kind equals the list row's ([surfaces.md](surfaces.md)); `session-payloads-phase.pg.spec.ts` 2/2 holds the server to it. Android's reading agrees wherever Android reads the payload. Apple misses it on three kinds (G3) |
| 18 facts-absent fixture rows: words and run labels | each equals its client's legacy baseline (§2) |
| Needs you / Working, 59 rows × 3 clients, tip against cf06a12e75 (before the display change) | identical on every row (§3) |
| Recorded groups (`../legacy-baseline.*.json`) | web, Apple, Android 18/18 equal |
| Previous rig table (send, wait, word, run label) | identical to revision 1's ([table-send.md](table-send.md)) |
| `session-payloads-legacy.pg.spec.ts` | passes, 0 skipped; golden file and spec identical to main |
| Named tests on the tip | web 165 (8 files), Android 107, OrbitKit 105, all pass |
| Apple compile | client.yml run 45559219646 on 30b8b4251a: macOS build + test and iOS build green. The tip's `src/macos` differs from it in `AgentToolsGuide.generated.swift` and `SessionStateContractTests.swift` only |

The generator fails (exit 1) on a planted missing list-row mark and a planted group change, and lists a planted missing
Shared with me mark.

## Gaps

**G1. Android search draws no facts at all (22 of 22 cases).** `SearchHit` (`directory/DirectoryModels.kt`) decodes none
of the six facts, and the row in `DirectoryScreen.kt` writes `agent · lifecycle · runState`: "payloads-agent · OPEN ·
AWAITING_INPUT" where web and Apple say Idle or Running. No marks. The server sends the facts on search hits since F1.

**G2. Web search draws no marks (17 of 22 cases).** The palette row (`SessionSearch.tsx`) draws the new state icon and
word and no `SessionMarkChips`, so a failed, finished or waiting session reads plain "Idle" or "Running". Apple's search
row draws the marks. (The five cases with no marks match.)

**G3. Apple drops the Background mark on three payload kinds**, because the type does not hand `runningBgCount` (or
`activity`) to `SessionDisplay`:
- search (`SessionSearchHit`): 4 cases, a running job included;
- task run label and shared Markdown (`SessionRef.displayFacts`): 3 cases (a process left up, alone or beside an
  approval or a stopped turn);
- live updates: `Session.applying(_:)` (`SessionUpsert.swift`) keeps the held row's `activity` and `runningBgCount`, and
  `ControlSessionSummary` does not decode the count, so a `session.updated` that starts background work shows no
  Background until the list is read again: 4 cases, with the summary folded into a row listed before the work showed.
  Android reads the list again on that event instead. Web's handling of the live event was not exercised.

**G4. Web Tasks list pill** draws no Needs you for a run waiting on an approval, nor its Background beside it (2 of 10
live runs): the task's row carries neither. Every other live run's pill matches, Will resume included. A released run with
a retry armed is not a live run, so its task reads "Open", with no Retrying mark. No other client has this pill.

**G5. Not checked:** the dependency graph node's aria-label (task 353bY2EvEsLWOxWFBFuYH). That task's Queued clock is on
the tip and drawn (`tasks-list.png`).

## Differences that are the board's own design

- iPhone and Android list rows draw two marks and "+N" (table 1 shows `+N` on the three-mark case). The web list row now
  wraps three chips under the line instead of clipping the third.
- iPhone and Android conversation headers have no state word. Android has no link card.
- Rows F15, F27, F29: web puts them in Working, Apple and Android do not, as before.
- Row F21: with the facts no client puts it in Needs you; the recorded facts-absent row does, on all three. The commit
  before the display change answers the same.
- Statuses no client knows (F33, F35) cannot be stored in the database, so only the fixture covers them. The settled
  landing container is in no session list or search, so web has no row for it.

## How the columns were read, and what was not run

- Web: the DOM of the built console on the tip's apiserver and PostgreSQL.
- Mac and iPhone: OrbitKit on Linux (`swift:6.1`), calling what the views call; no SwiftUI view was drawn and no Mac or
  iPhone screenshot taken. Mac = all marks, iPhone list row = `phoneRowMarks`.
- Android: JVM tests (Robolectric in the named draw tests); no device or emulator and no new screenshot. The search line is
  composed in the driver as `DirectoryScreen` composes it.
- Full web, Android, OrbitKit and apiserver suites and dark theme were not run; this task changes nothing under `src/`.
