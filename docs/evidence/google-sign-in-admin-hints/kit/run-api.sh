#!/usr/bin/env bash
# The production apiserver of the copy, on 127.0.0.1:3386, with none of the session's ORBIT_* variables.
# PROVIDER_SECRET_KEY comes from secrets.env; ROTATE=1 starts it with a fresh one instead — the case the
# walkthrough's second half is about — leaving secrets.env alone.
set -euo pipefail
S=${S:-/var/tmp/google-sign-in-admin-hints}
unset $(env | grep -o '^ORBIT_[A-Z0-9_]*') || true
[ -f "$S/secrets.env" ] || {
  umask 077
  printf 'JWT_SECRET=%s\nPROVIDER_SECRET_KEY=%s\n' "$(openssl rand -base64 32)" "$(openssl rand -base64 32)" > "$S/secrets.env"
}
set -a; . "$S/secrets.env"; set +a
if [ "${ROTATE:-}" = 1 ]; then PROVIDER_SECRET_KEY=$(openssl rand -base64 32); echo "run-api: PROVIDER_SECRET_KEY replaced for this run"; fi
cd "$S/src/src/apiserver"
exec env DATABASE_URL=postgresql://postgres:google_hints_pw@127.0.0.1:5686/orbit PORT=3386 \
  PUBLIC_ORIGIN=http://localhost:2386 CORS_ORIGINS=http://localhost:2386 NO_COLOR=1 node dist/main.js
