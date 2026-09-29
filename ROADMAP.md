# Orbit public roadmap

This is a lightweight direction map for the public project. It is intentionally organized as **now / next /
later**, not dated promises. A roadmap item is a direction, not a commitment to a release or a support level.
The [launch messaging brief](docs/messaging-brief.md) remains the source of truth for the audience, promise,
scenarios, and public boundaries.

## Now

- Make self-hosting, runner enrollment, and first-task setup easy to verify from a clean machine.
- Keep the server, web, Go runner, and native clients on one clearly documented pre-1.0 release line.
- Improve contributor discovery: current guides, Issue Forms, Discussions, labels, and independently scoped
  `good first issue` tasks.
- Keep security, backup, upgrade, and trust-boundary guidance adjacent to installation instructions.

## Next

- Publish a complete configuration and API reference generated from the supported interfaces.
- Add screenshot-led first-run journeys for a workspace, runner, task graph, approval, and merge/recovery.
- Make release artifacts easier to verify with checksums, provenance, and a documented support window.
- Move repository, domain, and release ownership toward a project account with more than one recoverable
  maintainer.

## Later

- Add inbound task sources and recurring schedules after their operational and security boundaries are ready.
- Version the user/operator documentation when stable releases need different migration instructions.
- Expand maintainer coverage and publish tested succession, incident-response, and account-recovery routines.

## How to influence the roadmap

Start with a **Discussion → Ideas** post when the problem or tradeoff is still being explored. Once the scope
and acceptance checks are clear, open an Issue or a pull request and link back to the discussion. Small,
independent documentation and test improvements can use the [good first issue list](https://github.com/jianghailong-xy/orbit/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).

The roadmap does not override the current implementation. Check the [documentation index](docs/README.md) and
the [release notes](https://github.com/jianghailong-xy/orbit/releases) for what is available today.
