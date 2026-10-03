# TEMPORARY evidence probe — a Codex pool on iOS, scheme A (task 34Yk3o3BCSppbBLazj00r)

Lives only on the `-shots` branch; never merged. `ios/run.sh` copies the real view files out of the commit
under test (`gen.py`), builds them into a throwaway iPhone app whose pools are the boards' own
(docs/mocks/account-pool-access/: jianghailong's Codex Pool, shared with Zhang Min and Lin Wei), and lets a
UI test open the page as its owner and as somebody he added, press its own buttons, and photograph every
screen, for side-by-side with `docs/mocks/account-pool-access/01–03`.
