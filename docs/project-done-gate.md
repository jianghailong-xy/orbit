# Project DONE: there is no gate

A project's `DONE` used to mean that its stated acceptance criteria were satisfied — decided by a
database trigger and re-checked by the service before the write. Migration
`0229_project_acceptance_judgment_removal` removed both, on the account owner's decision of
2026-09-03. This page says what is true now, because a page describing a gate that is gone is worse
than no page.

## What decides a project's DONE

Nothing. `project.status = 'DONE'` is an ordinary column write:

- there is no database trigger on `project` that inspects it (0150's `project_acceptance_done_gate`
  / `_advance_epoch` / `_epoch_audit` and 0172's `_criteria_fact` are all dropped);
- there is no application-layer refusal (`ProjectsService.refuseDirectDone` and its
  `PROJECT_DONE_AUTOMATIC_ONLY` 409 are removed);
- there is no acceptance epoch, no accepted-run pointer and no legacy-acceptance stamp on the row.

Any actor that may write the project — the account owner, a runner credential, a coordinator
session, raw SQL — may set it, and nothing is consulted first. Eleven projects were `DONE` when this
landed; ten of them stood on an acceptance run that no longer exists. Their `status` was not
rewritten. They are `DONE`, and the evidence for it is gone.

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
