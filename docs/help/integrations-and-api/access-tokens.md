---
title: Personal access tokens
summary: Let a script or the orbit CLI act as you, with only the access you give it.
category: integrations-and-api
routes: [/settings/access-tokens, /cli-login]
errors: [token.invalid]
platforms: [web, macos, ios, android]
common: false
updated: 2026-11-14
---

A personal access token lets your scripts and the `orbit` CLI use the Orbit API as you. What it writes is recorded as yours. Treat a token like a password.

## Create one

1. Open [Settings → Access tokens](orbit:/settings/access-tokens) and press **New token**.
2. In **New access token**:
   - **Name**: what it is for, such as "Nightly report script".
   - **Access**: **Read-only**, **Read & write**, or **Custom** to pick scopes one by one.
   - **Workspaces**: leave **All workspaces**, or confine it to some.
   - **Expires**: **30 days**, **90 days** (the default), **1 year** or **Never**. A token that never expires keeps working until you revoke it.
3. Press **Create token** and copy it. It is shown once.

## Use it from the CLI

On any machine, with or without a runner:

```bash
orbit login                       # approve in the browser; it saves a token for this machine
orbit login --with-token < token.txt   # or use a token you created above
orbit whoami
orbit api /api/tasks
orbit logout                      # revokes the token, then forgets it
```

`orbit login` opens a page in your browser showing the token's name, access, lifetime and the machine asking; approve or deny it there. In CI, set `ORBIT_USER_TOKEN` instead of saving a login.

## Revoke one

Tokens are listed under **Active** and **Revoked & expired**. Revoke a token as soon as you no longer need it, or if it may have leaked.

## What no token can do

No token can make your own decisions: confirmations, evidence verdicts, approvals, starting or finishing a project, account settings, administration, or managing tokens. Those stay in the app.

A `401` answer means the token is invalid, revoked or expired. Create a new one or run `orbit login` again.

Full guide: [Runner CLI: personal access tokens](../../runner-cli.md#personal-access-tokens).
