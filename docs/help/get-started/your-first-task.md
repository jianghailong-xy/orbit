---
title: Your first task, start to merge
summary: From a request to a change on main, and what you are asked along the way.
category: get-started
routes: [/tasks, /tasks/:id, /projects/:id]
errors: []
platforms: [web, macos, ios, android]
common: false
updated: 2026-11-17
---

A task is a piece of work with a definition of done. Here is the whole path once.

## 1. Ask for it

The quickest way is to start a session in a workspace and describe the change. For work you want tracked, ask the agent to file it as a task, or open a project and press **New task**. Creating a task shows you a card first; nothing is created until you approve it.

## 2. Let it run

A task runs as a session on the workspace's machine. Open it from **Tasks** or from its project's **Run queue** to watch. If the agent wants to run a command that needs you, an approval card appears: **Approve** (Enter) or **Reject**.

## 3. Check the evidence

When the agent says it is done, it attaches evidence: the commands it ran, test output, screenshots. A task that needs your confirmation shows its card in the task's session, and that session's row in the session list says **Confirm for you**. See [Find what needs you](orbit:/help/projects-and-tasks/find-what-needs-you).

- **Confirm done** when the evidence shows what the task asked for.
- **Chat about this** when something is missing. Your next message goes to the agent, and the task stays open.

## 4. Land it

Once the task is done, Orbit lands its branch: it merges the work and runs the merge check on the combined tree. The task shows **Landing**, then **Landed**, and finally **On main**. In a project, merging into main can wait for you on a **Merge to main** card.

If landing fails, see [When a merge fails](orbit:/help/projects-and-tasks/when-a-merge-fails).

Full guide: [Clean-machine first-run checklist, step 5](../../first-run.md#5-complete-a-small-task).
