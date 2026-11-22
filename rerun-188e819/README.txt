Re-run on commit 188e819c2ff25fde9ab5cb5bbb21767cfcd141a4
("test(apple): the timeline's wiring test reads the inline-output rule by its new name")
origin/probe/task-exempt-apple-188e819c2f, 2026-11-22.

exempt2-focused.log  swift test --filter for the landing/exempt classes: 69 tests, 0 failures
                     (LandingViewsWiringTests 15/0; the red from 8724c53 is gone).
exempt2-full.log     full swift test: 5877 tests, 5 skipped, 13 failures — the same two
                     pre-existing tests (BgJobCardTests.testTheBackgroundListCountsAFailedJobRedAndGoesToTheCard,
                     SessionProjectCopyParityTests.testEveryWebWordIsHeldHereOrNamed), 12 + 1 assertion failures.
