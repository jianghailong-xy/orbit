#!/usr/bin/env bash
# What the stack's database holds for Google sign-in: the sign_in_provider row (the secret as its length and
# whether the placeholder's plaintext appears in it), and the flows and identities tables.
set -euo pipefail
docker exec google-doc-e2e-pg psql -U postgres -d orbit -P pager=off -c "
SELECT provider, enabled, client_id, length(client_secret_enc) AS secret_enc_len,
       position('placeholder-not-a-google-secret' in client_secret_enc) > 0 AS plaintext_stored,
       signup_policy, updated_by_id IS NOT NULL AS updated_by_set, updated_at
FROM sign_in_provider;" -c "
SELECT status, intent, client, expires_at > now() AS live, ticket_hash IS NOT NULL AS has_ticket FROM oauth_login_flow ORDER BY created_at;" -c "
SELECT count(*) AS identities FROM user_identity;" -c "
SELECT email, role, password_hash IS NULL AS passwordless, created_at FROM \"user\" ORDER BY created_at;"
