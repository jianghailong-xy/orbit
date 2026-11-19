---
title: Move a workspace to another machine
summary: A workspace belongs to one machine; here is how to carry on the work somewhere else.
category: machines-and-engines
routes: [/settings/workspaces/:id, /settings/workspaces/new, /settings/machines/:id]
errors: []
platforms: [web]
common: false
updated: 2026-11-14
---

A workspace is a folder on one machine. Its settings page shows that machine under **Machine**; there is no button to move it, because the folder, its files and its Git checkout live on that machine's disk.

## Carry the work over

1. Make sure the work is somewhere the new machine can get it: pushed to the repository, or landed on main.
2. On the new machine, clone the repository to a folder the runner's user can write to.
3. In **Settings**, press **New workspace**, pick the new machine, and set **Working directory** to that folder. Give it a name you can tell apart, such as `site (gpu-01)`.
4. Start new sessions there.

## What moves and what stays

- **Moves**, because it lives in Orbit: projects, tasks, the wiki, your provider keys and account pools.
- **Stays** with the old workspace: its sessions and their transcripts, uncommitted files on the old machine, and the old machine's engine sign-ins. Sign the engines in again on the new machine.

## A session that cannot run where it is

When Claude is unavailable in the machine's region, the session's card offers **Move to another machine**, alongside **Use another provider** and **Check again**. That moves the one session, not the workspace.

## Retiring the old machine

When nothing runs on it any more, open the machine's **Actions** menu and choose **Delete**.

Full guide: [Onboarding, step 3](../../onboarding.md#3-create-the-first-workspace).
