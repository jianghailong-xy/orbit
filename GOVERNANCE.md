# Governance

Orbit currently uses a maintainer-led governance model. This document makes the present decision process
explicit and defines a path for the project to become less dependent on any one person or organization.

## Roles

- **Contributors** report issues, improve documentation, submit changes, and participate in design discussion.
- **Reviewers** are trusted contributors who regularly review changes in an area and help other contributors
  reach the project's quality bar.
- **Maintainers** can merge changes, manage releases and repository settings, respond to security and conduct
  reports, and are accountable for the health of the project.

Roles are earned through sustained, constructive participation. Maintainers may nominate a contributor as a
reviewer or maintainer based on technical judgment, reliability, review quality, communication, and care for
users—not simply commit count.

## Decisions

Routine fixes and small improvements are decided through pull-request review. Substantial changes should begin
with a public issue that explains the problem, alternatives, compatibility impact, and rollout plan. Examples
include schema or protocol changes, new runtime support, security-boundary changes, major dependencies, and
changes to product positioning or governance.

The project prefers rough consensus supported by evidence. Maintainers are responsible for making a clear
decision when discussion converges or stalls, documenting important tradeoffs, and avoiding indefinite design
debate. Until the project has multiple active maintainers, the repository owner has final responsibility for
merge and release decisions.

Security incidents, embargoed vulnerabilities, personal conduct reports, signing credentials, and other
sensitive matters may be handled privately. Outcomes should be disclosed publicly when doing so is safe and
useful.

## Releases

Maintainers choose release scope, confirm the required checks, write human-readable release notes, and publish
artifacts through the repository's release workflow. A release must have one unambiguous version across its
tag, application metadata, artifacts, and release notes.
See the [release process](docs/release-process.md) for the public checklist and the [community guide](COMMUNITY.md)
for response targets and channel ownership.

## Community operations

Questions, early ideas, release feedback, and showcases belong in [GitHub Discussions](https://github.com/jianghailong-xy/orbit/discussions);
reproducible bugs and scoped work belong in Issues. Maintainers keep the [public roadmap](ROADMAP.md), labels,
Issue Forms, and good-first-issue list current so that contributors can find an independently reviewable entry
point. The response targets in the community guide are volunteer targets, not a support SLA.

## Maintainer responsibilities

Maintainers are expected to:

- review or acknowledge community reports in a reasonable time;
- protect secrets, signing identities, and package/release accounts;
- require review and automated checks for production changes;
- disclose conflicts of interest that could materially affect a decision;
- keep contribution, security, support, and release policies accurate;
- make access revocable and avoid concentrating every critical credential in one account;
- nominate additional maintainers when contributors have earned that trust.

Inactive maintainers may step down or be moved to emeritus status. Access should be removed promptly when it is
no longer needed.

## Amendments

Governance changes are proposed through a pull request with public rationale. Material changes should remain
open long enough for active contributors to comment. The current maintainers approve amendments until a more
formal voting model is adopted.
