-- Who opened a conversation: a person, or one of the doors through which Orbit opens one on its own
-- (docs/workspace-default-model-design.md §2.2). The workspace default — the engine, credential and
-- model a person's next new session is preselected on, and what unattended work with no anchor of its
-- own starts on (workspaces/workspace-provider.ts `lastProviderByWorkspace`) — counts only PERSON.
-- Before this, a project's coordinator, a judgment, a wiki chat, a Feishu message, a task list's
-- console, a service token's bridge and an @-mention's reply each moved that default as if a person
-- had chosen it.
--
-- Written by the creating door (SessionsService.create's `openedBy`), never derived from a title.
-- A task run (`task_id`) and a spawned child (`parent_session_id`) keep the default: those two columns
-- already say what they are, and the default excludes them on their own.
--
-- A constant default is catalog-only: no rewrite, no scan. The CHECK is added NOT VALID and validated
-- after the COMMIT, as 0436 did for "kind", so the ACCESS EXCLUSIVE lock covers only catalog changes.
BEGIN;

ALTER TABLE "session" ADD COLUMN "opened_by" TEXT NOT NULL DEFAULT 'PERSON';
ALTER TABLE "session" ADD CONSTRAINT "session_opened_by_check"
  CHECK ("opened_by" IN (
    'PERSON',
    'COORDINATOR',
    'COORDINATOR_JUDGMENT',
    'TASK_LIST_CONSOLE',
    'WIKI_CHAT',
    'FEISHU',
    'SERVICE_TOKEN',
    'MENTION_REPLY',
    'ORBIT'
  )) NOT VALID;

-- The rows written before the doors recorded it, each by the marker its own door left behind. Only
-- conversations with no task and no parent are read by the default, so only they are classified.
-- First match wins:
--   COORDINATOR          a session a project points at, or pointed at when its generation was last
--                        counted (project_runtime), or whose title a project manages or once took
--                        over (title_managed_by_project / title_before_project_management, the two
--                        marks projects.service writes when it opens or promotes a coordinator).
--   COORDINATOR_JUDGMENT run_source PROJECT_COORDINATOR on a session that runs no task: only the
--                        judgment door writes that pair on a conversation (0122).
--   WIKI_CHAT            wiki_chat_space_id, written only by the chat door.
--   TASK_LIST_CONSOLE    a session a task list points at as its console.
--   FEISHU               the activity row each Feishu door records for the session it made.
--   SERVICE_TOKEN        batch_id naming a service token: every session one token starts shares it.
--   MENTION_REPLY        context_task_id, written only by the @-mention delivery sweep.
--   ORBIT                prompt_by_orbit (0493) with none of the above: Orbit wrote its opening, but
--                        the marker that said which door is gone (a console re-pointed, a mention's
--                        task deleted).
UPDATE "session" s
   SET "opened_by" = CASE
     WHEN EXISTS (SELECT 1 FROM "project" p WHERE p."coordinator_session_id" = s."id")
       OR EXISTS (SELECT 1 FROM "project_runtime" r WHERE r."coordinator_session_id" = s."id")
       OR s."title_managed_by_project"
       OR s."title_before_project_management" IS NOT NULL
       THEN 'COORDINATOR'
     WHEN s."run_source" = 'PROJECT_COORDINATOR' THEN 'COORDINATOR_JUDGMENT'
     WHEN s."wiki_chat_space_id" IS NOT NULL THEN 'WIKI_CHAT'
     WHEN EXISTS (SELECT 1 FROM "task_list" l WHERE l."owner_session_id" = s."id") THEN 'TASK_LIST_CONSOLE'
     WHEN EXISTS (
       SELECT 1 FROM "activity" a
        WHERE a."credential_kind" = 'FEISHU'
          AND a."type" IN ('feishu.session.created', 'feishu.group.session.created')
          AND a."payload"->>'sessionId' = s."id"::text
     ) THEN 'FEISHU'
     WHEN s."batch_id" IS NOT NULL
       AND EXISTS (SELECT 1 FROM "service_token" t WHERE t."id" = s."batch_id") THEN 'SERVICE_TOKEN'
     WHEN s."context_task_id" IS NOT NULL THEN 'MENTION_REPLY'
     WHEN s."prompt_by_orbit" THEN 'ORBIT'
     ELSE 'PERSON'
   END
 WHERE s."task_id" IS NULL
   AND s."parent_session_id" IS NULL
   AND s."kind" = 'CONVERSATION'
   AND (
     EXISTS (SELECT 1 FROM "project" p WHERE p."coordinator_session_id" = s."id")
     OR EXISTS (SELECT 1 FROM "project_runtime" r WHERE r."coordinator_session_id" = s."id")
     OR s."title_managed_by_project"
     OR s."title_before_project_management" IS NOT NULL
     OR s."run_source" = 'PROJECT_COORDINATOR'
     OR s."wiki_chat_space_id" IS NOT NULL
     OR EXISTS (SELECT 1 FROM "task_list" l WHERE l."owner_session_id" = s."id")
     OR EXISTS (
       SELECT 1 FROM "activity" a
        WHERE a."credential_kind" = 'FEISHU'
          AND a."type" IN ('feishu.session.created', 'feishu.group.session.created')
          AND a."payload"->>'sessionId' = s."id"::text
     )
     OR (s."batch_id" IS NOT NULL AND EXISTS (SELECT 1 FROM "service_token" t WHERE t."id" = s."batch_id"))
     OR s."context_task_id" IS NOT NULL
     OR s."prompt_by_orbit"
   );

-- What the default reads: per workspace, the newest conversation a person opened. Partial, so the
-- LATERAL's LIMIT 1 is the first index entry rather than a walk past every task run, child and
-- coordinator the workspace has had since (EXPLAIN in workspace-default-opened-by.pg.spec.ts).
CREATE INDEX "session_workspace_person_opened_idx"
  ON "session" ("workspace_id", "created_at" DESC)
  WHERE "task_id" IS NULL AND "parent_session_id" IS NULL
    AND "kind" = 'CONVERSATION' AND "opened_by" = 'PERSON';

COMMIT;

ALTER TABLE "session" VALIDATE CONSTRAINT "session_opened_by_check";
