# TEMPORARY evidence probe — never merged

Task 34nGWN2Poh34ku8ad93Ud: on iOS, the turn that hands the owner's answer to the coordinator is the question's
own Answered card, grey once answered (docs/mocks/owner-answer-sent-card/merged.html and tone.html; the web as
built is in docs/mocks/owner-answer-sent-card/built/). Copied from probe/answer-delivery-one-line: it builds the
iPhone app's own `CompactShell` from the real shell and shared sources into a throwaway app pointed at
`stub.py`, a fixture API with five coordinator conversations — the coordinator idle (one card), busy (the
answer queued), a Not yet… to a done request (the line), a question the read does not carry (the line), and
a delivery that went unconfirmed. `CardShotTests` opens each, finds the card or the line by its own words,
opens View details with the app's own tap, opens the fold of what the coordinator was told, and photographs
it all. The sample question, its options and times are the board's. All data is made up.
