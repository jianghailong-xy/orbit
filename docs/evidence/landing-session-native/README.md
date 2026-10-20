# Landing session — native evidence (iOS simulator + macOS)

What the iOS and macOS clients draw for the landing session page and its entrances, against the
owner-approved boards `docs/mocks/landing-session/v4/` (04, 05, 06), and the OrbitKit tests that hold
the words and the door conditions on Linux.

## The page and the entrances

- **05 — the landing session page.** The page is the console frame's own (`.console(sessionID:)`, as
  required by 方案 A's routing statement): once the session read says `sessionKind == "LANDING"`,
  `ConsoleView` draws `LandingSessionPageView` instead of a transcript and never creates a console
  model. That keeps every push and every `/sessions/<id>` link working unchanged.
  - header: the server row's title (or `Land project/<id> → main · #n` before the row exists), the
    `Landing` chip, the ⋯ menu, and `Run by Orbit · runner <name>` (or `· settled 9:51`).
  - status card: `ProjectLandingHead` with the newest attempt's word/right slot, then §7.2 V6's
    rows — the step clock against its budget, the liveness clause, the claim and round, the usual
    duration — and, once settled, the outcome card (`Merged into main`, the tasks now on main, the
    passed check and the landed tree).
  - timeline: the server's own sentences, section per attempt, the check output behind `Log ›`
    (paged by the cursor), the running check's tail, and the grey `No report from … since …` band.
  - footer: the read-only sentence and the one way out (`Open coordinator ›` / `Review Card ›`).
  - the ⋯ menu is the web's: ways to look (Open Task, Open Source Session, Open Coordinator, Review
    Card), then the doors the view's facts open (Stop Landing / Cancel Merge before the push,
    Abandon and the server's Retry / Re-run the check once the lease expired). No Copy Link.
  - Reduce Motion stops the head's ring and nothing else: `LandingRing` reads
    `accessibilityReduceMotion`, and the page adds no motion of its own.
  - a read this device cannot make freezes the card at `Update unavailable` and opens no door; the
    last `inFlight` snapshot the app held draws the page when nothing else can be read.
- **04 — the entrances.** A one-job Landing card carries `Open landing ›` at its foot (beside
  Retry); a several-job card carries one per task row and none on the merge job's row; the jobs
  list carries one per row; the merge round's whole row opens this round's landing (or the jobs list
  when the server names none), `+N job queued · All jobs ›` when the round stands for several; the
  CONFIRMED card's foot and the receipt's foot carry one; BLOCKED adds none. A server that names no
  landing session says `No landing page on this server yet` in grey. The Work overview now draws a
  merge job too, as web and Android do.
- **06 — the task page, the transcript and the list.** The task page's Landing section prints the
  web `LandTaskStatus` words (badge, `generation N`, `stopped while …`, the reason, the six facts)
  and `Open landing ›`; it rereads every 4 s while the landing RUNS and 15 s while QUEUED. A source
  conversation's bottom carries the derived `Landing · checking ›` / `On project/<id> ✓ ›` label.
  The delivery card's third link is `Open the landing ↗`. The owner card (X-E5) is headed
  `Now yours — no report from the runner for <N>m` and leads with the server's ABANDON.

## Tests (Linux, `swift:6.1` in Docker)

- `LandingSessionDecodingTests` — `sessionKind` + the landing view, the list row's summary under the
  same key, the log page, the task read port's `integration`, the promotion's landing session and
  cancel facts, the open item's landing job/lease, and the delivery card's landing session; each
  with a server that predates the field.
- `LandingSessionPageTests` — the status card's five livenesses and three job kinds, the read-failure
  freeze, J12's push verdict, the owner gates past the push boundary and after the lease expires,
  the ⋯ menu's rows, the settled outcome, the footer, the header, the 4 s / 15 s cadence, and the
  offline placeholder.
- `SessionProjectLandingsTests` + `LandingOpenItemDoorTests` — the Landings group's waiting /
  settled / folded rows and holder lines, the source label, the X-E5 heading and lead door, J12's
  ABANDON consequence, and the doors' address conditions.
- `LandingEntranceTests` — which job rows carry an entry, the round's landing session id (candidate
  first, the merge job second, nothing on a blocked round), the receipt's, and the Work overview's
  merge-job card.
- `LandingCopyParityTests` — every literal the page, the group, the entrances, the owner card and the
  task section add, looked up in `src/web/src/lib/landingSession.ts`, `sessionProjects.ts`,
  `ProjectPanoramaHeader.tsx`, `ProjectProgressStatus.tsx`, `LandTaskStatus.tsx` and
  `OpenItemDeliveryCard.tsx`.
- `LandingViewsWiringTests` — the SwiftUI connections: the console's renderer choice, the page's
  parts, each entrance, the task section and its poll, the source chip, `includeLanding=1` and the
  inFlight cache.

## Screenshots

`probe-harness/` is the evidence probe (never merged): the real iPhone `CompactShell` and the real
Mac `MainView` over `stub.py`, driven by `ProbeCase`. `probe-harness/ci/client.probe.yml` is the
workflow that ran on `probe/landing-session-native`; its pictures land in
`probe/landing-session-native-results` and are copied into `ios/` and `mac/` beside this file.

| picture | board |
|---|---|
| `ios/ios-05-a-live.png` | 05 a — a merge check running, LIVE |
| `ios/ios-05-c-merged.png` | 05 c — the round merged |
| `ios/ios-05-e-timeout-menu.png` | 05 e/f — a timed-out check, ⋯ menu open (Abandon / Re-run) |
| `ios/ios-04-c1-landings-group.png` | 04 c1 — the Landings group, waiting + folded |
| `ios/ios-06-task-landing.png` | 06 — the task page's Landing section |
| `ios/ios-06-source-label.png` | 06 e — the source session's derived label |
| `ios/ios-06-xe5-card.png` | 06 c — the X-E5 owner card: its heading and lead Abandon |
| `mac/mac-05-a-live.png` | 05 a on the Mac |
| `mac/mac-04-work-overview-merge-job.png` | 04 — the Work overview drawing a merge job |

## What is not covered here

- The X-E5 owner card and the delivery card are exercised by the OrbitKit tests above but not
  photographed: the probe's coordinator conversation would need the whole owner-item delivery
  projection to render the card.
- The Android client's screenshots belong to the Android tasks that depend on this one.
