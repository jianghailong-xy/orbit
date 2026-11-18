---
title: Runner troubleshooting
summary: Enrollment, heartbeat and engine failures on a runner machine, with the checks to run for each.
category: admin-and-self-hosting
routes: [/settings/machines/:id, /settings/machines/new, /runners/register, /enroll]
errors: [runner.offline, runner.enrollment-failed, engine.not-installed]
platforms: [web]
common: false
updated: 2026-11-14
---

Run every command below on the runner machine, as the user account that enrolled it.

## First, two commands

```bash
orbit status    # registration, server, heartbeat age, version
orbit doctor    # engines, sign-in state, the service's PATH
```

`orbit status` prints private identifiers and paths: tidy it before you share it.

## Enrollment does not finish

- From the machine, check the server answers: `curl -fsS https://your-orbit-server/healthz` should print `ok`.
- Approve the browser page while signed in to the right account, before it expires. For an expired one, copy a fresh command from **Register a machine**.
- If `orbit status` says "no runner registered", run the install command again.

## Enrolled, but Offline

- Run `orbit status` twice a minute apart; the heartbeat age should stay small.
- Look at the service: on Linux `systemctl status <service>` and `journalctl -u <service> --since '10 minutes ago'` (the name was printed at registration); on macOS `launchctl list com.orbit.runner` and `tail -n 100 ~/.orbit/runner.log`.
- A repeated `401` in the log means the runner's credential was revoked: register it again with `orbit register --server <url> --force`.
- Timeouts or TLS errors mean the machine cannot reach the server; fix the network rather than re-registering.

## Online, but a session cannot start its engine

- `orbit doctor` should show the selected engine installed, signed in, and visible on the service PATH. It prints the install or sign-in command for anything missing.
- An engine that works in your shell but not in sessions is usually on a different PATH or under a different user than the service.
- A quota or rate-limit error after a good sign-in is the vendor's limit: wait for the reset or use another account.

## Short on disk

Session checkouts live under `~/.orbit/worktrees`. The long guide explains what can be cleaned up safely.

## Before opening an issue

Note the OS, the Orbit version (first line of `orbit status`), which check failed and when. Remove tokens, codes, private addresses and file contents first.

Full guide: [Runner troubleshooting](../../runner-troubleshooting.md).
