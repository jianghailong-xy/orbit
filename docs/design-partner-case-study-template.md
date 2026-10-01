# Design partner case-study template

Use this template to collect a truthful, reviewable design-partner story about Orbit. It is a
working document for an interview and evidence handoff, not a promise that a partner will be named
or that a result will be published.

Keep the [launch messaging brief](messaging-brief.md) beside this file while writing. A case study
may add concrete detail, but it must not turn a boundary into a guarantee, describe a worktree as a
security sandbox, or imply hosted reliability.

## 0. Publication gate

Complete this section before recording a quote or sharing a draft outside the partner team.

| Check | Owner | Status / date |
| --- | --- | --- |
| Partner agreed to an interview and the intended audience | | `[ ]` |
| Partner chose named, anonymized, or private attribution | | `[ ]` |
| No credentials, tokens, hostnames, private URLs, customer data, or sensitive topology are in the draft | | `[ ]` |
| Screenshots and repository names are cleared or replaced with fixtures | | `[ ]` |
| Partner approved direct quotes and the final factual draft | | `[ ]` |
| Maintainer checked every product claim against the tagged commit and docs | | `[ ]` |
| Publication channel, date, and rollback contact are recorded | | `[ ]` |

**Do not publish until every required check is complete.** If the partner withdraws consent, remove
the draft from the launch queue and retain only the minimum internal record needed for audit.

## 1. Partner snapshot

- **Working title:** `[specific outcome, not a feature slogan]`
- **Attribution:** `[named company / team / anonymous infrastructure team]`
- **Role(s) interviewed:** `[engineering, platform, security, etc.]`
- **Team size and repository shape:** `[small team, monorepo, services, etc.]`
- **Environment:** `[self-hosted server, runner locations, private network — keep it non-sensitive]`
- **Interview date / revision tested:** `[YYYY-MM-DD / tag or commit]`
- **Primary scenario:** `[choose one canonical name]`
  - `[ ] Work that outlives a chat`
  - `[ ] Parallel agents without checkout collisions`
  - `[ ] Access to private infrastructure`
- **Secondary scenario:** `[optional; use the exact canonical name]`

## 2. Problem before Orbit

Describe the workflow as the partner experienced it. Prefer one concrete episode over a list of
frustrations.

- What work had to span sessions, machines, or context windows?
- Which repository, CLI, VPN, cluster, or credential had to remain private?
- Where did the old workflow lose state or require a person to reconstruct it?
- What was the existing review or approval point?

**Before snapshot (2–4 sentences):**

> `[Write the partner's words or a faithful paraphrase. State what happened, not what Orbit was
> expected to fix.]`

**Baseline evidence:**

| Observation | Source / date | Redaction needed |
| --- | --- | --- |
| `[e.g., handoff required a pasted transcript]` | `[interview / ticket / run log]` | `[none / describe]` |
| | | |

## 3. Pilot hypothesis and success measures

Write a falsifiable hypothesis before describing the outcome.

> If `[workflow]` is represented as `[task graph / runner routing / approval step]`, then
> `[observable change]` will improve without weakening `[review or security constraint]`.

Choose measures the partner can actually verify. Do not invent a percentage because it sounds more
like a launch story.

| Measure | Baseline | Target / question | Observed | Evidence |
| --- | --- | --- | --- | --- |
| Handoff reconstruction time | | | | |
| Number of sessions or runners involved | | | | |
| Approval / merge decisions retained in history | | | | |
| Failed or abandoned runs recovered | | | | |
| Other partner-defined measure | | | | |

If the pilot did not establish a baseline, say **not measured**. Qualitative evidence is valid when
the method and limitation are stated.

## 4. Setup record

Record only the details needed to reproduce the shape of the workflow. Use placeholders for anything
that would reveal private infrastructure.

- **Orbit tag / commit:** `[vX.Y.Z or full SHA]`
- **Control-plane host:** `[local / private network / other; no hostname]`
- **Runner labels:** `[e.g., linux, internal-cli]`
- **Runtime(s):** `[Claude Code / Codex / Kimi / OpenCode / compatible provider]`
- **Workspace and worktree mode:** `[shared checkout / per-session worktree]`
- **Approval policy:** `[permission mode / allowlist summary]`
- **Database and backup check:** `[operator record or link]`
- **Relevant docs:** [README](../README.md), [self-hosting guide](self-hosting.md), `[additional link]`

**Setup caveat:** Runtime support, resume behavior, model features, and usage data vary by engine
and provider. A worktree is file-collision isolation, not a security boundary.

## 5. Observed workflow

Walk through one end-to-end episode in the order a reader could verify it.

### Step A — Plan

- Task list and dependency graph:
- What the person decided to keep manual:
- Link or sanitized capture:

### Step B — Execute locally

- Runner and repository placement:
- Runtime selected:
- What stayed on the runner:
- Heartbeat / connection evidence:

### Step C — Recover or parallelize

- Interruption or parallel task that was tested:
- What the next session read before acting:
- Worktree and diff behavior:
- What did not resume automatically, if anything:

### Step D — Approve and review

- Exact class of command that requested approval (never paste a secret):
- Who made the decision and where it was recorded:
- Diff / test / merge review outcome:

**Evidence table:**

| Claim in the draft | Evidence link or artifact | Commit / date | Verified by |
| --- | --- | --- | --- |
| `[claim]` | `[sanitized transcript, screenshot, run log]` | | |
| | | | |

## 6. Partner voice

Ask open questions first, then capture exact language. Mark paraphrases as paraphrases.

1. What changed in the way your team hands work from one session or machine to the next?
2. Which decision do you still want a person to make?
3. What private access made a local runner useful?
4. What surprised you or still needs work?

**Candidate direct quote (max 2–3 sentences):**

> “`[exact words; preserve meaning and context]”

- Speaker / role:
- Recording or written consent reference:
- Approved edits (grammar only / substantive):

## 7. Draft story card

Use this compact card for a README, Discussion, or article sidebar after the full case is approved.

- **Headline (≤ 12 words):** `[outcome and audience]`
- **One-line context:** `[who had what problem]`
- **What they tried:** `[task graph / runner / approval workflow]`
- **Observed result:** `[measured or explicitly qualitative result]`
- **Quote:** `[approved short quote]`
- **Limit / lesson:** `[what remains manual or unverified]`
- **Links:** [README](../README.md) · [Demo repo](../examples/demo-repo/) · `[partner-approved link]`

## 8. Editorial and claim review

- `[ ]` Uses **Self-hosted mission control for coding agents** as the category when positioning the product.
- `[ ]` Uses **Run coding agents on your own machines. Keep the plan, history, and controls in one self-hosted place.**
  as the core promise when the opening needs a product description.
- `[ ]` If scenarios are named, they appear in this order: **Work that outlives a chat**; **Parallel agents
  without checkout collisions**; **Access to private infrastructure**.
- `[ ]` Does not claim autonomy, hosted reliability, SLA, compliance certification, or exact recovery.
- `[ ]` Does not call a worktree a sandbox or imply that a runner account is isolated from its host.
- `[ ]` States that Orbit is pre-1.0 and links the [self-hosting](self-hosting.md) and
  [security](../SECURITY.md) guidance near installation or sensitive workflows.
- `[ ]` Names the exact tag or commit tested; never presents `main` as a supported release.
- `[ ]` Links back to the [README](../README.md) or [demo repo](../examples/demo-repo/).

## 9. Final approval record

- **Partner approver:**
- **Maintainer approver:**
- **Approved artifact / checksum or commit:**
- **Approved channels:** `[README / blog / GitHub Discussion / social / private deck]`
- **Publication date:**
- **Removal or correction contact:**
- **Notes / expiry of permission:**
