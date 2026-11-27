---
title: What a project is
summary: A goal with a graph of tasks, a coordinator that works through them, and criteria that say when it is done.
category: projects-and-tasks
routes: [/projects, /projects/:id, /projects/:id/tasks/:taskId]
errors: []
platforms: [web, macos, ios, android]
common: false
updated: 2026-11-17
---

A project is a goal with a body of work under it. Its tasks say which one waits for which, and a coordinator, a conversation with an agent, decides what runs next until the work is merged.

## Create one

Open [Projects](orbit:/projects) and press **New project**. Describe the goal; the coordinator proposes tasks, and each one is shown to you on a card before it is created. You can also add one yourself with **New task** on the project page.

## Reading a project page

- **Work overview** counts the tasks that are running, ready, waiting on others, awaiting verification, done, failed or cancelled.
- **Coordinator** is the conversation that plans and steers the project. Talk to it like any session.
- **How it runs** holds the **Automatic** switch. With Automatic on, the coordinator starts ready tasks, decides when each is done, handles conflicts and failed checks, and merges the branch once the merge check passes. The criteria and anything irreversible stay yours.
- **Task graph** draws the dependencies: arrows point from a prerequisite to the work waiting on it. A dashed box is several finished tasks folded together; open it to see them.
- **Run queue** lists the tasks whose prerequisites are done. **Run** starts one.
- **Acceptance criteria** say what settles the project. Each task also carries its own definition of done.

## Where your attention is needed

Questions from the coordinator and confirmations it needs appear at the top of the project page and as cards in the session that asked. A request to move tasks into this project is approved on one card in its coordinator session. See [Find what needs you](orbit:/help/projects-and-tasks/find-what-needs-you).

Full guide: [Onboarding, step 5](../../onboarding.md#5-organize-work-as-a-project-and-read-its-task-graph).
