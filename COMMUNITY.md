# Community guide

This guide is the map for people who want to use, discuss, or improve Orbit. Orbit is aimed at small
engineering and infrastructure teams that run coding agents against private code or internal systems, plus
individual power users coordinating several agent sessions across machines. Read the [positioning
brief](docs/messaging-brief.md) for the public promise and its boundaries.

## Start here

| I want to… | Start with |
| --- | --- |
| Understand what is planned | [Public roadmap](ROADMAP.md) |
| Read what changed recently | [Public changelog](CHANGELOG.md) |
| Give feedback on a release | [Release feedback discussion](https://github.com/jianghailong-xy/orbit/discussions/159) |
| Install or operate Orbit | [Documentation index](docs/README.md) and [self-hosting guide](docs/self-hosting.md) |
| Contribute code or docs | [Contributing guide](CONTRIBUTING.md) |
| Ask a question or share a use case | [GitHub Discussions](https://github.com/jianghailong-xy/orbit/discussions) |
| Read or share a workflow story | [Long-running work article](docs/article-durable-agent-work.md) and [private multi-runtime article](docs/article-private-multi-runtime-control-plane.md) |
| Explore a design partnership | [Case-study template](docs/design-partner-case-study-template.md) |
| Report a reproducible problem | [New bug report](https://github.com/jianghailong-xy/orbit/issues/new?template=bug_report.yml) |
| Propose a product change | [New feature request](https://github.com/jianghailong-xy/orbit/issues/new?template=feature_request.yml) |
| Pick a small task | [Good first issues](https://github.com/jianghailong-xy/orbit/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) |
| Report a vulnerability | [Security policy](SECURITY.md) (never use a public issue) |
| Report a conduct concern | [Code of Conduct](CODE_OF_CONDUCT.md) |

## Which channel to use

### Discussions

Use Discussions for questions, proposed direction, release feedback, and examples of Orbit in use. The
maintainers use these categories:

- [**Q&A**](https://github.com/jianghailong-xy/orbit/discussions/categories/q-a) — installation, configuration, and usage questions.
- [**Ideas**](https://github.com/jianghailong-xy/orbit/discussions/categories/ideas) — an early problem statement or a possible future capability. Move an idea to Issues once its
  scope and acceptance criteria are clear.
- [**Show and tell**](https://github.com/jianghailong-xy/orbit/discussions/categories/show-and-tell) — deployments, integrations, workflows, and demos from the community.
- [**Announcements**](https://github.com/jianghailong-xy/orbit/discussions/categories/announcements) — maintainer-owned release, deprecation, and project updates.

Release feedback has one fixed, standing thread: [**Release feedback · how did the upgrade go?**](https://github.com/jianghailong-xy/orbit/discussions/159).
Reply there after upgrading to a tagged release with the tag, the deployment shape, whether the notes and
upgrade steps matched, and sanitized evidence. Maintainers read it within the response targets below and fold
recurring points into the roadmap, changelog, and next release notes. Use Issues for a reproducible bug or a
scoped change; a release thread is not a substitute for an actionable report.

Discussions are conversational and do not promise implementation. Link a relevant roadmap item or issue when
one exists so that useful context is not lost.

### Issues

Use Issues for one reproducible bug, one scoped feature proposal, one documentation gap, or one independently
reviewable task. Search first, choose the closest Issue Form, and include a release/tag or commit SHA when the
behavior depends on a version. Keep security details and personal information out of public Issues.

The repository keeps blank Issues disabled so that reports arrive with the minimum context maintainers need.
Questions that do not describe an actionable defect belong in Discussions.

### Pull requests

A pull request should solve one problem and use the repository template. Explain the user or operator impact,
verification performed, and any migration, compatibility, security, release, or rollback concern. Small docs,
test, and bug fixes may go directly to a pull request; large features, protocol/schema changes, new
dependencies, and visible redesigns should begin with an Issue or Discussion.

## Labels and triage

Maintainers keep labels deliberately small and composable:

| Label family | Values | Use |
| --- | --- | --- |
| Type | `bug`, `enhancement`, `documentation`, `question` | What kind of conversation this is |
| Area | `area:api`, `area:runner`, `area:web`, `area:native`, `area:docs`, `area:ops` | Which part of the project is affected |
| State | `status:needs-triage`, `status:ready`, `status:blocked` | What a contributor should do next |
| Participation | `good first issue`, `help wanted` | Suitable for a new contributor or extra help |
| Automation | `dependencies`, `docker`, `github_actions`, `javascript`, `swift_package_manager` | Bot or ecosystem metadata |

`good first issue` means that the scope, files, acceptance checks, and likely approach are written down and a
contributor can complete it without another Issue. Maintainers remove that label when the task becomes stale,
already has an owner, or needs design work first. The live list is the [good first issue query](https://github.com/jianghailong-xy/orbit/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).

The completed first batch (#93–#97) added the clean-machine checklist, the runner troubleshooting decision
tree, the release verification and rollback checklist, the configuration reference, and the documentation
check. The current open tasks are:

- [#160 Add a glossary of Orbit terms](https://github.com/jianghailong-xy/orbit/issues/160)
- [#161 Add a deployment secret-rotation runbook](https://github.com/jianghailong-xy/orbit/issues/161)
- [#162 Add copy-paste TLS reverse-proxy examples for the Compose gateway](https://github.com/jianghailong-xy/orbit/issues/162)
- [#163 Add an end-to-end first-contribution walkthrough](https://github.com/jianghailong-xy/orbit/issues/163)
- [#164 Add a runner error-message index](https://github.com/jianghailong-xy/orbit/issues/164)

## Maintainer response convention

Orbit is a volunteer, pre-1.0 project; these are response targets, not an SLA:

- acknowledge a new Issue, Discussion, or release feedback reply within **3 business days**;
- add an initial triage decision, owner, or request for missing information within **7 business days**;
- acknowledge a pull request within **5 business days** when it is ready for review;
- summarize the decision, next action, or reason for closing in the thread so the record remains useful;
- revisit `status:blocked` items when the blocking decision or dependency changes, rather than silently leaving
  them open.

Security reports follow the stricter private process and targets in [SECURITY.md](SECURITY.md). Conduct
reports are handled privately under the [Code of Conduct](CODE_OF_CONDUCT.md). No public channel promises a
fix date, a support contract, or emergency response.

## Community update cadence

Maintainers keep the public record current on a cadence a small volunteer team can sustain:

- **Each release:** publish the operator notes with the tag, move the `Unreleased` entries in the
  [changelog](CHANGELOG.md) under the new version, announce the release in Announcements, and link the
  release feedback thread.
- **Monthly, in the first business week:** review open Issues and Discussions against the
  [roadmap](ROADMAP.md) and changelog, sweep `good first issue` tasks for stale scope, an owner, or completed
  work, and post a short Announcements update when direction or priorities changed.
- **Quarterly:** review the response targets, label set, Issue Forms, and maintainer coverage, and record a
  change in this guide, [GOVERNANCE.md](GOVERNANCE.md), or the roadmap.
- **When a decision is made:** summarize the decision and its reason in the thread that raised it, so the
  public record explains the outcome rather than only the request.

These are volunteer targets, not an SLA. A quiet month is reported as quiet rather than filled with invented
progress, and a cadence item that cannot be kept is moved or dropped in public.

## Releases and current support

The [release process](docs/release-process.md) describes tags, release notes, checks, artifacts, and upgrade
communication. Releases use one `vX.Y.Z` (or `vX.Y.Z-beta.N`) tag for the product; the tag-triggered workflow
builds the native artifacts. Release notes must state the user-visible changes, upgrade impact, known limits,
verification evidence, and the exact commit or tag. `main` is a development branch, not a supported release.

The [curated changelog](CHANGELOG.md) summarizes notable changes across releases and links each version's
operator notes. Release feedback is collected in the fixed [release feedback
thread](https://github.com/jianghailong-xy/orbit/discussions/159), not in the changelog.

The latest release and all prereleases are listed on the [GitHub Releases page](https://github.com/jianghailong-xy/orbit/releases).

## Current guides versus design history

The [documentation index](docs/README.md) separates current user/operator/contributor guides from architecture
and design records. Current guides, source code, and release notes are authoritative for behavior. Files with a
`design`, `contract`, `proposal`, `evidence`, `mocks`, or `superpowers` name record reasoning or historical
evidence; they are valuable context but are not promises that an unreleased design is implemented. When code
diverges from a historical decision, append an implementation-differences note and update the nearest current
guide instead of rewriting history.
