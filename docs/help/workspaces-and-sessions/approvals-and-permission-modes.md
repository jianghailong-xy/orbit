---
title: Approvals and permission modes
summary: What runs without asking you, what stops for an approval card, and how to answer one.
category: workspaces-and-sessions
routes: [/workspaces/:id/*, /sessions/:id, /settings/general, /settings/workspaces/:id]
errors: []
platforms: [web, macos, ios, android]
common: false
updated: 2026-11-14
---

A session's permission mode decides what the agent may do without a person. You pick it in the composer; **Settings → General → Default permission mode** sets the mode new sessions start in.

## The modes

| Mode | What happens |
| --- | --- |
| **Default** | The agent asks before commands that are not already allowed. |
| **Accept Edits** | File edits run; other commands still ask. |
| **Plan** | The agent reads and plans. It does not change anything until you approve the plan. |
| **Auto** | The agent's own tool calls run inside the workspace without asking. |
| **Don't Ask** | Nobody is asked: anything not already allowed is refused. |
| **Bypass** | Every check is skipped. |

Not every engine supports every mode. When a mode cannot be honoured as chosen, the picker says so next to it, for example "unavailable on a root runner, runs as Auto". That note is what the session really does.

For unattended work that has to run commands, use **Auto**. **Don't Ask** refuses any command nobody allowed.

## Answering an approval card

When the agent needs you, the turn pauses and a card shows the tool and its exact input.

- **Approve** (Enter) allows this one call and the turn continues.
- **Always allow …** (⌘ + Enter on a Mac, Ctrl + Enter elsewhere) remembers a rule for calls like this one, here and in the workspace's other sessions. You can revoke it in the workspace's settings.
- **Reject** refuses the call and tells the agent, which can try another way.

A plan card says **Approve & run** and **Keep planning** instead.

Cards are answered oldest first: Enter always belongs to the oldest card you can answer. If the turn has already ended, the card's buttons are disabled; send a new message instead.

## Cards Orbit itself shows

Some actions always ask you, in every mode: creating a task or a project, connecting a provider, changing an agent. These cards come from Orbit, not from the engine.

Full guide: [Onboarding, step 6](../../onboarding.md#6-answer-an-approval).
