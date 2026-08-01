-- The dedicated System list is being removed. Every historical `system` session was
-- produced by the task runner, so move all of them to Active. Updating every system row
-- also covers task sessions detached by ON DELETE SET NULL after their task was deleted.
UPDATE "session"
SET "source" = 'user'
WHERE "source" = 'system';
