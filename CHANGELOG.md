# Changelog

<!-- markdownlint-disable MD024 -- each version repeats the Added/Changed/Fixed sections -->

All notable public changes to Orbit, curated by maintainers. This file is the long-lived summary across
releases. The operator-facing notes for a specific tag live in [`release-notes/`](release-notes/) and become
the GitHub Release body; they remain authoritative for upgrade impact, known limitations, artifacts,
verification, and rollback.

Versions follow the [release process](docs/release-process.md): the root `package.json` version is the
version of record and the tag is that version with a `v` prefix. Orbit is pre-1.0, so appearing in this file
does not imply compatibility between releases. `main` is a development branch, not a supported release.

Before a tag is cut, the release maintainer moves the `Unreleased` entries under the new version and links
that version's release notes. Entries are written for an operator or contributor: name the user-visible
change, the affected surface, and the upgrade or migration impact.

## Unreleased (main)

Nothing yet.

## 0.1.261

The current version of record; its operator notes are in
[`release-notes/0.1.261.md`](release-notes/0.1.261.md). The stable release after `v0.1.260`, with everything
merged since that tag. Its notes also correct the 0.1.260 notes' lists of migrations and security fixes.

### Added

- `GET /projects/:id/handoffs` names each crossing's target coordinator conversation
  (`toProject.coordinatorSessionId`).
- A dispatch of `ci.yml` on a branch reports all six of `main`'s required checks on the branch head,
  `Dependency review` included ([release process](docs/release-process.md#before-tagging)).

### Changed

- A busy runner's automatic self-update waits six hours for the runner to go idle, then drains between 02:00 and
  06:00 local time. A drain that lasts five minutes interrupts the turns still running, which resume on the
  updated runner. A release postponed with Later keeps its plain deferral.
- Project pages (web, macOS/iOS, Android) leave off the crossings their target's coordinator conversation
  already answers, and trashing an open project's coordinator opens the next one at once.
- macOS and iOS label a shared pool "Shared", as the web does.
- Both release skills (`.claude` and `.agents`) state the exact tag and its full commit SHA, and get explicit
  confirmation of both before tagging.

### Fixed

- A session queued before any runner claims it shows its first message instead of an empty page.
- iOS: the session list's pinned section header is glass on iOS 26, edge to edge.
- iOS and Android: the needs-you fold's chevron no longer squashes when there is no count.
- CI: Swift core's copy-parity and wiring checks follow the current web again, and the JavaScript required
  checks pass.

### Already in the v0.1.260 tree, first recorded here

These were merged before `v0.1.260` was tagged, but that release did not move them out of `Unreleased`.

#### Added

- A maintainer-curated public changelog, linked from the README, the documentation index, the community
  guide, and the website.
- A fixed [release feedback discussion](https://github.com/jianghailong-xy/orbit/discussions/159) for
  upgrade reports and release-note corrections.
- Five scoped, independently reviewable `good first issue` tasks with stated scope, environment, acceptance
  criteria, contribution guidance, and maintainer response cadence.

#### Changed

- The public roadmap now separates current work, recently shipped work, and later direction, and no longer
  lists the onboarding, configuration-reference, API-reference, or release-verification work as upcoming.
- The community guide states a sustainable maintainer response and community update cadence, including the
  monthly roadmap/changelog review and the stale-issue sweep.
- The release checklist now includes moving the `Unreleased` changelog entries under the version being
  tagged.

### Upgrade notes

- No database migrations since `v0.1.260`. Runners self-update; the update to 0.1.261 is taken under the rules
  of the runner it replaces. See the [release notes](release-notes/0.1.261.md).

## 0.1.257 to 0.1.260

`v0.1.260` is the first published release after `v0.1.2-beta.246`. 0.1.257 and 0.1.259 were never tagged, and
`v0.1.258`'s release run failed before it published anything. Their operator notes are
[0.1.257](release-notes/0.1.257.md), [0.1.258](release-notes/0.1.258.md), [0.1.259](release-notes/0.1.259.md)
and [0.1.260](release-notes/0.1.260.md). The [0.1.261 notes](release-notes/0.1.261.md) list the migrations and
the security fix they left out. `v0.1.260` also carries everything listed under 0.1.257-beta.1 below.

## 0.1.257-beta.1

Never tagged: `/dl` served it briefly from an untagged commit. Its operator notes are in
[`release-notes/0.1.257-beta.1.md`](release-notes/0.1.257-beta.1.md). This version brought in the single
version of record and the verifiable supply chain, with the onboarding and reference documentation written
against them.

### Added

- Current-UI screenshots and a four-step product demo on the public website, with the checked-in 90-second
  storyboard as the recording source ([public entrance](https://jianghailong-xy.github.io/orbit/)).
- Screenshot-led onboarding that walks the first administrator, runner, workspace, session, task graph,
  approval, and recovery through the current UI ([onboarding guide](docs/onboarding.md)).
- A complete operator configuration reference, covering every Compose and runner setting with its type,
  requirement, default, secret status, and change procedure ([configuration reference](docs/configuration.md)).
- An external HTTP API reference generated from the control-plane controllers
  ([API reference](docs/api-reference.md)).
- Verifiable release artifacts: `SHA256SUMS`, a CycloneDX SBOM, an in-toto/SLSA provenance statement, and a
  GitHub artifact attestation for every release, with the commands that verify each part
  ([supply chain guide](docs/supply-chain.md)).

### Changed

- One version of record across `package.json`, the tag, the GitHub Release, the macOS and Android builds,
  the TestFlight build, the runner binaries, the update feeds, and the release notes.
- Release notes are now the GitHub Release body instead of a generated changelog.

### Upgrade notes

- Runners released before the single-version rule compare versions component by component and do not see
  `0.1.257-beta.1` as newer. Reinstall such a runner once; later releases update normally. See the
  [release notes](release-notes/0.1.257-beta.1.md) for the command and the full upgrade impact.

## Earlier releases

Releases before `0.1.257-beta.1` were tagged from the `0.1.2-beta.N` line; their GitHub Release bodies were
generated from pull-request labels and many are terse or empty. This changelog starts with the single
version rule and does not rewrite those historical notes. Use the
[GitHub Releases page](https://github.com/jianghailong-xy/orbit/releases) for the tag list and the
[project maturity record](docs/project-maturity.md) for the capability history behind the current docs.
