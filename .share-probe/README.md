# TEMPORARY evidence probe — never merged

The iOS session list's rows now offer Share (left swipe, and Share… in the long-press menu), which
opens the session page's share panel, `ShareSheet(kind: .session)`, from a sheet the list holds
(`AgentPanes.sharingSession`). Not in Trash; not on macOS.

This probe builds the iOS app's shared sources into a throwaway app whose only screen is the real
session list — `AgentContentColumn(rowNavigation: .push)` in a navigation stack, as the compact shell
hosts it, minus the drawer — pointed (`-orbit.instance`) at `stub.py`, a fixture API: one workspace,
its Open / Completed / Trash sessions, and a public link for one session. A UI test swipes, long-presses
and taps through it on the newest iPhone simulator and photographs each step; the stub logs every
request, so the run shows which share link each tap asked for.

Fixture titles are made up; nothing here is real data.
