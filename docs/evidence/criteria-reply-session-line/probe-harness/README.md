# TEMPORARY evidence probe — never merged

Task 34pWyIeaPCCHGAznSK97W: the owner's answer to a criteria proposal goes to whichever session filed it. Told to a
task's run, its card says `toCoordinator: false`, and the line must say `Criteria proposal rejected · Sent to this
session · time` and open to `What this session was told`; told to the project's coordinator, it says what it said
before (`Sent to the coordinator`, `What the coordinator was told`). Adapted from the coordinator delivery line's probe
(`docs/evidence/coordinator-delivery-line/probe-harness`). It builds the iPhone app's own `CompactShell` and the Mac
app's own `MainView` from the tree's shell and shared sources into throwaway apps pointed at `stub.py`, a fixture API
with two conversations of one project: R1, a task's run that asked to drop a criterion and was told the owner's REJECT,
and C2, the project's coordinator, told the owner's APPROVE of its own proposal. The turns' words (`messages.json`) were
written by the apiserver's own `criteriaDecisionReplyMessage` (`gen-messages.cjs`). `ReplyLineShotTests` finds each line
by its words, opens it with the app's own tap, checks what both say and photographs them. All data is made up.
