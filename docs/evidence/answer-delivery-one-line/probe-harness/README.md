# TEMPORARY evidence probe — never merged

Task 34dQVoIQtWgVP0Ol03o3x: the owner's answer handed to the coordinator is drawn as one line,
"Sent to the coordinator · HH:mm", that opens to the words the agent read — not as the owner's own bubble
(`docs/mocks/coordinator-question-answered/`, step 4). Copied from probe/coordinator-question-answered:
builds the iPhone app's own `CompactShell` from the real shell and shared sources into a throwaway app
pointed at `stub.py`, a fixture API with three coordinator conversations — an answered question and the
turn that told the coordinator, the owner's Not yet… to a done request, and an answer still on the queue.
`LineShotTests` opens each, finds the line by its words, opens it with the app's own tap, and photographs
the conversation and the sheet. All data is made up.
