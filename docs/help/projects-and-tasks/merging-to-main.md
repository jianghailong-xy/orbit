---
title: Merging to main
summary: How a finished task's work lands, and when merging into main waits for you.
category: projects-and-tasks
routes: [/projects/:id, /projects/:id/landings, /projects/:id/tasks/:taskId, /tasks/:id]
errors: []
platforms: [web, macos, ios, android]
common: false
updated: 2026-11-14
---

When a task is done, Orbit lands its work: it merges the task's branch with the latest code and runs the merge check on the combined tree. Only a tree that passes is pushed.

## Following a landing

A task shows where its landing stands:

- **Waiting to land**, then **Landing** while the check runs.
- **Landed** when it is merged, and **On main** once it has reached main.
- **Already landed** or **Nothing to land** when there was nothing new to merge.

A project's **Landings** window lists every landing: what is in flight, what is waiting for a decision and what landed today. Orbit runs them; there is nothing to type there.

## Merging a project into main

In a project that works on its own branch, the finished branch is merged into main from a **Merge to main** card on the project page.

- **Merge to main** merges it now. The card then reads **✓ Merged into main**.
- **Not now** leaves it for later.

With **Automatic** on under **How it runs**, the coordinator merges the branch once the merge check passes, and gives you a receipt you can revert. When a project lands straight into main, merging still asks you unless you chose **The agent pushes it** under Delivery.

If a landing fails, see [When a merge fails](orbit:/help/projects-and-tasks/when-a-merge-fails).

Full guide: [Onboarding, step 5](../../onboarding.md#5-organize-work-as-a-project-and-read-its-task-graph).
