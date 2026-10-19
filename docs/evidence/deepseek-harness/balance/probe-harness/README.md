# TEMPORARY evidence probe — never merged

The DeepSeek account balance on the iPhone app. Builds the app's own `CompactShell` and Settings sheet
from the real shared sources into a throwaway app pointed at `stub.py`, a fixture API whose DeepSeek
keys answer GET /api/providers/mine/:id/balance in every state: one key behind DeepSeek and DeepSeek
Harness (the same balance on both), too low, rejected, unreachable, two currencies, and one the stub
never answers (loading). Each launch lands on Settings → Providers; `BalanceShotTests` taps each
DeepSeek row, presses Refresh / Retry, and photographs every page in light and dark. A state that does
not render, or a failure page that shows any amount, fails the test. All data is made up.
