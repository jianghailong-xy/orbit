# Project DONE: there is still no gate, and it is now a projection

A project's `DONE` used to mean that its stated acceptance criteria were satisfied — decided by a
database trigger and re-checked by the service before the write. Migration
`0229_project_acceptance_judgment_removal` removed both, on the account owner's decision of
2026-09-03. This page says what is true now, because a page describing a gate that is gone is worse
than no page.

## What decides a project's DONE

Since 2026-09-08, a PROJECTION — `projects/project-done-derived.ts`. It is not the gate 0229
removed, and the difference is the whole of this section: a gate refuses somebody's write, and this
refuses nobody. It re-reads facts that are already committed and stores what they project.

The account owner was asked again, with 0229's own sentence — "The owner was offered a narrower
guard and chose the other option" — quoted back to them, and answered that the derivation should be
built. So this is a re-deliberation of that decision and not the correction of an oversight.

`project.status` is projected as `DONE` when, and only while, BOTH hold:

- every criterion the project states reads `satisfied` **and** `landing = 'LANDED'`, from the two
  readers `project_get` already serves (`project-criterion-satisfaction.ts`,
  `project-criterion-landing.ts`) — not a second definition of either; and
- one `project_standard_set_confirmation` row names the version of the criteria that stands today
  (migration 0245, r3), compared by `criteriaSemanticRevision`. Editing a criterion's assertion or
  its verification method moves that digest, so the confirmation stops counting with no flag
  anybody has to clear.

A project that states no criteria is never projected `DONE`: "every one of zero criteria holds" is
the vacuous truth `NO_WORK_SERVES_IT` refuses one level down.

It is recomputed on three edges, none of which has a requester asking for a status: after the
owner's confirmation is written, on the post-commit edge of any task write in the project, and
after a write that restates the criteria themselves — an edit moves the version the confirmation
names, so the write that makes it is the write that has to re-derive from it. It
moves the column in BOTH directions — reopening a task or filing a new one against a met criterion
takes `DONE` away again — because a projection that could only ever set `DONE` would be a decision
recorded once rather than a reading of the facts. `CANCELLED` is never written and never overwritten:
that says a person dropped the project, which is not a claim the work can settle.

What 0229 removed stays removed, and none of it comes back to do this:

- there is no database trigger on `project` that inspects it (0150's `project_acceptance_done_gate`
  / `_advance_epoch` / `_epoch_audit` and 0172's `_criteria_fact` are all dropped, and so is 0150's
  alphabetical firing-order constraint, whose disappearance 0229 records as its intent);
- there is no application-layer refusal (`ProjectsService.refuseDirectDone` and its
  `PROJECT_DONE_AUTOMATIC_ONLY` 409 are removed);
- there is no acceptance epoch, no accepted-run pointer and no legacy-acceptance stamp on the row;
- the four acceptance tables and the `project_acceptance_verdict` enum stay dropped. The projection
  adds no migration and no table of its own.

Who may still WRITE the column directly is a separate question with a separate answer: every actor
that could write it after 0229 can still write it, except that a request carrying an acting session
is refused `PROJECT_STATUS_NOT_SESSION_WRITABLE` (`refuseProjectStatusWrite`, 2026-09-08). The
projection is not such a request — it carries no `status` from any caller and no session — which is
why the two coexist rather than the second refusing the first. `project-status-write-sites.spec.ts`
holds the complete list of places production code can set the column to those two.

Eleven projects were `DONE` when 0229 landed; ten of them stood on an acceptance run that no longer
exists. Their `status` was not rewritten then, and the projection does not rewrite it now unless one
of its two edges fires for that project.

## What the acceptance criteria are now

`project_acceptance_criterion_definition` still holds every authored criterion — 274 across 41
projects when 0229 landed — one row each, with the assertion text and the reader-facing
verification method. `0233_project_acceptance_criterion_wiring_removal` then took the declared
completion criterion and its configuration off that row: a criterion no longer names the work that
serves it, the work names the criterion (`task.criterion_definition_id`, migration 0232). They are
authored through `project_update`'s `acceptanceCriteriaItems` and read through `project_get`.

Nothing evaluates them. That is the same position an `EXECUTABLE` task has been in since
`0228_task_judgment_removal`: the declaration is precise, and the implementation is absent until the
account owner rebuilds one.

The legacy `project.acceptance_criteria` text went with the judgment. It was the input form of the
per-item rows — `project_acceptance_sync_legacy_definitions()` split it by `sha256(text)` and wrote
them — and once that parser was removed the text was prose with no parser, saying the same thing
twice. The per-item rows are the whole of it.

## Where a new finding belongs

A new finding belongs to the existing project only if it changes an acceptance criterion. In that
case, edit that criterion. If it changes no acceptance criterion, it does not belong to this
project's completion claim: create a separate project for it, rather than keeping an achieved goal
permanently open by adding unrelated work to its backlog.

The refusal to file new work into a settled project repeats this routing rule, so a caller is told
whether to revise this project's criteria or create a separate project.

## What is still recorded

`project_merge_evidence` survives: what a target branch was observed to CONTAIN, hashed by content
and never by `git branch --contains`. Nothing reads it to decide anything — acceptance runs were its
only consumer — so it is a record kept for a reader.
