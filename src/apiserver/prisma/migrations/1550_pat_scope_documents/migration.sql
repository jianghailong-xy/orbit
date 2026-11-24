-- 1550: the personal access token scope `files` is called `documents` (Orbit Files is renamed Documents, project
-- 352m8OwBHdxxcHAOboe9B).
--
-- Every stored token and every pending device login holding `files` now holds `documents` in its place, so a token
-- keeps exactly the grant it had under the new name. The apiserver still reads `files` as `documents`
-- (PAT_SCOPE_ALIASES in auth/pat.service.ts): a row an older apiserver writes during a rolling deploy keeps working.
-- A row already holding `documents` only loses the old name, so no scope appears twice. Nothing else in either row
-- changes, no row is added or removed, and no table, column, trigger or function is touched. Runs twice safely: the
-- second pass finds no row holding `files`.
--
-- 1550: the highest number on main was 1537 (1537_managed_runner_current_image_version), and 1547 on any session
-- worktree, when this was written.

UPDATE "personal_access_token"
SET "scopes" = CASE WHEN 'documents' = ANY ("scopes") THEN array_remove("scopes", 'files')
                    ELSE array_replace("scopes", 'files', 'documents') END
WHERE 'files' = ANY ("scopes");

UPDATE "pat_device_login"
SET "scopes" = CASE WHEN 'documents' = ANY ("scopes") THEN array_remove("scopes", 'files')
                    ELSE array_replace("scopes", 'files', 'documents') END
WHERE 'files' = ANY ("scopes");
