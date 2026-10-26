# /privacy: the public privacy policy for Google's consent screen

Task 34m9C57GuL4J9Won60lPO. Google's consent screen can only be published as "In production" with a
privacy policy to link to (docs/google-sign-in-design.md 5.6, 7.2). orbitd.io now serves the owner's
policy of October 25, 2026 at `/privacy`, word for word, with privacy@orbitd.io as the contact, and the
login page links to it at its foot.

Code: `src/web/src/pages/PrivacyPage.tsx`, the route in `App.tsx` (outside the auth gate),
`/privacy` in BootGate's bypass list, the Privacy link in `LoginPage.tsx`, the `authedFetch` guard in
`api.ts`, and the `.login-footer` / `.privacy-*` rules in `index.css`. Test: `src/web/src/App.privacy.test.tsx`.

## How these were taken

`kit/run.sh` serves the built bundle (`npm run build -w @orbit/web`, commit a05477a64) the way the web
image does: `nginx:alpine` with `src/web/nginx.conf` as its default server. No apiserver stands behind it,
so `/api/` answers 502. `kit/shoot.mjs` then opens each scene in a fresh Playwright 1.63 context (Chromium
or WebKit, no cookie and no stored session unless the scene says otherwise). It records the address bar,
every request, and the policy's blocks compared with the text the web test holds, which is the task's
own text. `run-output.txt` is the run's output and `report.json` has every scene in full.

The shots render in the fonts installed on this Linux host, in place of the Apple system font.

| Shot | Scene |
| --- | --- |
| [01-privacy-signed-out.png](01-privacy-signed-out.png) | `/privacy` signed out, Chromium, 1280 wide, the whole page |
| [02-privacy-signed-out-phone.png](02-privacy-signed-out-phone.png) | the same in WebKit, 393 wide |
| [03-privacy-signed-out-dark.png](03-privacy-signed-out-dark.png) | the dark theme |
| [04-login-privacy-link.png](04-login-privacy-link.png) | the login page with Google on (`/api/auth/methods` answered by the kit), Chromium |
| [05-login-privacy-link-phone.png](05-login-privacy-link-phone.png) | the login page with the password alone, WebKit, 393 wide |

## What the run shows

- `GET /privacy` with no cookie and no token answers 200 with `Cache-Control: no-cache`, and the body is
  the bundle's `index.html` (nginx's SPA fallback).
- Signed out (01–03): the address bar stays at `/privacy`, and no login form is drawn. The 22 blocks
  equal the task's 22 non-blank lines, in order. The page title is "Privacy Policy — Orbit", both
  addresses are `mailto:privacy@orbitd.io` links, and the page makes no `/api/` request at all.
- Signed in (a stored session, `/api/users/me` answered): the same page at `/privacy`. The only request
  is the theme's `GET /api/users/me`, which every page makes; BootGate warms no first screen.
- A stored session that turns out dead (`/api/users/me` and `/api/auth/refresh` answer 401): the page
  stays at `/privacy` with the full policy, and the dead session is cleared. Without the `api.ts` guard
  the 401 sends the reader to `/login`: the web test's dead-session case fails that way when the guard
  is taken out.
- Login page (04, 05): the Privacy link is `href="/privacy"` in the page footer, visible on the first
  screen 43–44 px above its bottom edge. The form's centre stays on the window's centre (offset 0) with
  and without the Google button. Following the link lands on `/privacy` with the full policy.
