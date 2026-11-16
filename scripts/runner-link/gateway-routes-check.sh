#!/usr/bin/env bash
# The web gateway's routes for several apiservers, checked on stand-ins (task 34nb3xgCijTDzQJVXDVT7; docs/self-hosting.md,
# "Several apiservers"): this checkout's gateway/nginx.conf, with and without gateway/several-apiservers/ mounted, in
# front of apiservers that answer every request with their own name. A Compose project of its own, removed at the end.
#
#   scripts/runner-link/gateway-routes-check.sh [--apiservers N] [--image IMAGE] [--old-image IMAGE] [--hold SECONDS] [--keep]
#
# What it checks, and prints as it goes:
#   1. gateway/nginx.conf loads on --image (nginx:alpine) and on --old-image (nginx:1.25-alpine), an nginx older than
#      the 1.27.3 the routes need: a deployment keeps the nginx:alpine it first pulled. With the directory mounted it
#      loads on --image, and --old-image refuses it (which is why docs/self-hosting.md asks for the version).
#   2. Without the directory, every request reaches the first apiserver, as with one apiserver: the viewer streams too.
#   3. With it, N apiservers (3 unless --apiservers): each session's stream, each session's guest stream and each public
#      link's streams reach the same apiserver every time; the sessions and links spread over all of them; link tokens
#      reach all of them; every other request still reaches the first.
#   4. One apiserver killed: the streams of its sessions open on the others, none reaches it once the gateway has
#      resolved the name again (10 s), the other sessions stay where they were until then, and once it is started
#      again it takes sessions again.
#   5. The gateway started while no apiserver answers to their shared name: the two routes answer 502 until nginx
#      looks the name up again, within 12 s. A deployment's gateway starts once the first apiserver is healthy
#      (docker-compose.yml), as every start here does but this one.
#   6. Only with --hold SECONDS (130 or more is the drill): a guest stream and both public link streams held open
#      through the gateway for that long, each with a ping from its apiserver every 20 s arriving 20 s apart, unbuffered;
#      and the guest stream's access_token in no line of the gateway's access log.
#
# Exits 0 when every check holds. --keep leaves the stand-ins running.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
n=3
image=nginx:alpine
old_image=nginx:1.25-alpine
keep=0
hold=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apiservers) n="$2"; shift 2 ;;
    --image) image="$2"; shift 2 ;;
    --old-image) old_image="$2"; shift 2 ;;
    --keep) keep=1; shift ;;
    --hold) hold="$2"; shift 2 ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
done
[[ "$n" =~ ^[2-9]$ ]] || { echo "--apiservers is 2 to 9" >&2; exit 2; }
[[ "$hold" =~ ^[0-9]+$ ]] || { echo "--hold is a number of seconds" >&2; exit 2; }
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
# orbit-apiservers, as docker-compose.yml has it. A request with `hold` in its query is answered as a stream instead:
# its name as the first event, then a ping every 20 s, as the apiserver's viewer streams send one.
standin_image=node:22-alpine
cat > "$work/apiserver.mjs" <<'EOF'
import http from 'node:http';
import os from 'node:os';
http.createServer((req, res) => {
  if (!new URL(req.url, 'http://standin').searchParams.has('hold')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`${os.hostname()}\n`);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.write(`event: hello\ndata: ${os.hostname()}\n\n`);
  const ping = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 20000);
  req.on('close', () => clearInterval(ping));
}).listen(3000);
EOF
{
  echo "services:"
  for i in $(seq 1 "$n"); do
    name=apiserver
    [ "$i" = 1 ] || name="apiserver-$i"
    cat <<EOF
  $name:
    image: $standin_image
    hostname: $name
    command: ["node", "/apiserver.mjs"]
    init: true
    volumes:
      - ./apiserver.mjs:/apiserver.mjs:ro
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

apiservers=(apiserver)
for i in $(seq 2 "$n"); do apiservers+=("apiserver-$i"); done
origin=""
# up first|spread: the apiservers, then the gateway, as a deployment's gateway starts once an apiserver is healthy.
up() {
  cp "$work/compose.$1.yml" "$work/compose.yml"
  { dc up -d --wait --force-recreate "${apiservers[@]}" && dc up -d --wait --force-recreate gateway; } >/dev/null 2>&1 ||
    { dc logs gateway | tail -20; echo "the stand-ins did not start" >&2; exit 1; }
  origin="http://$(dc port gateway 80)"
}
# who PATH [METHOD]: the apiserver that answered, or the HTTP status when none did.
who() {
  local body code
  body="$(curl -s -w '\n%{http_code}' --max-time 12 -X "${2:-GET}" "$origin$1")" || { echo "unreachable"; return; }
  code="${body##*$'\n'}"
  [ "$code" = 200 ] && echo "${body%%$'\n'*}" || echo "status-$code"
}
is_apiserver() { [[ " ${apiservers[*]} " == *" $1 "* ]]; }
sessions=()
# The access_token every guest stream here carries, which must appear in no line of the gateway's access log.
secret="tok$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
for i in $(seq 1 120); do sessions+=("$(printf 's%03d-%s' "$i" "$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')")"); done

# --- 2. Without the directory. ----------------------------------------------------------------------------------------
log "2. without gateway/several-apiservers/: $n apiservers behind the gateway"
up first
others="$(for s in "${sessions[@]:0:30}"; do
  who "/api/sessions/$s/events"; who "/api/guest-sessions/$s/stream?access_token=$secret"; who "/api/shared/l$s/stream"
  who "/api/shared/l$s/sessions/$s/stream"; who /api/runner/link-token POST; who /api/sessions/$s
done | sort | uniq -c)"
if [ "$(awk '{print $2}' <<<"$others" | sort -u)" = apiserver ]; then
  ok "streams, viewer streams, link tokens and everything else reach the first apiserver: $(tr -s ' \n' ' ' <<<"$others")"
else
  fail "requests reached others: $others"
fi

# --- 3. With it. ------------------------------------------------------------------------------------------------------
log "3. with gateway/several-apiservers/ mounted"
up spread
first_answer="$(who "/api/sessions/${sessions[0]}/events")"
if is_apiserver "$first_answer"; then ok "the routes answer as soon as the gateway is up: $first_answer"; else fail "the first stream right after the gateway started: $first_answer"; fi
declare -A home
split=0
for s in "${sessions[@]}"; do
  a="$(who "/api/sessions/$s/events")"
  b="$(who "/api/sessions/$s/events?sinceSeq=12")"
  c="$(who "/api/sessions/$s/events")"
  home[$s]="$a"
  is_apiserver "$a" && [ "$a" = "$b" ] && [ "$b" = "$c" ] || { split=$((split + 1)); echo "    $s: $a $b $c"; }
done
if [ "$split" = 0 ]; then ok "each of ${#sessions[@]} sessions' streams reached one apiserver, three times out of three"; else fail "$split sessions' streams reached more than one apiserver"; fi
spread="$(for s in "${sessions[@]}"; do echo "${home[$s]}"; done | sort | uniq -c)"
if [ "$(wc -l <<<"$spread")" = "$n" ] && ! grep -q status- <<<"$spread"; then
  ok "the sessions spread over all $n: $(tr -s ' \n' ' ' <<<"$spread")"
else
  fail "the sessions reached: $spread"
fi
# The viewer streams: a guest's by its session, a public link's two by the link's token.
declare -A guest_home link_home
split=0
for s in "${sessions[@]}"; do
  a="$(who "/api/guest-sessions/$s/stream?access_token=$secret")"
  b="$(who "/api/guest-sessions/$s/stream?access_token=$secret&sinceSeq=12")"
  c="$(who "/api/guest-sessions/$s/stream?access_token=$secret")"
  guest_home[$s]="$a"
  is_apiserver "$a" && [ "$a" = "$b" ] && [ "$b" = "$c" ] || { split=$((split + 1)); echo "    guest $s: $a $b $c"; }
  a="$(who "/api/shared/l$s/stream")"
  b="$(who "/api/shared/l$s/sessions/$s/stream")"
  c="$(who "/api/shared/l$s/sessions/other-$s/stream?sinceSeq=12")"
  link_home[$s]="$a"
  is_apiserver "$a" && [ "$a" = "$b" ] && [ "$b" = "$c" ] || { split=$((split + 1)); echo "    link l$s: $a $b $c"; }
done
if [ "$split" = 0 ]; then
  ok "each of ${#sessions[@]} sessions' guest streams, and each of ${#sessions[@]} links' streams, reached one apiserver, three times out of three"
else
  fail "$split guest sessions or links reached more than one apiserver"
fi
spread="$(for s in "${sessions[@]}"; do echo "${guest_home[$s]}"; echo "${link_home[$s]}"; done | sort | uniq -c)"
if [ "$(wc -l <<<"$spread")" = "$n" ] && ! grep -q status- <<<"$spread"; then
  ok "the guest sessions and links spread over all $n: $(tr -s ' \n' ' ' <<<"$spread")"
else
  fail "the guest sessions and links reached: $spread"
fi
tokens="$(for _ in $(seq 1 60); do who /api/runner/link-token POST; done | sort | uniq -c)"
if [ "$(wc -l <<<"$tokens")" = "$n" ] && ! grep -q status- <<<"$tokens"; then ok "link tokens reached all $n: $(tr -s ' \n' ' ' <<<"$tokens")"; else fail "link tokens reached: $tokens"; fi
rest="$(for s in "${sessions[@]:0:30}"; do
  who "/api/sessions/$s"; who "/api/sessions/$s/events/page"; who /api/events; who /api/runner/heartbeat POST
  who "/api/guest-sessions/$s"; who "/api/guest-sessions/$s/events"; who "/api/shared/l$s"; who "/api/shared/l$s/sessions/$s/events"
done | sort | uniq -c)"
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

# --- 5. The gateway started before any apiserver. ---------------------------------------------------------------------
log "5. the gateway started while no apiserver runs"
dc stop "${apiservers[@]}" >/dev/null 2>&1
dc up -d --wait --force-recreate --no-deps gateway >/dev/null 2>&1
origin="http://$(dc port gateway 80)"
before="$(who "/api/sessions/${sessions[0]}/events")"
dc start "${apiservers[@]}" >/dev/null 2>&1
started=$(date +%s%N)
after=""
while [ $(( ($(date +%s%N) - started) / 1000000000 )) -lt 15 ]; do
  after="$(who "/api/sessions/${sessions[0]}/events")"
  is_apiserver "$after" && break
  sleep 0.2
done
took=$(( ($(date +%s%N) - started) / 1000000 ))
if [ "$before" = status-502 ] && is_apiserver "$after" && [ "$took" -le 12000 ]; then
  ok "502 until nginx looked the name up again: answered by $after ${took} ms after the apiservers started"
else
  fail "before the apiservers: $before; after them: $after, ${took} ms on"
fi

# --- 6. The viewer streams held open. -------------------------------------------------------------------------------
if [ "$hold" -gt 0 ]; then
  log "6. a guest stream and both public link streams held open for $hold s"
  # hold_stream NAME PATH: every line the stream sends, after the time it arrived in ms, then curl's exit status (28:
  # still open when --max-time ran out).
  hold_stream() {
    { curl -sN --max-time "$hold" "$origin$2" && echo "curl-exit 0" || echo "curl-exit $?"; } |
      while IFS= read -r line; do echo "$(date +%s%3N) $line"; done > "$work/hold-$1"
  }
  s="${sessions[0]}"
  # Where each lands now: section 5 started the apiservers again, which may have moved their addresses in the list, and
  # nginx reads that list again within 10 s.
  sleep 12
  declare -A now_home=([guest]="$(who "/api/guest-sessions/$s/stream?access_token=$secret")"
    [link]="$(who "/api/shared/l$s/stream")" [link-session]="$(who "/api/shared/l$s/sessions/$s/stream")")
  hold_stream guest "/api/guest-sessions/$s/stream?access_token=$secret&hold=1" &
  hold_stream link "/api/shared/l$s/stream?hold=1" &
  hold_stream link-session "/api/shared/l$s/sessions/$s/stream?hold=1" &
  wait
  for name in guest link link-session; do
    out="$work/hold-$name"
    start="$(awk 'NR==1 {print $1}' "$out")"
    end="$(awk '/ curl-exit /{print $1}' "$out")"
    status="$(awk '/ curl-exit /{print $3}' "$out")"
    host="$(awk '$2 == "data:" && prev == "hello" {print $3; exit} {prev = $3}' "$out")"
    gaps="$(awk '$2 == "event:" && $3 == "ping" {if (last) printf "%.1f ", ($1 - last) / 1000; last = $1}' "$out")"
    pings="$(grep -c ' event: ping$' "$out" || true)"
    open_s=$(( (${end:-0} - ${start:-0}) / 1000 ))
    first="${now_home[$name]}"
    if [ "$status" = 28 ] && [ "$open_s" -ge $((hold - 1)) ] && [ "$host" = "$first" ] && [ "$pings" -ge $((hold / 20 - 1)) ] &&
      awk -v g="$gaps" 'BEGIN { n = split(g, a, " "); for (i = 1; i <= n; i++) if (a[i] < 19 || a[i] > 21) exit 1 }'; then
      ok "$name stream: open ${open_s} s on $host (where it opened just before), $pings pings, apart by $gaps s"
    else
      fail "$name stream: curl $status after ${open_s} s on ${host:-nothing} (expected ${first}), $pings pings, apart by $gaps s"
    fi
  done
  # The access log's lines alone: nginx's own error lines (`2026/11/16 11:47:57 [error] …`) still carry the request line,
  # token and all, when an upstream fails, which no log_format reaches (the comment above the map in gateway/nginx.conf).
  logs="$(dc logs --no-log-prefix gateway 2>&1)"
  access="$(grep -Ev '^[0-9]{4}/[0-9]{2}/[0-9]{2} [0-9:]{8} \[' <<<"$logs" || true)"
  errors="$(grep -cF "$secret" <<<"$(grep -E '^[0-9]{4}/[0-9]{2}/[0-9]{2} [0-9:]{8} \[' <<<"$logs" || true)" || true)"
  [ "$errors" = 0 ] || echo "  note: $errors of nginx's own error lines carry the token, as they do for every stream's"
  lines="$(grep -c '"GET /api/guest-sessions/[^ ]*/stream HTTP/1.1" 200' <<<"$access" || true)"
  if ! grep -qF "$secret" <<<"$access" && [ "$lines" -gt 0 ]; then
    ok "the guest streams' access_token is in no line of the gateway's access log; $lines guest stream lines, the query dropped: $(grep -m1 '/api/guest-sessions/[^ ]*/stream' <<<"$access")"
  else
    fail "the gateway's access log has the access_token in $(grep -cF "$secret" <<<"$access" || true) lines, and $lines guest stream lines:"
    grep -F "$secret" <<<"$access" | sed "s/$secret/<the token>/g; s/^/    /" || true
  fi
fi

if [ "$failures" = 0 ]; then
  echo "all checks hold"
else
  echo "$failures check(s) failed"
  exit 1
fi
