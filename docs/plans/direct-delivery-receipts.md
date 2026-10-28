# Direct delivery receipts

1. Reproduce a MAIN task check that answers ALREADY_LANDED but leaves no receipt, and a directly pushed commit whose temporary source ref was never published.
2. Bind checks to the runner-reported commit of settled task work; verify containment against a freshly fetched target before requiring the source ref. Never accept an empty source or a local-only target as delivery.
3. Settle verified TASK_BRANCH checks with the same atomic receipt and promotion transition as landings. Keep work-settlement and source-identity guards, repeated-report fencing, conflict gates, and item resolution.
4. Run real Git and isolated PostgreSQL regressions, build relevant packages, review the diff, and submit a fork PR to upstream main. Document safe historical recovery without database edits.

Progress: real-Git reproduction and final runner regressions passed. Direct-delivery PostgreSQL regression (10 tests), claim-race regression (3 tests), and focused unit tests (67 tests) passed with no skips. Related promotion, source-selection, and dependent-delivery PostgreSQL suites passed. Documentation checks passed. Final API build/full-suite results and PR publication are being collected.
