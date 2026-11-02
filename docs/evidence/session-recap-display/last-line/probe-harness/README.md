# TEMPORARY evidence probe — never merged

The recap card's one ⋯ at the end of its last line (docs/mocks/session-recap-display/07-last-line, the owner's B,
2026-11-02), photographed in the iPhone app's own `CompactShell` and the Mac app's own `MainView`, built from the
tree's shell and shared sources into throwaway apps pointed at `stub.py`: three conversations parked on the agent's
answer, each with a recap (a long one as long as the owner's screenshot, a medium one, an English one).
`RecapShotTests` finds each card by its paragraph's label, checks that the ⋯ sits on the last line at its end,
opens the ⋯'s menu (Refresh recap, Hide recap) and hides the card with it. Adapted from
`docs/evidence/coordinator-delivery-line/probe-harness`. All data is made up.
