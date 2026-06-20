-- Link uploaded image attachments to the conversation turn they were sent with, so the
-- inbox can hand the runner exactly that turn's images. Nullable (text-only turns have
-- none) + ON DELETE CASCADE (withdrawing a queued turn or ending the session drops its
-- blobs). FK actions match the existing session FK on this table.
ALTER TABLE "attachment" ADD COLUMN "turn_id" UUID;

CREATE INDEX "attachment_turn_id_idx" ON "attachment"("turn_id");

ALTER TABLE "attachment" ADD CONSTRAINT "attachment_turn_id_fkey" FOREIGN KEY ("turn_id") REFERENCES "conversation_turn"("id") ON DELETE CASCADE ON UPDATE CASCADE;
