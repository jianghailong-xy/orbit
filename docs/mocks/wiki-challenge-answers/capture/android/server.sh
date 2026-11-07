#!/usr/bin/env bash
# CI half of the Android probe (task 34tDf8rxHzhwoGyK6r0kj): the stack's own database, restored byte for byte from the
# local stack's pg_dump (stack.dump: owner, runner, task A's session, the cited tasks and tool call, the orbit space,
# the four entries and changeset 34so6smHP5ywNOPjvYbqa's four challenges, pending), and this commit's apiserver on :3734.
set -euo pipefail
K=$(cd "$(dirname "$0")" && pwd)
PGC=${PG_CONTAINER:?}
docker cp "$K/stack.dump" "$PGC:/tmp/stack.dump"
docker exec "$PGC" pg_restore -U orbit -d orbit --no-owner /tmp/stack.dump
# The challenges were filed 3 h before the local captures; keep them 3 h old here too.
docker exec "$PGC" psql -U orbit -d orbit -Atc "update wiki_changeset set created_at = now() - interval '3 hours'; select count(*) from wiki_changeset_op where decision = 'pending'"
npm ci --no-audit --no-fund >/dev/null
npm run build -w @orbit/shared >/dev/null
npm run prisma:generate -w @orbit/apiserver >/dev/null
npm run build -w @orbit/apiserver >/dev/null
cd src/apiserver
nohup env DATABASE_URL=postgresql://orbit:orbit@127.0.0.1:5734/orbit JWT_SECRET=$(openssl rand -hex 32) \
  PROVIDER_SECRET_KEY=$(openssl rand -base64 32) PORT=3734 PUBLIC_ORIGIN=http://127.0.0.1:3734 \
  CORS_ORIGINS=http://127.0.0.1:3734 NODE_ENV=production TZ=UTC node dist/main.js > "$K/shots/api.log" 2>&1 &
for i in $(seq 1 60); do grep -q "listening on :3734" "$K/shots/api.log" && break; sleep 2; done
tail -2 "$K/shots/api.log"
curl -sS -o /dev/null -w 'GET /api/health -> %{http_code}\n' http://127.0.0.1:3734/api/health || true
