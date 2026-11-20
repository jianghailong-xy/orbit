# macOS Scheduled page: an EVERY schedule's planned end

`scheduled-mac-every.png` — the Mac app's Scheduled section, drawn by the real
`ScheduledMacPage` and `ScheduledMacDetail` views, against the repository's own probe stub
(`docs/evidence/source-refused-native/probe-harness/stub.py`, extended with
`GET /api/schedules` and `GET /api/schedules/E1`; no real server was reached). The fixture is
one ACTIVE schedule with rule `EVERY 30 min 09:00–18:00 Mon–Fri`, `endAt` five days out,
`maxRuns: 20`, `runsLeft: 7`.

- Row line: `Every 30 min, 09:00–18:00, Mon–Fri · orbit · Check only · until Nov 25 · 7 runs left`
- Inspector: `Ends · until Nov 25 · 7 runs left`

Taken 2026-11-20 on the Mac mini (OrbitKit `swift test` green; OrbitApp `swift build` complete).
The probe's copy of `MainView.swift` widens the Scheduled content column to 760 pt: the shipped
400 pt column truncates the row line before the planned end.
