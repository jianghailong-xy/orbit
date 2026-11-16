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
merged since that tag. It supersedes the `0.1.261-beta.N` prereleases tagged from `main` on the way to it,
starting with `v0.1.261-beta.1` ([notes](release-notes/0.1.261-beta.1.md)). Its notes also correct the 0.1.260
notes' lists of migrations and security fixes.

### Added

- SubAgents. A session's `delegate` tool runs a child agent in the session's working directory, or on another
  workspace of the same repository chosen by name or by runner capability. Orbit routes it by tier and the
  agent's Optimize For setting across the enabled providers, Codex and Claude account pools included, and
  moves it on a limit or a sign-in failure. Its work is an Agent block in the parent's conversation on every
  client, with an Agents list in the composer band on macOS and iOS. A run on another workspace can be resumed
  for 7 days after it ends. An agent's settings have a SubAgents group, the Providers page a Tier column, and the
  API is `GET /sessions/:id/subagents`.
- Scheduled tasks: schedules that start agent runs on a timetable, with a Scheduled page, its timeline and run
  panel on web, macOS, iOS and Android. Schedule cards appear in conversations and in Waiting on you, runs count
  against a weekly budget, and CHECK_ONLY checks read the checkout without writing.
- Translation (Settings › Translation, web, macOS/iOS, Android). It works in about 30 languages, with an
  agent-language preference, Show original, and Show both languages, which interleaves each reply block with its
  original.
- The prompt optimizer. An account switch, a composer button and a suggestion card rewrite a draft in the
  agent's language, and the owner chooses whether to use it. On web and macOS, Tab optimizes a draft, and on the
  suggestion card it takes the rewrite.
- Coordinator handoff: Compact, or Start a new coordinator, from a coordinator's context gauge. The outgoing
  coordinator writes a handoff note, and its successor opens with it and takes over its waits.
- Session Settings on every client (a web drawer, an iOS/macOS sheet, an Android page). A session's own
  environment variables sit over the workspace's, with Restart to reload a live engine. It also holds
  notification overrides and a mute, the session's labels and public link, and its usage and engine version.
  The API is `PATCH /sessions/:id/settings` and `POST /sessions/:id/restart`.
- Discard on the main checkout (web, macOS/iOS, Android): the chosen files go back to HEAD after the whole
  checkout is saved to `orbit/rescue-*`. It needs a runner with `main-checkout-discard/v1` (0.1.261).
- New wiki…: an agent can ask the owner to create a wiki with a `WIKI_CREATE` owner card, and `POST
  /wiki/spaces` is owner-only.
- A recovery contract. Refusals and failures carry a stable code, a recovery action and whether the call may
  have written. `project_create` and `session_create` keep a receipt per request id, so a retried create
  returns the first one.
- Managed runners in Machines & models on macOS, iOS and Android. Their image bundles every supported engine, and
  a hosted runner left on an earlier image rolls onto the profile's once idle.
- Guests see a shared session's images and attach their own, and the invite field suggests people invited
  before (`GET /sessions/:id/guests/suggestions`).
- Fix with an agent under a failed Update engines report (web, iOS, Android).
- Android push notifications for crossing requests, coordinator confirmations and schedule alerts.
- A request to take a task out of its project reaches the owner and is answered in the source project's
  conversation (web, macOS/iOS).
- Chat about this on a pending owner request in its conversation (web, macOS/iOS, Android).
- `GET /projects/:id/handoffs` names each crossing's target coordinator conversation
  (`toProject.coordinatorSessionId`).
- A dispatch of `ci.yml` on a branch reports all six of `main`'s required checks on the branch head,
  `Dependency review` included ([release process](docs/release-process.md#before-tagging)).

### Changed

- A busy runner's automatic self-update waits six hours for the runner to go idle, then drains between 02:00 and
  06:00 local time. A drain that lasts five minutes interrupts the turns still running, which resume on the
  updated runner. A release postponed with Later keeps its plain deferral.
- The needs-you card on iOS and Android floats over the page at a notification's size, and a swipe up
  dismisses it. On iOS an approval that arrives with the app open shows in it. A conversation's navigation bar
  shows only its own needs-you, and something newly waiting is announced once, as a toast.
- A new machine's setup card asks for one folder name in the machine's home (`create-workdir/v2`), and on the
  web the card creates the workspace (`POST /workspaces` takes `newFolder`).
- A merge runs beside the session's turn instead of waiting for it, and a commit waits for changes to stop.
- A queued message says what holds it (`Queued · runner full`, `run full`, `batch full`, `runner updating`), on
  the queued turn itself. macOS and iOS move a send the server queued to the tray as "Queued for next turn".
- A machine's "N of M running" counts the sessions a background job holds.
- New sessions start on the workspace's last model, and only conversations a person opened move it.
- Switching an idle session to another account frees the old account. A refused removal names the sessions
  still using it.
- Removing a secret no longer holds up delivering another: the runner's scan of its checkouts runs in the
  background.
- An escalated owner item says when the coordinator can't take messages, and offers only the actions it can
  carry out.
- Project pages (web, macOS/iOS, Android) leave off the crossings their target's coordinator conversation
  already answers, and trashing an open project's coordinator opens the next one at once.
- The upgrade skill builds the `/dl` runner from the newest release tag behind the deployed commit, so a deploy
  between releases no longer publishes new runner code under the last release's number.
- The main checkout's Commit sends a default message naming the chosen files instead of asking for one.
- A turn that carries only Orbit's blocks is drawn as a From Orbit line, not as the owner's bubble.
- Create and start leads the single-task create card, except for a task filed to be held.
- The recap card has one ×, and Refresh recap is gone.
- iOS: the session list's section titles scroll away with their rows, and Settings is grouped as the web's
  navigation is (Personal, Machines, Providers). On iOS 26 the drawer's waiting count is the toolbar item's badge.
- New wiki… leaves the drawers and the Mac sidebar; the wiki head is a menu.
- macOS and iOS label a shared pool "Shared", as the web does.
- Both release skills (`.claude` and `.agents`) state the exact tag and its full commit SHA, and get explicit
  confirmation of both before tagging.

### Fixed

- iPhone photo uploads: a HEIC photo, or any image over 5 MB, goes up as a JPEG at most 2048 px on its long
  edge, and a failed upload says why.
- A branch that landed some other way drops its stale "Merge conflict".
- A background process no longer takes a session row's recap.
- A relative link in a reply finds a file the session saved in its uploads directory, and a runner in a
  container reports the container's CPU, memory and volume.
- A session queued before any runner claims it shows its first message instead of an empty page.
- CI: Swift core's copy-parity and wiring checks follow the current web again, Client CI's navigation gate no
  longer mistakes a view's private property for the model's, and the JavaScript required checks pass.

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

- Twenty-two additive migrations since `v0.1.260`, from `0524_subagent_run` to `0910_account_remove_sessions`;
  eleven are numbered below `0760`, the newest a 0.1.260 database has, and `prisma migrate deploy` applies them
  all. Runners self-update; the update to 0.1.261 is taken under the rules of the runner it replaces. Before
  rolling back to `v0.1.260`, relabel the sessions schedules started and clear messages held for their
  translation. See the [release notes](release-notes/0.1.261.md).

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
