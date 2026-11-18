---
title: API keys
summary: Add a provider's API key once and use it from every machine, billed per token.
category: models-keys-and-accounts
routes: [/settings/providers, /settings/providers/new, /settings/providers/new/:slug, /settings/providers/keys/:id, /settings/providers/:vendor]
errors: [provider.key-invalid]
platforms: [web, macos, ios, android]
common: false
updated: 2026-11-14
---

An API key lets sessions use a model provider's API and pay per token. Keys are stored on your Orbit account, so every one of your machines can use them; nothing has to be copied to each machine.

## Add a key

1. Open **Settings**. Under **Providers**, press **Connect a provider** (the **+** button), or open **API keys** and press **Add key**.
2. On **Add a provider**, pick the vendor: **Anthropic**, **OpenAI**, **Google Gemini**, **DeepSeek**, **Moonshot (Kimi)**, **Z.AI (GLM)**, **MiniMax**, **Qwen**, or **Custom** for any compatible endpoint you run yourself.
3. Paste the key and press **Connect**. Orbit checks the key with the vendor first. Each key is visible only to you.

[Open API keys](orbit:/settings/providers)

## Use it

When you start a session, choose the key in the composer's **Provider** menu, next to the engine and model. A key works with the engines that speak its vendor's API, for example an Anthropic key with Claude Code.

## Keys or a subscription?

- **API key**: billed per token by the vendor, no usage windows, usable from every machine.
- **Subscription** (Claude, ChatGPT): a monthly plan with usage limits, signed in on each machine. See [Sign in with a subscription](orbit:/help/models-keys-and-accounts/sign-in-with-a-subscription).

Several keys or subscriptions for the same engine can be combined in an [account pool](orbit:/help/models-keys-and-accounts/account-pools).

## Removing a key

Open the key from **API keys** to edit it and press **Save**, or delete it with **Delete key**. Orbit asks first and says what uses the key.

Full guide: [Runner CLI: providers](../../runner-cli.md#providers).
