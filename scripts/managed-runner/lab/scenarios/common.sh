# Shared by the lab scenarios: brings the managed-runner lab up from nothing and gives the scenarios
# their helpers. Sourced by run.sh; not run on its own. Everything is found from this checkout and
# lab.env's LAB_DIR, so nothing here names a host path.
# shellcheck shell=bash

SC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
L=$(cd "$SC/.." && pwd)
R=$(cd "$L/../../.." && pwd)
# shellcheck source=../lib.sh
. "$L/lib.sh"

# login-lab.py only works on a test server directory of this name.
export LAB_TEST_SERVER_DIR=${LAB_TEST_SERVER_DIR:-$LAB_DIR/test-server-t05}
S=$LAB_TEST_SERVER_DIR
NS=$LAB_NAMESPACE
API=http://127.0.0.1:$LAB_TEST_API_PORT/api
IMG=$LAB_DIR/image
PAGES_PORT=13791   # pages a scenario serves from the host, which Pods reach as http://10.0.2.2:13791
WEB_PORT=13718     # the web build behind the web image's nginx.conf, on the host
PROFILE_DIR=/home/orbit/.orbit/browser/profile
OUT=${LAB_OUT:?LAB_OUT must name the output directory}
LOGS=$OUT/logs
SESSIONS=$OUT/sessions
CHECKS=$OUT/checks.tsv
mkdir -p "$OUT" "$LOGS" "$SESSIONS"
: > "$CHECKS"

step() { printf '\n== %s %s\n' "$*" "$(date -u +%T)"; }
# A failed setup step: the end of its log, then out.
tail_die() { echo "--- last lines of $1" >&2; tail -n "${2:-40}" "$1" >&2 || true; die "${3:-setup failed}"; }

# ---- checks -------------------------------------------------------------------------------------
# check NAME COMMAND...: one line PASS or FAIL per check, kept in checks.tsv for result.json. A failed
# check does not stop the scenario; run.sh fails the run if any did.
check() {
  local name=$1; shift
  if "$@" >/dev/null 2>&1; then
    printf 'PASS  %s\n' "$name"; printf 'pass\t%s\n' "$name" >> "$CHECKS"
  else
    printf 'FAIL  %s\n' "$name"; printf 'fail\t%s\n' "$name" >> "$CHECKS"
  fi
}
# check_eq NAME ACTUAL EXPECTED
check_eq() {
  if [ "$2" = "$3" ]; then
    printf 'PASS  %s (%s)\n' "$1" "$2"; printf 'pass\t%s\n' "$1" >> "$CHECKS"
  else
    printf 'FAIL  %s: got [%s], expected [%s]\n' "$1" "$2" "$3"; printf 'fail\t%s\n' "$1" >> "$CHECKS"
  fi
}
# A scenario that cannot go on (no session, no Pod): recorded as a failed check, then out.
abort() { printf 'FAIL  %s\n' "$1"; printf 'fail\t%s\n' "$1" >> "$CHECKS"; exit 1; }

# ---- the lab ------------------------------------------------------------------------------------
K() { lab_kubectl -n "$NS" "$@"; }

# lab_up on|off: the VM (k3s, Ceph, Ceph-CSI), the runner image with the lab CA, the test server with
# managed runners on and the browser switch as asked, the runner link and NATS, one account (erin)
# on the fake model with its runner READY. Sets REF, POD, POD_UID, RUNNER, SLUG and the owner's tokens.
lab_up() {
  local browser=$1
  step "lab VM: create.sh (k3s, Ceph, Ceph-CSI)"
  "$L/create.sh" > "$LOGS/create.log" 2>&1 || tail_die "$LOGS/create.log" 60 "create.sh failed"
  tail -1 "$LOGS/create.log"

  step "the lab CA and the runner image at $(git -C "$R" rev-parse --short HEAD)"
  "$L/test-server.sh" secrets
  "$SC/build-image.sh" "$IMG" > "$LOGS/image.log" 2>&1 || tail_die "$LOGS/image.log" 60 "the runner image did not build"
  grep -E 'build:|manifest:' "$LOGS/image.log"
  python3 "$L/single-writer.py" import "$IMG/lab.oci.tar" > "$LOGS/import.json" || die "the image import failed"
  REF=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["pinned"])' "$LOGS/import.json")
  echo "pinned $REF"

  step "the manager's profile and identity"
  python3 "$L/single-writer.py" profile --image "$REF" > "$LOGS/profile.json"
  python3 "$L/login-lab.py" prepare --image "$REF" --from "$S" > "$LOGS/prepare.json"
  # One Chrome needs about 1.5 GiB more than the runner's 2 GiB limit (docs/runner-browser-design.md §3, Budget).
  python3 - "$S/managed-runner-profile.json" <<'PY'
import json, sys
v = json.load(open(sys.argv[1]))
v['runner']['resources']['runner']['limits']['memory'] = '3584Mi'
v['runner']['tmpSizeLimit'] = '1Gi'
open(sys.argv[1], 'w').write(json.dumps(v, indent=1))
PY

  step "test server: managed runners on, browser switch $browser; gate, link gateway, NATS"
  python3 "$L/login-lab.py" gate start > /dev/null
  local flags=(--managed); [ "$browser" = on ] && flags+=(--browser)
  "$L/test-server.sh" start "${flags[@]}" > "$LOGS/test-server.log" 2>&1 \
    || tail_die "$LOGS/test-server.log" 60 "the test server did not start"
  grep -E '^(apiserver|state):' "$LOGS/test-server.log" || true
  LAB_NATS=1 "$SC/link.sh" start > "$LOGS/link-start.log" 2>&1 || tail_die "$LOGS/link-start.log" 30 "the runner link did not start"
  head -1 "$LOGS/link-start.log"
  echo "browser switch in api.env: $(grep -E '^ORBIT_MANAGED_RUNNER_BROWSER' "$S/secrets/api.env" || echo absent)"
  python3 "$L/single-writer.py" admission install > "$LOGS/admission.json"

  step "the owner (erin), a fake-model key, the runner READY"
  python3 "$L/login-lab.py" account erin > "$LOGS/account.json" || die "the account was not made"
  python3 "$L/login-lab.py" until erin STARTING --reason MODEL_UNAVAILABLE --timeout 900 > "$LOGS/until-starting.json" || true
  python3 "$L/login-lab.py" key erin --fake > "$OUT/key.json" || die "the fake-model key was refused"
  SLUG=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["slug"])' "$OUT/key.json")
  python3 "$L/login-lab.py" until erin READY --timeout 1500 > "$LOGS/until-ready.json" \
    || { tail -c 2000 "$LOGS/until-ready.json"; K get pods -o wide || true; die "erin's runner did not get READY"; }
  read -r POD POD_UID < <(running_pod) || die "no Running Pod on $REF"
  K logs -f "$POD" -c runner > "$LOGS/runner.log" 2>&1 &
  RUNNER_LOGS=$!
  RUNNER=$(python3 -c "import importlib.util as u;s=u.spec_from_file_location('ll','$L/login-lab.py');m=u.module_from_spec(s);s.loader.exec_module(m);print(m.ml.status_of('erin')['runnerId'])")
  ORBIT_ACCESS_TOKEN=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["accessToken"])' "$S/state/erin.json")
  ORBIT_REFRESH_TOKEN=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("refreshToken",""))' "$S/state/erin.json")
  export ORBIT_ACCESS_TOKEN ORBIT_REFRESH_TOKEN
  echo "runner $RUNNER READY in Pod $POD; fake-model key $SLUG"
}

# The runner's Running Pod on the pinned image. A slow API answer is retried, not fatal.
running_pod() {
  local found= i
  for i in $(seq 120); do
    [ "$i" = 6 ] && { python3 "$L/login-lab.py" action erin retry >/dev/null 2>&1 || true; }
    found=$(K get pods -o jsonpath='{range .items[*]}{.metadata.name} {.metadata.uid} {.spec.containers[0].image} {.status.phase}{"\n"}{end}' 2>/dev/null \
      | awk -v r="$REF" '$3 == r && $4 == "Running" {print $1" "$2; exit}' || true)
    [ -n "$found" ] && break
    sleep 10
  done
  [ -n "$found" ] || { K get pods -o wide >&2 || true; return 1; }
  echo "$found"
}

# lab_collect: what the run leaves for the artifact (logs only: no secrets, no state), then teardown.
lab_collect() {
  set +e
  [ -n "${RUNNER_LOGS:-}" ] && kill "$RUNNER_LOGS" 2>/dev/null
  [ -n "${PAGES_PID:-}" ] && kill "$PAGES_PID" 2>/dev/null
  for f in apiserver.log link-gateway.log link-tls.log tls.log migrate.log fake-model.jsonl fake-model.out; do
    [ -f "$S/logs/$f" ] && cp "$S/logs/$f" "$LOGS/"
  done
  for f in console.log create.log; do [ -f "$LAB_DIR/logs/$f" ] && cp "$LAB_DIR/logs/$f" "$LOGS/vm-$f"; done
  if [ -f "$LAB_KUBECONFIG" ] && vm_running; then
    lab_kubectl get pods -A -o wide > "$LOGS/pods.txt" 2>&1
    K describe pods > "$LOGS/pods-describe.txt" 2>&1
    [ -n "${POD:-}" ] && K logs "$POD" -c runner > "$LOGS/runner-final.log" 2>&1
  fi
  { free -m; df -h; } > "$LOGS/host.txt" 2>&1
  # What systemd and the kernel saw of the lab's units (a unit that would not start, an OOM kill).
  journalctl --no-pager -b -o short-iso -u 'orbit-mr-lab*' > "$LOGS/journal-units.txt" 2>&1
  journalctl --no-pager -b -o short-iso -n 600 > "$LOGS/journal.txt" 2>&1
  dmesg -T 2>/dev/null | tail -n 200 > "$LOGS/dmesg.txt"
  # The host's way into the VM, as the lab's scripts take it, with ssh's own account of it.
  if vm_running; then
    { qemu-system-x86_64 --version | head -1; ssh -V; ss -Hltnp | grep -E ":(${LAB_SSH_PORT}|${LAB_API_PORT}) " || true
      timeout 30 ssh -vvv -i "$LAB_SSH_KEY" -p "$LAB_SSH_PORT" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 \
        -o UserKnownHostsFile="$LAB_DIR/ssh/known_hosts" -o StrictHostKeyChecking=accept-new ubuntu@127.0.0.1 true; echo "ssh exit $?"
    } > "$LOGS/vm-ssh.txt" 2>&1
  fi
  docker rm -f orbit-mr-lab-web-nginx >/dev/null 2>&1
  python3 "$L/login-lab.py" gate stop >/dev/null 2>&1
  "$L/stop.sh" >/dev/null 2>&1
  "$SC/link.sh" stop
  "$L/test-server.sh" stop >/dev/null 2>&1
  set -e
}

# ---- in the runner container --------------------------------------------------------------------
in_pod() { K exec "$POD" -c runner -- sh -c "$1"; }
chrome_count() { in_pod 'ps -eo comm | grep -ciE "^chrom" || true' 2>/dev/null | tail -1; }
profile_present() { in_pod "test -e $PROFILE_DIR"; }
# The remote Chrome's page targets, "url | title" per line, as DevTools in the Pod lists them.
cdp_pages() {
  in_pod "node -e \"fetch('http://127.0.0.1:9222/json/list').then(r=>r.json()).then(l=>{for(const t of l)if(t.type==='page')console.log(t.url+' | '+t.title)}).catch(e=>console.log('no DevTools: '+e.message))\""
}
# mcp_has TOOL ENV...: whether `orbit mcp` in the runner container lists TOOL under that environment.
mcp_has() {
  local tool=$1; shift
  in_pod "printf '%s\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}' '{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}' | env $* orbit mcp 2>/dev/null" \
    | python3 -c 'import json,sys
for line in sys.stdin:
    m = json.loads(line)
    if m.get("id") == 2:
        names = [t["name"] for t in m["result"]["tools"]]
        print(len(names), "tools;", sys.argv[1], "listed:", sys.argv[1] in names)
        sys.exit(0 if sys.argv[1] in names else 1)
sys.exit(2)' "$tool"
}
# mcp_lacks TOOL ENV...: `orbit mcp` answered the list, and TOOL is not in it.
mcp_lacks() { local rc=0; mcp_has "$@" || rc=$?; [ "$rc" = 1 ]; }

# ---- the owner and the sessions -----------------------------------------------------------------
owner_get() { curl -s -H "Authorization: Bearer $ORBIT_ACCESS_TOKEN" "$API$1"; }
owner_post() { curl -s -X POST -H "Authorization: Bearer $ORBIT_ACCESS_TOKEN" -H 'Content-Type: application/json' -d "$2" "$API$1"; }
browser_state() { owner_get "/runners/$RUNNER/browser"; echo; }
# json_field FIELD: one field of the JSON object on stdin ("" when absent).
json_field() { python3 -c 'import json,sys
try: v = json.load(sys.stdin).get(sys.argv[1])
except Exception: v = None
print("" if v is None else json.dumps(v) if isinstance(v, (dict, list, bool)) else v)' "$1"; }

# session PROVIDER FOLDER TITLE PROMPT: a session on erin's runner; waits until its turn ends.
session() { python3 "$SC/session.py" "$@"; }
# session_id LOG: the id session.py printed.
session_id() { sed -n 's/^POST \/sessions 20[01] {.id.: .\([A-Za-z0-9]*\).*/\1/p' "$1" | head -1; }
# last_tool_result TOOL: the newest result of TOOL that the fake model was sent, as {"isError", "text"}.
last_tool_result() {
  python3 - "$S/logs/fake-model.jsonl" "mcp__orbit__$1" <<'PY'
import json, sys
last = None
for line in open(sys.argv[1]):
    r = json.loads(line)
    for t in r.get('toolResults') or []:
        if t['name'] == sys.argv[2]:
            last = t
print(json.dumps({'isError': last['isError'], 'text': last['text']} if last else {}))
PY
}

# serve_pages DIR: DIR on the host at http://10.0.2.2:$PAGES_PORT (from the Pods).
serve_pages() {
  (cd "$1" && exec python3 -m http.server "$PAGES_PORT" --bind 127.0.0.1 > "$LOGS/pages.log" 2>&1) &
  PAGES_PID=$!
  sleep 1
}

# serve_web: the web build behind the web image's own nginx.conf, on 127.0.0.1:$WEB_PORT.
serve_web() {
  sed -e "s/server apiserver:3000 max_fails=0;/server 127.0.0.1:$LAB_TEST_API_PORT max_fails=0;/" \
      -e "s#http://apiserver:3000#http://127.0.0.1:$LAB_TEST_API_PORT#g" \
      -e "s/^    listen 80;/    listen 127.0.0.1:$WEB_PORT;/" -e '/listen  \[::\]:80;/d' \
      "$R/src/web/nginx.conf" > "$LOGS/web-nginx.conf"
  docker rm -f orbit-mr-lab-web-nginx >/dev/null 2>&1 || true
  docker run -d --name orbit-mr-lab-web-nginx --network host --memory 64m \
    -v "$LOGS/web-nginx.conf:/etc/nginx/conf.d/default.conf:ro" -v "$R/src/web/dist:/usr/share/nginx/html:ro" nginx:alpine >/dev/null
  sleep 2
}
