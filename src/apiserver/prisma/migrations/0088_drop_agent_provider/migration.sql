-- An agent holds no provider. It names a machine and a project directory; the provider is a
-- per-session binding (session.provider), and the default a new session inherits is derived from
-- the project's most recent interactive session (0087's index). Verified before dropping: for
-- every agent that had ever run a session, the derived value equalled the stored one.
-- AlterTable
ALTER TABLE "agent" DROP COLUMN "provider",
                    DROP COLUMN "provider_builtin";
