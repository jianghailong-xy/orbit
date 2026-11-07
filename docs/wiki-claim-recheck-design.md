# Wiki claim recheck: a change on main re-checks what an entry says

Status: approved by the owner 2026-11-06 (D1–D4 as recommended); implemented on branch `orbit/task-a-wiki-b45864`,
not deployed. The measurement did not reach its 80% bar (§7.1).

## 0. Summary

1. **`verified` says an entry's anchors are still there, not that the entry is still true.** The contract defines
   `anchorStates.verified` as "the last check found it as recorded": a path anchor is checked with `git cat-file -e`, a
   commit anchor with `git merge-base --is-ancestor`. A pitfall whose fix landed, a decision that was reversed and a
   convention the code stopped following all keep reading `verified`, and stay in the push and in search. Nothing
   connects a fix on main to the entries it makes untrue.
2. **Add a claim recheck to the maintenance run**, after the anchors step, in two parts. A **screen** costs no model
   call: when the run's commits touch an active pitfall's, decision's or convention's paths, the runner counts the lines
   of those paths that hold what the entry talks about (its terms) before and after, and the entry joins a due queue,
   ranked by what changed. A **budget** of model calls (20 a run by default) takes the queue from the top: the System
   model reads the entry, the commits that touched its paths, their diff and the current lines, and answers `holds`,
   `fixed` (naming the commit), `obsolete` or `unsure`.
3. **Two answers before anything happens.** A `fixed` or `obsolete` answer is asked a second time, and only two
   agreeing answers act. The claims project measured that the verifier changes a quarter of its answers when the same
   prompt is asked again (§6).
4. **What two such answers do:** the entry leaves agents' search and the push at once, and a system challenge in Review
   names the commit and proposes Retire. The owner answers it as any challenge: Retire, Re-confirm (the model was
   wrong) or Amend. Nothing is retired without the owner.
5. **Wrong at the moment it was written.** An entry's first screen looks back to the time of its earliest source, so a
   fix that landed between the incident and the writing ranks it and is in front of the model. The challenge then says the entry was
   already fixed when it was recorded, which is what happened to `34ZfFGATAFiBBi9qmqPF7`.
6. **Cost:** at most 20 asks a run plus their second asks, about 23 calls, against 78 calls a maintenance run makes
   today (+29%, §5). Asking about every entry a run's commits touch would be 741 a run: hot files carry hundreds of entries.
   The budget is a rule (`rules.recheckAsksMax`), so the owner sets the cost, and the ranking decides what it buys.
7. **It needs one new repository operation, `history`** (`git grep`, `git log`, `git diff` over an entry's paths, §3.1).
   It goes live with a runner release and an apiserver deploy, both the owner's to approve.

## 1. What went wrong

The 2026-11-06 review of HPC sessions' `wiki_search` calls found three entries that were returned as current fact
although they were not true:

| Entry | Kind, state when found | What it says | What is true |
| --- | --- | --- | --- |
| `34ZfFGATAFiBBi9qmqPF7` and duplicate `34ZfFGMSeZihiWjfnfrqp` | pitfall, `confirmed`, anchors `verified` | `session.sum_cache_read` is int4 and overflows on long sessions, wedging turn-complete | The column was dropped on 10-02 by `0347_drop_session_token_sums` (`fdeea9d51`), 39 hours before the entry was recorded on 10-03. The same overflow later hit `usage`'s four counts, fixed by `0473_usage_token_counts_bigint` (`b4619320b`, 11-05). |
| `34s2IFZlpqkEDdbKZwcj3` | decision, `unreviewed`, anchors `verified` | the claims code stays on branch `wiki-claims-replay`, not merged to main | The claims pass landed through `9c27b68fa` (11-05 05:58Z) and the backfill through `ed358c61b` (07:14Z). At 17:30Z the entry was still returned as verified to the task running that backfill. |
| `34b7UEDj0LeCFuk4AWZUD` | convention, `auto`, no anchors | production deploys need no confirmation from the owner | The owner approves deploys (`34WhLfjm6eXNpWKzGWb1I`). The entry generalized one task's own instruction. |

All four were challenged on 2026-11-06 (changeset `34so6smHP5ywNOPjvYbqa`) and wait for the owner's answer.

**Why the checks missed them.** A path anchor holds while the file exists, and a file that was only modified is not
even checked again (`anchorRules.verify.skip`). The sum_cache_read entry's anchors were last checked on 10-10 and have
been skipped since: `schema.prisma` and `runner-api.controller.ts` were only modified. A commit anchor holds while the
commit is an ancestor of main, and a fix commit stays one forever. Nothing reads what the entry says against the code.

**What this design does not cover.** `34b7UEDj0LeCFuk4AWZUD` names no path: it is a rule about how people work, not a
claim about the code, and no recheck of code can catch it. It came from the extraction turning one task's instruction
into a convention, which is the claims project's side (§6). In the orbit space 6,302 of the 14,848 live pitfalls,
decisions and conventions name no path (§5).

## 2. Which entries, and when

### 2.1 Scope

An entry is rechecked when it is active, its kind is `pitfall`, `decision` or `convention`, and it names at least one
path: the paths of its `path` and `symbol` anchors, and a pitfall's `fields.trigger.paths`, spelled as the anchors
step spells them (no leading `./` or `/`, no trailing `/`; a path names itself and everything under it). Commit
anchors and the server-checked anchor types name no path. Principles, recipes and concepts are out of scope.

### 2.2 What the entry talks about: its terms

From the title, the summary and every text field (not `trigger.paths`), the server takes at most 8 terms: identifiers
(`snake_case`, `camelCase`, `UPPER_CASE`, dotted names and their last part), hyphenated names with two or more hyphens,
spans in backticks, and a pitfall's `trigger.errorSignature`. File names of its own paths, common words and SQL
keywords are left out. `34ZfFGATAFiBBi9qmqPF7` gives `sum_cache_read`, `session.sum_cache_read`, `IN_FLIGHT`,
`integer out of range`. Terms are only a filter and a reading aid; the model reads the entry whole.

### 2.3 The screen: what changed, without a model

Each run diffs main from the commit the previous run's recheck screened to its own commit (one `diff` operation, which
exists; the commit screened is kept per space). For every entry with a path in that diff, the runner counts, at both
commits, the lines of its paths that hold each term (`history`, screen mode, §3.1). The entry joins the due queue with
a rank, the lowest it has earned until it is asked:

| Rank | Signal |
| --- | --- |
| 0 | an entry written in the last 24 hours with any signal below since its earliest source |
| 1 | a term is in none of its paths any more, or one of its paths itself was added, deleted or renamed |
| 2 | the number of lines that hold one of its terms changed |
| 3 | its paths changed, its terms did not |

An entry never screened (every existing entry when this ships, and each new one) is screened once from the time of its
earliest source: the runner takes the first-parent commit of main before that time as the base. A fix that landed
between the incident and the writing (`34ZfFGATAFiBBi9qmqPF7`: the incident 10-02 00:41Z, the fix 04:15Z, the entry
10-03) then shows as a vanished term. New entries are screened first, so an entry the run itself applied is screened,
and if it ranks 0 asked, in the same run. At most `rules.recheckScreenMax` (400) never-screened entries a run.

An entry whose check found it `fixed` or `obsolete` and that waits for the owner is not screened.

### 2.4 The budget: which entries are asked

At most `rules.recheckAsksMax` (20) entries are asked a run: the lowest rank first, then the ones agents read most
(`stats` search hits and gets), then the longest due. An entry asked in the last 7 days waits
(`rules.recheckAskIntervalDays`). What does not fit stays due, keeping its rank and its age, for the next run.

## 3. What the model is asked

### 3.1 The `history` repository operation

A new kind beside `snapshot`, `read`, `diff` and `anchors`, run by the space's runner in its checkout like the others.
Input: the run's commit and, for each entry, its base (`from`: the commit screened or checked last) or the time to look
back to (`since`), its paths, its terms, and whether it is asked (`detail`). For each entry it answers, without a fetch
when the checkout has the commits:

- `base`: `from`, or `git rev-list -1 --first-parent --before=<since> <to>`, with its date;
- `census`: for each term, how many lines of the paths hold it at the base and at the head (`git grep -c -F`);
- `moved`: the paths themselves that `git diff --name-status <base> <to> -- <paths>` adds, deletes or renames.

Asked entries (`detail`) also get:

- `commits`: `git log <base>..<to> -- <paths>`, newest first, at most 20 (sha, date, subject), each marked when it
  changed how many times a term occurs (`git log -S`, a fixed string);
- `lines`: the lines of the paths at the head that hold a term (`git grep -n -F`), at most 40;
- `diff`: `git diff <base> <to> -- <paths>`, the hunks with a term first, at most 6,000 characters.

The screen is a few `git grep` calls an entry, about 15–30 s of git for the ~740 entries a run touches; nothing of it
reaches the model.

A runner that does not know the kind fails the operation, and the step then does nothing that run and says so in its
report: the apiserver can be deployed before or after the runners.

### 3.2 The question

One request per entry, step `recheck`, unit the entry's id, through the request queue like every other call. The
prompt is the entry (kind, title, summary, fields, recorded date), the base and head commits with their dates, and the
operation's answer. The rules it states:

- `holds`: what the entry says is still true at the head commit; an agent who acts on it today would be right.
- `fixed`: a change removed the problem the entry warns about, so an agent who believed it would be misled; name the
  commit.
- `obsolete`: what the entry talks about is gone or was replaced, or a decision or convention no longer describes the
  code, without that being a fix of it; name the commit if one shows it.
- `unsure`: the material shows a change to what the entry describes, but not enough to tell.

The commit list is split where the entry was recorded, and the prompt states how to read it (after round 1 of the
measurement, §7): a term the entry names as present or broken that occurs in none of its files now means fixed or
obsolete, even when the entry records that change; otherwise a pitfall whose own recorded fix is in the code holds —
the commit that applied it is not a fix of the entry — and is fixed only when a change after its recording altered the
behaviour it describes as current; a decision or convention is obsolete when a later commit does what it said not to
do; and nothing in the material that changes what the entry describes means holds.

The answer is one JSON object: `{"verdict": …, "commit": "<12-character sha from the list, or null>", "reason": "<one
sentence>"}`. An answer that cannot be read, or that names a commit not in the list for `fixed`, counts as `unsure`.

### 3.3 Two asks

A `holds` or `unsure` answer is the verdict. A `fixed` or `obsolete` answer is asked again under unit
`<entry id>#second`, with the same prompt. Two non-`holds` answers make the verdict (the first one's label and commit);
anything else makes it `unsure`, which changes nothing and lets the entry rank again the next time it is touched.

## 4. What a verdict does

| Verdict | Written on the entry | Effect |
| --- | --- | --- |
| `holds` | `claim_state` holds, the head commit, the time | leaves the due queue |
| `unsure` | `claim_state` unsure, the head commit | leaves the due queue; ranks again when touched |
| `fixed` / `obsolete` | the state, the commit that did it with its date and subject, the model's reason, whether it was already so when the entry was recorded | out of agents' search and the push at once; one system challenge in Review |

- **The challenge** is filed as the anchors step files one (`origin` maintenance, author `system`, its rationale naming
  the run's job), only when none is open. Its reason: "Claim recheck on origin/main at `<head>`: fixed by `<sha>` (`<date>`, `<subject>`).
  `<the model's reason>`. It was already fixed when this entry was recorded on `<date>`. Proposed answer: Retire."
- **Search.** The runner door's `wiki_search` leaves out an entry whose `claim_state` is `fixed` or `obsolete`, as it
  leaves out a tainted entry nobody vouched for. `wiki_get` still returns it, with `claimState` and the claim check in
  the entry, so an agent reading it by id sees "fixed by …". The owner's own search and Review show it as before.
- **The owner's answer.** Retire ends it. Re-confirm sets `claim_state` to `holds` at the commit of the verdict, so it
  is asked again only when its paths change after that. Amend writes a new revision, whose claim is `unchecked` again.
  A pitfall is "retired once its fix lands" (`kinds.pitfall.invalidation`) and a decision is "only superseded, never
  rewritten" (`kinds.decision.invalidation`), so Retire is the proposed answer for both labels.

**Storage.** Migration `0481` (free on main, `project/*` and pushed `orbit/*` branches on 11-06; checked again before it
lands): on `wiki_entry` `claim_state` (`unchecked`, `holds`, `fixed`, `obsolete`, `unsure`; default `unchecked`, a
CHECK), `claim_checked_ref`, `claim_checked_at`, `claim_check` (jsonb: verdict, commit, reason, base, both answers),
`claim_screened_at` (null until its first screen), and the queue's `claim_due_rank` and `claim_due_at`; on `wiki_space`
`claim_recheck_ref`, the commit the last recheck screened to; `wiki_repo_op_kind_chk` gains `history`. The service's
one writer of an entry writes the verdicts (`applyOp`, op `claim_check`, as `anchor_check`); the screen writes only
the queue columns of the entries it ranks, in one statement.

**Report.** `report.recheck`: `{ head, from, screened, ranked: {0, 1, 2, 3}, asked, calls, holds, fixed, obsolete,
unsure, due, skipped }`.

**Contract.** A new block `maintenance.job.server.recheck`, the closed set `claimStates`, `repoOps.kinds` + `history`,
`rules.steps.recheck`, the rules above, and a section in `docs/wiki-contract.md`. No client decodes the report, and
Swift and Kotlin read entries leniently; the Go `wiki_search` struct does not change.

## 5. How many model calls

Read-only export of the orbit space on 2026-11-06 09:41Z (orbit-prod session `34soSaXtHYh4J3fJRzBdk`), replayed
against main's history on HPC. Scripts and raw numbers are kept with the task's evidence. The terms were a prototype
of §2.2 that also took hyphenated words with one hyphen, so the product's counts of rank 2 are no higher.

| What | Value |
| --- | --- |
| Maintenance runs in 14 days | 102 (7.3 a day), 101 consecutive pairs of commits |
| Model calls a run makes today | 78.4: verify 31, extract 15, claims 10, the documents 21, plan 0.6 |
| Commits between two runs | mean 15.2, p50 8, p90 41 |
| Live pitfalls, decisions, conventions | 14,848; 8,546 name a path (5,510 / 1,930 / 1,106), 6,302 do not |
| Entries a run's commits touch | mean 741, p50 690, p90 1,727: asking all of them is ten times today's calls |
| Pitfalls a run touches, with terms | mean 480 |
| Rank 1 (a term vanished, or a path itself added, deleted or renamed) | 0.3 a run |
| Rank 2 (a term's line count changed) | 59 a run (p50 36, p90 157) |
| Rank 3 (only touched) | 420 a run |
| Asks ranks 1–2 want with one ask an entry a week, no cap | 23.4 a run (pitfalls); about 36 with decisions and conventions |

The budget decides the rest. Simulated over the 14 days on the pitfalls' signals (ranks 1–2, one ask an entry a week):

| `recheckAsksMax` | Asks a run | Model calls a run (with ~15% second asks) | Against today's 78 | Rank 1–2 wait p50 / p90 | Still due after 14 days |
| --- | --- | --- | --- | --- | --- |
| 10 | 10 | ~12 | +15% | 137 h / 209 h | 868 |
| **20** | **20** | **~23** | **+29%** | **47 h / 164 h** | **576** |
| 40 | 23.4 (the cap is reached in 23 of 67 runs) | ~27 | +35% | 0 h / 162 h | 455 (waiting out their week) |

A recheck prompt is about the size of a verification's (an entry and up to ~10 KB of git), so 23 calls a run add a
few model-minutes and one to two minutes of wall time at the queue's concurrency of 4.

**The backlog.** Of the 5,323 pitfalls with paths and terms, 125 had a term vanish since their earliest source (rank
1), 2,316 had a term's count change (rank 2), and 1,174 were never touched after they were written. Rank 1 is always
asked first, so the 125 (and their share of decisions and conventions) are asked within the first day of runs. Of the
entries of §1, both sum_cache_read pitfalls are rank 1 (`sum_cache_read` 1 → 0 and `sumCacheRead` 2 → 0 lines in
their paths since 10-02 00:41Z); the claims decision is rank 2 (`wiki-claims-replay` 0 → 2 lines since 11-04 19:50Z);
the deploy convention names no path. Rank 2 never drains completely at 20 asks a run: it is a queue ordered by how
often agents read the entry, so what agents actually find is asked first.

## 6. The wiki memory claims project (`34ronGIfMKgVckX2XJ5J6`)

The two are halves of one problem: what enters the wiki, and whether it stays true.

- **Stale is the main error.** The claims project's M1 audit (design §6.1) judged 210 sampled `auto` entries against main: of
  12 wrong, 10 were wrong because the code changed later; of 13 partly right, 5 were stale. The claims project changes
  what enters (evidence classes, the trust cap R2, the pass over agents' notes). It has nothing for an entry that was
  right and stopped being right; this design is that path.
- **The verifier is unstable.** Its replay asked the same prompt twice for 96 entries and 24 answers changed (25.0%, G4).
  So no single answer of the System model retires or hides anything here: two asks must agree (§3.3), and the result is
  only a challenge the owner answers. The measurement (§7) reports how often the two asks disagree.
- **Agreeing with the text.** The claims replay found the model sometimes repeats what it is shown (G2). The recheck
  shows the entry but judges it against code and commits, not against its own sources, and it states that identifiers
  still present and used as described mean `holds`.
- **One queue.** Both send their calls to the same System model through the same queue (concurrency 4). The recheck's
  calls are the maintenance run's own, at the run's priority.
- **New entries.** Every entry the claims pass writes is an entry like any other here: it is screened in the run that
  wrote it, and asked there when its code already changed since its sources.

## 7. Measurement

Method, seed and readings are in task comment `34soO1JKvd7COiHWw9Gqw`, written before any production read: 30 active
pitfalls whose paths changed on main after they were written, drawn by a seeded hash; two blind raters label each one
`holds`, `fixed` or `obsolete` against main at `29739d60a`; their agreements are the gold; the recheck must match at
least 80% of the gold and must catch `34ZfFGATAFiBBi9qmqPF7` and `34s2IFZlpqkEDdbKZwcj3`. Production stays read-only:
the replay runs in `orbit-wiki-worker` over a read-only connection from an orbit-prod session, and calls the System
model directly instead of through the queue.

The replay asks about every sampled entry, so it measures the question and the two asks (§3), not the screen. The
report says separately which rank the screen would have given each sampled entry and each named case.

### 7.1 Results (2026-11-06 and 11-07): the 80% bar was not met

| | Round 1 (99f4b760f) | Round 2 (e365ca495) |
| --- | --- | --- |
| Raters agreeing | 30/30 (kappa 1.00): 25 holds, 3 fixed, 2 obsolete | 24/30 (kappa 0.32): 22 holds, 2 fixed |
| Recheck = gold | **17/30 = 56.7%** | **17/24 = 70.8%** |
| holds called fixed or obsolete | 4 fixed | 1 obsolete |
| holds called unsure | 6 | 6 |
| fixed or obsolete missed | 3 fixed called holds | 0 |
| `34ZfFGATAFiBBi9qmqPF7` / `34s2IFZlpqkEDdbKZwcj3` | fixed (wrong when recorded) / obsolete | fixed (wrong when recorded) / obsolete |

Task comments `34tAEF209cmYgKyBHTtlv` and `34tBOKTR5TNf57r6LyoCV` hold the details. Production stayed read-only both
times: orbit-prod session `34suBpsw6k2yKTA5GGVHq`, `orbit-wiki-worker`, a `default_transaction_read_only` connection whose
write probe was refused, and the System model called directly, so no queue row or wiki row was written.

What the misses say:
- **Round 1's four false "fixed"** named the entry's own recorded fix, which a first check's look-back includes. Round
  2's question (commits split where the entry was recorded, reading rules) removed them.
- **`unsure` is the larger loss in both rounds** (6 of each). Two round-2 entries name glob paths that the runner reads
  literally; two had more history than 20 commits and a 6,000-byte diff show; two were second asks that split. The
  measurement counts unsure as a miss, though in the product it acts on nothing, exactly as holds does.
- **A vanished term is not always stale:** one entry's test file was deleted while the lesson stayed current.

Before this goes live, a next iteration would read glob paths as globs, give a first check more history around the
commits that changed a term's count, and measure again on a fresh sample. Nothing here is deployed.

## 8. What needs the owner

- Deploying the apiserver with migration `0481`, and releasing a runner with the `history` operation. Either order
  works (§3.1).
- After the deploy, every existing entry with a path is screened once, 400 a run (about three days), and the asks
  start with rank 1. Each `fixed` or `obsolete` verdict is a Review card; if they come too fast, lowering
  `rules.recheckAsksMax` slows them.

## 9. Decisions

- **D1. What two `fixed`/`obsolete` answers do.** Recommended: out of agents' search and the push, plus a challenge
  (§4). Alternative: only the challenge, so agents keep finding the entry until the owner answers.
- **D2. The budget.** Recommended: 20 asks a run (~23 calls, +29%). Alternatives: 10 (~12 calls, +15%, rank-2
  entries wait about six days) or 40 (~27 calls, +35%, the queue keeps up).
- **D3. Existing entries.** Recommended: screen every existing entry once from its earliest source, so old fixes such
  as the three of §1 are found. Alternative: only entries written or touched from the deploy on, which never asks
  about an old entry whose code does not change again.
- **D4. The `history` operation.** Recommended: a new runner operation, so the challenge names the commit. Alternative:
  the server alone, with the operations that exist (`diff`, `read`): no runner release, but the verdict could name only
  a range of commits, not the fix.

## 10. Not doing

- No automatic retire, supersede or rewrite: a retire waits for the owner in every review mode.
- No change to the anchors step, to `anchorStates`, or to how a new op is verified (the verifier still judges an op from
  its records alone).
- Nothing for entries that name no path.
