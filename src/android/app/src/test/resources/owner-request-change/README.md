# Real apiserver responses for the owner request CHANGE card

Verbatim bodies from a production-build apiserver (`node build/main.js`, as the container starts it) built from server commit
`00cf917347` (migration 1538), against a disposable PostgreSQL 16, read over HTTP with the owner's sign-in. Nothing is edited.

The request was filed through the runner door (`RunnerOwnerRequestsController.file`, what `POST /runner/owner-requests` calls) by a
session of runner `mac-mini` (Max Concurrent 4, three sessions running), asking for 2.

| file | request |
|---|---|
| `owner-requests-pending.json` / `runners-pending.json` | `GET /api/owner-requests?state=open` / `GET /api/runners`, as filed |
| `owner-requests-moved.json` / `runners-moved.json` | the same two reads after the runner's Max Concurrent became 5 |
| `apply-3.json` | `POST /api/owner-requests/:id/apply {"maxConcurrent":3}` (header `x-orbit-client: android/1.0`) |
| `owner-requests-done.json` / `runners-applied.json` | `GET /api/owner-requests?state=all` / `GET /api/runners` afterwards |
