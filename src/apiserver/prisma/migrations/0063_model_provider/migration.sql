-- ModelProvider: a control-plane-configured model provider (e.g. DeepSeek) that borrows a
-- built-in runtime CLI (runtime = claude|codex) instead of shipping its own. `slug` is the
-- identity stored in agent/session.provider; `api_key_enc` is the AES-256-GCM ciphertext of
-- the provider API key (PROVIDER_SECRET_KEY master key — never stored or served in plaintext).
-- `owner_id` NULL = a shared provider (admin-managed, visible to everyone); set = a personal
-- (BYOK) provider visible and dispatchable only for its owner. Rows cascade-delete with the user.
CREATE TABLE "model_provider" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "runtime" TEXT NOT NULL DEFAULT 'claude',
    "base_url" TEXT NOT NULL,
    "api_key_enc" TEXT NOT NULL,
    "models" JSONB NOT NULL DEFAULT '[]',
    "default_model" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER,
    "owner_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_provider_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "model_provider_slug_key" ON "model_provider"("slug");

CREATE INDEX "model_provider_owner_id_idx" ON "model_provider"("owner_id");

ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
