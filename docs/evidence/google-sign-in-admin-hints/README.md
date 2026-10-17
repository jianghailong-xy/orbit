# The admin area's two Google sign-in hints, on an isolated stack

A walk through the two admin-area hints task `34bfJcxctbgThKlyWePPi` adds, on an isolated stack with an empty
database, on 2026-10-07. The stack was built from `c2c9303de` (the task's code commit; the kit beside this
README was the one uncommitted path at build time). PostgreSQL 16 ran on 127.0.0.1:5686, the apiserver
(`node dist/main.js`) on 3386 with `PUBLIC_ORIGIN=http://localhost:2386`, and a loopback gateway
(`kit/gateway.mjs`) served the web build and forwarded `/api`, as `gateway/nginx.conf` does. No runner was
needed. Headless Chromium (Playwright 1.63) drove the real UI through `kit/drive.mjs`;
`walkthrough-output.txt` is its output, one JSON line per step.

The Google client entered is a placeholder, not a Google credential: nothing here signs in with Google. What
is under test is what the admin area says about the saved client secret, with a key that can read it and with
one that cannot, and what **Add user** says about the address a **Google sign-in only** account is created for.

| # | What happened | Picture |
| --- | --- | --- |
| 1 | Fresh deployment: the first visit went to `/setup`, where the administrator the walkthrough signs in as was created. `/api/auth/methods` answered `google: false`. | |
| 2 | **Admin → Sign-in**, a placeholder client ID and secret pasted, the switch on, **Save**: the badge read **On**, the secret field said *A secret is saved. It is never shown again; leave this empty to keep it.*, and no warning was on the page. `GET /api/admin/sign-in/google` answered `hasSecret: true`, `secretUnreadable: false`, and no secret. | `00-signin-secret-readable` |
| 3 | **Admin → Users → Add user**, **Google sign-in only** ticked: the dialog stated that the address must be a Gmail or Google Workspace address — Google has to vouch for it — that any other address leaves the account with no way to sign in, and to give them a password instead. | `01-add-user-google-only` |
| 4 | The apiserver restarted with a new `PROVIDER_SECRET_KEY` (`ROTATE=1 kit/run-api.sh`), the case the docs call a rotation. **Admin → Sign-in** now calls the saved secret what it is: the badge reads **Off** while the switch still shows the saved setting, a warning says the saved client secret can no longer be decrypted, usually because `PROVIDER_SECRET_KEY` changed, and to paste the client secret again and save; the field's placeholder asks for it again, and its hint no longer offers to keep a secret that cannot be read. `GET /api/admin/sign-in/google` answered `hasSecret: true`, `secretUnreadable: true`, and still no secret. `/api/auth/methods` answered `google: true` as before: this flag is the admin area's, and a sign-in that reaches Google still fails with the generic message. | `02-signin-secret-unreadable` |
| 5 | The client secret entered again and saved: the page returned to **On** with no warning, the readable placeholder and hint back, `secretUnreadable: false`. The screenshot is byte for byte the one from step 2 (`f4ebdb4d30abf7ce459ada7923c417d804a15710134c5e3eee99f4e35e852738`): the page is exactly where it was. | `03-signin-secret-readable-again` |

What the JSON lines establish, step by step:

- steps 2 and 5 answer `"secretUnreadable": false` and draw the readable page text; step 4 answers
  `"secretUnreadable": true` and draws the warning — the page follows one field of the answer, and the field
  is the one the task adds.
- `"secretInAnswer": false` in every step: neither the placeholder secret nor anything stored for it appears in
  any answer the page read.
- step 3's `dialogNote` is the Add-user dialog's own text, with the Gmail / Workspace limit in it.

The unit-level side of the same change is in the specs, not here: the apiserver's
`google-sign-in-config.http.spec.ts` covers both states of `secretUnreadable` (and that neither the secret nor
the ciphertext is answered), `google-sign-in-config.pg.spec.ts` rotates the key on a real row and enters the
secret again, and the web tests cover both states of the page and the Add-user text.

## The runs on the final tree

`checks/` holds the two runs the task's acceptance asks for, both on `fcb53ab85` — the merge of
`origin/project/34b9KDmnRzopeuF1enIN6` (tip `359876433`) into this branch. An earlier pair of runs on
`94c40abb6` (the branch with `origin/main` absorbed but not the project branch) was sent back by the
coordinator, because both sides had registered the same census key: this branch's `c2c9303de` sends
`POST /runner/projects/:id/tasks/:taskId/integration/skip-merge-check body approvalId` as a real
`RUNNER_ISOLATION_FIELD_CASES` case, while the project branch's `731e9a363` filed it as a reading by hand.
`tenant-isolation-census.spec.ts` refuses a key registered both ways ("both sent and read by hand"), so the
merge keeps the real case and drops that one hand-proof entry (see the merge commit); the census line
`✔ every id a runner-gate request carries … has a case or a reading by hand` is in the merge-check record.

| Run | Record | Result |
| --- | --- | --- |
| The project's merge check, verbatim: `npm run test:compose-topology && npm run prisma:generate && npm run build && npm test -w @orbit/shared && npm test -w @orbit/apiserver && npm test -w @orbit/web` | `checks/merge-check-final/` | exit 0 — compose-topology 9/9; shared 24 files / 398 tests; apiserver 4691 pass, 0 fail, 0 skipped; web 344 files / 4380 tests |
| `bash scripts/run-pg-spec.sh src/apiserver/src/auth/google-sign-in-config.pg.spec.ts` | `checks/pg-spec-google-sign-in-config/` | exit 0 — 7 pass, 0 fail, 0 skipped against PostgreSQL 16.15 (392 migrations), no skips |

Each directory keeps `exit.txt`, the stages and summaries in `output-filtered.txt`, and every line in
`output-full.txt.gz`. The rotation case — a row still holding the ciphertext the previous
`PROVIDER_SECRET_KEY` wrote — is asserted inside the pg spec's subtest (3).

The screenshots above were driven on the isolated stack from the task's code commit `c2c9303de`. Between
that commit and `fcb53ab85`, the pages, service and specs of this change differ only in two comment lines
(the `§5.6` → `§5.2` citation fix); `docs/self-hosting.md` also carries the project branch's shared-provider
paragraph, which no screenshot renders. Nothing the walkthrough rendered changed.

## Rerunning

`kit/` is what ran, from `/var/tmp/google-sign-in-admin-hints`: `S=$PWD bash kit/setup.sh build` and
`S=$PWD bash kit/setup.sh db`, then `kit/run-api.sh` (with `ROTATE=1` for the second half) and
`node kit/gateway.mjs` as long-running processes, and `node drive.mjs <step> …` with the step names in
`drive.mjs` (`setup` first, on an empty database).
