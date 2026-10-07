# The batch-create review, on the iPhone simulator

Pictures of the review approved in `docs/mocks/batch-create-review-ios`, as built from commit
`96c9a964d` by GitHub Actions run 37574938744 (Xcode 26.3, iPhone 17 Pro simulator, iOS 26). Every job of
that run passed: the font-token and navigation gates, macOS (OrbitKit `swift test` and the OrbitApp
build) and the iOS app build (`RESULTS.txt`).

- `real3-*`: the three independent tasks of the owner's screenshot, with their real titles,
  acceptance criteria and descriptions. `real3-1-review` is the sheet as it opens, and
  `real3-3-task-page` is the first task's page, opened by a tap on its row.
- `diamond-*`: made-up data. Task 1 waits on an existing task, 2 and 3 wait on 1, and 4 waits on 2
  and 3. The review lists them by level, and `diamond-3-task-page` is task 4's page with its
  "Waits on" section.
- `-task-page-scrolled` pictures are the task pages after one swipe up. Both reviews fit on one
  screen, so their swipe moved nothing and those pictures were dropped.

`probe-harness/` is what ran. It is kept here rather than built by this repository. The probe branch
carried `client.yml` as `.github/workflows/client.yml` and the rest under `.batch-probe/`. Its app
composes the review exactly as `ToolApprovalCard` does inside `ApprovalReviewSheet`: the grouped
`ApprovalReviewLayout`, `BatchCreateReviewBody`, the two actions and `ApprovalReviewCloseButton`. It
feeds the card the same JSON shape the runner sends (`tasks` plus the server's `preview`). The
probe branches were deleted after the run.
