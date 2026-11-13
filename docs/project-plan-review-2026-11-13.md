# Project plan review: brand and open-source maturity

**Review date:** 2026-11-13
**Reviewed baseline:** `8b0a7c1dafd201ef11c06830568a4d87019b306c` (`origin/main`, committed 2026-11-13 07:37:01 +0100)
**Review branch:** `orbit/task-p0-main-04e5d6`, fast-forwarded to the baseline before this review; the branch
contains the reviewed commit.
**Review task:** P0, re-review the brand plan against the latest main (`34wj7wzYWIG6aVJz0B1S2` in the Orbit
project).
**Status of this document:** public review and decision material. It records recommendations only. No rename,
repository transfer, application or package rename, domain purchase, account migration, or change to the
project's acceptance criteria has been performed.

**Baseline movement:** `main` advanced during the review from `22a13906b` to `8b0a7c1d`. The two intervening
commits are a runner updater fix and the release bump to `0.1.256`; they do not change the plan findings. The
review branch merged the newer commit, and every repository statement below is anchored to `8b0a7c1d`.

## 1. Executive summary

The August 2026 plan was a credible audit of a product repository that had no public project layer. Most of
its Phase 0 and Phase 1 engineering recommendations have since been delivered outside the task graph: public
documentation and community files, repository-wide CI and branch protection, dependency review and Dependabot,
a live bilingual website, a tag-driven multi-client release pipeline, backup and operations runbooks, and a
public roadmap. The plan, the task descriptions, and the project's completion model still describe the August
repository, however, and still order almost all work as if naming, organization, and domain were prerequisites.

Five findings drive the recommendations:

1. **The plan is stale in both directions.** It understates what exists (site, CI, dependency controls, release
   automation, operations guides) and overstates what is still required before useful work can proceed (a name
   and an organization are treated as gates for documentation, changelog, onboarding verification, demo media,
   and supply-chain evidence that do not depend on either).
2. **Naming is a single point of failure.** Nine of the other sixteen tasks depend transitively on the naming
   task. The owner has explicitly paused the naming decision, so those nine tasks are parked even where their
   remaining work is name-independent. Ten of the sixteen tasks are blocked at this baseline, twelve have no
   assignee, and all sixteen other tasks have automatic start disabled.
3. **The project cannot complete as configured.** The project states one acceptance criterion with eight
   clauses, `satisfiedBy: TASKS`, but no task declares that criterion key. Orbit reports
   `unmet: NO_WORK_SERVES_IT`, so no amount of task work can satisfy the criterion, and the criterion also
   reports `NO_RECEIPT` for landing. The criterion mixes owner decisions with engineering evidence and has a
   numbering defect from its migration.
4. **Status does not follow the work.** One open task already has most of its outcome on `main` (the website),
   another is marked in progress while its latest fixes are not on `main`, and the naming report exists only on
   an unpushed local branch. Two historical tasks are marked done with no session run records; their evidence
   was reconstructed independently in comments. Landing receipts are absent across the project.
5. **Release identity is still unreconciled at the reviewed commit.** Tag `v0.1.2-beta.245` carries
   `package.json` version `0.1.254`; `main` then bumps to `0.1.256`; the newest non-prerelease GitHub release is
   `v0.1.0` from 2026-06-26 while 346 releases exist, almost all prereleases; and the README still says the
   source version is `0.1.198` against tag `v0.1.2-beta.138`. This is the same class of defect the August audit
   flagged, now larger.

Recommended immediate sequence: finish this review and land it; land the pending dependency-security work;
reconcile one release identity; refresh the plan and README against reality; then run the name-independent
documentation, community, demo-media, and supply-chain work in parallel while the owner keeps the naming,
organization, and domain decisions parked. Section 8 gives the proposed sequence and Section 7 separates the
decisions only the owner can make.

## 2. Scope, method, and evidence

### 2.1 Documents read

- [Project maturity and brand roadmap](project-maturity.md)
- [Documentation index](README.md) and the [root README](../README.md)
- `brand/README.md` as named by the task: this file no longer exists. It was removed by commit
  `5a03da612` ("chore(brand): remove brand directory from repository"); the current public brand assets are
  under [site/assets](../site/assets/README.md).
- [Contributing](../CONTRIBUTING.md), [governance](../GOVERNANCE.md), [security](../SECURITY.md),
  [support](../SUPPORT.md), [community](../COMMUNITY.md), [roadmap](../ROADMAP.md), and
  [code of conduct](../CODE_OF_CONDUCT.md)
- Current operator and release guides that the plan promises: [self-hosting](self-hosting.md),
  [first run](first-run.md), [configuration](configuration.md),
  [runner troubleshooting](runner-troubleshooting.md), [release process](release-process.md),
  [dependency security](dependency-security.md), [Postgres backup and restore](postgres-backup-restore.md),
  and [GitHub Pages](github-pages.md)
- The repository implementation relevant to the plan: `.github/workflows/`, `.github/dependabot.yml`,
  `site/`, `scripts/docs-public-files.txt`, `scripts/check-docs.mjs`, and `package.json`.

### 2.2 Orbit project data read

- The project record: goal, instructions, the single acceptance criterion and its unmet reason, integration
  settings, concurrency, and task counts.
- All seventeen tasks in the project, including descriptions, acceptance criteria, status, assignees,
  priorities, dependencies, and comment history.
- The dependency edges are reproduced in Appendix A.

### 2.3 Public repository data read

Read-only GitHub API queries were used for repository metadata, branch protection, releases, pull requests,
issues, discussions categories, contributors, and workflow runs. No write was made to the repository or its
settings. The public site and appcast were requested over HTTPS and returned `200`.

### 2.4 Checks

The repository's own documentation gate was run on the review branch:

```bash
npm run test:docs
npm run docs:check
```

At the baseline, before this report was added, the checker covered 32 public Markdown files with 0 lint
issues and 0 local link or anchor errors, and the checker's own three tests passed. After the report and its
index entry were staged, the same gate covered 33 public Markdown files. The task evidence records the exact
run of both commands.

### 2.5 Limitations

- The GitHub Social Preview image and the anonymous-browser link walk are not readable through the API used
  here; the report records them as unverified rather than as failures.
- There is no project organization to inspect. Organization roles, two-administrator recovery, and
  project-owned contacts are therefore absent by construction, not merely undocumented.
- No live deployment was probed beyond the public website and appcast; claims about the running production
  instance are outside this review.
- The review is against the baseline commit. Later commits on `main` may change individual facts; the
  baseline hash is the anchor for every repository statement below.

## 3. What changed since the August 2026 plan

The plan's "Executive conclusion" describes a repository with no homepage, topics, social image, discussion
space, community or security policy, no repository-wide CI, and 12 production dependency findings. The table
compares that audit with the reviewed baseline.

| Area | August 2026 plan premise | State at the reviewed baseline | Evidence |
| --- | --- | --- | --- |
| Public documentation layer | Long README and implementation records; no public entry layer | 32 public guides checked, including product, self-hosting, configuration, first run, runner troubleshooting, release, backup, conflicts, and launch copy | `docs/README.md`; `npm run docs:check` |
| Community files | No visible community or security policy | CONTRIBUTING, GOVERNANCE, SECURITY, SUPPORT, COMMUNITY, CODE_OF_CONDUCT, Issue Forms, and a PR template are on `main`; Community Profile reported 100 percent at the time of the closing comment | PR #29, merge `bba40eb5f`; files on `main` |
| Repository-wide CI | Native-client CI only; no repository-wide gate | `CI` runs JavaScript, Go runner, Swift core, PostgreSQL specs, and container images; `Documentation` and `Dependency review` also report required checks | `.github/workflows/ci.yml`, `docs.yml`, `dependency-review.yml`; PR #30 merged |
| Branch protection | None | Required checks: JavaScript, Go runner, Swift core, Dependency review, Container images, PostgreSQL specs; strict, one approving review, no force push, no deletion | GitHub branch-protection API |
| Dependency security | 12 production findings, 3 high | The baseline review is recorded per package; Dependabot, dependency review, audit gating, vulnerability alerts, and security updates are enabled | `docs/dependency-security.md`; `.github/dependabot.yml`; GitHub security settings |
| Private vulnerability reporting | No visible channel | Private vulnerability reporting, secret scanning, and push protection are enabled; SECURITY.md defines targets | GitHub security settings; `SECURITY.md` |
| Discovery | No homepage, topics, social image, or Discussions | Description, 14 topics, and Discussions are set; the homepage field points to the documentation index rather than the public site; Social Preview is unverified | GitHub repository API |
| Website | No project website; plan says publish one after naming | A bilingual static site is live over HTTPS, links documentation, releases, issues, security, Discussions, and the appcast, and has Open Graph metadata | `site/index.html`; `docs/github-pages.md`; live `200` |
| Release pipeline | Minimal public release history; inconsistent versions | One `v*` tag builds signed and notarized macOS, TestFlight iOS, and signed Android artifacts; runner binaries carry a SHA-256 manifest; rollout and rollback are documented | `.github/workflows/release.yml`; `docs/release-process.md`; release runs |
| Operations | No public backup or incident guidance | Backup and point-in-time restore, managed-runner Docker and Kubernetes operations, and PostgreSQL conflict runbooks exist | `docs/postgres-backup-restore.md`; `docs/managed-runner-docker-operations.md` |
| Governance | No governance document | GOVERNANCE and COMMUNITY define roles, decisions, response targets, and labels; the repository remains under a personal account with no public maintainer roster | `GOVERNANCE.md`; `git remote`; contributors API |

The plan's Phase 0 exit signal ("a new visitor can identify the product, install it, find support and security
guidance, and run the same checks as a contributor") is mostly met. The first-task leg is not: the checked-in
clean-host record says server boot and runner-online **PASS**, but the first real agent task was **BLOCKED** by
the provider's weekly limit ([clean-install evidence](evidence/clean-install-2026-09-29.md), cited by the
README).

## 4. Findings about the plan documents

### 4.1 `docs/project-maturity.md`

The document is still dated 2026-08-19 and still opens with findings that are no longer true. Its "Executive
conclusion" says the repository had no project homepage or topics, no public discussion space, no visible
community or security policy, and no repository-wide CI gate; all of those are false at the baseline. Its
dependency paragraph describes 12 production findings, which the dependency work records as resolved. Its
Phase 0 list still asks for CI, repository metadata, Discussions, private vulnerability reporting, and one
coherent prerelease as if they were all pending.

The document is not obsolete as a direction. Its brand platform, category, audience, promise, proof pillars,
and the warning about the saturated "Orbit" name remain the project's clearest public positioning. The defect
is that it is frozen at the audit date, so it cannot serve as the current plan. It needs a dated revision that
keeps the positioning, marks completed items, and adds a name-independent track. This review deliberately does
not rewrite it: the replacement should be reviewed and approved as one change, and it must not silently
change the project's acceptance criteria.

### 4.2 The missing brand baseline

The task description names `brand/README.md` as a public baseline, but the whole `brand/` directory was
removed in commit `5a03da612`. The removed file contained the approved mark and lockup usage, the core palette
(Orbit Blue `#3370FF`, Signal Blue `#5B8BFF`, Ink, White), the name and descriptor rules, the voice rules, and
the three proof points. The current repository keeps only the deployed assets: [site/assets/brand](../site/assets/brand)
contains `logo.svg` and `favicon.svg`, the site asset contract describes the social image and reserved product
media slots, and the native app icon sources live with the clients. There is no public brand usage guide now.

This matters for three reasons. First, the plan treats a brand baseline as a public document and it is gone.
Second, the site's social image is an SVG (`site/assets/social/og-image.svg`), and the asset contract itself
says to replace it with raster media where a channel requires it; no approved PNG or WebP is recorded. Third,
if the owner ever approves a rename, the palette and name sections of the removed guide become the first
things a migration has to touch, and they currently exist only in Git history.

### 4.3 Stale README and package identity

The root README is otherwise current and is the strongest public document in the repository. Two paragraphs
are behind reality:

- `README.md` lines 266-269 say the runner source version is `0.1.198` while the newest tag is
  `v0.1.2-beta.138`. The reviewed checkout is `0.1.256`, the newest tag is `v0.1.2-beta.245`, and the two do
  not follow one scheme.
- `package.json` describes the product as "Orbit — AI Agent task scheduling platform (control plane +
  distributed coding-agent runners)", while the approved descriptor is "Agent Mission Control" and the
  category line is "self-hosted mission control for coding agents". The repository description uses the
  approved line; the package metadata does not.

### 4.4 Website wording versus reality

"Independent website" now means "a public entrance separate from the repository", not "a project-owned
domain". The site lives at `jianghailong-xy.github.io/orbit`, its appcast lives on the same personal Pages
origin, and `docs/github-pages.md` documents that origin as the contract. That is a legitimate interim state,
but the plan and the task title should say so, and the remaining domain migration should be a separate,
owner-gated step rather than a prerequisite for the site work.

### 4.5 Plan items that are already behind the implementation

The following plan statements are obsolete as written and should be removed or rephrased in the next plan
revision:

- "no project homepage or topics, no custom social image, no public discussion space" in the executive
  conclusion.
- "no visible community or security policy".
- "no repository-wide CI gate".
- "12 production dependency findings" as a current gap.
- "Do not commission more logo production until this decision is made": logo production and deployment have
  already happened; the useful rule now is "do not commit to a new name-bearing identity until the decision".
- `brand/README.md` as a public baseline.
- The README's `0.1.198` / `v0.1.2-beta.138` paragraph.
- The claim that a website waits for a name decision: the public entrance is live and name-neutral in its
  layout; only the domain and the name-bearing copy wait.

## 5. Task-by-task review

References `T1` to `T16` are the sixteen other tasks in the project; the full ids, English titles, statuses,
and dependencies are in Appendix A. `T17` is this review. The verdict uses the five labels requested by the
task: completed, continue, obsolete, rescope, or new recommendation. "Priority" is a recommended numeric
Orbit priority, not the `P0`-`P3` label in the title; Section 6.5 explains the mapping.

| Ref | Task | Status | Verdict | Basis at the reviewed baseline | Depends on | Priority |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | Name and trademark clearance | OPEN | Continue, owner-paused | The clearance brief exists as `docs/naming-decision.md` at commit `b56c15d1b` on local branch `orbit/task-p0-081917`; it is not on `main` and the branch is not pushed. The owner recorded a pause on 2026-11-13, not a choice among the candidates. | None | 150 |
| T2 | Review and publish docs and community baseline | DONE | Completed | PR #29 merged as `bba40eb5f`; the files are on `main`; the docs check passes. The closing comment records an independent verification of links, Issue Forms, build, and a clean Compose stack. | None | Closed |
| T3 | Repository-wide CI and main quality gate | DONE | Completed | `.github/workflows/ci.yml` is on `main`; PR #30 merged on 2026-08-20; the branch-protection API reports six required checks, strict mode, one review, and no force push or deletion. | None | Closed |
| T4 | Triage and remediate production dependency alerts | IN_PROGRESS | Continue | The August baseline and the continuous controls are on `main`. The latest comment (2026-11-13) reports four DSH alerts fixed and a new section added to `docs/dependency-security.md`, but the section and the `@modelcontextprotocol/client` override are absent from the reviewed `main`; the work is unlanded. The Dependabot API at review still lists alerts #75 and #76 (high) and #77 and #78 (moderate) open in the two DSH lockfiles, plus development moderates #129 and #130. | None | 270 |
| T5 | One version, tag, and release rule | OPEN | Rescope | `docs/release-process.md` and the tag-driven workflow are live, but identity is inconsistent: tag `v0.1.2-beta.245` contains `package.json` `0.1.254`; `main` then bumps to `0.1.256`; the newest non-prerelease release is `v0.1.0`; the README still cites `0.1.198` and `v0.1.2-beta.138`. | None | 280 |
| T6 | Independent organization, domain, and account plan | OPEN | Rescope | No organization or project domain exists; the remote is a personal namespace and the site and appcast are on personal Pages. The written ownership, roles, two-recovery-admin, cost, and exit plan does not require the final name; execution does. | T1 | 140 |
| T7 | GitHub facade and discovery metadata | OPEN | Rescope | Description, 14 topics, and Discussions are already configured; the homepage points at `docs/README.md`, not the site; Social Preview and anonymous link checks are unrecorded. Topics and brand assets are name-dependent; Discussions and link checks are not. | T1, T2 | 120 |
| T8 | Project-level security and conduct channels | OPEN | Rescope | Private vulnerability reporting, secret scanning, and push protection are enabled; SECURITY.md and CODE_OF_CONDUCT still route reports to a maintainer's GitHub profile or a public issue. No project-owned address, no two named recipients, no drill record. | T6 | 130 |
| T9 | Public website, documentation entrance, and product demo | OPEN | Rescope | The bilingual site is live over HTTPS and links documentation, Releases, Issues, Security, Discussions, and the appcast. The hero is explicitly a decorative SVG and the demo slot is empty; no real screenshot or short demo exists. It is a personal Pages origin, not a project domain. | T6, T7 | 180 |
| T10 | Screenshot onboarding, configuration, and API reference | OPEN, READY | Rescope | Configuration, first-run, self-hosting, runner-troubleshooting, and release guides exist. The clean-host record passes server and runner but the first task is blocked by provider quota. There is no OpenAPI or equivalent API reference, and no screenshot set presented as the current UI. | T2 | 240 |
| T11 | Public roadmap, changelog, and contribution funnel | OPEN | Rescope | ROADMAP and COMMUNITY are live and linked from the README and the site; Discussions has Q&A, Ideas, Show and tell, and Announcements categories. There is no CHANGELOG, zero open issues, and all five seed good-first issues (#93 to #97) are closed. Its dependencies on the name-gated facade and security tasks are unnecessary. | T2, T7, T8 | 220 |
| T12 | Verifiable software supply chain | OPEN | Rescope | Runner asset digests, Android APK checksums, signed and notarized clients, pinned action commits in newer workflows, and narrow workflow permissions exist. There is no SBOM, no provenance attestation, no documented checksum set for the server and web images, and no public statement of the legal relationship to the Apple signing entity. | T3, T4, T5 | 200 |
| T13 | Organization transfer and multi-maintainer governance | OPEN | Continue | The repository is still personal. The contributors API lists four logins besides Dependabot (`jianghailong-xy`, `claude`, `migege`, `torvalds4zh`), but GOVERNANCE names no maintainers, there is no CODEOWNERS, and the release and signing accounts remain personal. | T6, T8 | 110 |
| T14 | Recovery, security, and maintainer-handoff drills | OPEN | Rescope | Backup, restore, managed-runner, and conflict runbooks exist; no executed drill record exists. Database restore, key rotation, and a vulnerability tabletop do not require an organization; only the second-maintainer release leg does. | T12, T13 | 100 |
| T15 | OpenSSF best-practices baseline | OPEN | Rescope | There is no OpenSSF badge application and no Scorecard workflow, but many Passing inputs already exist: license, public docs, contribution and security policies, CI, dependency review, and vulnerability reporting. The task's entire P1 and P2 chain as dependencies is broader than the badge requires. | T11, T12, T13 | 90 |
| T16 | v1.0 readiness review | OPEN | Continue | It is the final gate and all six of its dependencies are blocked or unstarted. Compatibility and upgrade pre-work can start before the gate; the gate itself cannot. | T9, T10, T11, T12, T14, T15 | 80 |
| T17 | Re-review the brand plan against the latest main | OPEN | Continue; this document is its deliverable | The review branch contains the baseline; this report covers all tasks, criteria, dependencies, and integration settings; the documentation checks are the verification. | None | 300 |

### 5.1 Notes on the most consequential verdicts

**T1 is valid work waiting on a decision, not a failed task.** The brief's recommendation (rename to Ropewalk
with Watchstation as the alternate and Orbit Mission Control as the fallback) is decision material, not a
decision. The owner's 2026-11-13 reply is a pause. The task should stay open and unstarted until the owner
records a choice. The report should not be published under `docs/` while the decision is open, because a
public document recommending a rename would itself become name-bearing content that a later decision would
have to retract.

**T4 is the highest-value name-independent finish.** The continuous controls already protect `main`; what is
missing is the 2026-11-13 change set. It should be landed, the four DSH alerts confirmed closed on the next
dependency-graph scan, and the full web suite completed (the task's own comment records it as a gap). At
review the API still lists alerts #75 to #78 open in the two DSH lockfiles, which confirms the change set is
not on `main`. Until then the supply-chain task correctly stays blocked.

**T5 should be split, not merely continued.** The documentation and workflow work is largely present; the
defect is identity. A small task should choose one public version scheme, align `package.json`, the tag, the
GitHub Release, the native artifacts, the runner manifest, and the update feed, then refresh the README's
version paragraph. A second, later task can own the support window and upgrade policy. The current task mixes
both and remains open despite most of its text already being implemented.

**T9 and T10 overlap on screenshots.** The site owns the public media slots; the onboarding guide owns the
captured journey. One real capture set should serve both. Keeping two tasks that each demand screenshots
against the current UI will duplicate the work and let both claim partial evidence.

**T11's dependency on T7 and T8 is wrong.** A changelog and a fresh set of good-first issues do not need the
repository facade or the final security contacts. The roadmap half is already delivered. The remaining halves
should be a name-independent task and can start now.

**T12 and T15 should start with what does not need a supply-chain chain.** An SBOM and a Scorecard workflow can
be added on today's CI; they do not need the version scheme to be settled first, only a release artifact to
attach to. The task graph's serial ordering postpones them without a technical reason.

## 6. Structural problems and executable fixes

### 6.1 Project acceptance criteria

The project has one criterion with eight clauses. Its `satisfiedBy` is `TASKS`, and Orbit reports
`unmet: [{ "clause": "NO_WORK_SERVES_IT" }]` because no task in the project declares the criterion key
`5e0ce2IK9aUhniDIvqYUy8`. The criterion's landing is `NO_RECEIPT`, so the project is withheld by both
`CRITERION_UNSATISFIED` and `CRITERION_UNLANDED`. Every one of the seventeen tasks, including this review,
has `criterionDefinitionId: null`.

The current clauses, in English, are:

| Clause | Requirement | Tasks that would serve it | Current state |
| --- | --- | --- | --- |
| C1 | Complete name and trademark clearance and record a keep-or-rename decision | T1 | Brief produced; owner paused; no decision |
| C2 | Independent organization, domain, public contact, and security channels | T6, T8, T13 | Absent; personal namespace and profiles |
| C3 | One identity and narrative across website, repository, documentation, applications, and releases | T5, T7, T9 | Orbit is used consistently, but the version story and namespace are not unified |
| C4 | Repository-wide required CI, branch protection, dependency security, and private vulnerability reporting | T3, T4, T8 | Largely met; admin bypass is allowed; T4's latest fixes are unlanded |
| C5 | Consistent and verifiable version, tag, release, checksum, SBOM, and provenance chain | T5, T12 | Not met; no SBOM or provenance; version identity inconsistent |
| C6 | At least two maintainers can independently release, respond, and recover accounts | T13, T14 | Not met; one personal owner and personal accounts |
| C7 | A user can install, connect a first runner, complete a first task, and judge production boundaries from public material | T9, T10 | Install and runner pass; first task blocked; boundaries documented |
| C8 | Pre-1.0 compatibility, support matrix, and operational drills | T14, T16 | Not started |

Structural defects:

1. **One binary criterion cannot express partial progress.** Seven of the eight clauses are multi-step
   programs. A single satisfied-or-not statement means the project is either "done" or "not done" for the
   entire maturity program, and no task completion moves it.
2. **The task mapping is declared but not implemented.** `satisfiedBy: TASKS` promises a task mapping; the
   actual mapping is empty, which is why Orbit says no work serves the criterion. The defect is in the project
   record, not in the tasks.
3. **Owner decisions are mixed with engineering evidence.** C1 and C6 are not things an executing session can
   prove; they need an owner-recorded decision and a named second maintainer. Mixing them into a `TASKS`
   criterion makes the whole criterion unprovable even after the engineering parts are complete.
4. **The criterion does not describe landing.** A criterion satisfied by tasks should say how each task's
   work reaches `main`; the project has no line and no merge check, so the criterion can only ever be
   `NO_RECEIPT`.
5. **The text carries a migration defect.** The first clause has lost its `1.` marker and the clauses run
   together, which makes any automatic or human comparison of revisions unreliable.

Recorded recommendation only, not applied: replace the single criterion with eight criteria that use the
clause keys above; declare each task's `criterionKey` on the task that serves it; make C1 and the
maintainer-naming part of C6 owner-confirmed decisions; keep C8 as the final gate that depends on C1 to C7.
Do not edit the project record until the owner approves the split.

### 6.2 Task graph

The reviewed graph is a chain, not a program:

- T1 blocks T6 and T7.
- T6 blocks T8, T9, and T13.
- T8 blocks T11 and T13.
- T5, T4, and T3 block T12.
- T12 and T13 block T14.
- T11, T12, and T13 block T15.
- T9, T10, T11, T12, T14, and T15 block T16.

Nine of the sixteen other tasks depend transitively on T1. That is the graph's central defect: a decision the
owner has deliberately paused is also the gate for documentation, changelog, demo media, supply-chain
evidence, drills, OpenSSF, and v1.0. The graph has no name-independent track at all.

The second defect is that several nodes bundle work of different kinds. T5 bundles an engineering identity fix
with a documentation policy. T9 bundles a public entrance that is live with media that does not exist and a
domain that does not exist. T10 bundles a verified first task, a configuration audit, and an API reference.
T11 bundles a delivered roadmap with a missing changelog and a stale contributor funnel. T12 bundles
checksums, SBOM, provenance, and a legal statement. T14 bundles drills that need an organization with drills
that only need a database. Large nodes make partial evidence unusable and make every dependency wait for the
slowest leg.

The third defect is dispatch: ten of sixteen tasks are blocked, twelve have no assignee, and all sixteen other
tasks have `autoRunWhenReady: false`. The project instructions deliberately require manual starts, so the flag
is not wrong; the missing piece is a coordinator decision about which name-independent tasks should be
assigned and started.

### 6.3 Status and evidence hygiene

- T2 and T3 are done and the outcomes are verifiable, but their session lists are empty. The closing comments
  record that an independent verifier reconstructed the evidence from GitHub and the repository. That is an
  audit anomaly, not a reason to reopen, but it means the project cannot rely on run records for those two
  tasks.
- T4 is in progress with a detailed 2026-11-13 comment, yet the claimed documentation section and lockfile
  overrides are absent from `main`. The task is correctly not done, but the gap between the comment and the
  branch is exactly the kind of drift a landing receipt would expose.
- T1's report is on an unpushed local branch. The Orbit task records the report path and commit, but a public
  reviewer cannot fetch it. The report should stay non-public while the decision is open, and the task record
  should say "unpublished decision brief" rather than pointing at a path a reader cannot resolve.
- T5's work is effectively done in documentation but the task remains open because the identity defect is
  unowned. The task graph should make the defect its own task with its own evidence.
- No task in the project has a landing receipt. The project's integration record is `NOT_DECIDED`, so there is
  nothing to attach one to. That is the root cause of the `CRITERION_UNLANDED` withholding.

### 6.4 Project integration configuration

The project record at the baseline is:

| Setting | Value | Consequence |
| --- | --- | --- |
| `integration.line` | `null` (`NOT_DECIDED`) | No project line to land on; tasks are not integrated as a project |
| `integration.ref` | `null` | No branch or ref to compare against |
| `deliveryMode` | `PLATFORM` | Work is delivered by the platform, but the target is undefined |
| `landingCheckCommand` | absent (`FALLS_BACK_TO_MERGE_CHECK`) | No landing-specific gate |
| `mergeCheckCommand` | absent (`NOT_CONFIGURED`) | No project merge gate at all |
| `lastMainBranch` | `main` of the personal repository, chosen 2026-11-13 05:19Z | The main branch association is newer than most tasks |
| Task integration state | `NOT_APPLICABLE` on every task | No task can produce a landing receipt |

The structural problem is that a project whose stated criterion is satisfied by tasks has no mechanism that
connects a task's commit to the criterion. Even if every task were completed, the criterion would remain
`NO_RECEIPT`. Recommendations, recorded only:

1. Set the project line to `main` and the reference to `main`. This is the branch the product's CI, releases,
   and website already use. Do not create a long-lived branding branch; the rename, if it happens, is a
   one-off migration that can use a dedicated branch later.
2. Configure a merge check that is deterministic and cheap on every landing. The repository's documentation
   gate (`node scripts/check-docs.mjs`) is the natural always-runnable check; the six required GitHub checks
   remain the product gate. A merge check should not duplicate a 30-minute PostgreSQL run.
3. Require every task's evidence to cite a commit that is an ancestor of `main` (or a merged pull request),
   and let the platform write the landing receipt. For this review, the review branch itself is the
   deliverable until it is merged; the evidence must say so.
4. Keep `deliveryMode: PLATFORM`. There is no need for a separate project delivery line while all work lands
   on `main`.

### 6.5 Priority and dispatch

The `P0` to `P3` prefixes in task titles are not mapped to the Orbit priority field. At the baseline, every
task is priority 0 except T4, which is 2. Title phases therefore do not influence dispatch order, and the
server's ready-queue order among otherwise equal tasks is effectively arbitrary.

Recommended mapping for the project's numeric priority field:

| Title phase | Suggested range | Meaning |
| --- | --- | --- |
| P0 | 250 to 300 | unblocks the program or prevents a false public claim |
| P1 | 190 to 240 | public trust, documentation, and release evidence |
| P2 | 120 to 180 | independent operation and community durability |
| P3 | 50 to 110 | final readiness gate |

The specific per-task values are in the Section 5 table. The important ordering change is that the review, the
release-identity fix, the dependency landing, the README refresh, and the admin-enforcement follow-up come
before the name-gated tasks, even though the latter carry `P0` labels.

## 7. Decisions for the project owner

These are the trade-offs that an executing session cannot settle. Each is listed with the current state, the
options, and the cost of leaving it open.

| Decision | Current state | Options | Cost of deferral | Suggested timing |
| --- | --- | --- | --- | --- |
| Project name | Paused on 2026-11-13; a brief recommends Ropewalk, with Watchstation and Orbit Mission Control as alternates | Resume and choose; commission a new shortlist; formally retain Orbit under a compound identity | Org, domain, facade remainder, site domain, security contacts, and org migration stay parked; search and trademark risk continues | After this plan is approved; before any domain, package, or organization spend |
| Publication of the naming brief | Exists only on a local branch | Keep unpublished; publish a redacted summary; publish fully after a decision | No public confusion now; the analysis is not reusable by outside reviewers | Keep unpublished until a decision |
| Organization and domain | Personal repository, personal Pages origin, personal appcast | Create a project organization after naming; use a neutral sponsor entity; stay personal with disclosure | The project cannot meet C2 or C6; release, signing, and recovery remain single-person | Plan now, execute after naming |
| Two recoverable administrators | None named | Nominate a second maintainer; document recovery; use a shared access-controlled vault | Every P2 task and v1.0 remain blocked; bus factor is one | Start conversations now |
| Public maintainer roster and CODEOWNERS | No roster, no CODEOWNERS | Publish a roster first; add CODEOWNERS only after owners agree | Contributors cannot tell who decides or reviews; T13 cannot close | After the second maintainer agrees |
| Security and conduct contacts | GitHub profile contact or public issue fallback | Project-owned alias; shared mailbox; PVR only with two named responders | T8 cannot close; reports depend on one person's profile | With the organization decision |
| One release version scheme | Tags use `v0.1.2-beta.N`; `package.json` uses `0.1.25x`; latest non-prerelease release is `v0.1.0` | Align the tag to the package and SemVer; keep the beta channel as a prerelease suffix; declare one supported line | Every release claim is ambiguous; C5 and the launch gate cannot close | Now, independent of naming |
| Stable versus prerelease posture | 346 releases, almost all prereleases; one old stable `v0.1.0` | Cut a deliberate `0.1.x` stable when the gates pass; remain prerelease-only with an explicit statement | Users cannot tell what is supported; Security policy's "latest release" is ambiguous | With the release-identity fix |
| Public brand guide | Removed with the `brand/` directory | Restore a short guide under `docs/`; keep only the site asset contract; publish the old guide after a rename decision | No public usage rules; social media and press have no approved reference | Now for a short, name-neutral guide |
| License and contributor paperwork | MIT, inbound equals outbound | Keep; adopt a DCO; adopt a CLA | None today; the plan says do not add paperwork without a legal need | No action unless a legal need appears |
| Acceptance-criteria changes in this report | Recorded only | Approve the eight-criterion split and task keys; reject; revise | The project remains unable to satisfy its criterion | With the plan re-baseline |
| Support boundary | Volunteer, best effort, no SLA | Keep; add a funded support tier later | None; the current boundary is honest and visible | Revisit only with a sponsor |

## 8. Proposed re-baselined sequence

The sequence keeps the owner's pause intact and moves everything that does not need a name.

### Wave 0: make the record true (this week)

1. Land this review and link it from the documentation index.
2. Land the pending dependency-security change set, confirm the four DSH alerts close, and complete the web
   suite.
3. Publish a release-identity fix: one scheme across `package.json`, tag, GitHub Release, native artifacts,
   runner manifest, and update feed; refresh the README paragraph.
4. Publish a dated revision of the maturity plan that keeps the positioning and marks completed items. It must
   not change the project criterion in the same change.
5. Record the admin-bypass policy on `main` (current protection allows administrators to bypass); either
   enforce administrators or document why not.

Exit signal: the repository, the plan, and the project record agree on what is done, what one release is, and
what is still open.

### Wave 1: name-independent public trust (two to four weeks)

1. T10 remainder: a clean-host run that completes one first task, a configuration completeness check, and an
   API reference (OpenAPI or an equivalent generated reference).
2. T11 remainder: `CHANGELOG.md` and three to five open, fully specified good-first issues.
3. T9 media: one approved real screenshot set and one short demo, wired into the existing site slots; share it
   with the onboarding guide.
4. T12 remainder: SHA-256 for every published artifact, an SBOM per release, and build provenance that a
   public document shows how to verify.
5. T15 preparation: add an OpenSSF Scorecard workflow and draft the badge self-assessment.
6. A short name-neutral brand usage guide restored under `docs/`.
7. Project integration: set the line and merge check, and start recording landing receipts.

Exit signal: a new user can install, connect a runner, complete a first task, verify a release, and find a
current brand guide without private knowledge.

### Wave 2: owner-decided identity (after the naming decision)

1. Record the name decision and publish the decision record.
2. Complete T6's written org, domain, contact, cost, and exit plan; then execute the organization transfer.
3. Finish T7 (About, topics, Social Preview, anonymous link check) and T8 (project contacts, two recipients,
   drill).
4. Move the site and appcast to the project-owned domain.
5. Publish the maintainer roster; add CODEOWNERS after the owners agree.
6. Start T13's org migration.

Exit signal: repository, website, docs, applications, releases, and security channels resolve to one
project-owned identity with more than one recoverable administrator.

### Wave 3: independent operation and v1.0

1. Run the database restore drill, key rotation, vulnerability tabletop, and second-maintainer release (T14).
2. Complete the OpenSSF badge (T15).
3. Run the v1.0 readiness review (T16): compatibility, support matrix, security window, upgrade and rollback
   evidence, and two-maintainer sign-off.

Exit signal: the project can publish, respond, recover, and continue without the original author, and users can
make a production decision from public evidence.

## 9. Acceptance-criteria change register (recorded, not applied)

This register exists so the owner and coordinator can approve or reject each change without reading the whole
report. Nothing here has been written to Orbit.

| Object | Current | Proposed | Why |
| --- | --- | --- | --- |
| Project criterion | One text with eight clauses | Eight criteria, one per clause, using C1 to C8 | A binary criterion cannot express partial progress and cannot be landed |
| Project criterion mapping | `satisfiedBy: TASKS`, no task keys | Each serving task declares its key | Orbit currently reports `NO_WORK_SERVES_IT` |
| C1 | Included in the same `TASKS` criterion | Owner-confirmed decision with a linked decision record | A name decision is not an engineering result |
| C6 | Included in the same `TASKS` criterion | Owner-confirmed for the maintainer roster and recovery evidence | It requires a second person, not a session |
| C8 | Included in the same `TASKS` criterion | Final gate depending on C1 to C7 | It is a readiness verdict, not a parallel work item |
| T5 | One task: identity plus policy | Split into release-identity reconciliation and support-policy tasks | The identity fix is urgent and independent; the policy is not |
| T9 | Website, docs entrance, demo, domain | Split into media, domain, and already-delivered entrance | The entrance is live; the media and domain are separate states |
| T10 | First task, configuration, API reference, screenshots | Split into first-task verification, configuration audit, API reference | Screenshots belong with the site media task |
| T11 | Roadmap, changelog, funnel | Roadmap marked delivered; changelog and good-first issues become a new task | The roadmap is already public and linked |
| T12 | Checksums, SBOM, provenance, legal statement | Split into artifact checksums, SBOM and provenance, signing-entity statement | Each has a different evidence type and dependency |
| T14 | All drills | Split database restore and tabletop from the maintainer-handoff drill | Only the handoff leg needs a second maintainer |
| T15 | Badge plus whole P1 and P2 chain | Start Scorecard and self-assessment now; badge waits for the evidence tasks | The current dependency set is broader than the badge requires |
| T3 follow-up | Closed | New task: enforce administrators or document the bypass policy | The current protection allows admin bypass |
| Priority fields | All 0 except T4 at 2 | Section 5 values | Title phases do not order the queue |

## 10. Verification and limits

The review branch contains the baseline commit and this report. The documentation gate was run on the branch
with the repository's own commands; the task evidence records the exact job. The report's own local links are
covered by the same gate because the file is listed in `scripts/docs-public-files.txt`.

What this evidence does not establish:

- It does not prove the Social Preview image, Discussions category configuration as seen by an anonymous
  browser, or any logged-out behavior that the GitHub API does not expose.
- It does not prove the state of the production deployment, the private signing accounts, or the owner's
  intent beyond the recorded pause.
- It does not execute or validate any rename, organization transfer, domain purchase, or account migration;
  those are explicitly out of scope and remain owner decisions.
- It does not change the Orbit project record, any task status, any criterion, or any integration setting.
- It does not establish that the proposed priorities are optimal; they are a starting order for the
  coordinator, not a measurement.

## Appendix A: tasks and dependency edges at the reviewed baseline

Every task below belongs to the project. "Blocks" lists the direct dependents in the reviewed graph.

| Ref | Task id | English title | Status | Current priority | Blocks |
| --- | --- | --- | --- | --- | --- |
| T1 | `349vy0KHzVXe6LcefJB08` | Complete project name and trademark clearance | OPEN | 0 | T6, T7 |
| T2 | `349vy0HknpSjHwdwJ31O1` | Review and publish documentation and community baseline | DONE | 0 | T7, T10, T11 |
| T3 | `349vy0OBlJtFibGd9xx8C` | Establish repository-wide CI and main quality gate | DONE | 0 | T12 |
| T4 | `349vy0PeVgisVYFB0ysPf` | Triage and remediate production dependency alerts | IN_PROGRESS | 2 | T12 |
| T5 | `349vy0QixLFO2ONBInnVi` | Unify version, tag, and release rules | OPEN | 0 | T12 |
| T6 | `349vy0RnPBmjXH09RmKZs` | Decide independent organization, domain, and account plan | OPEN | 0 | T8, T9, T13 |
| T7 | `349vy0TqNBfJdPFQbHRO1` | Complete GitHub project facade and discovery metadata | OPEN | 0 | T9, T11 |
| T8 | `349vy0XwFXXR5RhWQluHs` | Establish project-level security and conduct reporting channels | OPEN | 0 | T11, T13 |
| T9 | `349vy0ZOjXUt3OQZPBuM8` | Launch public website, documentation entrance, and product demo | OPEN | 0 | T16 |
| T10 | `349vy0b9RhlUzCp1Jbh5r` | Complete screenshot onboarding, configuration, and API reference | OPEN | 0 | T16 |
| T11 | `349vy0cK5rP8aZDvxXeD2` | Establish public roadmap, changelog, and contribution funnel | OPEN | 0 | T15, T16 |
| T12 | `349vy0dsusjXPmqO0fPNO` | Build a verifiable software supply chain | OPEN | 0 | T14, T15, T16 |
| T13 | `349vy0hCTRTiSfObHJTMx` | Complete organization transfer and multi-maintainer governance | OPEN | 0 | T14, T15 |
| T14 | `349vy0j3GFUVj9KGX58pg` | Run recovery, security, and maintainer-handoff drills | OPEN | 0 | T16 |
| T15 | `349vy0lIIOMk71KynB9mo` | Complete the OpenSSF best-practices baseline | OPEN | 0 | T16 |
| T16 | `349vy0nd9znb19KrbhafO` | Complete the v1.0 readiness review | OPEN | 0 | None |
| T17 | `34wj7wzYWIG6aVJz0B1S2` | Re-review the brand plan against the latest main | OPEN | 0 | None |

The edge list used for the review, as task-to-prerequisite pairs:

- T6 depends on T1.
- T7 depends on T1 and T2.
- T8 depends on T6.
- T9 depends on T6 and T7.
- T10 depends on T2.
- T11 depends on T2, T7, and T8.
- T12 depends on T3, T4, and T5.
- T13 depends on T6 and T8.
- T14 depends on T12 and T13.
- T15 depends on T11, T12, and T13.
- T16 depends on T9, T10, T11, T12, T14, and T15.
- T17 has no dependencies.

## Appendix B: evidence index

| Evidence | Value |
| --- | --- |
| Reviewed `origin/main` commit | `8b0a7c1dafd201ef11c06830568a4d87019b306c` |
| Baseline at review start | `22a13906b0a394650c1af89b58549956eaa21c2a`; superseded during the review by the runner fix and the `0.1.256` release bump |
| Review branch | `orbit/task-p0-main-04e5d6` |
| `main` package version at baseline | `0.1.256` |
| Documentation baseline merge | `bba40eb5f`, PR #29 |
| Repository-wide CI merge | PR #30, merged 2026-08-20 |
| Dependency baseline merge | PR #31, merged 2026-08-20 |
| Naming brief | `b56c15d1b` on local branch `orbit/task-p0-081917`, not pushed |
| Brand directory removal | `5a03da612` |
| Required checks on `main` | JavaScript, Go runner, Swift core, Dependency review, Container images, PostgreSQL specs |
| Latest release at review | `v0.1.2-beta.245`, published 2026-11-13 05:49Z, package `0.1.254` |
| Latest non-prerelease release | `v0.1.0`, published 2026-06-26 |
| Release count | 346 |
| Public site | `https://jianghailong-xy.github.io/orbit/`, HTTPS `200` |
| Appcast | `https://jianghailong-xy.github.io/orbit/appcast.xml`, HTTPS `200` |
| Open issues | 0 |
| Discussions categories | Announcements, General, Ideas, Polls, Q&A, Show and tell |
| Dependency controls | Dependabot security updates enabled; vulnerability alerts enabled; secret scanning and push protection enabled |
| Open Dependabot alerts | 6: #75 and #76 high, #77 and #78 moderate in the two DSH lockfiles; #129 and #130 moderate, development scope |
| Documentation check at baseline | 32 files, 0 lint issues, 0 local link or anchor errors, 3 checker tests passed before this report was added |
| Documentation gate after this report | 33 public Markdown files; the result is recorded in the task evidence job |
