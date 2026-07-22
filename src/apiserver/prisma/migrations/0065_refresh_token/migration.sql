-- RefreshToken: a long-lived opaque token a client swaps for a fresh short-lived access JWT via
-- POST /api/auth/refresh, so an active client is never forced to re-login. Only the SHA-256 hash of
-- the token is stored (never the token itself). Rotating: each refresh sets revoked_at on the
-- presented row and inserts a new one; replaying an already-revoked row signals theft and revokes the
-- user's whole family. Logout revokes the presented token. Rows cascade-delete with the user.
CREATE TABLE "refresh_token" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "refresh_token_token_hash_key" ON "refresh_token"("token_hash");

CREATE INDEX "refresh_token_user_id_idx" ON "refresh_token"("user_id");

ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
