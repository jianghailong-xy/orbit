#!/usr/bin/env bash
# The production apiserver of the copy (`node dist/main.js`), on 127.0.0.1:3396, with none of the session's
# ORBIT_* variables. JWT_SECRET and PROVIDER_SECRET_KEY are made once into secrets.env (0600).
set -euo pipefail
S=/var/tmp/x1-disable-e2e
unset $(env | grep -o '^ORBIT_[A-Z0-9_]*') || true
[ -f "$S/secrets.env" ] || {
  umask 077
  printf 'JWT_SECRET=%s\nPROVIDER_SECRET_KEY=%s\n' "$(openssl rand -base64 32)" "$(openssl rand -base64 32)" > "$S/secrets.env"
}
set -a; . "$S/secrets.env"; set +a
cd "$S/src/src/apiserver"
exec env DATABASE_URL=postgresql://postgres:x1_disable_pw@127.0.0.1:5696/orbit PORT=3396 \
  PUBLIC_ORIGIN=http://localhost:2396 CORS_ORIGINS=http://localhost:2396 NO_COLOR=1 node dist/main.js
