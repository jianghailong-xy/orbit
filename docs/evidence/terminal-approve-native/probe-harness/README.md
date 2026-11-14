# Approve-terminal card and Settings → Terminals on iPhone (evidence probe)

TEMPORARY evidence probe for task T4 (project "Start an Orbit session by typing `orbit` in a terminal"). It builds the
iPhone app's real shared sources (`src/macos/OrbitApp`, `src/ios/Sources`, OrbitKit) with a probe entry point that
signs in to `stub.py`, and `TerminalShotTests` drives the simulator:

1. Waiting on you with the pending request's card (`ios-1-approve-card.png`), Approve pressed (`ios-2-after-approve.png`);
2. Settings and its Terminals row (`ios-3-settings.png`), Settings → Terminals with two terminals (`ios-4-terminals.png`),
   Revoke's question (`ios-5-revoke-question.png`), the list after Revoke (`ios-6-after-revoke.png`).

The stub logs every request; `writes.txt` holds the approve POST and the revoke DELETE the app sent.
It ran on GitHub's macOS runner from a probe branch whose only workflow runs `run.sh`; the pictures were pushed to
`probe/terminal-approve-shots-results`.
