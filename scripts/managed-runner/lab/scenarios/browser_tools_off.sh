# The four browser tools with the browser switch ABSENT (task 350AnMXxrSeMsxMPs2mk2): none is offered. Sourced by run.sh
# once the lab is up.
#   1. api.env has no ORBIT_MANAGED_RUNNER_BROWSER_ENABLED line, and the runner container has no Chrome;
#   2. `orbit mcp` in the runner container, as a session of the account would run it, lists none of browser_status,
#      browser_open, browser_clear_logins, browser_request_sign_in; the tool list is printed;
#   3. a session's turn (FAKE-SH) runs `orbit browser <command>` for each of the four: every one is an unknown command.
# lab-browser: off

step "1. the switch is absent, nothing runs"
check "api.env has no browser switch line" test "$(grep -c '^ORBIT_MANAGED_RUNNER_BROWSER_ENABLED' "$S/secrets/api.env" || true)" = 0
check_eq "no Chrome in the runner container" "$(chrome_count)" 0

step "2. orbit mcp's tool list, with ORBIT_BROWSER unset as the runner leaves it"
LIST=$(in_pod "printf '%s\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}' '{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}' | env -u ORBIT_BROWSER ORBIT_MANAGED_RUNNER_GENERATION=1 orbit mcp 2>/dev/null" \
  | python3 -c 'import json,sys
for line in sys.stdin:
    m = json.loads(line)
    if m.get("id") == 2:
        print("\n".join(sorted(t["name"] for t in m["result"]["tools"])))')
echo "--- tools/list ($(wc -l <<<"$LIST") tools)"; echo "$LIST" | tee "$OUT/tool-list.txt" | head -80
check "the list is not empty" test -n "$LIST"
for tool in browser_status browser_open browser_clear_logins browser_request_sign_in; do
  check "$tool is not in the tool list" test "$(grep -cxF "$tool" <<<"$LIST" || true)" = 0
done
check "the list still has other orbit tools" grep -q '^task_get$' <<<"$LIST"

step "3. orbit browser <command> in a session's turn: unknown for all four"
COMMAND='for c in status open clear-logins request-sign-in; do out=$(orbit browser $c 2>&1 | head -1); echo "browser $c: $out"; done'
session "$SLUG" off-$(date -u +%H%M%S) "Browser tools, switch absent" \
  "Try the browser commands. FAKE-SH $(printf '%s' "$COMMAND" | base64 -w0) OFF" > "$OUT/session.log" 2>&1 \
  || { cat "$OUT/session.log"; abort "the session ran"; }
python3 - "$S/logs/fake-model.jsonl" > "$OUT/bash-off.json" <<'PY'
import json, sys
last = {}
for line in open(sys.argv[1]):
    for t in json.loads(line).get('toolResults') or []:
        if t['name'] == 'Bash':
            last = {'isError': t['isError'], 'text': t['text']}
print(json.dumps(last))
PY
echo "--- the Bash tool's result"; cat "$OUT/bash-off.json"
TEXT=$(json_field text < "$OUT/bash-off.json")
for c in status open clear-logins request-sign-in; do
  check "orbit browser $c is an unknown command" grep -q "^browser $c: unknown command" <<<"$TEXT"
done
