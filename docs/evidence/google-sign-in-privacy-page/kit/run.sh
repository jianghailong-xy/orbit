#!/usr/bin/env bash
# The privacy page's evidence run: serve the built web bundle (src/web/dist, `npm run build -w @orbit/web`)
# the way the web image does — nginx:alpine with src/web/nginx.conf as its default server — then take the
# screenshots and checks in shoot.mjs against it. Nothing stands behind nginx: /api/ answers 502, which a
# page that asks the server nothing never meets.
#
#   bash docs/evidence/google-sign-in-privacy-page/kit/run.sh [port]
set -euo pipefail
KIT=$(cd "$(dirname "$0")" && pwd)
OUT=$(dirname "$KIT")
REPO=$(git -C "$KIT" rev-parse --show-toplevel)
PORT=${1:-18431}
NAME=orbit-privacy-evidence

test -f "$REPO/src/web/dist/index.html" || { echo "no src/web/dist: run npm run build -w @orbit/web first" >&2; exit 1; }
docker rm -f "$NAME" >/dev/null 2>&1 || true
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:80" --add-host apiserver:127.0.0.1 \
  -v "$REPO/src/web/dist:/usr/share/nginx/html:ro" \
  -v "$REPO/src/web/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
  nginx:alpine >/dev/null
for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.2
done

echo "== source: $(git -C "$REPO" rev-parse HEAD)$(git -C "$REPO" diff --quiet HEAD -- src || echo ' + uncommitted src changes'), dist built $(date -u -r "$REPO/src/web/dist/index.html" +%FT%TZ)"
echo "== GET /privacy (signed out: no cookie, no token)"
curl -sS -o /dev/null -D - "http://127.0.0.1:$PORT/privacy" | tr -d '\r'
echo "== the shell it serves is the bundle's index.html: $(curl -sS "http://127.0.0.1:$PORT/privacy" | cmp -s - "$REPO/src/web/dist/index.html" && echo yes || echo NO)"
echo "== browsers"
node "$KIT/shoot.mjs" "http://127.0.0.1:$PORT" "$OUT" "$REPO/src/web/src/App.privacy.test.tsx"
