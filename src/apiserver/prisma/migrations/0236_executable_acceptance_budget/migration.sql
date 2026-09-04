-- How long an EXECUTABLE acceptance command may run stops being a constant compiled into the
-- runner.
--
-- Measured on 2026-09-03: `runShellTurn` bounded every shell turn at a hard-coded two minutes that
-- nothing could change, so a task whose declared command is a real test suite was judged by host
-- load rather than by its code. Orbit's own Go suite ran 101s, 104s, 105s and 126s across four runs
-- of the same tree; the 101s run derived DONE and the 126s run was killed, reported -1 and derived
-- FAILED. EXECUTABLE was unusable for any repository whose suite runs longer than two minutes.
--
-- This migration is one nullable integer and a CHECK. NULL is the default and means the runner's
-- own two-minute budget, so every existing row keeps exactly the behaviour it has.
--
-- The name is reused deliberately and the machinery is not. 0200 created a column called
-- "acceptance_timeout_seconds" and 0227 dropped it with the rest of that runtime; what comes back
-- is the number alone. No admission reads it before the command starts -- it is handed to the
-- runner with the work and bounds a context deadline, which is the whole of its effect. The two
-- ceilings it was negotiated against stay dropped, and it is used exactly as declared, so there is
-- no clamp for a ceiling to apply. No typed termination returns: a command that outlives this
-- budget is killed and reported as exit -1, compared literally against
-- "acceptance_expected_exit_code" like any other integer, so it still derives FAILED -- raising a
-- budget cannot turn a failing suite into a passing one. Nothing about a run is recorded; this is
-- an INPUT its author writes. `executable-acceptance-runtime-removal.spec.ts` states the same
-- boundary as assertions.
--
-- Why a column, when 0230 pointedly created none: the budget is a property of the declared work,
-- authored with the command it bounds, and it has to be readable when that command is dispatched
-- -- a different transaction, in a different process, from the one that wrote it.
--
-- The constraint is new rather than a revival of "task_executable_runtime_shape_check", whose
-- subject was the negotiation and seven of whose eight columns are gone.

BEGIN;

ALTER TABLE "task"
  ADD COLUMN "acceptance_timeout_seconds" integer;

ALTER TABLE "task" ADD CONSTRAINT "task_acceptance_timeout_shape_check" CHECK (
  "acceptance_timeout_seconds" IS NULL
  OR (
    "completion_criterion" = 'EXECUTABLE'
    AND "acceptance_command" IS NOT NULL
    AND "acceptance_expected_exit_code" IS NOT NULL
    AND "acceptance_timeout_seconds" > 0
    AND "acceptance_timeout_seconds" <= 86400
  )
);

COMMIT;
