---
title: Account pools
summary: Put several accounts under one name, and each session starts on the one with quota to spare.
category: models-keys-and-accounts
routes: [/settings/providers/pools, /settings/providers/pools/:id]
errors: []
platforms: [web, macos, ios, android]
common: false
updated: 2026-11-14
---

An account pool is several accounts under one name. Choose the pool instead of a single account, and Orbit picks the account for each session.

## How a pool picks

- A pool of your subscriptions: each session starts on the account whose quota resets soonest, and stays on it until that one runs out. None of your quota goes unused.
- A pool of API keys: each session starts on the key with the most room.

## Create one

1. Open [Settings → Account pools](orbit:/settings/providers/pools) and press **New pool**.
2. In **New account pool**, choose the **Engine**, give it a **Name**, and choose **Who can use it**: **Just me** or **Me and people I add**.
3. Tick the **Accounts** to include: subscriptions signed in on your machines and API keys.
4. Press **Create pool**.

If you have more than one Claude subscription, the page suggests it: "Pool them, and each session starts on the one whose quota resets soonest". Press **Create a pool**.

## Use it

Pick the pool in the composer's **Provider** menu when you start a session.

## Sharing a pool

With **Me and people I add**, the people you add can run their own sessions on the pool's accounts.

Full guide: [Runner CLI: providers](../../runner-cli.md#providers).
