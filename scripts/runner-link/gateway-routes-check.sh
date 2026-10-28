#!/usr/bin/env bash
# The web gateway's routes for several apiservers, checked on stand-ins (task 34nb3xgCijTDzQJVXDVT7; docs/self-hosting.md,
# "Several apiservers"): this checkout's gateway/nginx.conf, with and without gateway/several-apiservers/ mounted, in
# front of apiservers that answer every request with their own name. A Compose project of its own, removed at the end.
#
#   scripts/runner-link/gateway-routes-check.sh [--apiservers N] [--image IMAGE] [--old-image IMAGE] [--keep]
#
# What it checks, and prints as it goes:
#   1. gateway/nginx.conf loads on --image (nginx:alpine) and on --old-image (nginx:1.25-alpine), an nginx older than
#      the 1.27.3 the routes need: a deployment keeps the nginx:alpine it first pulled. With the directory mounted it
#      loads on --image, and --old-image refuses it (which is why docs/self-hosting.md asks for the version).
#   2. Without the directory, every request reaches the first apiserver, as with one apiserver.
#   3. With it, N apiservers (3 unless --apiservers): each session's stream reaches the same apiserver every time; the
#      sessions spread over all of them; link tokens reach all of them; every other request still reaches the first.
#   4. One apiserver killed: the streams of its sessions open on the others, none reaches it once the gateway has
#      resolved the name again (10 s), the other sessions stay where they were until then, and once it is started
#      again it takes sessions again.
#
# Exits 0 when every check holds. --keep leaves the stand-ins running.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
n=3
image=nginx:alpine
old_image=nginx:1.25-alpine
keep=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apiservers) n="$2"; shift 2 ;;
    --image) image="$2"; shift 2 ;;
    --old-image) old_image="$2"; shift 2 ;;
    --keep) keep=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
done
[[ "$n" =~ ^[2-9]$ ]] || { echo "--apiservers is 2 to 9" >&2; exit 2; }
for tool in docker curl; do command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 2; }; done

project="orbit-link-routes-check-$$"
work="$(mktemp -d)"
failures=0
log() { echo "==> $*"; }
ok() { echo "  ok: $*"; }
fail() { echo "  FAIL: $*"; failures=$((failures + 1)); }
dc() { docker compose -p "$project" --project-directory "$work" -f "$work/compose.yml" "$@"; }
cleanup() {
  if [ "$keep" = 1 ]; then
    echo "kept: docker compose -p $project --project-directory $work -f $work/compose.yml down"
  else
    dc down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$work"
  fi
}
trap cleanup EXIT

# --- 1. Which nginx loads which configuration. ------------------------------------------------------------------------
log "1. gateway/nginx.conf on $image and on $old_image, with and without gateway/several-apiservers/"
loads() {
  local img="$1"
  shift
  docker run --rm -v "$repo/gateway/nginx.conf:/etc/nginx/conf.d/default.conf:ro" "$@" "$img" nginx -t 2>&1
}
for img in "$image" "$old_image"; do
  version="$(docker run --rm "$img" nginx -v 2>&1 | tail -1)"
  if out="$(loads "$img")"; then ok "$img ($version) loads gateway/nginx.conf"; else fail "$img ($version) refuses gateway/nginx.conf: $out"; fi
done
spread_mount=(-v "$repo/gateway/several-apiservers:/etc/nginx/several-apiservers:ro")
if out="$(loads "$image" "${spread_mount[@]}")"; then
  ok "$image loads it with gateway/several-apiservers/"
else
  fail "$image refuses it with gateway/several-apiservers/: $out"
fi
if out="$(loads "$old_image" "${spread_mount[@]}")"; then
  fail "$old_image loads gateway/several-apiservers/, which needs 1.27.3"
else
  ok "$old_image refuses gateway/several-apiservers/: $(grep -m1 emerg <<<"$out")"
fi

# --- The stand-ins. ---------------------------------------------------------------------------------------------------
# Each apiserver answers with its name. The first is `apiserver`, which the /api/ location reaches; every one answers to
# orbit-apiservers, as docker-compose.yml has it.
cat > "$work/apiserver.conf" <<'EOF'
server {
    listen 3000;
    location / { default_type text/plain; return 200 "$hostname\n"; }
}
EOF
{
  echo "services:"
  for i in $(seq 1 "$n"); do
    name=apiserver
    [ "$i" = 1 ] || name="apiserver-$i"
    cat <<EOF
  $name:
    image: $image
    hostname: $name
    volumes:
      - ./apiserver.conf:/etc/nginx/conf.d/default.conf:ro
    networks:
      default:
        aliases: [orbit-apiservers]
EOF
  done
  cat <<EOF
  gateway:
    image: $image
    ports: ["127.0.0.1::80"]
    volumes:
      - $repo/gateway/nginx.conf:/etc/nginx/conf.d/default.conf:ro
EOF
} > "$work/compose.yml"
cp "$work/compose.yml" "$work/compose.first.yml"
{
  cat "$work/compose.first.yml"
  echo "      - $repo/gateway/several-apiservers:/etc/nginx/several-apiservers:ro"
} > "$work/compose.spread.yml"

origin=""
up() {
  cp "$work/compose.$1.yml" "$work/compose.yml"
  dc up -d --wait --force-recreate >/dev/null 2>&1 || { dc logs gateway | tail -20; echo "the stand-ins did not start" >&2; exit 1; }
  origin="http://$(dc port gateway 80)"
  # nginx resolves the alias in the background once it has started: wait until every apiserver answers.
  local seen i
  for _ in $(seq 1 50); do
    seen="$(for i in $(seq 1 40); do curl -s "$origin/api/runner/link-token" -X POST; done | sort -u | wc -l)"
    [ "$1" = first ] || [ "$seen" -ge "$n" ] && return 0
    sleep 0.2
  done
}
# who PATH [METHOD]: the apiserver that answered, or the HTTP status when none did.
who() {
  local body code
  body="$(curl -s -w '\n%{http_code}' --max-time 12 -X "${2:-GET}" "$origin$1")" || { echo "unreachable"; return; }
  code="${body##*$'\n'}"
  [ "$code" = 200 ] && echo "${body%%$'\n'*}" || echo "status-$code"
}
sessions=()
for i in $(seq 1 120); do sessions+=("$(printf 's%03d-%s' "$i" "$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')")"); done

# --- 2. Without the directory. ----------------------------------------------------------------------------------------
log "2. without gateway/several-apiservers/: $n apiservers behind the gateway"
up first
others="$(for s in "${sessions[@]:0:30}"; do who "/api/sessions/$s/events"; who /api/runner/link-token POST; who /api/sessions/$s; done | sort | uniq -c)"
if [ "$(awk '{print $2}' <<<"$others" | sort -u)" = apiserver ]; then
  ok "streams, link tokens and everything else reach the first apiserver: $(tr -s ' \n' ' ' <<<"$others")"
else
  fail "requests reached others: $others"
fi

# --- 3. With it. ------------------------------------------------------------------------------------------------------
log "3. with gateway/several-apiservers/ mounted"
up spread
declare -A home
split=0
for s in "${sessions[@]}"; do
  a="$(who "/api/sessions/$s/events")"
  b="$(who "/api/sessions/$s/events?sinceSeq=12")"
  c="$(who "/api/sessions/$s/events")"
  home[$s]="$a"
  [ "$a" = "$b" ] && [ "$b" = "$c" ] || { split=$((split + 1)); echo "    $s: $a $b $c"; }
done
if [ "$split" = 0 ]; then ok "each of ${#sessions[@]} sessions' streams reached one apiserver, three times out of three"; else fail "$split sessions' streams reached more than one apiserver"; fi
spread="$(for s in "${sessions[@]}"; do echo "${home[$s]}"; done | sort | uniq -c)"
if [ "$(wc -l <<<"$spread")" = "$n" ] && ! grep -q status- <<<"$spread"; then
  ok "the sessions spread over all $n: $(tr -s ' \n' ' ' <<<"$spread")"
else
  fail "the sessions reached: $spread"
fi
tokens="$(for _ in $(seq 1 60); do who /api/runner/link-token POST; done | sort | uniq -c)"
if [ "$(wc -l <<<"$tokens")" = "$n" ] && ! grep -q status- <<<"$tokens"; then ok "link tokens reached all $n: $(tr -s ' \n' ' ' <<<"$tokens")"; else fail "link tokens reached: $tokens"; fi
rest="$(for s in "${sessions[@]:0:30}"; do who "/api/sessions/$s"; who "/api/sessions/$s/events/page"; who /api/events; who /api/runner/heartbeat POST; done | sort | uniq -c)"
if [ "$(awk '{print $2}' <<<"$rest" | sort -u)" = apiserver ]; then ok "everything else reached the first apiserver: $(tr -s ' \n' ' ' <<<"$rest")"; else fail "other requests reached: $rest"; fi

# --- 4. One apiserver killed, then started again. ---------------------------------------------------------------------
victim="apiserver-$n"
log "4. $victim killed"
dc kill -s KILL "$victim" >/dev/null 2>&1
killed_at=$(date +%s%N)
moved=0
stayed=0
lost=0
slowest=0
for s in "${sessions[@]}"; do
  [ "${home[$s]}" = "$victim" ] || continue
  t0=$(date +%s%N)
  now="$(who "/api/sessions/$s/events")"
  ms=$(( ($(date +%s%N) - t0) / 1000000 ))
  [ "$ms" -gt "$slowest" ] && slowest=$ms
  case "$now" in
    "$victim"|status-*|unreachable) lost=$((lost + 1)); echo "    $s: $now" ;;
    *) moved=$((moved + 1)) ;;
  esac
done
for s in "${sessions[@]}"; do
  [ "${home[$s]}" = "$victim" ] && continue
  [ "$(who "/api/sessions/$s/events")" = "${home[$s]}" ] && stayed=$((stayed + 1))
done
if [ "$lost" = 0 ] && [ "$moved" -gt 0 ]; then
  ok "the $moved sessions on $victim opened on the others at once (slowest ${slowest} ms); $stayed of the others' were where they had been"
else
  fail "$lost of the sessions on $victim found no apiserver"
fi
# Once the gateway has resolved the name again, nothing reaches the killed one, and the sessions now spread over the rest.
sleep $(( 12 - ($(date +%s%N) - killed_at) / 1000000000 > 0 ? 12 - ($(date +%s%N) - killed_at) / 1000000000 : 0 ))
after="$(for s in "${sessions[@]}"; do who "/api/sessions/$s/events"; done | sort | uniq -c)"
if ! grep -q -e "$victim" -e status- <<<"$after" && [ "$(wc -l <<<"$after")" = $((n - 1)) ]; then
  ok "12 s on, the sessions spread over the other $((n - 1)): $(tr -s ' \n' ' ' <<<"$after")"
else
  fail "12 s on, the sessions reached: $after"
fi
log "4. $victim started again"
dc start "$victim" >/dev/null 2>&1
back=""
for _ in $(seq 1 30); do
  back="$(for s in "${sessions[@]}"; do who "/api/sessions/$s/events"; done | sort | uniq -c)"
  grep -q "$victim" <<<"$back" && break
  sleep 1
done
if grep -q "$victim" <<<"$back" && ! grep -q status- <<<"$back"; then ok "$victim takes sessions again: $(tr -s ' \n' ' ' <<<"$back")"; else fail "$victim took no session back: $back"; fi

if [ "$failures" = 0 ]; then
  echo "all checks hold"
else
  echo "$failures check(s) failed"
  exit 1
fi
