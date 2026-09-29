# Orbit in 90 seconds

This is the checked-in storyboard for a short GitHub demo. It is intentionally evidence-led: record the three
scenes in order, keep the runner and repository names visible, and do not imply that a worktree is a security
sandbox or that an agent works without supervision. A screen recording can follow this script verbatim; the
repository currently ships the storyboard and UI preview rather than claiming a hosted video URL.

## Opening (0:00–0:08)

Say:

> Orbit is self-hosted mission control for coding agents. Run coding agents on your own machines. Keep the plan,
> history, and controls in one self-hosted place.

Show the Orbit project page and the runner list. Keep the product name and the runner's online indicator in frame.

## Scene 1 — Work that outlives a chat (0:08–0:32)

1. Open a project with a task list containing a migration or test-rescue task.
2. Expand one dependency so the prerequisite and the waiting task are visible.
3. Open the associated session, show a result and a comment, then close/reopen the browser or switch to a fresh
   session.
4. Return to the same task graph and history; do not claim that the agent completed the work without review.

Narration:

> The plan is a durable task graph, not a chat transcript. Dependencies, comments, and session history survive a
> context limit, a restart, or a closed browser, so the next session can continue without reconstructing the plan.

## Scene 2 — Parallel agents without checkout collisions (0:32–0:56)

1. Dispatch two independent tasks to a workspace with per-session worktree isolation enabled.
2. Show the two sessions and their separate worktree/branch names.
3. Open one diff, then show the merge-review card and the human merge action.

Narration:

> Two tasks can run at once in separate git worktrees. That reduces file collisions; it is not a security boundary.
> Orbit shows the diffs and leaves the merge decision to a person.

## Scene 3 — Access to private infrastructure (0:56–1:18)

1. Show a runner whose checkout is on the private-network machine, alongside its heartbeat/online status.
2. Start a task that needs the internal CLI, VPN, or cluster access already present on that machine.
3. Pause on the approval card for the risky command; show the exact command, Allow/Deny, transcript, and outcome.

Narration:

> The runner polls outward from the machine that already has the repository and internal tools. A risky command
> can stop at an approval card before it proceeds. The runner account still has the OS access its operator gave it.

## Close (1:18–1:30)

Say:

> Orbit is pre-1.0. It coordinates and supervises agent work; it is not a hosted service or a security sandbox.
> Pin a tagged release, follow the hardening guide, and review the limits before using it.

End on the [Quick Start](../README.md#quick-start) link and leave the [Security](../SECURITY.md) and
[Self-hosting](self-hosting.md) links visible.

## Recording checklist

- Use a tagged or explicitly named commit and record it with the clean-host evidence.
- Redact repository names, hostnames, tokens, cookies, internal URLs, and provider account details.
- Use a real runner heartbeat and a real approval card; do not use a static mock as evidence of a live deployment.
- If a scene is a design preview, label it as such. The repository's [UI preview](mocks/project-progress/04-merge-to-main.png)
  is annotated design evidence, not a claim that the public hosted service exists.
- Link the [canonical messaging brief](messaging-brief.md) when publishing the recording so future edits preserve
  the category line, core promise, scenario order, and pre-1.0 boundary.

## Launch package handoff

Pair this storyboard with the [long-running-work article](article-durable-agent-work.md), the
[private multi-runtime article](article-private-multi-runtime-control-plane.md), and the
[first-launch copy pack](launch-copy.md). Use the [design-partner case-study template](design-partner-case-study-template.md)
to collect any partner story shown in the recording, and link the [demo repo fixture](../examples/demo-repo/)
for a reproducible first checkout.
