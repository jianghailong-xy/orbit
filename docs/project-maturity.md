# Project maturity and brand roadmap

Audit date: 2026-08-19

## Executive conclusion

Orbit already has the hardest part of an open-source brand: a differentiated product with real operational
depth. Distributed runners, durable task graphs, human approvals, isolated worktrees, multiple coding-agent
runtimes, and web/native clients form a credible product story. The mark and blue visual system are also
coherent across app surfaces.

What it does not yet have is an independent project's trust and continuity layer. At the time of this audit,
the repository lived under a personal account, had no project homepage or topics, no custom social image, no
public discussion space, a minimal public release history, and no visible community or security policy. The
documentation was dominated by a long README and implementation design records. Native-client CI existed,
but there was no repository-wide CI gate for the server, web client, and Go runner. A clean
`npm audit --omit=dev` also reported 12 production dependency findings, including 3 rated high; these require
reachability and upgrade triage rather than an assumption that every advisory is exploitable.

The key principle is: **brand maturity is a repeated promise backed by operating evidence, not a logo pass.**
Orbit should build identity, trust, distribution, and governance together.

This documentation pass establishes a public entry layer—short README, documentation index, user/operator
guides, brand usage, contribution, governance, security, support, conduct, and issue/PR templates. The
remaining work depends on project-owner decisions and repository or service configuration.

## Brand platform

### Category

Self-hosted mission control for coding agents.

“Agent platform” is too broad and “multi-agent desktop” understates the durable queue, distributed runners,
and project-level coordination. “Mission control” is useful because it implies supervision, visibility,
coordination, and intervention rather than a claim of full autonomy.

### Primary audience

- Small engineering and infrastructure teams running agents against private code and internal systems.
- Developers coordinating several coding-agent sessions across machines.
- Operators who need agent work to remain visible, resumable, and reviewable beyond a terminal session.

### User problem

Coding agents are effective inside one session, but projects span multiple sessions, machines, repositories,
people, approvals, and context windows. The plan and operational control are fragmented across terminals and
chat histories.

### Promise

Orbit keeps agent work running on your machines while preserving the plan, history, and human control in one
self-hosted system.

### Proof pillars

1. **Durable work:** task lists, dependencies, comments, resumable conversations, and searchable history.
2. **Local execution:** outbound-only runners execute beside the tools, repositories, and credentials they
   need.
3. **Supervised parallelism:** worktree isolation, permission modes, live approvals, status, and usage across
   web, macOS, and iOS.

### Personality

Calm, precise, capable, and honest about boundaries. Orbit should feel like an operations tool that happens to
be elegant, not a speculative AI demo.

## Messaging hierarchy

Use one stable message at each level:

| Level | Recommended message |
| --- | --- |
| Name | Orbit |
| Descriptor | Agent Mission Control |
| Category line | Self-hosted mission control for coding agents |
| One sentence | Run coding agents on your own machines and keep the plan, history, and controls in one place. |
| Primary proof | Durable task graph + distributed runners + human approvals |
| Secondary proof | Multi-runtime support, isolated worktrees, and web/native clients |

Feature lists should follow the proof pillars instead of presenting every capability at equal weight. Lead
with the durable project and distributed-runner difference; model-provider logos and generic chat features are
supporting evidence, not the category.

## The name is the largest brand risk

“Orbit” is memorable and fits the mission-control metaphor, but it is highly saturated across software. More
seriously, [another active project already uses **Orbit**](https://github.com/xinnaider/orbit) for a desktop
application that runs multiple Claude Code, Codex, and OpenCode agents with worktree isolation, web access,
and orchestration. That is not a distant dictionary-name collision; it overlaps the same search terms,
audience, and product category.

The recommended decision before investing in a domain, package distribution, content, or v1.0 launch is to
select a more distinctive project name. If the project retains Orbit, it should at minimum use a cleared
compound identity such as “Orbit Mission Control” consistently and accept continuing search and attribution
friction. A descriptor improves recognition but may not solve legal or namespace conflicts.

A naming process should:

1. Write a brief around the durable-project, distributed-runner, and human-control promise.
2. Shortlist names that work as a product, GitHub organization, domain, CLI/package namespace, and app name.
3. Search GitHub, search engines, package registries, app stores, Homebrew, social accounts, domains, and
   relevant trademark databases in target markets.
4. Obtain professional legal clearance before a commercial or high-visibility launch.
5. Migrate with a dual-name period, repository redirects, CLI compatibility plan, and explicit release notes.

Do not commission more logo production until this decision is made. A rename is cheapest before a stable
release and external contributor ecosystem exist.

## Workstreams

### 1. Project identity and discovery

- Move from a personal repository namespace to a project organization after the name decision.
- Secure a project-owned domain and stable URLs for website, documentation, security, and downloads.
- Set a specific GitHub description, homepage, topics, and a custom Open Graph/social image.
- Publish a product screenshot or short narrated demo showing task graph → parallel runners → approval →
  result. The current brand preview is not a product demo.
- Keep one canonical one-liner, feature order, icon, and color system across GitHub, website, app metadata,
  installers, releases, and social profiles.
- Add a trademark policy once the name is cleared and ownership is decided.

Suggested repository topics after the name decision: `coding-agents`, `ai-agents`, `self-hosted`,
`developer-tools`, `task-orchestration`, `claude-code`, `codex`, `opencode`, `golang`, `typescript`.

### 2. Documentation and onboarding

- Test the self-hosting guide from a clean machine and automate its smoke test.
- Add an operator configuration reference for every environment variable, port, storage path, and retention
  setting.
- Add user journeys with screenshots: first workspace, first runner, first session, first task graph, approval,
  and merge/recovery.
- Publish an API reference or generated OpenAPI document for external interfaces.
- Separate current guides from historical design records and mark superseded documents explicitly.
- Adopt versioned documentation once stable releases need different instructions.
- Decide the localization policy. Keep English canonical for public contribution while adding a maintained
  Simplified Chinese entry page only if the team can keep both versions synchronized.

### 3. Community and governance

- Enable GitHub Discussions for questions, ideas, showcases, and release feedback; keep Issues actionable.
- Create a public roadmap with `now / next / later`, avoiding dates that are not commitments.
- Establish a project-owned conduct and security address rather than relying on a personal profile.
- Recruit at least one additional maintainer and document ownership for server, runner, web, and native code.
- Add `CODEOWNERS` only after those owners have agreed to the responsibility.
- Publish a response and deprecation policy that matches volunteer capacity.
- Decide explicitly whether MIT plus inbound=outbound is sufficient or whether a DCO/CLA is needed. Do not add
  contributor paperwork without a concrete legal or relicensing need.

### 4. Release and distribution trust

- Reconcile the version sources. During this audit, the root package version, Git tags, and latest GitHub
  Release did not tell one coherent release story.
- Define SemVer for the whole product, prerelease channels, support window, and artifact naming.
- Write human-curated release notes with upgrade impact and security fixes; generated commit notes alone are
  insufficient for operators.
- Publish checksums for downloadable binaries and document how users verify them. Evaluate signed provenance
  and an SBOM for each release.
- Make the server, web, runner, and native-client build/test suites required checks on pull requests.
- Add dependency updates, secret scanning, dependency review, static analysis, and an OpenSSF Scorecard.
- Protect `main`, require review, prevent force pushes, and minimize release-token permissions.
- Document the legal relationship between the open-source project and the entity that owns Apple signing or
  distribution accounts.

### 5. Independent operations

- Put the repository, domains, DNS, release accounts, Apple credentials, and signing keys under project-owned
  or transparently sponsored accounts with at least two recoverable administrators.
- Require phishing-resistant 2FA where supported and store recovery material in a shared, access-controlled
  system.
- Separate contributor, maintainer, security-response, and release permissions.
- Document backup, key rotation, maintainer succession, incident response, and project archival procedures.
- Track recurring costs and sponsorship separately from any maintainer's personal accounts.
- If a company sponsors the project, state what it owns, what maintainers decide, and what happens if
  sponsorship ends.

## Phased plan

### Phase 0 — credible public baseline (0–2 weeks)

- Merge and verify the new documentation/community layer.
- Decide whether to rename; pause additional identity production until the decision.
- Add repository-wide CI for TypeScript, Go, and Swift core checks.
- Configure GitHub description, topics, homepage, social preview, Discussions, and private vulnerability
  reporting.
- Publish one coherent prerelease with human-written notes and install verification.

**Exit signal:** a new visitor can identify the product, install it, find support/security guidance, and run
the same checks as a contributor without private knowledge.

### Phase 1 — recognizable project (2–6 weeks)

- Complete the name migration or consistently deploy the cleared compound identity.
- Launch a small project website with product story, demo, docs, releases, and community links.
- Add screenshot-led onboarding and a configuration/API reference.
- Publish roadmap, changelog, release policy, checksums, and upgrade notes.
- Establish project-owned contact addresses and account ownership.

**Exit signal:** search results, repository, website, installers, and apps all resolve to one unambiguous
identity and release channel.

### Phase 2 — independently operable (6–12 weeks)

- Transfer to a project organization with two or more administrators and maintainers.
- Enable branch protection, ownership review, dependency/security automation, provenance, and SBOMs.
- Run a backup restore, credential-recovery exercise, vulnerability-response tabletop, and maintainer handoff.
- Apply for the [OpenSSF Best Practices badge](https://www.bestpractices.dev/en/criteria/0) and close the
  evidence gaps it exposes.
- Publish a regular release and community update cadence that the maintainers can sustain.

**Exit signal:** the project can publish, respond, recover, and continue when the original author is
temporarily unavailable.

### Phase 3 — v1.0 readiness

- Define and meet compatibility, migration, security-support, and documentation standards for v1.0.
- Validate installation and upgrade paths on supported platforms from a clean environment.
- Resolve all critical trust-boundary documentation and release-supply-chain gaps.
- Publish a governance review, stable roadmap, and explicit support matrix.

**Exit signal:** users can make a reasoned production adoption decision from public evidence rather than
maintainer assurances.

## Metrics

Avoid optimizing for stars alone. Track a small funnel tied to project health:

- **Discovery:** repository/website visitors who reach install or documentation pages.
- **Activation:** clean installations that connect a runner and complete a first session or task.
- **Reliability:** upgrade success, runner recovery, backup verification, and time to resolve regressions.
- **Community:** first-time issue authors, first-time contributors, review turnaround, and repeat contributors.
- **Continuity:** active maintainers, ownership coverage, release bus factor, and tested account recovery.
- **Trust:** vulnerability response time, required-check pass rate, signed/verifiable releases, and current
  supported-version documentation.

The brand becomes mature when these signals consistently substantiate the promise: durable agent work, on the
user's machines, under visible human control.
