-- Keep the account's permission-mode change history readable by actor and time.
CREATE INDEX "activity_default_permission_mode_audit_idx"
    ON "activity" ("actor_id", "created_at" DESC, "id" DESC)
    WHERE "type" = 'preferences.default_permission_mode.changed';
