# TEMPORARY evidence probe — never merged as an app

Task 34se1Wpwmw3db4PGWDHLa (C11): the wiki chat in the iPhone and Mac apps (docs/wiki-chat-design.md §9, board
`docs/mocks/wiki/42-wiki-chat` ⑤). Adapted from the wiki-diagram probe (`docs/evidence/wiki-diagram-apple/probe-harness`).
It builds the iPhone app's own `CompactShell` and the Mac app's own `MainView` from the tree's shell and shared sources
into throwaway apps pointed at `stub.py`, each launch opening the Wiki section on the document of board 42 ⑤ at its
section 3 (`ProbeArgs.land`).

`stub.py` serves one space and the shared fixture's document `session-runtime` (3.1) with board 42 ⑤'s own section 3
("turn 投递与 inbox 领取", the heartbeat sentences), every sentence with an id; and, by stage (`POST /__set`):

| stage | what the reads say | what `WikiChatShotTests` photographs and checks |
|---|---|---|
| `ask` | no chat; a new one runs in the remembered `orbit-develop · HPC` | the button at rest (`Chat`); a long press (a Mac's right click) on the paragraph offers Ask; the Ask sheet over its sentences; one tapped; the half sheet with the page chip `3.1 §3` and the quote `1 sentence · 2 sources`; a drag on the page behind the half sheet scrolls it |
| `card` | the chat `Runner 离线判定的原因` ends on `wiki_propose`'s answer naming card D1, a fresh draft | the button's amber `1 needs you`; the chat at full height ending on the card — Apply full width on top, Edit and Discard sharing the row under it |
| `updated` | D1 applied; its rewrite of 3.1 §3 came out, one sentence added | folded away: the button's check (`Wiki updated`), the floating `Wiki updated · 3.1 §3  See changes`, `Updated` beside §3, the new sentence; See changes |
| `working` | the chat has a turn running | the button's ring (`Working…`) |

On a Mac the panel is the third column beside the page (the inspector). Every write is answered 409: the probe
presses nothing. All data is made up.

Run on a Mac with Xcode and XcodeGen: `bash run.sh` (`PASSES=ios` or `PASSES=mac` for one). On GitHub, the probe branch
carries this directory as `.c11-probe/` and `client.probe.yml` as its `.github/workflows/client.yml`.
