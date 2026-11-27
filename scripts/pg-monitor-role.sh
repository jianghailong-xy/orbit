#!/bin/sh
# postgres-exporter's role (docker-compose.yml, pg-monitor-role; docs/self-hosting.md, "Monitoring"). Run once each time
# the monitoring profile comes up, as the bootstrap superuser over the Postgres socket, the way pgbackup connects.
#
# - The password lives in /secret/password, the pg-monitor-secret volume postgres-exporter reads it from. It is
#   generated here the first time, 64 hex digits from /dev/urandom, and kept after that: delete the volume to replace it.
# - orbit_monitor is a login role in pg_monitor, which reads the statistics views and settings and nothing of the
#   application's tables, with no other right, and at most 3 connections (the connection budget counts them).
# - Every run sets all of that again, so a role changed by hand, or a password the volume lost, is put right.
set -eu

secret=/secret/password
umask 077
if [ ! -s "$secret" ]; then
  head -c 32 /dev/urandom | od -An -vtx1 | tr -d ' \n' >"$secret.new"
  mv "$secret.new" "$secret"
  echo "pg-monitor-role: generated a new password for orbit_monitor"
fi
# postgres-exporter runs as nobody.
chown 65534:65534 "$secret"
chmod 0400 "$secret"

psql -v ON_ERROR_STOP=1 -q -v password="$(cat "$secret")" <<'SQL'
SELECT 'CREATE ROLE orbit_monitor' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'orbit_monitor') \gexec
ALTER ROLE orbit_monitor WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT
  CONNECTION LIMIT 3 PASSWORD :'password';
GRANT pg_monitor TO orbit_monitor;
SQL
echo "pg-monitor-role: orbit_monitor is ready (pg_monitor, at most 3 connections)"
