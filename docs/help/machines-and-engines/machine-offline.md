---
title: A machine shows Offline
summary: Why it happens, and how to bring it back in under a minute.
category: machines-and-engines
routes: [/settings/machines/:id, /infrastructure]
errors: [runner.offline]
platforms: [web, macos, ios, android]
common: true
updated: 2026-11-14
---

Orbit marks a machine **Offline** when its runner has not checked in for 90 seconds. Runners check in every 30 seconds, so that is three missed beats. Sessions on it wait, and pick up once it is back.

## 1. Is the computer awake?

A sleeping laptop is the most common cause. Wake it and wait a few seconds. The machine's row says **Offline · last seen …**, which tells you when it went quiet.

## 2. Is the runner running?

On the machine, as the user that registered it, run:

```bash
orbit status
```

It shows the server the runner is registered with and how long ago it last checked in. Run it twice, a minute apart: the heartbeat age should stay small.

If something looks wrong, let it check itself:

```bash
orbit doctor
```

## 3. Start the service

The runner runs as a service. To restart it:

- **Linux**: `systemctl status <service>` shows it; the service name was printed when you registered.
- **macOS**: `launchctl list com.orbit.runner`; the log is `~/.orbit/runner.log`.

If you registered with `--no-service`, run `orbit run` in a terminal you keep open.

## 4. Still offline?

- The machine may not reach your Orbit server (network, VPN, firewall or proxy). The long guide has two `curl` checks for this.
- A runner whose credential was revoked gets refused. Register it again from **Register a machine**.

## Updating is not offline

A runner installing an update says **Updating to 0.1.254**. It stops taking new work, finishes the turns in flight, then installs and restarts by itself.

[Open the machine](orbit:/settings/machines/:id)

Full guide: [Runner troubleshooting, section B](../../runner-troubleshooting.md#b-enrolled-runner-stays-offline-or-heartbeats-stop).
