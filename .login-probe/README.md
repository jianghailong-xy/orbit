# TEMPORARY evidence probe — a Codex pool of one's own on iOS (task 34WipmJcFjSy0VyBGrj9p, P3-c)

Lives only on the `-shots` branch; never merged. `ios/run.sh` copies the real view files out of the
commit under test (`gen.py`), builds them into a throwaway iPhone app whose pools are decoded from the
shape GET /providers/pools answers with, and lets a UI test open each screen, walk "Sign in with ChatGPT"
against a stand-in server with real taps, swipe the account out, and photograph every step, for
side-by-side with `docs/mocks/codex-shared-pool/05-phone.png`.
