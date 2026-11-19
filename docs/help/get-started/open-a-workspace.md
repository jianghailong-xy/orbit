---
title: Open a workspace
summary: Point Orbit at a folder on one of your machines, so agents have somewhere to work.
category: get-started
routes: [/settings/workspaces/new, /settings/workspaces/:id]
errors: []
platforms: [web]
common: false
updated: 2026-11-14
---

A workspace is a folder on one machine: the directory an agent works in. It is usually a Git repository.

## Create one

1. Open **Settings**. Under **Workspaces**, press **New workspace** (the **+** button).
2. Pick the machine. Only a machine that is **Online** can get a new workspace. With no machine yet you see **No machines yet** and a **Register a machine** button instead.
3. Fill in **Location**:
   - **Name**: a short label for lists, such as `tea-cli builder`.
   - **Working directory**: an absolute path on that machine, such as `/home/mia/code/site`. It must exist, and the runner's user account must be able to write to it.
   - **Repository URL** (optional): Orbit detects it from the folder's `origin` remote when you leave it empty. It is used for project integration.
4. Press **Create**. Orbit opens the new workspace's settings page.

If Orbit finds Claude Code history for that folder, a **Claude Code history** section offers to import it.

## Start working in it

The workspace appears under **Workspaces** in the sidebar. Open it and press **New session**. See [Start a session](orbit:/help/workspaces-and-sessions/start-a-session).

## Good to know

- Agents run with the privileges of the machine's runner account, so give that account only the files it should touch.
- A workspace lives on one machine. To use another machine, see [Move a workspace](orbit:/help/machines-and-engines/move-a-workspace).

Full guide: [Onboarding, step 3](../../onboarding.md#3-create-the-first-workspace).
