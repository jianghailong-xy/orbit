-- The Open list's version (sessions/open-list-version.ts) learns two more sources.
--
-- A session row now counts the open owner requests it asked (`owner_request`) and the PENDING task
-- moves waiting on it (`project_handoff_approval`) in `pendingApprovals` / `waitingKind`
-- (projects/owner-decision-signal.ts). The Open list answers 304 from the counters in
-- `open_list_epoch` without building the list, so a table the row reads and that bumps no counter
-- is a change the clients never see: a request answered while the list sits on a 304 would keep
-- its row amber. Both tables carry `owner_id`, so they bump through `open_list_bump_owner` like
-- every other owned source (0484, 0487, 0511). Triggers only; no row is written at apply time.

CREATE TRIGGER "owner_request_open_list_epoch_insert" AFTER INSERT ON "owner_request"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('owner_request');

CREATE TRIGGER "owner_request_open_list_epoch_update" AFTER UPDATE ON "owner_request"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('owner_request');

CREATE TRIGGER "owner_request_open_list_epoch_delete" AFTER DELETE ON "owner_request"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('owner_request');

CREATE TRIGGER "project_handoff_approval_open_list_epoch_insert" AFTER INSERT ON "project_handoff_approval"
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('handoff_approval');

CREATE TRIGGER "project_handoff_approval_open_list_epoch_update" AFTER UPDATE ON "project_handoff_approval"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('handoff_approval');

CREATE TRIGGER "project_handoff_approval_open_list_epoch_delete" AFTER DELETE ON "project_handoff_approval"
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION open_list_bump_owner('handoff_approval');
