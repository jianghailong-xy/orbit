-- Attachment: in-DB (bytea) blob storage for web-composer image uploads. Owner-scoped for
-- tenant isolation; optional session FK cascades cleanup when a session is deleted. See the
-- model comment in schema.prisma for why bytes live in Postgres rather than disk/object store.
CREATE TABLE "attachment" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "session_id" UUID,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "attachment_owner_id_idx" ON "attachment"("owner_id");

CREATE INDEX "attachment_session_id_idx" ON "attachment"("session_id");

ALTER TABLE "attachment" ADD CONSTRAINT "attachment_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "attachment" ADD CONSTRAINT "attachment_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
