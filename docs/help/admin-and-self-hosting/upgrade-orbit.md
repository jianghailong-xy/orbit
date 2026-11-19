---
title: Upgrade Orbit
summary: Move a self-hosted server to a new release; runners follow on their own.
category: admin-and-self-hosting
routes: [/admin, /settings/machines/:id]
errors: [runner.outdated]
platforms: [web]
common: false
updated: 2026-11-14
---

A self-hosted Orbit server is upgraded from its deployment checkout. Runners then update themselves from the server.

## Upgrade the server

1. Read the release notes and make a verified backup first.
2. In the deployment checkout, check out the release and rebuild:

   ```bash
   git fetch --tags
   git checkout <release-tag>
   docker compose up -d --build
   ```

3. The server applies database migrations as it starts. Keep PostgreSQL running.

On a deployment with managed runners or the runner link, use the repository's upgrade script, `.claude/skills/upgrade/upgrade.sh`, instead: it also rebuilds the managed runner image, sets up the runner link and recreates the gateway.

These steps keep `.env` as it is.

## Runners follow

Each runner downloads its update from your own server. An idle runner updates itself within about 10 minutes. A busy one waits for its turns to end: its machine page shows **Updating to …**, it stops taking new work, finishes the turns in flight, then installs and restarts.

To update one now, open the machine in **Settings** and choose **Update Runner Now** from its **Actions** menu.

## A runner that does not update

A runner with self-update turned off (`ORBIT_NO_SELFUPDATE`), or one that cannot write to its install directory, stays on its version. On that machine run:

```bash
orbit upgrade
```

Use `sudo /usr/local/bin/orbit upgrade` if the binary was installed system-wide. A runner older than 0.1.237 logs "Run `orbit upgrade` to update this runner" each time it starts.

## Apps

The Mac app updates itself; the Android app offers new versions; the iPhone app updates through TestFlight.

Full guide: [Self-hosting: upgrading](../../self-hosting.md#upgrading).
