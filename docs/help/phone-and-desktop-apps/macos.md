---
title: Orbit for Mac
summary: The native Mac app, how to install and update it, and how it relates to the runner.
category: phone-and-desktop-apps
routes: []
errors: []
platforms: [macos]
common: false
updated: 2026-11-14
---

The Mac app is a native window onto your Orbit account: projects, tasks, workspaces and sessions, the wiki, machines and models, and Settings. It is a client: it does not run agents by itself.

## Install it

Each Orbit release attaches a signed, notarized disk image, `Orbit-v<version>-arm64.dmg`, to its GitHub Release. Open it and drag Orbit to Applications. The app needs an Apple silicon Mac.

## Update it

The app checks for new versions itself. To check now, open the **Orbit** menu and choose **Check for Updates…**.

## Sign in

Enter your **Email** and **Password** and click **Sign In**, or **Continue with Google**. For a self-hosted server, change the **Server address** from the sign-in screen first (see [Orbit on iPhone and iPad](orbit:/help/phone-and-desktop-apps/iphone); the Mac works the same way).

## Running agents on this Mac too

To let agents work on this Mac, add it as a machine: in **Settings**, open **Register a machine** and run the command in Terminal. The runner is a separate service from the app, so agents keep working when the app is closed. See [Add a machine](orbit:/help/machines-and-engines/add-a-machine).

::: platform macos
The runner on a Mac is a launchd service named `com.orbit.runner`; its log is `~/.orbit/runner.log`.
:::

Full guide: [Runner troubleshooting](../../runner-troubleshooting.md#find-the-runner-logs).
