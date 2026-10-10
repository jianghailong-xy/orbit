#!/usr/bin/env bash
# vite + the shot script in one private network namespace: on this host, docker veths come and go and
# abort the dev server's module loads (ERR_NETWORK_CHANGED), leaving the page blank.
set -euo pipefail
WT=${WT:-/root/.orbit/worktrees/01a12363-4f7f-73d9-bfec-54de1ae607f7}
cd "$WT/src/web"
ip link set lo up
npx vite --host 127.0.0.1 --port 4178 --strictPort > /var/tmp/startcard-shot/vite.log 2>&1 &
VITE=$!
trap 'kill $VITE 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4178/ui-migration/p43b-cards.html || true)
  [ "$code" = "200" ] && break
  sleep 1
done
echo "vite: $code"
cd /var/tmp/startcard-shot
node "$@"
