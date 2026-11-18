---
title: Install or update an engine
summary: Claude Code, Codex, Cursor CLI, Kimi Code, OpenCode, DeepSeek Harness and Antigravity CLI, from the machine's page.
category: machines-and-engines
routes: [/settings/machines/:id]
errors: [engine.not-installed, engine.signed-out]
platforms: [web, macos, ios, android]
common: true
updated: 2026-11-14
---

An engine is the coding-agent program a session runs: **Claude Code**, **Codex**, **Cursor CLI**, **Kimi Code**, **OpenCode**, **DeepSeek Harness** or **Antigravity CLI**. Each machine runs the engines installed on it.

## Install one

1. Open **Settings**, then the machine under **Machines**.
2. Find the engine. One that is missing says **Not installed — Orbit can install it here**.
3. Press **Install**. The row shows **Installing…**, then **Installed**. If it fails, the row says **Install failed** with what the machine reported; press **Retry**.

The machine must be online. It runs the engine's own recommended installer.

## Sign it in

An installed engine needs an account to think with. Its row says **Signed in**, **Signed out** or **Unknown**. Press **Sign in** and follow the panel: it opens the engine's own sign-in page (for Antigravity, **Sign in with Google**). The sign-in stays on that machine. See [Sign in with a subscription](orbit:/help/models-keys-and-accounts/sign-in-with-a-subscription).

## Updates

Engines update themselves: the runner checks about every 30 minutes. To update now, open the machine's **Actions** menu and choose **Update engines**. From the machine's terminal you can also run:

```bash
orbit engine-update
```

## From the command line

`orbit doctor` lists each engine with its version, sign-in state and whether the runner's service can find it, and prints the install or sign-in command for any that are missing.

## If a session says the engine is missing

The engine may be installed for your shell but not on the runner service's PATH, or under another user account. Run `orbit doctor` as the runner's user and compare.

Full guide: [Runner troubleshooting, section C](../../runner-troubleshooting.md#c-runner-is-online-but-a-task-cannot-start-its-runtime).
