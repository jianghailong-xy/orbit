---
title: Start a session
summary: Open a workspace, press New session, and describe what you want done.
category: workspaces-and-sessions
routes: [/workspaces/:id/*, /sessions/:id, /runners/:id/new]
errors: []
platforms: [web, macos, ios, android]
common: false
updated: 2026-11-14
---

A session is one conversation with an agent inside a workspace. The transcript keeps every message, every tool call the agent made and its result.

## Start one

1. Open a workspace from **Workspaces** in the sidebar.
2. Press **New session**. In the installed app the shortcut is ⌘N on a Mac, Ctrl N elsewhere.
3. Before you send, check the composer: it shows the **engine and model** the session runs on, the effort, and the **permission mode**. Each can be changed per session.
4. Describe the task and send it.

The session runs on the workspace's machine. While the agent works, the header says **Running**. When the turn ends it says **Waiting for your reply**: the session is not closed, and your next message continues with everything it already knows.

## Reading a turn

- **Worked for …** is the turn's summary line. Under it are the agent's thinking and its tool calls, collapsed.
- Open a tool row to see its exact input and output.
- An approval card in the transcript means the agent is waiting for you. See [Approvals and permission modes](orbit:/help/workspaces-and-sessions/approvals-and-permission-modes).

## Keeping the list tidy

The session list has three views: **Open**, **Completed** and **Trash**. A session stays under Open until you complete it or move it to Trash. A session in Trash is deleted after 30 days; open it and press **Restore to Open** to bring it back.

Full guide: [Onboarding, step 4](../../onboarding.md#4-start-a-session-and-watch-a-turn).
