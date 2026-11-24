Server-shaped bodies for the owner request kind CHANGE, captured verbatim (secrets omitted) from a real
apiserver built from origin/project/34x9XC3FVT1DO5WNDoO2u at 26f032395c22c59d1c1b38bde18460a390528e88
(migration 1538_owner_request_change), run against a throwaway Postgres, on 2026-11-24. URLs carry the `/api` prefix.

1. POST /api/runner/owner-requests  {kind:CHANGE, change:{runnerId, maxConcurrent:4}}  -> 1-filed-response.json
2. GET  /api/owner-requests?state=open (PENDING; runner maxConcurrent 6)               -> 2-open-pending.json
3. GET  /api/runners (the HPC row, maxConcurrent 6, activeSessions 1)                   -> 3-runners.json
4. PATCH /api/runners/:id {maxConcurrent:5}                                              -> 4-runner-patch-request.json, 4-runner-patched-response.json
   (GET /api/owner-requests?state=open then answers the same body as step 2: changeSpec.before stays 6.)
5. POST /api/owner-requests/:id/apply {maxConcurrent:3} (requested 4, owner chose 3)    -> 6-apply-request.json, 6-applied-response.json
6. GET  /api/owner-requests (the request DONE, answer {applied:3, actualBefore:5})      -> 7-list-done.json

Read by OwnerRequestChangeTests (Tests/OrbitKitTests).
