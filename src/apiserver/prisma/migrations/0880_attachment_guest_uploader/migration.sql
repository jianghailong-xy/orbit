-- 0880: who uploaded a session guest's image (docs/session-guests-design.md §5).
--
-- A guest attaches images to their message: the upload is a row of the owner's session (owner_id is the session's
-- owner, so the turn's own checks and the runner's delivery read it as any image of that session), and
-- uploaded_by_guest_id names the guest who sent it, so a guest turn names only the guest's own uploads. NULL on every
-- other row. No FK, as session_guest.owner_id has none: the session's cascade already takes the row, and an id left
-- by a deleted account matches no live invitation.
--
-- One nullable column with no default: catalog-only, no table rewrite. The running release neither reads nor writes
-- it. Can run twice.

ALTER TABLE "attachment" ADD COLUMN IF NOT EXISTS "uploaded_by_guest_id" UUID;
