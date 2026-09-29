-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- A profile photo of one's own. Every client draws the account's avatar — Settings' header, the
-- sidebar's account row, the web's Profile page — and until now it could only be the first letter of
-- the name. The owner picks a photo, the client crops it square and scales it down, and it is kept
-- here and drawn in the letter's place.
--
-- WHAT IS ADDED
-- -------------
--   user_avatar   at most one row per user: the image's bytes, its type as the server read it off the
--                 bytes (JPEG, PNG or WebP — never what the client claimed), and when it was set,
--                 which is the version a client fetches it by. A new photo replaces the row, removing
--                 the photo deletes it, and deleting the user takes it with them.
--
-- Its own table rather than columns on "user": that row is read on every sign-in and token refresh,
-- often without a select list, and a photo has no business riding along on those reads.
--
-- No INSERT, UPDATE or DELETE: the table starts empty.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE "user_avatar" (
    "user_id" UUID NOT NULL,
    "mime_type" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_avatar_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "user_avatar_mime_type_check" CHECK ("mime_type" IN ('image/jpeg', 'image/png', 'image/webp')),
    CONSTRAINT "user_avatar_data_check" CHECK (octet_length("data") > 0)
);

ALTER TABLE "user_avatar" ADD CONSTRAINT "user_avatar_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
