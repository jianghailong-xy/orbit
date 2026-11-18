---
title: Add a machine
summary: Install the runner on a Mac, Linux box or server and enroll it in your account.
category: machines-and-engines
routes: [/settings/machines/new, /settings/machines/:id, /runners/register, /infrastructure]
errors: []
platforms: [web, macos, ios, android]
common: false
updated: 2026-11-14
---

Any computer you can open a terminal on can run your agents. Each machine runs the runner, a small service, and the engines installed on it.

## Enroll it

1. Open **Settings**. Under **Machines**, press **Register a machine** (the **+** button). The page is called **Add a runner**.
2. Choose **macOS**, **Linux** or **Windows**, press **Copy**, and run the command on the new machine:

   ```bash
   curl -fsSL https://your-orbit-server/install.sh | bash
   ```

   On Windows, in PowerShell: `irm https://your-orbit-server/install.ps1 | iex`.
3. Run it as the user account that should run agents. Agents get that account's access to files and credentials, so a dedicated account is a good idea on a shared machine.
4. Your browser opens to confirm the machine belongs to you. Approve it.
5. The page shows **Runner online — "build-box" is ready**. Press **Machine settings** to see it, or **Start a session**.

::: platform ios
The iPhone app lists your machines under **Settings → Machines & models**. Enrolling a new machine needs its terminal; run the command there and approve the browser page on any device.
:::

## Check it

On the machine:

```bash
orbit status    # the server it is registered with, and the last heartbeat
orbit doctor    # engines found, sign-in state, and the service PATH
```

## On the machine's page

Each machine's page under Settings shows whether it is **Online**, how many sessions are running out of how many it allows, its engines, and an **Actions** menu: **Rename**, **Update Runner Now**, **Update engines**, **Refresh models**, **Rotate token** and **Delete**.

## Several people on one Linux server

An administrator can set the machine up once with `orbit host setup --server <url>` (as root); then each person registers their own runner on it. See the long guide.

Full guide: [Self-hosting: register a runner](../../self-hosting.md#4-register-a-runner).
