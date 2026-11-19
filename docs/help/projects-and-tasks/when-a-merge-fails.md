---
title: A task can't merge to main
summary: What a landing conflict or failed merge check means, and how to get the work merged.
category: projects-and-tasks
routes: [/projects/:id, /projects/:id/landings, /projects/:id/tasks/:taskId, /tasks/:id]
errors: [landing.conflict, landing.checks-failed, landing.error]
platforms: [web, macos, ios, android]
common: true
updated: 2026-11-14
---

Landing merges a task's work with the latest code and runs the merge check on the combined tree. When either step fails, nothing is pushed and the task keeps its work.

## What the task says

| Status | What happened |
| --- | --- |
| **Landing conflict** ("Could not merge · conflict") | The task's changes and newer changes touch the same lines. |
| **Landing checks failed** ("checks failed · exit N after …") | The merge worked, but the merge check failed on the combined tree. |
| **A check timed out on the combined tree** | The check ran past its time limit. |
| **Landing error** ("Stopped with an error") | Something else stopped it, such as the machine going away. |

The landing's page also says whether anything was pushed. "Nothing was pushed" means main is untouched.

## What to do

1. Open the landing from the task or from the project's **Landings** window, and read the failure. For a failed check, the output shows which test broke.
2. Pick an action:
   - **Retry** runs the landing again, for example after a flaky test or a machine coming back.
   - **Re-run the check** ends this check and queues the next one on the same candidate.
   - **Abandon** only ends it; the work goes back to you.
3. For a conflict or a real test failure, the fix is new work: ask the task's session, or the project's coordinator, to rebase onto the latest main and fix it. Use **Open Task** or **Open Coordinator** to get there.

With **Automatic** on, the coordinator handles conflicts and failed checks itself; you see **Coordinator is resolving it**. When it cannot, the card says **It is yours**.

Full guide: [Merging to main](orbit:/help/projects-and-tasks/merging-to-main) and [Onboarding, step 7](../../onboarding.md#7-recovery-when-a-run-stops).
