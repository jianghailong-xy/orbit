---
title: A session stopped: account out of quota
summary: What the 5-hour and weekly limits mean, and how the session resumes on its own.
category: models-keys-and-accounts
routes: [/workspaces/:id/*, /sessions/:id, /settings/providers/pools]
errors: [account.quota-exhausted]
platforms: [web, macos, ios, android]
common: true
updated: 2026-11-14
---

Subscriptions have usage windows. When the account a session runs on uses its share, the turn stops and the session shows a card such as **5-hour limit reached**, **Weekly limit reached** or **Usage limit reached**. The session itself is fine: nothing is lost.

## What the card tells you

- Whose quota it is: for example "The 5-hour quota for Claude on "build-box" is used up."
- When it comes back: **Resets 19:20 · in 2 h 14 min**.
- **Auto-retry when the quota resets**. When it is on, the card says "Runs on the server — you can close this tab." The turn is sent again by itself after the reset.

## What you can do

1. **Wait.** With auto-retry on, there is nothing to do.
2. **Retry now anyway** if you know the limit has lifted. Before the reset it will likely fail again, and the card says so.
3. **Use another account.** Start new work on another key or subscription, or set up an [account pool](orbit:/help/models-keys-and-accounts/account-pools) so sessions start on the account with quota left.

If the card says **Auto-retry gave up** ("Tried 3 times — the quota still reports as spent. Over to you."), the vendor still reports the quota as spent. Check your plan on the vendor's site, then press **Retry now**.

## Provider errors

**Provider unavailable** is a different card: the vendor's API failed, not your quota. It retries the same way.

Full guide: [Onboarding, step 7](../../onboarding.md#7-recovery-when-a-run-stops).
