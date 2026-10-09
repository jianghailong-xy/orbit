# Google sign-in on a self-hosted deployment, following the docs

A walk through the "Google sign-in" section of `docs/self-hosting.md`, step by step, on an isolated stack with an
empty database, on 2026-10-07. The stack was built from `c4c1d2891`, the project branch tip; the docs commit beside
this one changes no code. PostgreSQL 16 ran on 127.0.0.1:5676 and the apiserver (`node dist/main.js`) on 3376 with
`PUBLIC_ORIGIN=http://localhost:2376`. A loopback gateway (`kit/gateway.mjs`) served the web build and forwarded
`/api` with `X-Real-IP`, as `gateway/nginx.conf` does. No runner was needed. Headless Chromium (Playwright 1.63)
drove the real UI through `kit/drive.mjs`; `walkthrough-output.txt` is its output, one JSON line per step, and
`apiserver-log.txt` the apiserver's lines that matter.

**Blocked: no Google test client.** The owner's Google test OAuth client has not been provided (E1 needs it too).
So the Google Cloud console step was not done, and placeholders stood in for the client:
`000000000000-orbit-doc-walkthrough-placeholder.apps.googleusercontent.com` and a made-up secret. Google refuses
them on its authorization page. No Google account signed in. Nothing here shows a Google sign-in, sign-up or link
completing. Where the walkthrough had to get past Google, the browser itself went to the callback with Google's
`state` and a made-up `code`. That shows what Orbit does when Google refuses a code.

| # | Step of the doc | What happened | Picture |
| --- | --- | --- | --- |
| 1 | Fresh deployment | The first visit went to `/setup`. The administrator created there landed on `/runners/register`. | `00-setup` |
| 2 | Before setup | The login page had no Google button, and `/api/auth/methods` answered `google: false`. | `01-login-before` |
| 3 | Set it up, 1 | **Admin → Sign-in**, opened from the account menu, said **Off** and showed `http://localhost:2376/api/auth/google/callback`. | `02-admin-signin-empty` |
| 4 | Set it up, 2 | Google Cloud console: **not done**, see above. | |
| 5 | Set it up, 3 | Client ID and secret pasted, switch on, **Existing accounts only**, **Save**: the badge said **On**. `GET /api/admin/sign-in/google` answered `hasSecret: true` and no secret. The database held 86 characters of ciphertext, not the secret (`kit/check-db.sh`). | `03-admin-signin-on` |
| 6 | Set it up, 4 | A new browser's login page offered **Continue with Google**: `google: true, googleSignup: false`. | `04-login-google` |
| 7 | Who can sign in | **Anyone with a Google account** showed its warning. After **Save**, the login page added "New to Orbit? Continue with Google to create an account." (`googleSignup: true`). Then back to **Existing accounts only**. | `05-admin-open-warning`, `06-login-signup-hint` |
| 8 | Who can sign in | **Admin → Users → Add user** offered **Google sign-in only**. The account it made shows **Google · pending**. | `07-add-user-google-only`, `08-users-badges` |
| 9 | Leaving for Google | **Continue with Google** sent the browser to `https://accounts.google.com/o/oauth2/v2/auth` with `response_type=code`, the client ID, `redirect_uri=http://localhost:2376/api/auth/google/callback`, `scope=openid email profile`, `prompt=select_account` and `code_challenge_method=S256`. Google answered "Access blocked: Authorization Error. The OAuth client was not found. Error 401: invalid_client", as the troubleshooting table says. With a real client, Google's account chooser comes here. | `09-google-invalid-client` |
| 10 | Troubleshooting | The callback with a made-up code: the apiserver asked Google's token endpoint, which answered 401 `invalid_client`. It logged `WARN [GoogleSignIn] Google's token endpoint refused the code: 401 invalid_client`, and the login page said "Orbit couldn't confirm your sign-in with Google…". | `10-callback-exchange-failed` |
| 11 | `runner-cli.md` | Signed out, `/enroll?code=DOC-WALK-1` and `/cli-login?code=DOC-WALK-2` went to `/login?next=…`, which offered **Continue with Google**. After the trip to Google each was back at its `/login?next=…`: `next` survives the round trip. | output only |
| 12 | Limits | Started at `http://127.0.0.1:2376`, not at `PUBLIC_ORIGIN`: back at `localhost` the page said "That Google sign-in expired or was finished in a different browser." | `11-other-address` |
| 13 | Limits | At `http://orbit-doc.test:2376` (plain HTTP, not localhost; Chromium resolved the name to 127.0.0.1) the page said "Couldn't start Google sign-in in this browser. Make sure Orbit is open over HTTPS, then try again." | `12-insecure-context` |
| 14 | Limits | 31 starts from one `X-Real-IP` within a minute: 30 answered 302, the 31st 429. One more from another address: 302. Sent to the apiserver directly, with the header the gateway sets. | output only |
| 15 | `PROVIDER_SECRET_KEY` | The apiserver restarted with a new key. **Admin → Sign-in** still said **On** and that a secret is saved. The callback logged `ERROR [GoogleSignIn] the saved Google client secret cannot be decrypted; an administrator must enter it again`. With the secret entered again, the next callback reached Google again (401 `invalid_client`). | `apiserver-log.txt` |
| 16 | Turning it off | Switched off and saved: **Off**, `google: false`. `/start` sent the browser to the login page with "Google sign-in is turned off on this Orbit server…", and no Google button. | `13-off` |

## What went back into the docs

- `self-hosting.md`: after `PROVIDER_SECRET_KEY` changes, **Admin → Sign-in** still shows the secret as saved and
  the badge **On** (step 15).
- `self-hosting.md`: the `invalid_client` log line stands for a client ID and secret Google does not accept
  together, not only a wrong secret (step 10).
- Found while writing rather than walking: Google exempts apps that ask only for `openid`, `email` and `profile`
  from the Testing status's test-user list ([Manage App Audience](https://support.google.com/cloud/answer/15549945)).
  Design 7.2 said Testing admits only the test users; `self-hosting.md` and design 7.2 now follow Google. Not
  verified here: it needs the test client.

## With the owner's test client

Register `http://localhost:2376/api/auth/google/callback` on it, or rebuild the kit for another port. Enter it in
**Admin → Sign-in**, open `http://localhost:2376` through `ssh -L 2376:localhost:2376 <hpc>`, and sign in with a
Google account under both policies. While the app is in Testing, also try an account that is not on its test-user
list.

## Rerunning

`kit/` is what ran, from `/var/tmp/google-doc-e2e`: `setup.sh build` and `setup.sh db`, then `run-api.sh` and
`node gateway.mjs` as long-running processes, then `node drive.mjs <step> …` with the step names in `drive.mjs`
(`setup` first, on an empty database).
