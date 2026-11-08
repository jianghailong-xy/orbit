#!/usr/bin/env bash
# Put the stack's database back to the snapshot (four challenges pending). The apiserver must be stopped first.
set -euo pipefail
docker exec rv34t-pg psql -U orbit -d postgres -Atc "select pg_terminate_backend(pid) from pg_stat_activity where datname='orbit' and pid <> pg_backend_pid()" >/dev/null
docker exec rv34t-pg dropdb -U orbit orbit
docker exec rv34t-pg createdb -U orbit orbit
docker cp /mnt/data/tmp/34tDf8/android/ci/stack.dump rv34t-pg:/tmp/stack.dump
docker exec rv34t-pg pg_restore -U orbit -d orbit --no-owner /tmp/stack.dump
docker exec rv34t-pg psql -U orbit -d orbit -Atc "update wiki_changeset set created_at = now() - interval '3 hours'; select count(*) from wiki_changeset_op where decision='pending'"
