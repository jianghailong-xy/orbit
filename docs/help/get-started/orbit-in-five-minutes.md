---
title: Orbit in five minutes
summary: Machines, workspaces, sessions and tasks, and how they fit together.
category: get-started
routes: [/, /runners/register, /settings/general]
errors: []
platforms: [web, macos, ios, android]
common: false
updated: 2026-11-26
---

Orbit gives a coding agent a computer and a task, and keeps the conversation and its results in one place, on the web and on your phone.

## The four things you work with

- **Machine.** A computer that runs your agents: your laptop, a Linux box or a server. It runs a small program, the runner, and the engines installed on it (Claude Code, Codex, Cursor and others). Machines are listed under **Settings → Machines**. [How runners and the server work together](orbit:/help/machines-and-engines/how-runners-and-the-server-work) explains how they connect.
- **Workspace.** A folder on one machine, usually a Git repository. Every agent conversation happens inside a workspace.
- **Session.** One conversation with an agent in a workspace. You write a message, the agent works, and the transcript keeps every message, tool call and result.
- **Task.** A piece of work with a definition of done. Tasks can stand alone or belong to a **project**, a goal with a graph of tasks that a coordinator works through until the result is merged.

## How a first hour goes

1. [Add a machine](orbit:/settings/machines/new) by running one command on it.
2. Connect a model: sign in with a Claude or ChatGPT subscription, or add an API key.
3. Create a workspace that points at a folder on that machine.
4. Start a session and describe what you want.
5. Answer approvals when the agent asks, and review the result.

## Where things that need you show up

- Questions, confirmations and approval cards appear in the session that asked. Its row in the session list gets an amber dot and says what it wants, such as **Decision for you**.
- Terminals asking to sign in wait on their machine's page under **Settings → Machines**, and scheduled runs that need you wait on the **Scheduled** page.
- [Find what needs you](orbit:/help/projects-and-tasks/find-what-needs-you) lists every kind.
- Your phone can notify you; see the article on notifications.

Full guide: [Onboarding, step by step](../../onboarding.md).
