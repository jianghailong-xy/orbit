#!/usr/bin/env bash
# One `*.pg.spec` (or several), run against a PostgreSQL this script creates and destroys — and
# RED when nothing was witnessed.
#
#   scripts/run-pg-spec.sh src/apiserver/src/projects/decision-facts-no-coordinator-turn.pg.spec.ts
#   scripts/run-pg-spec.sh src/apiserver/src/projects/criteria-pending-{decisions,owner-read}.pg.spec.ts
#
# WHY THIS EXISTS
# ===============
# Four tasks in this repo settled DONE on an EXECUTABLE acceptance command shaped like
#
#     cd src/apiserver && npx tsc -p tsconfig.test.json && node --test build/tasks/<x>.pg.spec.js
#
# and every one of those greens was empty. A `*.pg.spec` skips itself when COORDINATOR_PG_URL is
# unset; the acceptance environment does not set it. The inbox spec's green was `pass 0 /
# skipped 3` — the command proved the test tree compiles and the file loads, and nothing about a
# single assertion inside it. So an acceptance command that names this script instead gets the two
# things that one was missing: a PostgreSQL to run against, and the refusal below.
#
# A SKIP IS RED
# =============
# `node --test` exits 0 on a file whose every case skipped, which is exactly how the hole stayed
# open. This script exits non-zero when the TAP summary reports ANY skip, any failure, tests=0, or
# a summary it cannot vouch for. Wrapping the old command without that would be worse than the old
# command: the same empty green, with the `# skipped 3` no longer in front of whoever reads it.
#
# `RUN_PG_SPEC_CONTROL=omit-url` is the control that holds this to it: everything below happens
# exactly as it normally does, except that none of the three URL names is handed to the child —
# the acceptance environment's own condition. Every case reports `# SKIP`, `node --test` exits 0, and
# this script must still exit non-zero. The day it goes green under that knob, every green it has
# ever printed is worth nothing.
#
# WHAT IT SETS UP, AND WHY EACH PIECE IS THERE
# ============================================
#   * The worktree overlays. A git worktree has no node_modules of its own, and `npm install`
#     inside one tears the symlinks back down, so the main checkout's are borrowed. `@orbit/shared`
#     is linked TWICE — once under `src/` for the compiler and once under `build/` for the child
#     process — because with only the first one the child resolves the main checkout's older
#     `dist/` and reports missing fields on types like RunnerHeartbeatResponse. That red is the
#     harness, not the product.
#   * The branch's own Prisma client, in a worktree only. `@prisma/client` in the main checkout is
#     whatever the last `prisma generate` in THAT tree left behind, and it does not know this
#     branch's schema: a branch that adds a model compiles into `Property 'x' does not exist on
#     type 'PrismaService'` and the acceptance command goes red on an implementation that is right.
#     Same class of harness red as the `@orbit/shared` link above, so it gets the same answer —
#     `@prisma/client` and `.prisma` are copied and generated rather than linked (node resolves a
#     linked package by its realpath and would read the main checkout's client straight back), and
#     the client is regenerated whenever this branch's schema.prisma is the newer of the two. In
#     the main checkout the whole thing is skipped: generating there rewrites the client every
#     concurrent session is compiling against.
#   * `rm -rf build` before compiling. `tsc` does not delete outputs whose sources are gone, so a
#     tree left by an earlier branch runs deleted specs and imports deleted modules.
#   * PGDATA on tmpfs. A throwaway PostgreSQL's data volume is what fills the root disk; on tmpfs
#     there is nothing to leak, and the `docker rm -f -v` below takes the rest. `-v` is not
#     optional. The trap fires on the failure paths too — a script that goes red still cleans up.
#     The trade is that this cluster does not survive `docker restart`, so
#     COORDINATOR_PG_RESTART_COMMAND is deliberately NOT supplied: a spec that needs a real server
#     restart will skip, and a skip here is red, which is the honest answer rather than a restart
#     that silently returns an empty data directory.
#   * A template database migrated once, cloned per spec. Specs that own schema would otherwise
#     hand the next one a database they left rearranged.
#   * Readiness over TCP, from inside the container. The entrypoint runs an init server that
#     listens on the unix socket only, so `psql` without `-h` answers while the real server is
#     still down; and the host-side port answers before either, because docker's proxy binds it
#     at once. Neither is the server the spec will talk to.
#
# Only the container named below is ever touched. Other sessions on this host have their own
# throwaway PostgreSQLs and their own volumes, and none of them are this script's to reap.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$REPO/src/apiserver"
# The reporter the child is pinned to, and the parser that decides whether its summary can be
# believed at all. Both are shared with scripts/project-pg-matrix.sh and covered by
# scripts/pg-matrix-summary-selftest.sh.
# shellcheck source=scripts/pg-matrix-summary.lib.sh
. "$REPO/scripts/pg-matrix-summary.lib.sh" || exit 1

IMAGE="${RUN_PG_SPEC_IMAGE:-postgres:16-alpine}"
CONTAINER="pccspec-pg-$$-$RANDOM"   # never a fixed name: sibling sessions run their own
ADMIN=pccspec_          # the pcc_* naming the specs' own isolation guard demands of role and database
PASSWORD=pccspec_pw
TEMPLATE=pccspec_tpl
SPEC_TIMEOUT="${RUN_PG_SPEC_TIMEOUT:-600}"
NODE="${NODE:-node}"

die() { echo "run-pg-spec: $*" >&2; exit 2; }
[ "$#" -ge 1 ] || die "usage: $(basename "$0") <path/to/x.pg.spec.ts> [more...]"

# Accept a path relative to the caller's directory or to the repo root; the acceptance harness
# uses the latter.
SPECS=()
for arg in "$@"; do
  if   [ -f "$arg" ];        then SPECS+=("$(cd "$(dirname "$arg")" && pwd)/$(basename "$arg")")
  elif [ -f "$REPO/$arg" ];  then SPECS+=("$REPO/$arg")
  else die "no such spec: $arg"; fi
done
for spec in "${SPECS[@]}"; do
  case "$spec" in
    "$API/src/"*.pg.spec.ts) ;;
    *) die "not an apiserver pg spec: $spec" ;;
  esac
done

# --- the worktree overlays ----------------------------------------------------------------------
# Refresh a symlink, create a missing one, never touch a real directory: in the main checkout every
# one of these already exists and the block is skipped. That guard is the block's, not a nicety —
# when MAIN falls back to REPO source and target are the same path, and on a tree that has no
# node_modules at all the target does not exist yet, so `ln -sfn` made `node_modules -> node_modules`.
# The run still stopped at the `no tsc` below, but a second one left anyone checking by hand reading
# `Too many levels of symbolic links` instead, which is a broken environment rather than a missing
# `npm install`, and three self-referential links in the caller's tree that this script had made.
link() { if [ -L "$2" ] || [ ! -e "$2" ]; then ln -sfn "$1" "$2"; fi; }
MAIN="$(dirname "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)")"
[ -d "$MAIN/node_modules" ] || MAIN="$REPO"
if [ "$MAIN" != "$REPO" ]; then
  echo "==> overlaying node_modules from $MAIN"
  link "$MAIN/node_modules"                "$REPO/node_modules"
  link "$MAIN/src/apiserver/node_modules"  "$API/node_modules"
  link "$MAIN/src/shared/node_modules"     "$REPO/src/shared/node_modules"
fi
# TypeScript 7 and Prisma 7 were installed per workspace, beside a root that hoisted the 5.9.3 that
# @nestjs/cli pinned, until the 2026-09-09 bumps (#74, #78) moved both to the root; so prefer the
# apiserver's copy of each and fall back to the root's. Resolved HERE and not up with the other
# constants, because "prefer" is a question about the links above: a worktree that has none of them
# yet answers "not executable" to both preferred paths, and both fallbacks then lie. The root had no
# prisma at all, so the run died at `prisma migrate deploy` with the container already up; and the
# root's tsc WAS that 5.9.3, so the guard below passed and a first run compiled the whole test tree
# with the wrong compiler without saying so. Hence also the version echo: which compiler built this
# tree is the thing that failed silently, so it is printed rather than assumed.
TSC="$API/node_modules/.bin/tsc"; [ -x "$TSC" ] || TSC="$REPO/node_modules/.bin/tsc"
PRISMA="$API/node_modules/.bin/prisma"; [ -x "$PRISMA" ] || PRISMA="$REPO/node_modules/.bin/prisma"
[ -x "$TSC" ]    || die "no tsc under $MAIN — run npm install in the main checkout first"
[ -x "$PRISMA" ] || die "no prisma under $MAIN — run npm install in the main checkout first"
echo "==> tsc $TSC ($("$TSC" --version))"

# The branch's own Prisma client — see the header for why it cannot be the main checkout's. The
# whole-directory link above is undone for the apiserver and rebuilt as one symlink per package, so
# that the two entries which have to be ours can be real directories. Never in the main checkout:
# generating there is how every concurrent session's tree goes red.
if [ "$MAIN" != "$REPO" ]; then
  NM="$API/node_modules"; MAIN_NM="$MAIN/src/apiserver/node_modules"
  # Where the main checkout's install put the two packages this step pairs, asked of Node rather
  # than named: npm kept both under the apiserver workspace until the 2026-09-09 dependabot bumps
  # (#74, #78) hoisted them to the root, and `$MAIN_NM/@prisma/client` then named nothing at all.
  pkg_dir() { ( cd "$MAIN/src/apiserver" && node -p "path.dirname(require.resolve('$1/package.json'))" ); }
  CLIENT_PKG="$(pkg_dir @prisma/client)" || die "no @prisma/client under $MAIN — run npm install in the main checkout first"
  PRISMA_PKG="$(pkg_dir prisma)" || die "no prisma under $MAIN — run npm install in the main checkout first"
  [ -L "$NM" ] && rm -f "$NM"
  mkdir -p "$NM/@prisma" "$NM/.prisma"
  for d in "$MAIN_NM"/* "$MAIN_NM"/.[!.]*; do
    [ -e "$d" ] || continue
    case "$(basename "$d")" in @prisma|.prisma|prisma) continue ;; esac
    link "$d" "$NM/$(basename "$d")"
  done
  for d in "$MAIN_NM/@prisma"/*; do
    [ -e "$d" ] || continue
    [ "$(basename "$d")" = "client" ] || link "$d" "$NM/@prisma/$(basename "$d")"
  done
  # The CLI goes beside the copy below, wherever it was installed. `prisma generate` resolves
  # `prisma` and `@prisma/client` from the schema's directory without following links, and refuses
  # with `Could not resolve @prisma/client` unless both sit in the same node_modules — so a private
  # client here with the CLI only at the root fails exactly as a missing client does.
  link "$PRISMA_PKG" "$NM/prisma"
  # A copy, ~75MB, once per worktree: `prisma generate` finds the package by walking up from the
  # schema's directory, and through a link it would find — and write beside — the main checkout's.
  # It also has to be in place BEFORE generating, which otherwise fails with `Could not resolve
  # @prisma/client`. Copied again when the main checkout's package.json differs from the copy's, so
  # a dependency bump reaches a worktree that already has one; the generated client goes with it.
  if [ ! -d "$NM/@prisma/client" ] || [ -L "$NM/@prisma/client" ] ||
     ! cmp -s "$CLIENT_PKG/package.json" "$NM/@prisma/client/package.json"; then
    echo "==> copying @prisma/client out of $CLIENT_PKG (this worktree needs its own)"
    rm -rf "$NM/@prisma/client" "$NM/.prisma/client"
    cp -r "$CLIENT_PKG" "$NM/@prisma/client" || die "could not copy @prisma/client"
  fi
  # ~6s, so only when this branch's schema is newer than what was generated from it last time.
  GENERATED="$NM/.prisma/client/index.d.ts"
  if [ ! -f "$GENERATED" ] || [ "$API/prisma/schema.prisma" -nt "$GENERATED" ]; then
    echo "==> generating this branch's Prisma client"
    ( cd "$API" && "$PRISMA" generate >/dev/null ) || die "prisma generate failed"
    [ -f "$GENERATED" ] || die "prisma generate wrote no $GENERATED"
  fi
fi

echo "==> building @orbit/shared"
"$TSC" -p "$REPO/src/shared/tsconfig.json" || die "src/shared failed to compile"
mkdir -p "$REPO/src/node_modules/@orbit"
link "$REPO/src/shared" "$REPO/src/node_modules/@orbit/shared"          # compile time

echo "==> building the test tree (rm -rf build first)"
rm -rf "$API/build"
( cd "$API" && "$TSC" -p tsconfig.test.json ) || die "tsconfig.test.json failed to compile"
mkdir -p "$API/build/node_modules/@orbit"
link "$REPO/src/shared" "$API/build/node_modules/@orbit/shared"          # run time

# --- the throwaway server -----------------------------------------------------------------------
cleanup() { echo "==> removing $CONTAINER"; docker rm -f -v "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

echo "==> provisioning $CONTAINER ($IMAGE, PGDATA on tmpfs)"
docker run -d --name "$CONTAINER" \
  -e "POSTGRES_USER=$ADMIN" -e "POSTGRES_PASSWORD=$PASSWORD" -e POSTGRES_DB=postgres \
  -e PGDATA=/pgdata --tmpfs /pgdata:size=2g \
  -p 127.0.0.1::5432 "$IMAGE" >/dev/null || die "docker run failed"
PORT="$(docker port "$CONTAINER" 5432/tcp | head -1 | sed 's/.*://')"
[ -n "$PORT" ] || die "docker did not publish a host port"

psql_db() {
  docker exec -e "PGPASSWORD=$PASSWORD" "$CONTAINER" \
    psql -h 127.0.0.1 -p 5432 -U "$ADMIN" -d "$1" -v ON_ERROR_STOP=1 -tAc "$2"
}
psql_admin()    { psql_db postgres "$1"; }
psql_template() { psql_db "$TEMPLATE" "$1"; }
for _ in $(seq 1 120); do psql_admin 'SELECT 1' >/dev/null 2>&1 && break; sleep 1; done
psql_admin 'SELECT 1' >/dev/null || die "$CONTAINER never accepted a TCP connection"

SYSTEM_ID="$(psql_admin 'SELECT system_identifier FROM pg_control_system()' | tr -d '[:space:]')"
VERSION="$(psql_admin 'SHOW server_version' | tr -d '[:space:]')"
echo "==> PostgreSQL $VERSION on 127.0.0.1:$PORT, system_identifier=$SYSTEM_ID"

psql_admin "CREATE DATABASE $TEMPLATE" >/dev/null || die "could not create the template database"
echo "==> prisma migrate deploy (template $TEMPLATE)"
( cd "$API" && DATABASE_URL="postgresql://$ADMIN:$PASSWORD@127.0.0.1:$PORT/$TEMPLATE" \
    "$PRISMA" migrate deploy >/dev/null ) || die "prisma migrate deploy failed"
echo "==> $(psql_template 'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL') migrations applied"

# --- run them -----------------------------------------------------------------------------------
CONTROL="${RUN_PG_SPEC_CONTROL:-}"
[ "$CONTROL" = "omit-url" ] &&
  echo "==> CONTROL omit-url: all three URL names withheld; every case should SKIP and this run should be RED"

n=0; RED=()
for spec in "${SPECS[@]}"; do
  n=$((n+1))
  rel="${spec#"$API/src/"}"; js="build/${rel%.ts}.js"; base="$(basename "$spec")"
  [ -f "$API/$js" ] || die "$base compiled to no $js"
  DB="pccspec_$n"
  psql_admin "CREATE DATABASE $DB TEMPLATE $TEMPLATE" >/dev/null || die "could not clone $TEMPLATE into $DB"

  URL="postgresql://$ADMIN:$PASSWORD@127.0.0.1:$PORT/$DB"
  child=(COORDINATOR_PG_EXPECTED_DATABASE="$DB"
         COORDINATOR_PG_EXPECTED_USER="$ADMIN"
         COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER="$SYSTEM_ID"
         NODE_OPTIONS="$(pg_matrix_child_node_options)")
  # One database, under all three names a pg spec in this tree looks for. Of the 113, 111 read
  # COORDINATOR_PG_URL; `runner-api/steer-dequeue.pg.spec` reads ORBIT_TEST_PG_URL and
  # `projects/project-work-overview-readiness.pg.spec` reads WORK_OVERVIEW_PG_URL. A spec whose
  # name is unset skips every case, and a skip here is red — so handing over one name made those
  # two permanently red on THIS path while they passed under scripts/project-pg-matrix.sh, which
  # has handed over all three since d021cc0e. That red was the harness, not the product. The extra
  # names need nothing else: the isolation guard and identity check read the expectations set
  # above, whichever name carried the URL to the child.
  # All three are withheld together under the control, and that is the whole point of withholding:
  # dropping only COORDINATOR_PG_URL would leave those two specs connected and running, and the
  # control would go quietly green off the very specs it exists to keep honest.
  [ "$CONTROL" = "omit-url" ] ||
    child+=(COORDINATOR_PG_URL="$URL" ORBIT_TEST_PG_URL="$URL" WORK_OVERVIEW_PG_URL="$URL")

  echo "########## $base ##########"
  out="$(cd "$API" && env "${child[@]}" \
    timeout -k 20 "$SPEC_TIMEOUT" "$NODE" "${PG_MATRIX_NODE_TEST_ARGS[@]}" "$js" 2>&1)"
  rc=$?
  printf '%s\n' "$out"
  echo "SPEC_EXIT=$rc"

  IFS=$'\t' read -r t p f s unreadable < <(printf '%s\n' "$out" | pg_matrix_summary)
  why=""
  if [ "$rc" = "124" ] || [ "$rc" = "137" ]; then why="TIMEOUT/KILLED rc=$rc (hang or leaked handle)"
  elif [ "$rc" != "0" ];                      then why="node exited rc=$rc"; fi
  [ -n "$unreadable" ] && why="${why:+$why; }$unreadable"
  [ "$f" -gt 0 ]       && why="${why:+$why; }$f failing"
  # The one this script exists for.
  [ "$s" -gt 0 ]       && why="${why:+$why; }$s SKIPPED — those assertions were not witnessed"
  [ -n "$why" ] && RED+=("$base: $why")
  printf '==== %s tests=%s pass=%s fail=%s skipped=%s %s\n' "$base" "$t" "$p" "$f" "$s" "$why"
  psql_admin "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1
done

for r in ${RED[@]+"${RED[@]}"}; do echo "RED: $r"; done
[ "${#RED[@]}" -gt 0 ] && exit 1
echo "==> OK: $n spec(s) witnessed against PostgreSQL $VERSION, no skips"
exit 0
