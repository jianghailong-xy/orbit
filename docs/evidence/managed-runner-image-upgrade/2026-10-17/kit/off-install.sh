#!/bin/bash
# The `off` host's deployment: installed by hand, as README's Quick Start says to ("write .env as self-hosting
# describes and run `docker compose up -d --build`"), so its .env carries no managed runner line at all — the
# kind of deployment orbitd.io is. Run inside d6-off-dind in /work/orbit. If the first boot's migrations outlast
# the apiserver's health check on this slow disk (D3 saw it), wait for it and run `up` again; both are logged.
set -u
cd /work/orbit
echo "+ git rev-parse HEAD: $(git rev-parse HEAD) ($(git symbolic-ref --short HEAD))"
# The commands, echoed as written: no `set -x`, which would print the generated values.
echo '+ cp .env.example .env'
cp .env.example .env
echo '+ jwt_secret="$(openssl rand -base64 32)"; provider_secret_key="$(openssl rand -base64 32)"'
jwt_secret="$(openssl rand -base64 32)"
provider_secret_key="$(openssl rand -base64 32)"
sed -i \
  -e "s|^JWT_SECRET=.*$|JWT_SECRET=\"${jwt_secret}\"|" \
  -e "s|^PROVIDER_SECRET_KEY=.*$|PROVIDER_SECRET_KEY=\"${provider_secret_key}\"|" \
  .env
unset jwt_secret provider_secret_key
echo "+ sed -i (JWT_SECRET, PROVIDER_SECRET_KEY) .env"
echo "+ grep managed-runner lines in .env (none expected):"
grep -n -E '^[[:space:]]*(ORBIT_MANAGED_RUNNERS|COMPOSE_PROFILES)' .env || echo "  (none)"
echo "+ docker compose up -d --build"
if ! docker compose up -d --build; then
  echo "!! docker compose up -d --build failed; waiting for the apiserver to finish its first boot"
  for _ in $(seq 1 120); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' orbit-apiserver 2>/dev/null)" = healthy ] && break
    sleep 5
  done
  echo "+ docker compose up -d --wait"
  docker compose up -d --wait || exit 1
fi
docker compose ps
