-- 1590: the personal access token scope `documents` is called `drive` (Documents is renamed back to Drive, project
-- 35370KiEBDnxlOS5Yyaxh).
--
-- Every stored token and every pending device login holding `documents`, or the older `files` (a row an older apiserver
-- wrote after 1550 ran), now holds `drive` in its place, so a token keeps exactly the grant it had under the new name.
-- The apiserver still reads `documents` and `files` as `drive` (PAT_SCOPE_ALIASES in auth/pat.service.ts): a row an older
-- apiserver writes during a rolling deploy keeps working. `drive` takes the place of `documents` (of `files` in a row
-- without `documents`) and the other old name is removed; a row already holding `drive` only loses the old names. So no
-- scope appears twice and the rest keep their order. Nothing else in either row changes, no row is added or removed,
-- and no table, column, trigger or function is touched. Runs twice safely: the second pass finds no row holding
-- `documents` or `files`. 1550 is left as it is.
--
-- 1590: the highest number on main was 1560 (1560_document_sync), and 1582 on any pushed project/* or orbit/* branch
-- (1582_integration_main_sync_held), when this was written.

UPDATE "personal_access_token"
SET "scopes" = CASE WHEN 'drive' = ANY ("scopes") THEN array_remove(array_remove("scopes", 'documents'), 'files')
                    WHEN 'documents' = ANY ("scopes") THEN array_remove(array_replace("scopes", 'documents', 'drive'), 'files')
                    ELSE array_replace("scopes", 'files', 'drive') END
WHERE "scopes" && ARRAY['documents', 'files']::text[];

UPDATE "pat_device_login"
SET "scopes" = CASE WHEN 'drive' = ANY ("scopes") THEN array_remove(array_remove("scopes", 'documents'), 'files')
                    WHEN 'documents' = ANY ("scopes") THEN array_remove(array_replace("scopes", 'documents', 'drive'), 'files')
                    ELSE array_replace("scopes", 'files', 'drive') END
WHERE "scopes" && ARRAY['documents', 'files']::text[];
