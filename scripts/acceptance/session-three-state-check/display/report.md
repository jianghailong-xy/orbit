# Cross-client check, revision 3: project tip 61a13a1aa9 (2026-11-25)

Criterion 7: "Web, Mac, iPhone and Android agree, for every fixture case, on the state shown and on each mark shown, and the
membership of the Needs you and Working groups is the same as before this project."

**Answer.** It holds on every surface this check reads: no disagreement in the state, in any mark or in either group. What
was read rather than drawn, and one web-only surface that shows less, are listed below.

## Fixes on the tip

Android search 4b8b78e8a6 landed as 3b32b91fad and Apple 847a2ae96d as 61a13a1aa9, both with identical patch ids; web
search 57b6a8a438 and the web leftover 0ec4b17951 (Queued clock, dependency node's name) are ancestors.

## Results

Reference: `docs/mocks/session-display-three-states/capture/rules.mjs`, Disconnected drawn as Failed. The expected answer
of a case on any surface is its list row's.

| Check | Result |
|---|---|
| Table 1: 41 cases (18 fixture, 23 server-built list rows) × 4 clients, state and 9 marks | all agree with the board ([display-table.md](display-table.md) §1) |
| Table 1b: search, Shared with me, shared / guest head, task run label, shared Markdown; 23 cases × 4 clients | 114 rows, 0 differences (§1b) |
| Table 1c: a live `session.updated` on Apple, 4 cases with background work | the update adds the Background mark to a row listed without it, and the update that ends the work removes it; state and all marks as the board says (§1c) |
| Web real-stack walk: list row, header, task run, link card, shared page, guest page, Shared with me, search; 22 cases each | all match |
| The two functions on every payload kind, the ending `session.updated` included | clients agree on every one; each kind reads as the list row does ([surfaces.md](surfaces.md)) |
| 18 facts-absent fixture rows: words and run labels | each equals its client's legacy baseline (§2) |
| Needs you / Working, 59 rows × 3 clients, tip against cf06a12e75 (before the display change) | identical on every row (§3) |
| Recorded groups (`../legacy-baseline.*.json`) | web, Apple, Android 18/18 equal |
| Previous rig table (send, wait, word, run label) | identical to revision 2's ([table-send.md](table-send.md)) |
| `session-payloads-legacy.pg.spec.ts` | 1/1, 0 skipped; golden file and spec identical to main |
| `session-payloads-phase.pg.spec.ts` | 2/2, 0 skipped |
| Named tests on the tip | web 214 (9 files), Android 131, OrbitKit 128, all pass |
| Apple compile | client.yml run 45593452792 on 847a2ae96d: macOS build + test and iOS build green; `src/macos` and `src/ios` do not differ from the tip |

The generator fails (exit 1) on a planted missing mark in Android search, a planted missing Background after a live update
and a planted group change.

The walk ran three times on this tip. The first two had one search row and two guest pages not read within the walk's
waits on a loaded host; the waits were lengthened (and the guest page is reread), and the third run has none.

## Not a difference between clients

- **Web Tasks list pill** (no other client has it) draws no Needs you for a run waiting on an approval, nor its Background
  beside it (2 of 10 live runs: the task's row carries neither), and a released run with a retry armed reads the task word
  "Open". The coordinator accepted this in the answer to revision 2.
- iPhone and Android list rows draw two marks and "+N" (table 1 shows `+N` on the three-mark case); the web list row wraps
  three chips under the line.
- iPhone and Android conversation headers have no state word. Android has no link card.
- Rows F15, F27, F29: web puts them in Working, Apple and Android do not, as before.
- Row F21: with the facts no client puts it in Needs you; the recorded facts-absent row does, on all three. The commit
  before the display change answers the same.
- Statuses no client knows (F33, F35) cannot be stored in the database, so only the fixture covers them. The settled
  landing container is in no session list or search, so web has no page for it.

## How the columns were read, and what was not run

- Web: the DOM of the built console on the tip's apiserver and PostgreSQL; the Markdown line from web's `taskMarkdown`.
- Mac and iPhone: OrbitKit on Linux (`swift:6.1`), calling what the views call; no SwiftUI view was drawn and no Mac or
  iPhone screenshot taken. Mac = all marks, iPhone list row = `phoneRowMarks`.
- Android: JVM tests; the list, search and guest rows are drawn by the named Robolectric tests, while this table reads the
  functions they draw from. No device or emulator, no new screenshot.
- A live event on web was not exercised (table 1c's web column is its two functions on the same updates). Android reads the
  Open list again on the event.
- Full web, Android, OrbitKit and apiserver suites and dark theme were not run; this task changes nothing under `src/`.
