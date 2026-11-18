---
title: Add your first machine
summary: Run one command on the computer you want the agent to work on, and Orbit moves on by itself.
category: get-started
routes: [/runners/register, /settings/machines/new]
errors: []
platforms: [web]
common: false
updated: 2026-11-14
---

Agents run on a machine you connect: a Mac, a Linux box or a server. Until one is online, Orbit has nowhere to run anything, so a new account starts on the welcome card.

## Connect it

1. On the welcome card, find **A computer to work on**. (Later you can use [Register a machine](orbit:/settings/machines/new) in Settings, which opens **Add a runner**.)
2. Pick the machine's operating system: **macOS**, **Linux** or **Windows**.
3. Press **Copy** and run the command on that machine. On macOS and Linux it looks like:

   ```bash
   curl -fsSL https://your-orbit-server/install.sh | bash
   ```

4. The installer puts the `orbit` CLI on the machine and opens your browser to confirm the machine belongs to you. Approve it while signed in to the same Orbit account.
5. Keep the terminal open until it says the service is installed. It sets up a systemd service on Linux or a launchd service on macOS, so the runner keeps going after you close the terminal.

The page says **Waiting for it to connect… this page moves on by itself.** You do not need to refresh.

## Check it from the machine

```bash
orbit status
orbit doctor
```

`orbit status` shows the server it is registered with and how long ago it last checked in. `orbit doctor` lists the engines it found and prints the install or sign-in command for any that are missing.

## A runner Orbit starts for you

Some servers have managed runners turned on. Then the welcome card says **Orbit is starting one for you. You don't need to install anything.** Choose **Use my own computer instead** if you would rather connect your own.

## If it does not move on

See [A machine shows Offline](orbit:/help/machines-and-engines/machine-offline) or the long guide below.

Full guide: [Clean-machine first-run checklist](../../first-run.md#4-enroll-a-runner-and-authenticate-one-runtime).
