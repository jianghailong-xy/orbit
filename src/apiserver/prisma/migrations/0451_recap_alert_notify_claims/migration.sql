-- 0451 — three things each apiserver kept in its own memory, kept on the rows they are about instead, so that several
-- apiservers (docs/self-hosting.md, "Several apiservers") hold them between them as one apiserver does:
--
--   session.recap_claimed_at     the rolling recap's two-minute window (sessions/recap.ts). A pass that obeys the window
--                                claims it here just before it asks a model, and only while neither this nor recap_at is
--                                inside it; a settle that finds it taken asks again when it closes. Each apiserver used to
--                                keep its own timer for that wait, so settles of one session taken by different
--                                apiservers each asked a model once a window. A pass that writes its recap leaves this
--                                equal to recap_at; one that writes nothing clears it.
--   session.alerted_approval_at  the created_at of the approval the owner's phone was last alerted for (push/push.service.ts,
--                                notifyApprovalRequest): the first approval of a stretch in which the session has
--                                approvals pending. Set under the session row's lock and only ever forward, so one stretch
--                                rings once whichever apiserver took its approvals. It used to be a set of sessions in each
--                                apiserver's memory.
--   session.agent_notified_at    when an agent in the session last rang its owner through `notify` (notifyAgentMessage),
--   user.agent_notified_at       and when a `notify` naming no session last rang the account. Once a minute, compared and
--                                set in one statement, so the limit holds over both doors that reach it: POST
--                                /runner/notify, and the daemon's POST /runner/sessions/:id/notify, which the link gateway
--                                spreads over every apiserver. It used to be a map in each apiserver's memory.
--
-- Catalog-only ADD COLUMNs, nullable, with no default: no row is read, written or backfilled, and every stored row reads
-- NULL, which each reader takes as "never claimed". No index, trigger, function or constraint: every trigger on
-- "session" is scoped to other columns, and none is declared on "user".
--
-- 0451: the next number free on main, on every branch of origin, in every commit of `git log --all` and in every
-- worktree on this host (2026-10-28). Every statement can run twice.

ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "recap_claimed_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "alerted_approval_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "agent_notified_at" TIMESTAMP(3);

ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "agent_notified_at" TIMESTAMP(3);
