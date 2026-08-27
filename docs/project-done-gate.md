# Project DONE gate

A project's `DONE` means that its stated acceptance criteria are satisfied. It does not mean that
its task list is empty, or that every task reached `DONE`.

## Completion inputs

The gate reads:

- the current acceptance-criterion definitions and the latest run's verdict for every criterion;
- merge evidence cited by those criteria, the acceptance epoch, and the run's freshness;
- open project blockers and unresolved live verification failures.

It does not read task counts, task statuses, completion policies, or task-verification verdict
aggregates. Tasks are ways to pursue the outcome; they are not a second definition of the outcome.
Consequently:

| Acceptance criteria | Task list | DONE gate |
|---|---|---|
| every criterion `PASS` | may contain `OPEN` nice-to-have work | allow, unless an explicit blocker remains |
| any criterion is not `PASS` | even if every task is `DONE` | refuse and name each non-PASS criterion |

The service gate is `ProjectAcceptanceService.assertDoneAllowed`. Migration
`0182_project_done_gate_acceptance_only` enforces the same criterion rule for direct database
writers and removes the task-change triggers that previously reopened accepted projects.

## Where a new finding belongs

A new finding belongs to the existing project only if it changes an acceptance criterion. In that
case, return that criterion to non-`PASS` by opening/running the next acceptance attempt; the
project then leaves its completed standing because its acceptance is no longer current.

If the finding changes no acceptance criterion, it does not belong to this project's completion
claim. Create a separate project for it. Do not keep an achieved goal permanently open by adding
unrelated or nice-to-have tasks to its backlog.

DONE refusals and the refusal to file new work into a settled project repeat this routing rule so a
caller is told whether to re-run this project's acceptance or create a separate project.
