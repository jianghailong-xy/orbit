# TEMPORARY evidence probe — shared pool page on iOS (task 34W9lSlgG1hhRqntpUlla)

Lives only on the `-shots` branch; never merged. `ios/run.sh` copies the real view files out of the
commit under test (`gen.py`), builds them into a throwaway iPhone app with fixture pools, and lets a UI
test open, scroll, swipe and photograph each screen for side-by-side with
`docs/mocks/codex-shared-pool/05-phone.png`.
