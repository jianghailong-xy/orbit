---
title: Sessions that pause and resume
summary: A session whose machine goes offline or whose account runs out waits instead of failing, and picks up again.
category: workspaces-and-sessions
routes: [/workspaces/:id/*, /sessions/:id]
errors: [runner.offline, session.waiting-to-resume]
platforms: [web, macos, ios, android]
common: true
updated: 2026-11-27
---

A run that cannot continue is not a lost session. Orbit keeps the conversation, records why it stopped, and often resumes it by itself.

## What you might see

| You see | What it means | What to do |
| --- | --- | --- |
| **The assigned runner is offline. This session starts when it comes back.** | The session is queued for a machine that is not connected. | Bring the machine back. See [A machine shows Offline](orbit:/help/machines-and-engines/machine-offline). |
| **Runner offline** in the composer, or **Disconnected** in the header | The machine went away during the run. | Same as above. Work it held is sent out again once the machine is back. |
| **5-hour limit reached**, **Weekly limit reached** or **Usage limit reached** | The account the session runs on is out of quota. | Leave **Auto-retry when the quota resets** on. See [A session stopped: account out of quota](orbit:/help/models-keys-and-accounts/account-out-of-quota). |
| **Idle**, on a session that set a watch or a scheduled wake-up | The session is parked on something that will wake it. It reads Idle like any other session between turns. | Nothing. It continues on its own. |
| **Running in background** | A background job is still running. | Nothing. The agent is woken when it ends. |

## Resuming by hand

- On a quota card, **Retry now** sends the turn again. While auto-retry is armed the button reads **Retry now anyway**: use it when you know the limit has lifted.
- In any session that is waiting for your reply, a new message continues it with its context.

## When it is in Trash

A session moved to Trash stays there for 30 days. Open it and press **Restore to Open**.

Full guide: [Onboarding, step 7](../../onboarding.md#7-recovery-when-a-run-stops).
