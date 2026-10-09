# TEMPORARY evidence probe — never merged

Task 34ceRLXU8u4QA1DrQF74A: a coordinator's question that has ended keeps what it asked
(`docs/mocks/coordinator-question-answered/`). Builds the iPhone app's own `CompactShell` from the real
shell and shared sources into a throwaway app pointed at `stub.py`, a fixture API whose seven coordinator
conversations carry the endings the board draws: two answers with the recommended option, an option with
a note, the Other row, a question with no options answered yesterday, an answer no coordinator has had,
a withdrawn question, and one still open that the test answers with the app's own Send answer.
`AnsweredShotTests` opens each conversation, photographs the record cards and their View details sheets,
and relaunches once to show the records come back from the server. All data is made up.
