#!/usr/bin/env bash
# The world the integration-line cases run in: a PostgreSQL this script creates and destroys, a real
# apiserver serving from `dist/`, a real `orbit` runner registered against it, and local git
# repositories on this machine's disk.
#
# Nothing here is a double. The apiserver is the production `AppModule`; the runner is the binary
# built from `src/runner-go`; the repositories are real repositories with a real `origin`; the checks
# are real commands the runner really runs. What IS seeded directly into the database is the shape of
# a finished piece of work — a session that took a worktree, on a branch — because producing that
# through a real engine would mean an LLM, and none of the behaviour under test is downstream of one.
#
# Sourced by `scripts/acceptance/project-integration-line.sh`. Each case gets its own repository,
# workspace and project, so a case cannot inherit another's refs.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
API_DIR="$REPO_ROOT/src/apiserver"
RUNNER_GO_DIR="$REPO_ROOT/src/runner-go"

FIX_SCRATCH=""
FIX_PG_CONTAINER=""
FIX_PG_URL=""
FIX_PG_USER="integration_line_e2e"
FIX_PG_DB="integration_line_e2e"
FIX_API_PID=""
FIX_API_ORIGIN=""
FIX_RUNNER_PID=""
FIX_TOKEN=""
FIX_RUNNER_UUID=""
FIX_OWNER_UUID=""
FIX_LOG=""

# ── plumbing ───────────────────────────────────────────────────────────────────────────────────

say() { printf '==> %s\n' "$*"; }

# A failed expectation ENDS the thing it was expected of, and is remembered on disk.
#
# Both halves are load-bearing, and a `return 1` here has neither. `main` runs each case as the
# condition of an `if`, and bash turns errexit off for everything inside a tested command — so a
# case whose first assertion failed carried on through every later one and then reported PASS,
# which is how a tree with no integration line at all passed all four cases. Exiting is what stops
# the case: a case runs in a subshell, so this ends that case and nothing else. The file is for the
# `fail` calls that happen inside a `$( )`, where the exit ends only the substitution — the case
# would otherwise keep going with an empty string it was never given. `run_case` reads it.
fail() {
  printf '!! %s\n' "$*" >&2
  [ -n "$FIX_SCRATCH" ] && : > "$FIX_SCRATCH/case-failed"
  exit 1
}

# One case, run so that it cannot report anything but what happened.
run_case() {
  local name="$1" status=0
  rm -f "$FIX_SCRATCH/case-failed"
  ( "$name" ) || status=$?
  if [ -e "$FIX_SCRATCH/case-failed" ]; then return 1; fi
  return "$status"
}

# One query, tuples only. `psql` runs inside the container, so this needs no client on the host.
# A failing statement says what PostgreSQL said and fails: a seeding error that only shows up as a
# missing row 240 seconds later is a test that reports the wrong thing.
sql() {
  local out status
  out="$(docker exec -i "$FIX_PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$FIX_PG_USER" \
    -d "$FIX_PG_DB" -tAc "$1" 2>&1)" && status=0 || status=$?
  if [ "$status" -ne 0 ]; then
    printf '!! sql failed: %s\n!! %s\n' "$1" "$out" >&2
    return "$status"
  fi
  printf '%s\n' "$out"
}

# One scalar. `psql -tA` prints a RETURNING value on the first line and its command tag ("INSERT 0
# 1") on the next, so a caller that squeezes the whole answer gets `<uuid>INSERT01` — a value every
# later statement then refuses as malformed. Taking the first line is what makes a RETURNING usable.
sql1() {
  sql "$1" | head -1 | tr -d '[:space:]'
}

# One JSON request to the user API. Answers the body on stdout; the status goes to a FILE rather
# than a variable, because every caller reads the body through `$( )` and a global assigned inside a
# command substitution is assigned in a subshell the caller never sees — a status variable read back as
# the empty string on every single request.
api() {
  local method="$1" route="$2" body="${3:-}"
  local tmp="$FIX_SCRATCH/api-body"
  if [ -n "$body" ]; then
    curl -sS -o "$tmp" -w '%{http_code}' -X "$method" "$FIX_API_ORIGIN/api$route" \
      -H 'content-type: application/json' -H "authorization: Bearer $FIX_TOKEN" -d "$body" \
      > "$FIX_SCRATCH/api-status"
  else
    curl -sS -o "$tmp" -w '%{http_code}' -X "$method" "$FIX_API_ORIGIN/api$route" \
      -H "authorization: Bearer $FIX_TOKEN" > "$FIX_SCRATCH/api-status"
  fi
  cat "$tmp"
}

# The status of the last `api` call.
api_status() { cat "$FIX_SCRATCH/api-status" 2>/dev/null; }

# Retry `cmd` until it succeeds or the budget runs out. The description is what the failure says.
wait_for() {
  local what="$1" budget="$2"; shift 2
  local deadline=$(( $(date +%s) + budget ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  fail "timed out after ${budget}s waiting for $what"
}

# Wait until a single-value query answers `expected`. Prints what it last saw when it does not.
wait_for_sql() {
  local what="$1" budget="$2" query="$3" expected="$4"
  local deadline=$(( $(date +%s) + budget )) seen=""
  while [ "$(date +%s)" -lt "$deadline" ]; do
    seen="$(sql1 "$query" 2>/dev/null || true)"
    if [ "$seen" = "$expected" ]; then return 0; fi
    sleep 1
  done
  fail "timed out after ${budget}s waiting for $what (wanted '$expected', last saw '$seen')"
}

assert_eq() {
  local what="$1" want="$2" got="$3"
  if [ "$want" != "$got" ]; then fail "$what: expected '$want', got '$got'"; fi
  printf '    ok  %s = %s\n' "$what" "$got"
}

# ── boot ───────────────────────────────────────────────────────────────────────────────────────

fixture_boot() {
  FIX_SCRATCH="$(mktemp -d /tmp/integration-line-e2e.XXXXXX)"
  FIX_LOG="$FIX_SCRATCH/logs"
  mkdir -p "$FIX_LOG"
  say "scratch $FIX_SCRATCH"

  local password; password="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  FIX_PG_CONTAINER="integration-line-e2e-$$-$RANDOM"
  say "postgres ($FIX_PG_CONTAINER)"
  docker run -d --name "$FIX_PG_CONTAINER" \
    -e "POSTGRES_USER=$FIX_PG_USER" -e "POSTGRES_PASSWORD=$password" -e "POSTGRES_DB=$FIX_PG_DB" \
    -e PGDATA=/pgdata --tmpfs /pgdata:size=1g \
    -p 127.0.0.1::5432 postgres:16-alpine >/dev/null
  local published port
  published="$(docker port "$FIX_PG_CONTAINER" 5432/tcp | head -1)"
  port="${published##*:}"
  [ -n "$port" ] || fail "docker published no port for $FIX_PG_CONTAINER"
  FIX_PG_URL="postgresql://$FIX_PG_USER:$password@127.0.0.1:$port/$FIX_PG_DB"
  # `pg_isready` answers yes to the temporary server initdb runs, so the first real query is the
  # readiness signal — the same reasoning scripts/project-e2e.sh gives.
  wait_for "PostgreSQL to answer a query" 120 sql 'SELECT 1'

  say "prisma migrate deploy (empty database)"
  # WHERE THE CLI IS DEPENDS ON HOW THE CHECKOUT WAS INSTALLED, and asking for one path is how this
  # step dies with `node_modules/.bin/prisma: No such file or directory` and a container already up.
  # npm leaves the CLI under the apiserver while something pins prisma there and hoists it to the
  # repository root when nothing does, which is what the 2026-09-09 bumps did for every tree on this
  # host; `scripts/worktree-overlay.sh` resolves the same pair the same way, for the same reason. The
  # two are the same package — the version is printed rather than assumed.
  local prisma_cli="$REPO_ROOT/src/apiserver/node_modules/.bin/prisma"
  [ -x "$prisma_cli" ] || prisma_cli="$REPO_ROOT/node_modules/.bin/prisma"
  [ -x "$prisma_cli" ] || fail "no prisma CLI in this checkout — run npm install in the main checkout first"
  say "prisma CLI $prisma_cli"
  ( cd "$API_DIR" && DATABASE_URL="$FIX_PG_URL" "$prisma_cli" migrate deploy \
      --schema prisma/schema.prisma ) >"$FIX_LOG/migrate.log" 2>&1 \
    || { cat "$FIX_LOG/migrate.log"; fail "migrate deploy failed"; }

  say "building the apiserver"
  ( cd "$API_DIR" && npm run build ) >"$FIX_LOG/build-api.log" 2>&1 \
    || { tail -40 "$FIX_LOG/build-api.log"; fail "apiserver build failed"; }

  say "building the orbit runner"
  # `-buildvcs=false`: the binary's VCS stamp is nothing this test reads, and stamping FAILS in a
  # detached git worktree — which is exactly the shape a reviewer re-runs this in to compare against
  # an older tree.
  ( cd "$RUNNER_GO_DIR" && go build -buildvcs=false -o "$FIX_SCRATCH/orbit" . ) >"$FIX_LOG/build-runner.log" 2>&1 \
    || { tail -40 "$FIX_LOG/build-runner.log"; fail "runner build failed"; }

  local api_port; api_port="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
  FIX_API_ORIGIN="http://127.0.0.1:$api_port"
  say "apiserver on $FIX_API_ORIGIN"
  ( cd "$API_DIR" && \
    DATABASE_URL="$FIX_PG_URL" \
    PORT="$api_port" \
    JWT_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" \
    PROVIDER_SECRET_KEY="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" \
    CORS_ORIGINS='http://127.0.0.1' \
    MODEL_CATALOG_URL='http://127.0.0.1:9/models.json' \
    NO_COLOR=1 \
    HOME="$FIX_SCRATCH/api-home" \
    node dist/main.js ) >"$FIX_LOG/apiserver.log" 2>&1 &
  FIX_API_PID=$!
  mkdir -p "$FIX_SCRATCH/api-home"
  wait_for "the apiserver to answer /api/auth/setup-status" 180 \
    curl -sSf "$FIX_API_ORIGIN/api/auth/setup-status"

  local owner_password="e2e-$RANDOM-$RANDOM"
  local bootstrap
  bootstrap="$(curl -sS -X POST "$FIX_API_ORIGIN/api/auth/bootstrap" -H 'content-type: application/json' \
    -d "{\"email\":\"integration-line@example.invalid\",\"name\":\"Integration Line E2E\",\"password\":\"$owner_password\"}")"
  FIX_TOKEN="$(printf '%s' "$bootstrap" | python3 -c 'import json,sys;print(json.load(sys.stdin)["accessToken"])')"
  [ -n "$FIX_TOKEN" ] || fail "bootstrap did not return an access token: $bootstrap"
  FIX_OWNER_UUID="$(sql1 "SELECT id FROM \"user\" LIMIT 1")"

  local enrollment token
  enrollment="$(api POST /runners/enrollment-tokens '{"label":"integration-line-e2e","ttlHours":6}')"
  token="$(printf '%s' "$enrollment" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')"
  [ -n "$token" ] || fail "no enrollment token: $enrollment"

  say "orbit register"
  mkdir -p "$FIX_SCRATCH/runner-home" "$FIX_SCRATCH/orbit-home" "$FIX_SCRATCH/work"
  # The `( )` is for `fixture_runner_env`'s `exec`: without it this foreground call would replace the
  # fixture's own shell with `orbit register` and the script would end there. The status, the log and
  # the `fail` below are unchanged — the subshell exits with the same status the caller saw before.
  ( fixture_runner_env "$FIX_SCRATCH/orbit" register \
      --server "$FIX_API_ORIGIN" --token "$token" --name integration-line-e2e \
      --workdir "$FIX_SCRATCH/work" --no-service --no-auto-install-engines ) \
    >"$FIX_LOG/register.log" 2>&1 || { cat "$FIX_LOG/register.log"; fail "orbit register failed"; }
  FIX_RUNNER_UUID="$(sql1 "SELECT id FROM runner WHERE name = 'integration-line-e2e'")"
  [ -n "$FIX_RUNNER_UUID" ] || fail "orbit register created no runner row"

  say "orbit run"
  fixture_runner_env "$FIX_SCRATCH/orbit" run >"$FIX_LOG/runner.log" 2>&1 &
  FIX_RUNNER_PID=$!
  wait_for_sql "the runner to heartbeat" 120 \
    "SELECT count(*) FROM runner WHERE id = '$FIX_RUNNER_UUID' AND last_heartbeat_at IS NOT NULL" 1
}

# The runner's environment, built from nothing rather than inherited: no ORBIT_* of whoever runs
# this script, and a HOME of its own so it cannot touch the real credentials file.
#
# `exec`, and only for the background `orbit run` below. bash forks a SUBSHELL for a background
# FUNCTION call, so `$!` names that subshell and not the command the function runs; `FIX_RUNNER_PID`
# was therefore a wrapper, teardown's `kill` killed the wrapper, and the runner was orphaned onto PID
# 1 — where it went on retrying an apiserver whose container and scratch tree had been removed, one
# more per run, forever. `exec` replaces that subshell with the runner, so `$!` is the runner.
#
# It replaces whatever shell calls it, so the one caller that has to keep running — `orbit register`
# below — calls it in a `( )` of its own.
fixture_runner_env() {
  exec env -i \
    PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    HOME="$FIX_SCRATCH/runner-home" \
    ORBIT_HOME="$FIX_SCRATCH/orbit-home" \
    TMPDIR="$FIX_SCRATCH/tmp" \
    SHELL=/bin/sh LANG=C.UTF-8 \
    ORBIT_NO_SELFUPDATE=1 ORBIT_NO_ENGINE_UPDATE=1 \
    GIT_AUTHOR_NAME=orbit GIT_AUTHOR_EMAIL=orbit@example.invalid \
    GIT_COMMITTER_NAME=orbit GIT_COMMITTER_EMAIL=orbit@example.invalid \
    "$@"
}

fixture_teardown() {
  [ -n "$FIX_RUNNER_PID" ] && kill "$FIX_RUNNER_PID" 2>/dev/null || true
  [ -n "$FIX_API_PID" ] && kill "$FIX_API_PID" 2>/dev/null || true
  sleep 1
  [ -n "$FIX_RUNNER_PID" ] && kill -9 "$FIX_RUNNER_PID" 2>/dev/null || true
  [ -n "$FIX_API_PID" ] && kill -9 "$FIX_API_PID" 2>/dev/null || true
  if [ -n "$FIX_PG_CONTAINER" ]; then docker rm -f -v "$FIX_PG_CONTAINER" >/dev/null 2>&1 || true; fi
  if [ "${KEEP_SCRATCH:-0}" = "1" ]; then
    say "keeping $FIX_SCRATCH"
  elif [ -n "$FIX_SCRATCH" ]; then
    rm -rf "$FIX_SCRATCH"
  fi
}

# ── a case's own world ─────────────────────────────────────────────────────────────────────────

# A bare repository with one commit on main, and a checkout of it. The bare one is `origin`, so the
# runner's push is a real push over a real remote rather than a local ref move.
new_repo() {
  local name="$1"
  # No `.git` suffix: `project_codebase_canonical_url_chk` (PSC SR36) refuses a canonical URL that
  # carries one, and the whole point of a canonical URL is that the raw value equals it.
  local origin="$FIX_SCRATCH/repos/$name.origin" work="$FIX_SCRATCH/work/$name"
  mkdir -p "$FIX_SCRATCH/repos" "$FIX_SCRATCH/work"
  git init --quiet --bare --initial-branch=main "$origin"
  git init --quiet --initial-branch=main "$work"
  git -C "$work" config user.email orbit@example.invalid
  git -C "$work" config user.name orbit
  printf 'base\n' > "$work/README.md"
  git -C "$work" add README.md
  git -C "$work" commit --quiet -m 'base'
  git -C "$work" remote add origin "$origin"
  git -C "$work" push --quiet -u origin main
  printf '%s\n' "$work"
}

repo_origin_of() { printf '%s\n' "$FIX_SCRATCH/repos/$1.origin"; }

# A branch with one commit touching `file`, pushed to origin. This is what a finished task's work
# looks like from the outside, which is all the integration line reads.
new_task_branch() {
  local work="$1" branch="$2" file="$3" content="$4"
  git -C "$work" checkout --quiet -b "$branch" main
  printf '%s\n' "$content" > "$work/$file"
  git -C "$work" add "$file"
  git -C "$work" commit --quiet -m "$branch: $file"
  git -C "$work" push --quiet origin "$branch"
  git -C "$work" checkout --quiet main
  git -C "$work" rev-parse "$branch"
}

# A workspace on this runner, pointed at `work`, carrying the repository URL the integration line
# binds to. `repo_url` has no writer in the product today (migration 0273 withdrew the one door that
# set it), so it is written here directly — it is an input to the thing under test, not part of it.
new_workspace() {
  local name="$1" work="$2" origin="$3"
  local created id
  created="$(api POST /workspaces "$(python3 -c '
import json,sys
print(json.dumps({"name": sys.argv[1], "runnerId": sys.argv[2], "workDir": sys.argv[3]}))' \
    "$name" "$FIX_RUNNER_UUID" "$work")")"
  [ "$(api_status)" = "201" ] || fail "POST /workspaces answered $(api_status): $created"
  id="$(printf '%s' "$created" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("id") or d["publicId"])')"
  [ -n "$id" ] || fail "workspace not created: $created"
  local uuid
  uuid="$(sql1 "SELECT id FROM workspace WHERE work_dir = '$work' LIMIT 1")"
  sql "UPDATE workspace SET repo_url = '$origin' WHERE id = '$uuid'" >/dev/null
  printf '%s\n' "$uuid"
}

# A project whose integration line is a branch of its own, with a merge check command if given.
# EXPLICIT rather than left to the default rule: what the default rule decides is criterion 4's
# subject (`project-integration-ref.pg.spec.ts`), and a case about landing should not also depend on
# how the line was chosen.
new_project() {
  local title="$1" workspace_uuid="$2" origin="$3" merge_check="${4:-}"
  local created project_uuid
  created="$(api POST /projects "$(python3 -c '
import json,sys
print(json.dumps({"title": sys.argv[1], "goal": "integration line acceptance"}))' "$title")")"
  project_uuid="$(printf '%s' "$created" | python3 -c '
import json,sys
d = json.load(sys.stdin)
import base64
print(d.get("id") or d["publicId"])')"
  # The response carries a public id; the row is what the rest of this script works in.
  project_uuid="$(sql1 "SELECT id FROM project WHERE title = '$title' ORDER BY created_at DESC LIMIT 1")"
  [ -n "$project_uuid" ] || fail "project not created: $created"
  local check_sql='NULL'
  if [ -n "$merge_check" ]; then check_sql="'$merge_check'"; fi
  sql "INSERT INTO project_codebase
         (id, project_id, owner_id, slot, canonical_repo_url, upstream_ref, integration_ref,
          integration_ref_source, ref_authority, remote_name, merge_check_command, created_at, updated_at)
       VALUES (gen_random_uuid(), '$project_uuid', '$FIX_OWNER_UUID', 'primary', '$origin',
               'refs/heads/main', 'refs/heads/project/$title', 'EXPLICIT', 'REMOTE', 'origin',
               $check_sql, now(), now())" >/dev/null
  local bound
  bound="$(sql1 "SELECT count(*) FROM project_codebase WHERE project_id = '$project_uuid'")"
  [ "$bound" = "1" ] || fail "project $title has no codebase binding"
  printf '%s\n' "$project_uuid"
}

# A project whose integration line IS its upstream: `integration_ref == upstream_ref`, which is what
# makes it a MAIN line (§1.2). Nothing lands on a branch of its own — a finished task's branch is
# offered to the owner directly (§3.4 M-F2) — so `new_project`'s project branch is deliberately
# absent here, and a case that seeded one would be testing a different line.
new_main_line_project() {
  local title="$1" workspace_uuid="$2" origin="$3" merge_check="${4:-}"
  local created project_uuid
  created="$(api POST /projects "$(python3 -c '
import json,sys
print(json.dumps({"title": sys.argv[1], "goal": "integration line acceptance"}))' "$title")")"
  project_uuid="$(sql1 "SELECT id FROM project WHERE title = '$title' ORDER BY created_at DESC LIMIT 1")"
  [ -n "$project_uuid" ] || fail "project not created: $created"
  local check_sql='NULL'
  if [ -n "$merge_check" ]; then check_sql="'$merge_check'"; fi
  sql "INSERT INTO project_codebase
         (id, project_id, owner_id, slot, canonical_repo_url, upstream_ref, integration_ref,
          integration_ref_source, ref_authority, remote_name, merge_check_command, created_at, updated_at)
       VALUES (gen_random_uuid(), '$project_uuid', '$FIX_OWNER_UUID', 'primary', '$origin',
               'refs/heads/main', 'refs/heads/main', 'EXPLICIT', 'REMOTE', 'origin',
               $check_sql, now(), now())" >/dev/null
  local bound
  bound="$(sql1 "SELECT count(*) FROM project_codebase
                  WHERE project_id = '$project_uuid' AND upstream_ref = integration_ref")"
  [ "$bound" = "1" ] || fail "project $title is not on a MAIN line"
  printf '%s\n' "$project_uuid"
}

# A task in `project`, with a work session that took a worktree on `branch` — the three columns
# `isCodeTask` reads (§1.1). OWNER_CONFIRMED so that the DONE this script drives is a real HTTP
# door of the product (`POST /api/tasks/:id/owner-confirmation`) and not a write into the database.
#
# `acceptance_command` is the pair §2.4 J-S5 re-runs on the combined tree, for the cases whose
# subject is what the platform checks before it lands. It is a separate declaration from the
# completion criterion on purpose: a task the owner settles still declares the command its work is
# judged by, and the fence's OWNER_CONFIRMED lane — not this pair — is what makes its DONE canonical.
new_code_task() {
  local project_uuid="$1" title="$2" workspace_uuid="$3" branch="$4" base_sha="$5"
  local acceptance="${6:-}"
  local acceptance_sql='NULL, NULL'
  [ -n "$acceptance" ] && acceptance_sql="'$acceptance', 0"
  local task_uuid session_uuid
  task_uuid="$(sql1 "INSERT INTO task (id, owner_id, project_id, title, status, creator_type, creator_id,
                      completion_criterion, codeless,
                      acceptance_command, acceptance_expected_exit_code, created_at, updated_at)
                    VALUES (gen_random_uuid(), '$FIX_OWNER_UUID', '$project_uuid', '$title', 'OPEN',
                            'USER', '$FIX_OWNER_UUID', 'OWNER_CONFIRMED', false,
                            $acceptance_sql, now(), now())
                    RETURNING id")"
  session_uuid="$(sql1 "INSERT INTO session (id, owner_id, creator_id, workspace_id, task_id, title, prompt,
                         status, starts_task_work, isolation_status, branch, base_sha, assigned_runner_id,
                         created_at, updated_at)
                       VALUES (gen_random_uuid(), '$FIX_OWNER_UUID', '$FIX_OWNER_UUID', '$workspace_uuid',
                               '$task_uuid', '$title', 'integration line acceptance', 'SUCCEEDED',
                               true, 'worktree', '$branch',
                               '$base_sha', '$FIX_RUNNER_UUID', now(), now())
                       RETURNING id")"
  [ -n "$session_uuid" ] || fail "no work session for $title"
  printf '%s\n' "$task_uuid"
}

# A public id is DERIVED from the uuid (base62), not stored — there is no such column. Every door
# takes either spelling (`toUuid`), so the rows' own uuids are what this script addresses them by.
task_public_id() { printf '%s\n' "$1"; }

# The DONE fact, through the product's own door. The platform's enqueue runs in this request's
# transaction — that is J-T1a, and driving it any other way would test something else.
confirm_task_done() {
  local task_uuid="$1"
  local public_id; public_id="$(task_public_id "$task_uuid")"
  local body; body="$(api POST "/tasks/$public_id/owner-confirmation" '{"decision":"CONFIRM"}')"
  case "$(api_status)" in
    200|201) ;;
    *) fail "owner-confirmation for $task_uuid answered $(api_status): $body" ;;
  esac
}

job_state_of() { sql1 "SELECT state FROM project_integration_job WHERE task_id = '$1' ORDER BY generation DESC LIMIT 1"; }
job_column_of() { sql1 "SELECT COALESCE($2::text, '') FROM project_integration_job WHERE task_id = '$1' ORDER BY generation DESC LIMIT 1"; }

# The queue row itself. Separate from the state wait so "the platform never queued anything" fails in
# thirty seconds with that sentence, instead of four minutes later as a state that never arrived.
wait_for_job_row() {
  local task_uuid="$1" budget="${2:-30}"
  wait_for_sql "an integration job to be queued for $task_uuid" "$budget" \
    "SELECT CASE WHEN EXISTS (SELECT 1 FROM project_integration_job WHERE task_id = '$task_uuid')
             THEN 'yes' ELSE 'no' END" yes
}

wait_for_job_state() {
  local task_uuid="$1" expected="$2" budget="${3:-180}"
  wait_for_job_row "$task_uuid"
  wait_for_sql "the integration job of $task_uuid to reach $expected" "$budget" \
    "SELECT COALESCE((SELECT state FROM project_integration_job WHERE task_id = '$task_uuid'
                       ORDER BY generation DESC LIMIT 1), 'NONE')" "$expected"
}

origin_tip() { git -C "$1" rev-parse --verify --quiet "$2" 2>/dev/null || true; }

# ── promotions: merging a project branch into main (§3) ────────────────────────────────────────

# One JSON request made the way an AGENT would make it: the same credential, plus the session header
# that says a session is holding it. The doors that keep a decision for the account owner refuse it,
# and that refusal is the whole of "only the owner can confirm" — a rule checked at one door only is
# not a rule, so the case that asserts it has to be able to knock on the door as an agent.
api_as_session() {
  local method="$1" route="$2" session="$3" body="${4:-}"
  local tmp="$FIX_SCRATCH/api-body"
  if [ -n "$body" ]; then
    curl -sS -o "$tmp" -w '%{http_code}' -X "$method" "$FIX_API_ORIGIN/api$route" \
      -H 'content-type: application/json' -H "authorization: Bearer $FIX_TOKEN" \
      -H "x-orbit-session-id: $session" -d "$body" > "$FIX_SCRATCH/api-status"
  else
    curl -sS -o "$tmp" -w '%{http_code}' -X "$method" "$FIX_API_ORIGIN/api$route" \
      -H "authorization: Bearer $FIX_TOKEN" -H "x-orbit-session-id: $session" \
      > "$FIX_SCRATCH/api-status"
  fi
  cat "$tmp"
}

# A new commit on the upstream, pushed. What "main moved" means for every case below, and the one
# fact §3 turns on: a candidate is checked against the upstream as it was, and the upstream does not
# hold still while somebody decides.
advance_upstream() {
  local work="$1" file="$2" content="$3"
  git -C "$work" checkout --quiet main
  printf '%s\n' "$content" > "$work/$file"
  git -C "$work" add "$file"
  git -C "$work" commit --quiet -m "main: $file"
  git -C "$work" push --quiet origin main
  git -C "$work" rev-parse main
}

# The project's newest promotion, and one column of it.
promotion_of() { sql1 "SELECT id FROM project_promotion WHERE project_id = '$1' ORDER BY created_at DESC LIMIT 1"; }
promotion_column_of() {
  sql1 "SELECT COALESCE($2::text, '') FROM project_promotion
         WHERE project_id = '$1' ORDER BY created_at DESC LIMIT 1"
}

wait_for_promotion_state() {
  local project="$1" expected="$2" budget="${3:-180}"
  wait_for_sql "the promotion of $project to reach $expected" "$budget" \
    "SELECT COALESCE((SELECT state FROM project_promotion WHERE project_id = '$project'
                       ORDER BY created_at DESC LIMIT 1), 'NONE')" "$expected"
}

# One column of the job of a given kind that belongs to this project's newest promotion.
promotion_job_column_of() {
  sql1 "SELECT COALESCE($3::text, '') FROM project_integration_job j
         WHERE j.project_id = '$1' AND j.kind = '$2'
         ORDER BY j.created_at DESC LIMIT 1"
}

# The owner pressing Merge on the card (§3.4 M-F3).
confirm_promotion() {
  local project="$1" promotion="$2"
  local body; body="$(api POST "/projects/$project/promotions/$promotion/confirm" '{}')"
  case "$(api_status)" in
    200|201) ;;
    *) fail "confirm of promotion $promotion answered $(api_status): $body" ;;
  esac
}

# A project that also STATES something: one acceptance criterion, so that `project.status` has
# something to be derived from. `new_project` deliberately states none — a project with no criteria
# is withheld DONE by `NO_CRITERIA_STATED` and could never flip.
new_project_with_criterion() {
  local title="$1" workspace_uuid="$2" origin="$3" merge_check="${4:-}"
  local created project_uuid
  created="$(api POST /projects "$(python3 -c '
import json,sys
print(json.dumps({
  "title": sys.argv[1],
  "goal": "integration line acceptance",
  "acceptanceCriteriaItems": [{
    "text": "the work reaches main",
    "verificationMethod": "the acceptance script asserts project.status flips on the merge",
  }],
}))' "$title")")"
  project_uuid="$(sql1 "SELECT id FROM project WHERE title = '$title' ORDER BY created_at DESC LIMIT 1")"
  [ -n "$project_uuid" ] || fail "project not created: $created"
  local stated
  stated="$(sql1 "SELECT count(*) FROM project_acceptance_criterion_definition WHERE project_id = '$project_uuid'")"
  # The owner's own door applies criteria directly; an agent's would be held as a proposal. A held
  # one here would make every later assertion about DONE a statement about the wrong thing.
  [ "$stated" = "1" ] || fail "the project states $stated criteria, expected 1: $created"
  local check_sql='NULL'
  if [ -n "$merge_check" ]; then check_sql="'$merge_check'"; fi
  sql "INSERT INTO project_codebase
         (id, project_id, owner_id, slot, canonical_repo_url, upstream_ref, integration_ref,
          integration_ref_source, ref_authority, remote_name, merge_check_command, created_at, updated_at)
       VALUES (gen_random_uuid(), '$project_uuid', '$FIX_OWNER_UUID', 'primary', '$origin',
               'refs/heads/main', 'refs/heads/project/$title', 'EXPLICIT', 'REMOTE', 'origin',
               $check_sql, now(), now())" >/dev/null
  printf '%s\n' "$project_uuid"
}

# The account owner saying that THIS version of the criteria expresses the goal — one of the four
# things `project-done-derived.ts` folds, and the only one no work can supply.
confirm_standard_set() {
  local project="$1"
  local standing digest
  standing="$(api GET "/projects/$project/acceptance/confirmation")"
  digest="$(printf '%s' "$standing" | python3 -c 'import json,sys;print(json.load(sys.stdin)["currentVersion"]["digest"])')"
  [ -n "$digest" ] || fail "no criteria digest to confirm: $standing"
  local body; body="$(api POST "/projects/$project/acceptance/confirmation" "{\"criteriaDigest\":\"$digest\"}")"
  case "$(api_status)" in
    200|201) ;;
    *) fail "confirming the standard set answered $(api_status): $body" ;;
  esac
}

# Which stated criterion a task serves. Written here rather than through the task door because the
# fixture creates its tasks with SQL — the declaration is an input to what is under test, not part
# of it.
declare_task_serves_criterion() {
  local task="$1" project="$2"
  sql "UPDATE task SET criterion_definition_id = d.id, criterion_revision = d.revision
         FROM project_acceptance_criterion_definition d
        WHERE d.project_id = '$project' AND task.id = '$task'" >/dev/null
}

# Is `ancestor` in `descendant`'s history, in the checkout `work`? Answers yes/no rather than a
# status, so an assertion reads as the sentence it is making.
is_ancestor_in() {
  local work="$1" ancestor="$2" descendant="$3"
  if git -C "$work" merge-base --is-ancestor "$ancestor" "$descendant" 2>/dev/null; then
    printf 'yes\n'
  else
    printf 'no\n'
  fi
}

# Everything the origin holds, in this checkout, so the assertions below can read commits the runner
# made on another branch of the same repository.
fetch_all() { git -C "$1" fetch --quiet origin '+refs/heads/*:refs/remotes/origin/*' 2>/dev/null || true; }
