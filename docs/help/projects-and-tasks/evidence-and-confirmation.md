---
title: Evidence and confirmation
summary: How an agent shows a task is done, and how you confirm it or send it back.
category: projects-and-tasks
routes: [/tasks/:id, /projects/:id, /projects/:id/tasks/:taskId]
errors: []
platforms: [web, macos, ios, android]
common: false
updated: 2026-11-17
---

When an agent says a task is done, it attaches evidence: the commands it ran, their output, screenshots, commits. A task is not done because an agent says so; it is done when its definition of done is shown to hold.

## Where you see it

The confirmation card appears in the task's session, and that session's row in the session list gets an amber dot and **Confirm for you**. A notification or link opens the session at the card. In a project with a coordinator, the coordinator usually decides first and only hands you the ones that need a person.

## Confirm or send it back

A confirmation card asks **Confirm this task is done?** It shows **WHAT COUNTS AS DONE** and **WHAT THE AGENT SAID**.

- **Confirm done** when the evidence shows what the task asked for. The card then reads **Confirmed done**.
- **Chat about this** when something is missing. Type what is missing in the **What's missing?** box. Your message goes to the agent and the task stays open; the card reads **Asked for more**.

An evidence card asks **Does this evidence settle the task?** and lists **WHAT IT HAS TO SATISFY**. Its buttons work the same way. When you send it back, your message is the reason the next attempt aims at, so say exactly what it has to show.

## Why this matters

Confirming a task can unblock the tasks that wait on it and start its landing. If you are not sure, send it back: the agent tries again, and nothing downstream starts.

Full guide: [Onboarding, step 5](../../onboarding.md#5-organize-work-as-a-project-and-read-its-task-graph).
