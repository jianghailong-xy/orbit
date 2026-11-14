# Orbit public roadmap

This is a lightweight direction map for the public project. It is intentionally organized as **now / next /
later**, not dated promises. A roadmap item is a direction, not a commitment to a release or a support level.
The [launch messaging brief](docs/messaging-brief.md) remains the source of truth for the audience, promise,
scenarios, and public boundaries.

## Now

- Make self-hosting, runner enrollment, and first-task setup easy to verify from a clean machine, and keep
  the dated clean-install evidence current.
- Keep the server, web, Go runner, and native clients on one clearly documented pre-1.0 release line with a
  single version of record and verifiable release artifacts.
- Keep the public roadmap and the [curated changelog](CHANGELOG.md) current, and collect release feedback in
  the fixed [release feedback discussion](https://github.com/jianghailong-xy/orbit/discussions/159).
- Keep contributor discovery current: guides, Issue Forms, Discussions, labels, and independently scoped
  `good first issue` tasks that state scope, environment, acceptance checks, and maintainer response cadence.
- Keep security, backup, upgrade, and trust-boundary guidance adjacent to installation instructions.

## Recently shipped

These are reflected in the [changelog](CHANGELOG.md) and the current guides; they are no longer "next":

- A public entrance that ships current-UI screenshots and a four-step product demo, with the checked-in
  90-second storyboard as its recording source ([public website](https://jianghailong-xy.github.io/orbit/)).
- Screenshot-led first-run journeys for the first administrator, runner, workspace, session, task graph,
  approval, and recovery ([onboarding guide](docs/onboarding.md)).
- A complete operator configuration reference ([configuration reference](docs/configuration.md)) and an
  external HTTP API reference generated from the supported controllers ([API reference](docs/api-reference.md)).
- Release artifacts with checksums, an SBOM, SLSA provenance, and an artifact attestation, plus the commands
  that verify them ([supply chain guide](docs/supply-chain.md)).
- A curated changelog, a fixed release feedback entry, and a documented contributor funnel
  ([community guide](COMMUNITY.md)).

## Next

- Complete the v1.0 readiness review, and publish compatibility, migration, and support guarantees only after
  the evidence gates in the [maturity record](docs/project-maturity.md) are met.
- Complete the OpenSSF best-practices baseline so the project's security and contribution posture are
  independently checkable.
- Grow maintainer coverage beyond one active maintainer, with tested succession, incident-response, and
  account-recovery routines.
- Use the release feedback thread to drive a visible roadmap and changelog update each cycle, and retire
  `good first issue` tasks that go stale or gain an owner.

## Later

- Add inbound task sources and recurring schedules after their operational and security boundaries are ready.
- Version the user and operator documentation when stable releases need different migration instructions.
- Any change to the project name, repository organization, domain, or release accounts is a project-owner
  decision. This roadmap neither schedules nor authorizes it, and no other work waits on it.

## How to influence the roadmap

Start with a **Discussion → Ideas** post when the problem or tradeoff is still being explored. Once the scope
and acceptance checks are clear, open an Issue or a pull request and link back to the discussion. Small,
independent documentation and test improvements can use the [good first issue
list](https://github.com/jianghailong-xy/orbit/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).

For a release you have upgraded to, reply in the [release feedback
discussion](https://github.com/jianghailong-xy/orbit/discussions/159). Maintainers read it on the
[community response convention](COMMUNITY.md#maintainer-response-convention) and publish project updates on
the [community update cadence](COMMUNITY.md#community-update-cadence).

The roadmap does not override the current implementation. Check the [documentation index](docs/README.md),
the [changelog](CHANGELOG.md), and the [release notes](https://github.com/jianghailong-xy/orbit/releases) for
what is available today.
