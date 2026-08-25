ALTER TABLE "session"
  ADD COLUMN "title_managed_by_project" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "title_before_project_management" TEXT;

-- No historical row is adopted automatically. Even a title matching Orbit's old
-- `Coordinator: <project>` convention could have been typed manually later; storage has no
-- provenance that distinguishes those cases. A false positive would let a future Project rename
-- overwrite a user's chosen Session title, while a false negative merely preserves the title they
-- already see. Only an explicit promotion/new coordinator performed by the new service sets the
-- ownership bit.
