---
title: Background jobs
summary: Long builds and test runs an agent starts in the background, and where to see them.
category: workspaces-and-sessions
routes: [/workspaces/:id/*, /sessions/:id]
errors: []
platforms: [web]
common: false
updated: 2026-11-14
---

An agent can start a long command, such as a build, a test suite or a dev server, as a background job. The job is run by the machine's runner, not by the agent's own process, so it keeps going between turns and the agent is woken when it ends.

## Where you see them

- Above the composer, the **Background processes** tray shows how many are running, for example `1 running · 3 total`. Press **Show processes** to list them with their state: running, done, failed or killed.
- In the session list, a session with a job running says **Background process running**.
- When a job finishes, the transcript shows a card such as **Background job finished** or **Background job failed**, and the agent picks up from there.
- A session that is idle but has a job in flight reads **Running in background**, not "Waiting for your reply".

## Jobs follow the permission mode

A job runs under the runner's account, outside any sandbox the engine has, so the runner checks it against the session's permission mode before it starts:

- **Auto** and **Bypass** start it.
- **Default** and **Accept Edits** show you a card with the command: allow once, always allow, or reject. You can answer whenever you like; the job starts when you say yes.
- **Plan** and **Don't Ask** refuse it, with a note saying what to do instead.

## Stopping a job

Ask the agent to stop it. Ending the session also stops its jobs.

Full guide: [Runner CLI: permission modes, shell commands and background jobs](../../runner-cli.md#permission-modes-shell-commands-and-background-jobs).
