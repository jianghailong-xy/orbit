# TEMPORARY evidence probe — never merged

Task 350Wz6vjlg4mgTMX8AYaq: under a message the server accepted but no runner has taken, while a full runner holds
the session, the foot reads `Queued · runner full · Cancel`; Cancel withdraws the turn (`DELETE
/api/sessions/:id/turns/:turnId`) and puts the words back in the composer. Adapted from the criteria reply line's
probe (`docs/evidence/criteria-reply-session-line/probe-harness`). It builds the iPhone app's own `CompactShell` and
the Mac app's own `MainView` from the tree's shell and shared sources into throwaway apps pointed at `stub.py`, a
fixture API with one session, S1, queued behind HPC's 16 full slots (`queuedReason: runner_at_capacity`), whose last
message `Why is task 6 still queued?` is listed by `GET …/turns?view=active` as the accepted head (no runner echo).
`HeldCancelShotTests` photographs the foot, presses Cancel with the app's own tap, and checks the DELETE the stub
logged and the words back in the composer. All data is made up.
