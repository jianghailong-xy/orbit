# Engine sign-in in the Orbit Cloud browser: design (v1)

**Status:** **decided** (owner, 2026-11-23); phases 1–3 built for Claude Code and the device flows, Antigravity's capture and the lab walk to come. Q1 B, Q2 A, Q3 A, Q4 A (§7). Builds on `docs/runner-browser-design.md`.

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

Doing it by hand works today (open the browser, paste the link into the address bar, copy the code back); this
makes it one press and takes the code out by itself.

## 2. What the owner sees (web)

On the Orbit Cloud runner, when its browser is on (`GET /runners/:id/browser` answers), the sign-in card gains one
action beside **Open the sign-in page** once the link is there:

**Starting (revised 2026-11-23, owner: option A).** An engine row's **Sign in**, and an account's, starts the sign-in as
its panel opens, as **+ Account** does, and opens no tab: the card says "Starting sign-in on the runner…" until the link
is there, then offers **Open the sign-in page** and, here, **Use the runner's browser** side by side, so nothing has
opened before the owner chooses. Before, the row only opened the panel, its **Sign in to …** started the sign-in, and for
Claude Code and Antigravity that press parked a tab of the owner's own browser at once, ahead of the choice. Kimi still
asks which site first (the site's press starts it). A panel opened again while its own sign-in waits on the link takes
that sign-in up rather than starting another. On every runner, not only Orbit Cloud.

- **Use the runner's browser** — a secondary button, with the line "You stay signed in to this site on this runner.
  Agents on this runner can use it." (the Browser section's saved-logins wording).
- Pressing it opens the browser tab in control (`openRunnerBrowserTab(runnerId, true)`, on the click so no popup
  blocker stops it) and asks the runner to open the sign-in page there.
- The card then says **Finish signing in in the runner's browser**, with **Show the browser** (re-opens the tab) and
  **Cancel**. For Codex and Kimi it still shows the one-time code, which the owner types or pastes (⌘V already works).
- For Claude Code and Antigravity there is nothing to paste: when the vendor's page redirects to its callback, the
  runner takes the code from the address and hands it to the CLI (§4). The card goes to verifying, then **Signed
  in**, as after a paste. The paste field stays under **Paste a code instead**, for when the capture misses.
- Everything else (failed, expired link, cancel, accounts) is today's card.

Not offered on a self-hosted runner, with the browser switch off, or for OpenCode.

## 3. The shared profile (Q1 = B)

The sign-in page opens as a **new tab of the runner's shared profile**, the one the owner's Open browser and the
agents use:

- The vendor's web login (claude.ai, ChatGPT, Google) **stays** in the profile after the sign-in, so the next
  sign-in, or adding a second account, is usually one click. Every agent on the runner can use that login, as with any
  site signed in there; **Clear saved logins** removes it.
- The tab is brought to the front, so the owner's browser tab shows it. It is left open when the sign-in ends.
- **While the sign-in runs, the browser is reserved for the owner**, as `browser_request_sign_in` reserves it
  (`YieldForSignIn`): another session's browser call gets the existing "in use" error, so an agent's clicks do not
  land in the sign-in. A session holding the lease when the owner presses the button keeps its turn; it just waits
  for the browser. The reservation ends with the sign-in, bounded by the relay's existing timeout.

The agents already run on the credentials this sign-in writes; what the shared profile adds is the vendor's web
account (billing, settings, other products) within their reach. The owner chose that for the faster sign-in (Q1).

## 4. Taking the code (Claude Code, Antigravity)

- The runner knows the authorize URL it scraped: its `redirect_uri` and `state`. It reads Chrome's pages
  (`/json/list` on its DevTools, every half second) until the attempt ends (`login_runner_browser.go`).
- When a page is at the `redirect_uri` (scheme, host and path equal) with a `code` and a `state`
  equal to the one in the authorize URL (which only this attempt's page can carry), the runner builds what the page would show (Claude Code: `code#state`) and
  hands it to the CLI exactly as `submitCode` hands a pasted one. Any other address is ignored.
- One capture per attempt, reported as `code-taken` (the card shows it signing in); a code the CLI rejects falls back
  to the paste field with today's message.
- The URL, the code and the state are never logged or reported: only "code taken from the browser".
- Antigravity keeps the paste for now: its callback must first be confirmed against a live `agy` sign-in; if it is a
  page with the code in its address, it is captured the same way.

The device flows need none of this: the CLI sees the approval itself.

## 5. Protocol

- **Capability** `login-runner-browser/v1`, declared only by a runner that has a browser (beside
  `browser-open/v1`). The server offers the action only to the caller's own Orbit Cloud runner, with the browser
  gate on and the capability declared; anything else is 404, as the browser routes answer.
- **Web → server**: `POST /runners/:id/browser/sign-in` (`browser-state.ts`, beside Clear saved logins and behind the
  same switch) on the attempt waiting on its link (no new start: the link already exists); 409 with no link waiting
  or a runner that does not declare the capability. It sets `runner.login_browser` to `requested` (migration 1462).
- **Server → runner**: `LoginCommand{action: "browser", attempt, account}` on the heartbeat, redelivered until the
  runner's report on that attempt carries `browser`: `opened`, `failed` or `code-taken` (`LoginResult.browser`),
  a repeat of the attempt's waiting report so the link and the one-time code stay. Idempotent: a second delivery
  for the same attempt reports again and opens nothing.
- **Runner**: `handleBrowserOpen`'s path (start the browser without the lease), then the reservation, the tab,
  and for `takesCode` flows the watcher of §4. The relay ends the reservation when the attempt ends.
- `RunnerLoginState.browser` is shown by the card (§2) while the link waits, and cleared with the attempt and by
  every new start.

## 6. Risks

- **Bot checks.** The runner's Chrome is started with DevTools enabled and runs from a data-centre address. Google
  in particular refuses some automated browsers ("This browser or app may not be secure"); Cloudflare may challenge
  claude.ai or ChatGPT. Each engine is tried on the managed-runner lab before its button ships; one that is refused
  does not get the button.
- **The vendor login stays.** An agent on the runner can act on the owner's claude.ai, ChatGPT or Google account
  until **Clear saved logins** (§3, Q1 = B).

## 7. Decisions

| # | Question | A | B | Decision |
| --- | --- | --- | --- | --- |
| Q1 | Where the sign-in happens | a private window, disposed after | the shared profile: the vendor login stays, and agents can use it (§3) | **decided B** (owner, 2026-11-23) |
| Q2 | The code for Claude Code / Antigravity | taken from the callback by the runner (§4), paste as fallback | pasted by the owner, as today | **decided A** (owner, 2026-11-23) |
| Q3 | Place on the card | a secondary button; your own browser stays the default | the main button on the Orbit Cloud runner | **decided A** (owner, 2026-11-23) |
| Q4 | Clients in v1 | web only | web and the native clients | **decided A** (owner, 2026-11-23) |

## 8. Phases

1. **Runner**: the capability, `action: browser`, the tab and the reservation, ended with the attempt; tests with a
   fake DevTools like `browser_open_test.go`.
2. **Server and web**: the route, the gate checks, the heartbeat command, the card's new states.
3. **Code capture** for Claude Code, then Antigravity once its callback is confirmed.
4. **Lab walk** per engine on the managed-runner lab (`scripts/managed-runner/lab/`), switch on and off.
