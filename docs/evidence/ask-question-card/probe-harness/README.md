# TEMPORARY evidence probe — never merged

An agent's answered question (AskUserQuestion) in the conversation, before and after the card became
the record of the question (iPhone + Mac). Builds the iPhone app's `CompactShell` and the Mac app's
`MainView` from the real shared sources into throwaway apps pointed at `stub.py`: one workspace and
five idle conversations, each ending on an answered question — one question (the 10:14 screenshot's,
word for word), two questions, words typed instead of an option, a multi-select question, and a reply
given with Chat about this. `QuestionCardShotTests` photographs each card as the conversation opens,
with its row near the top, and after a tap on the row.

To run it: copy this directory to `.aqc-probe/` at the repo root and `client.probe.yml` to
`.github/workflows/client.yml` on a `probe/ask-question-card` branch, and push; the report job pushes
the pictures, notes and logs to `probe/ask-question-card-results`. It runs the same tests on the tree
before the change (`BASE_SHA`) and on the pushed commit's parent. Nothing here is a real runner or
model. The board built from it is in `docs/mocks/ask-question-card-ios/`.
