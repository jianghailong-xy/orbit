# Engine sign-in in the Orbit Cloud browser: design (v1)

**Status:** **proposed**, nothing built. Open questions in §7. Builds on `docs/runner-browser-design.md`.

Today an engine's sign-in on a runner (Settings → the runner → Engines → **Sign in**) hands the owner a link to open
in their own browser and, for Claude Code and Antigravity, a code to paste back. On the Orbit Cloud runner there is
also the runner's own Chrome. This lets the owner finish the sign-in there instead, in one press, without copying a
link in or a code out.

## 1. Today

- `loginFlowFor` (`src/runner-go/login.go`) runs the engine's CLI on the runner and scrapes what the owner needs:
  - **Claude Code**: `claude auth login` prints an authorize URL whose `redirect_uri` is Anthropic-hosted
    (`https://platform.claude.com/oauth/code/callback`); that page shows a code the owner pastes back
    (`awaiting_code`, `takesCode`).
  - **Antigravity**: `agy`'s Google OAuth, the same shape: a URL, then a code pasted back.
  - **Codex** (`codex login --device-auth`), **Kimi Code** (`kimi login`) and **Cursor CLI** (`agent login`): device
    flows. The owner approves on the page (typing a one-time code for Codex and Kimi); the CLI polls. Nothing comes
    back (`awaiting_approval`).
  - **OpenCode**: not driven from here.
- The web card is `src/web/src/components/RunnerSignIn.tsx`: **Open the sign-in page**, **Copy sign-in link**, and
  for the code flows a paste field. The relay's steps reach the runner as `LoginCommand` (`action: start | code`) on
  the heartbeat, redelivered until the runner reports a status.
- The runner's Chrome (`browser_supervisor.go`) already opens pages for sessions over DevTools on
  `127.0.0.1:9222` (`browser_open.go`) and inserts pasted text (`browser_paste.go`). The owner watches it in the
  browser tab `/runners/:id/browser` (`openRunnerBrowserTab`).

Doing it by hand works today (open the browser, paste the link into the address bar, copy the code back), but it
leaves the engine vendor's web login (claude.ai, ChatGPT, Google) in the profile every agent on the runner shares.

## 2. What the owner sees (web)

On the Orbit Cloud runner, when its browser is on (`GET /runners/:id/browser` answers), the sign-in card gains one
action beside **Open the sign-in page** once the link is there:

- **Use the runner's browser** — a secondary button, with the line "Opens a private window on this runner. Nothing
  stays signed in after."
- Pressing it opens the browser tab in control (`openRunnerBrowserTab(runnerId, true)`, on the click so no popup
  blocker stops it) and asks the runner to open the sign-in page there.
- The card then says **Finish signing in in the runner's browser**, with **Show the browser** (re-opens the tab) and
  **Cancel**. For Codex and Kimi it still shows the one-time code, which the owner types or pastes (⌘V already works).
- For Claude Code and Antigravity there is nothing to paste: when the vendor's page redirects to its callback, the
  runner takes the code from the address and hands it to the CLI (§4). The card goes to verifying, then **Signed
  in**, as after a paste. The paste field stays under **Paste a code instead**, for when the capture misses.
- Everything else (failed, expired link, cancel, accounts) is today's card.

Not offered on a self-hosted runner, with the browser switch off, or for OpenCode.

## 3. The private window

The sign-in page opens in a **new Chrome browser context** (`Target.createBrowserContext`, the same thing as an
incognito window), not in the shared profile:

- The vendor's cookies live only in that context and go when it is disposed: when the sign-in ends (done, failed,
  cancelled or timed out), or when the browser stops. The shared profile is never touched.
- The context's window is brought to the front, so the owner's tab shows it.
- **While the sign-in runs, the browser is reserved for the owner**, as `browser_request_sign_in` reserves it
  (`YieldForSignIn`): another session's browser call gets the existing "in use" error, so an agent's clicks do not
  land in the sign-in. A session holding the lease when the owner presses the button keeps its turn; it just waits
  for the browser. The reservation ends with the sign-in, bounded by the relay's existing timeout.

What it does **not** do: DevTools listens on the runner's loopback, so an agent process that deliberately connects
to it could see the private window while it is open. The window removes what would otherwise stay; it is not a wall
against the agents on the same runner, which in any case run on the credentials this sign-in writes.

## 4. Taking the code (Claude Code, Antigravity)

- The runner knows the authorize URL it scraped: its `redirect_uri` and `state`. It watches the private context's
  targets over the browser's DevTools socket (`Target.setDiscoverTargets`, `targetInfoChanged`).
- When a page of that context reaches the `redirect_uri` (scheme, host and path equal) with a `code` and a `state`
  equal to the one in the authorize URL, the runner builds what the page would show (Claude Code: `code#state`) and
  hands it to the CLI exactly as `submitCode` hands a pasted one. Any other address is ignored.
- One capture per attempt; a code the CLI rejects falls back to the paste field with today's message.
- The URL, the code and the state are never logged or reported: only "code taken from the browser".
- Antigravity's exact callback must be confirmed against a live `agy` sign-in; if it is not a page with the code in
  its address, Antigravity keeps the paste.

The device flows need none of this: the CLI sees the approval itself.

## 5. Protocol

- **Capability** `login-runner-browser/v1`, declared only by a runner that has a browser (beside
  `browser-open/v1`). The server offers the action only to the caller's own Orbit Cloud runner, with the browser
  gate on and the capability declared; anything else is 404, as the browser routes answer.
- **Web → server**: `POST /runners/:id/login/browser` on the current attempt (no new start: the link already exists).
- **Server → runner**: `LoginCommand{action: "browser", attempt}` on the heartbeat, redelivered until the runner's
  `LoginResultRequest` carries `inBrowser: true` (or a failure). Idempotent: a second delivery for the same attempt
  re-fronts the window instead of opening another.
- **Runner**: `handleBrowserOpen`'s path (start the browser without the lease), then the reservation, the context,
  the page, and for `takesCode` flows the watcher of §4. The relay disposes the context when the attempt ends.
- `inBrowser` is shown by the card (§2) and cleared with the attempt.

## 6. Risks

- **Bot checks.** The runner's Chrome is started with DevTools enabled and runs from a data-centre address. Google
  in particular refuses some automated browsers ("This browser or app may not be secure"); Cloudflare may challenge
  claude.ai or ChatGPT. Each engine is tried on the managed-runner lab before its button ships; one that is refused
  does not get the button.
- **No saved login.** A private window means the owner types the password and second factor each time. That is
  the price of §3; Q1 is the other way.

## 7. Decisions

| # | Question | A | B | Proposed |
| --- | --- | --- | --- | --- |
| Q1 | Where the sign-in happens | a private window, disposed after (§3) | the shared profile: the vendor login stays, and agents can use it | **A** |
| Q2 | The code for Claude Code / Antigravity | taken from the callback by the runner (§4), paste as fallback | pasted by the owner, as today | **A** |
| Q3 | Place on the card | a secondary button; your own browser stays the default | the main button on the Orbit Cloud runner | **A** |
| Q4 | Clients in v1 | web only | web and the native clients | **A** (as the browser's P5) |

## 8. Phases

1. **Runner**: the capability, `action: browser`, the private context and reservation, disposing it; tests with a
   fake DevTools like `browser_open_test.go`.
2. **Server and web**: the route, the gate checks, the heartbeat command, the card's new states.
3. **Code capture** for Claude Code, then Antigravity once its callback is confirmed.
4. **Lab walk** per engine on the managed-runner lab (`scripts/managed-runner/lab/`), switch on and off.
