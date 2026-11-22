-- An owner's Update Now of a busy Orbit Cloud runner, with their word that its running turns may be interrupted
-- (managed-runner.service.ts updateNow, `interruptTurns: true`): the manager asks the backend to stop the instance rather
-- than wait for it to be idle (ManagedRunnerManager.ownerUpdate). False for a request on an idle runner. Additive: a
-- NOT NULL boolean with a constant default, a catalog change with no rewrite, which the running release neither reads
-- nor writes.
ALTER TABLE "managed_runner" ADD COLUMN "update_interrupt_turns" BOOLEAN NOT NULL DEFAULT false;
