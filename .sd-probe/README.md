# TEMPORARY evidence probe — never merged

Task 353SkITm4HyfRI5bDGMlh (project 353SgnUjvamRr06Sho0EZ): the approved board's fixture rows
(docs/mocks/session-display-three-states) in the iPhone app's own `CompactShell` and the Mac app's own `MainView`,
built from the tree's shell and shared sources into throwaway apps pointed at `stub.py`. The stub serves the board's 18
cases (the comparison rig's fixture payloads, with the board's titles and times); `POST /__set {"facts": false}` serves
each case's facts-absent twin (an older server). `DisplayShotTests` photographs the session list (four screens) both
ways, notes every row's label and value, and on the Mac opens the interrupted session for the status-bar header.
Adapted from docs/evidence/criteria-reply-session-line/probe-harness. Run on a Mac from the repository root:
`bash .sd-probe/run.sh` (needs xcodegen, Xcode, an iPhone 17 Pro simulator). All data is made up.
