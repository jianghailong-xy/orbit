---
title: Sign in with a subscription
summary: Use your Claude or ChatGPT plan instead of an API key; the sign-in stays on that machine.
category: models-keys-and-accounts
routes: [/settings/machines/:id, /runners/:id/new]
errors: [engine.signed-out]
platforms: [web, macos, ios, android]
common: false
updated: 2026-11-14
---

If you have a Claude or ChatGPT subscription, sessions can run on it instead of a pay-per-token key. You sign the engine in on the machine that runs it, and the login stays there: Orbit's server never receives it.

## Sign in

1. Open **Settings**, then the machine under **Machines**.
2. Find the engine: **Claude Code** for a Claude plan, **Codex** for a ChatGPT plan, **Kimi Code** for Kimi. Its row says **Signed out**.
3. Press **Sign in**. The panel offers **Sign in to Claude Code** (or Codex, or Kimi Code).
4. Press **Copy Code & Open Sign-In Page**, sign in to the vendor in the browser tab that opens, and paste the code if it asks for one. **Copy sign-in link** lets you finish on another device.
5. The row turns to **Signed in**.

A new account does this on the welcome card, at step 2, **A model to think with**.

## Several accounts on one machine

Press **Add account** on the engine's row to sign in a second subscription. To have sessions move between them as quota runs out, put them in an [account pool](orbit:/help/models-keys-and-accounts/account-pools).

## When it signs out

A vendor can end a login, for example after a password change. The row goes back to **Signed out**, sessions on it stop, and your devices are notified (**Engine sign-outs** is always sent). Sign in again the same way.

::: platform macos
On a Mac whose user only logs in over SSH, Claude Code cannot read the login Keychain from the runner's service, so it shows signed out. Sign in again with the machine's **Sign in** button; Claude Code then keeps the login in a file the service can read.
:::

Full guide: [Runner troubleshooting, section C](../../runner-troubleshooting.md#c-runner-is-online-but-a-task-cannot-start-its-runtime).
