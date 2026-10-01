# Orbit first-launch copy pack

This is a ready-to-edit set of opening lines, announcements, and calls to action for the first
public GitHub launch. It is subordinate to the [canonical messaging brief](messaging-brief.md):
keep the category line, core promise, scenario names, and pre-1.0 statement verbatim. Replace every
`[placeholder]` with evidence from the exact tag or commit being announced; do not publish a guessed
metric or an unverified release claim.

## Link set

Use these destinations consistently:

- Product and install: [README](../README.md)
- 90-second walkthrough: [demo storyboard](90-second-demo.md)
- Safe first checkout: [demo repo](../examples/demo-repo/)
- Long-running work article: [When a coding task outlives a context window](article-durable-agent-work.md)
- Private multi-runtime article: [A control plane for private, multi-runtime agent work](article-private-multi-runtime-control-plane.md)
- Operations: [self-hosting guide](self-hosting.md)
- Security: [security policy](../SECURITY.md)
- Community: [community guide](../COMMUNITY.md)

Each channel posts its own link from the [launch tracking plan](launch-tracking.md#channel-link-identifiers).

## Canonical opening and boundary

> **Orbit is self-hosted mission control for coding agents.**
>
> Run coding agents on your own machines. Keep the plan, history, and controls in one self-hosted place.

Use the three scenarios in this order whenever a launch post names product behavior:

1. **Work that outlives a chat**
2. **Parallel agents without checkout collisions**
3. **Access to private infrastructure**

Close a first-launch post with:

> Orbit is pre-1.0. It coordinates and supervises agent work; it is not a hosted service or a security sandbox.
> Pin a tagged release, follow the hardening guide, and review the limits before using it.

## GitHub release opening

Paste this at the top of release notes, then fill in the bracketed evidence.

> Orbit is self-hosted mission control for coding agents. Run coding agents on your own machines. Keep the plan,
> history, and controls in one self-hosted place.
>
> This release demonstrates **Work that outlives a chat**, **Parallel agents without checkout collisions**, and
> **Access to private infrastructure**. See the [90-second demo](90-second-demo.md), try the [demo repo](../examples/demo-repo/),
> and follow the [Quick Start](../README.md#quick-start).
>
> **What changed:** [two or three user-visible changes]
>
> **Verification:** `[tag / full commit]`; [clean-install evidence](evidence/clean-install-2026-09-29.md);
> `[CI or client evidence links]`.
>
> **Upgrade impact:** [migration, configuration, restart, or rollback note; say “none” only when checked].
>
> **Known limits:** runtime feature parity and resume behavior vary by provider; worktrees reduce file collisions
> but are not a security boundary; operators own TLS, host hardening, backups, and access controls.
>
> Orbit is a pre-1.0 open-source project under active development. Pin deployments to a tagged release and
> review upgrade notes before changing versions. The latest published release receives best-effort security fixes;
> `main` is a development branch and older releases are not supported.

## GitHub Discussion announcement

**Title:** Orbit — self-hosted mission control for coding agents

**Body:**

> We are opening Orbit for teams that already run coding agents against private code or internal systems and need
> work to span sessions, machines, and context windows without losing visibility or human control.
>
> Orbit runs the control plane on infrastructure you operate and executes agents on runners you choose. The first
> walkthrough follows three scenarios:
>
> - **Work that outlives a chat:** task graphs, dependencies, comments, and resumable sessions keep a multi-day
>   migration or test rescue legible.
> - **Parallel agents without checkout collisions:** optional per-session worktrees make concurrent diffs reviewable;
>   a person still decides what to merge.
> - **Access to private infrastructure:** outbound-polling runners stay beside the repositories, CLIs, VPNs, and
>   internal networks they need; risky commands can stop at an approval card.
>
> Start with the [README](../README.md), run the [demo repo](../examples/demo-repo/), and watch the
> [90-second storyboard](90-second-demo.md). Questions, corrections, and small deployment reports are welcome in
> this thread.
>
> Orbit is pre-1.0, self-hosted, and not a security sandbox or managed service. Please read the
> [self-hosting](self-hosting.md) and [security](../SECURITY.md) guidance before attaching sensitive infrastructure.

## Short social post

> Orbit is self-hosted mission control for coding agents.
>
> Run agents on your own machines. Keep the plan, history, and controls in one self-hosted place.
>
> 90-sec walkthrough → `[demo URL]`
> Try the fixture → `[demo-repo URL]`
> Read the limits → `[README URL]`

Use the exact scenario names only if the post has room; otherwise link the full [demo storyboard](90-second-demo.md).

## Longer social / newsletter version

> A coding agent is easy to start and surprisingly hard to supervise across a week.
>
> Orbit puts the durable task graph, session history, approvals, and runner status in one self-hosted control plane,
> while execution stays beside the repositories and internal tools you choose. The launch walkthrough shows work that
> outlives a chat, parallel agents without checkout collisions, and access to private infrastructure.
>
> It is pre-1.0 and deliberately bounded: worktrees are not sandboxes, providers differ, and operators own TLS,
> host hardening, backups, and the merge decision.
>
> [README](../README.md) · [90-second demo](90-second-demo.md) · [demo repo](../examples/demo-repo/)

## Maintainer reply snippets

### Is this hosted?

> No. You run the control plane and PostgreSQL, register runners, install and authenticate a runtime on those
> runners, and choose the network and access controls. Start with the [self-hosting guide](self-hosting.md).

### Is a worktree a sandbox?

> No. A worktree reduces checkout collisions between concurrent sessions. Processes still run as the runner OS
> account and can access whatever that account can access.

### Can it finish a project without review?

> Orbit coordinates and supervises agents; it does not guarantee that an agent finishes correctly without review,
> approval, or a human merge decision.

### Which runtimes are supported?

> Claude Code, Codex, Kimi Code, and OpenCode are supported, with configured compatible providers where applicable.
> Install and authenticate the runtime on the runner; feature parity and resume behavior vary by provider.

## Design-partner call to action

Use this only when a maintainer can follow up personally and the partner has read the boundaries.

> We are looking for a few small engineering or infrastructure teams that already run agents against private code.
> A design partnership means trying one concrete workflow with a pinned Orbit revision, sharing what was useful or
> confusing, and deciding together whether a short, fact-checked case study is worth publishing. There is no promise
> of hosted support, a feature date, or a positive result. If this sounds like your environment, open a Discussion
> with the workflow, runtime, and network constraints you can safely describe.

Use the [case-study template](design-partner-case-study-template.md) internally; never ask a partner to disclose
credentials, private URLs, or sensitive topology in a public thread.

## Launch checklist

Before publishing any variant:

- `[ ]` The exact tag or commit is named and reproducible.
- `[ ]` The README, demo, and this copy use the canonical category, promise, and scenario order.
- `[ ]` Clean-install, CI, security/operations, and version evidence are linked or explicitly marked as pending.
- `[ ]` Installation copy sits next to HTTPS, least-privilege, backup, and restore guidance.
- `[ ]` No “autonomous,” “sandbox,” “SaaS,” “SLA,” compliance, or exact-recovery promise slipped in.
- `[ ]` Any metric has a baseline, method, date, and source.
- `[ ]` Screenshots and partner quotes have written permission and are redacted.
- `[ ]` A maintainer has a correction/removal contact and a rollback plan for the post.
