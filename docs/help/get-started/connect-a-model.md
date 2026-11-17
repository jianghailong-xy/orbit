---
title: Connect a model
summary: Sign in with your Claude or ChatGPT subscription, or use an API key.
category: get-started
routes: [/runners/:id/new, /settings/machines/:id, /settings/providers, /settings/providers/new]
errors: [engine.signed-out]
platforms: [web, macos, ios, android]
common: false
updated: 2026-11-14
---

An agent needs a model to think with. There are two ways to give it one, and you can use both.

## A subscription: Claude or ChatGPT

Use the plan you already pay for. You sign in on the machine that runs the agent, and the sign-in stays on that machine.

1. On the welcome card, step 2 is **A model to think with**. Later, open the machine under **Settings → Machines**.
2. Pick the engine: **Claude Code** for Claude, **Codex** for ChatGPT.
3. Press **Sign in** and follow the vendor's sign-in page.
4. The engine's row turns to **Signed in**.

Subscriptions have usage limits, such as a 5-hour window. See [A session stopped: account out of quota](orbit:/help/models-keys-and-accounts/account-out-of-quota).

## An API key

Pay per token, with no usage windows. A key is stored on your Orbit account, so every machine can use it.

1. Open **Settings**. Under **Providers**, press **Connect a provider**.
2. Pick the vendor, such as **Anthropic**, **OpenAI** or **DeepSeek**, paste the key, and press **Connect**.

[Connect a provider](orbit:/settings/providers/new)

## Choosing per session

The composer shows the engine and model a session runs on, and its **Provider** menu lists your keys and account pools. Pick there before you send.

## Check from the machine

`orbit doctor` lists each engine with its sign-in state and prints the sign-in command for one that is signed out.

Full guide: [Onboarding, step 2](../../onboarding.md#2-connect-the-first-runner).
