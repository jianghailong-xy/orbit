# A session with more mode changes than its detail carries

What a real apiserver on PostgreSQL answered, unedited (pretty-printed), for `PermissionModePagingWireTests`. Made by
`scripts/permission-mode-actual-stack/capture-paging.mjs`; how, and what each file is, is in the README beside Android's copy
of the same files (`src/android/core/src/test/resources/wire/permission-mode/README.md`, "paging/").

- `session-paging.json`: `GET /api/sessions/:id`, the newest 50 changes and `permissionModeChangesHasMore: true`.
- `session-paging-page-1.json`: `GET /api/sessions/:id/permission-mode-changes?before=<the detail's oldest seq>`.
- `session-paging-page-2.json`: the same `?before=<page 1's oldest seq>`, through to `hasMore: false`.
