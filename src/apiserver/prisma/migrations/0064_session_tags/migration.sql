-- Session tags: personal, colored Files.app-style labels the owner applies to their sessions.
-- `session_tag` is the per-owner label library (name + #RRGGBB color); `is_system` marks the 7
-- seeded preset-color tags (Red…Gray) that are always present + selectable but not editable.
-- `session_tag_link` is the many-to-many join onto sessions. Both link endpoints cascade-delete
-- with their parent, so trashing a session or deleting a tag cleans up its links; the sessions
-- themselves are never touched by a tag delete. No rows are seeded here — the 7 system tags are
-- created lazily per owner on first list (SessionTagsService.ensureSystemTags), so existing users
-- need no backfill and new users get theirs the first time any client opens the tag list.
CREATE TABLE "session_tag" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "owner_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_tag_pkey" PRIMARY KEY ("id")
);

-- One tag name per owner: makes the system-tag seed idempotent and blocks duplicate custom names.
CREATE UNIQUE INDEX "session_tag_owner_id_name_key" ON "session_tag"("owner_id", "name");

CREATE INDEX "session_tag_owner_id_idx" ON "session_tag"("owner_id");

ALTER TABLE "session_tag" ADD CONSTRAINT "session_tag_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "session_tag_link" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_tag_link_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "session_tag_link_session_id_tag_id_key" ON "session_tag_link"("session_id", "tag_id");

CREATE INDEX "session_tag_link_tag_id_idx" ON "session_tag_link"("tag_id");

ALTER TABLE "session_tag_link" ADD CONSTRAINT "session_tag_link_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "session_tag_link" ADD CONSTRAINT "session_tag_link_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "session_tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
