# Disabling an account and enabling it again, through the real UI

Task X1 of the Google sign-in project (docs/google-sign-in-design.md §5.5), on 2026-10-07. The stack was built
from `50148e574`, the X1 branch with main merged in, with no uncommitted paths, on an empty database. PostgreSQL 16
ran on 127.0.0.1:5696 and the apiserver (`node dist/main.js`) on 3396. A loopback gateway (`kit/gateway.mjs`)
served the web build on `http://localhost:2396` and forwarded `/api`. No runner and no Google client were needed.
Headless Chromium (Playwright) drove the real UI through `kit/drive.mjs`. `walkthrough-output.txt` is its output,
one JSON line per step, with the status, code and message each of Mallory's credentials was answered.

Four accounts: Owner (administrator, the one signed in to **Admin → Users**), Dana (administrator), Dev and Mallory
(members). Mallory is signed in in a browser tab of their own and holds a personal access token.

| # | Step | What happened | Picture |
| --- | --- | --- | --- |
| 1 | Mallory signed in | Mallory's tab is on `/runners/register`, where an account with no runner lands. | `01-mallory-signed-in` |
| 2 | Admin → Users | Opened from the account menu. **Status** says **Active** for all four. **Disable** is offered on Dana, Dev and Mallory, not on Owner's own row. | `02-users` |
| 3 | Disable, asked first | "Disable `mallory@example.com`?" says they are signed out everywhere and cannot sign in, that their access tokens, runners and service tokens stop working until the account is enabled again, and that nothing they own is deleted. | `03-disable-confirm` |
| 4 | Disabled | The toast says **Account disabled**. Mallory's row says **Disabled** and offers **Enable** instead of **Disable**. | `04-disabled` |
| 5 | Mallory's credentials | Access token: 401. Refresh: 403 `ACCOUNT_DISABLED`. Personal access token: 403 `ACCOUNT_DISABLED`. Password login: 403 `ACCOUNT_DISABLED`. | output only |
| 6 | Mallory's open tab | Reloaded, its first request was a 401, the refresh a 403: the tab dropped both tokens and went to `/login`. | `05-mallory-signed-out` |
| 7 | Mallory signs in again | The login page says "This Orbit account is disabled. Ask an administrator to enable it again." | `06-login-disabled` |
| 8 | Enable | At once, nothing asked. The toast says **Account enabled**; Mallory's row says **Active** and offers **Disable**. | `07-enabled` |
| 9 | Mallory's credentials | The personal access token works again (200). The refresh token the disable revoked is unknown (401 `invalid refresh token`). | output only |
| 10 | Mallory signs in again | Signed in with the password, back on `/runners/register`. | `08-mallory-signed-in-again` |

Not shown here, and held instead by `src/apiserver/src/auth/account-disable.pg.spec.ts` against the production
apiserver over PostgreSQL: the Google exchange (§5.2 rows 1 and 3), the runner credential at both runner guards,
the service token, the refusals of the administrator's own account and of the last administrator, the revocation
of every refresh token, the Activity rows, and a disable written by another server reaching access tokens and
personal access tokens within 30 seconds. `src/web/src/pages/AdminUsersPage.disable.test.tsx` holds the page's
Disable / Enable, including a refusal shown in the dialog.

## Rerunning

`kit/` is what ran, from `/var/tmp/x1-disable-e2e`: `setup.sh build` and `setup.sh db`, then `run-api.sh` and
`node gateway.mjs` as long-running processes, then `node drive.mjs` on the empty database. `setup.sh down` removes
the database container.
