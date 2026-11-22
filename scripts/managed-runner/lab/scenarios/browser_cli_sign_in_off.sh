# The CLI sign-in opener with the browser switch OFF (task 350B7GkI4U7T9yZnUSTQ9): nothing is redirected. Sourced by
# run.sh once the lab is up.
#   1. a Claude Code session's turn (FAKE-SH) runs the lab CLI through $BROWSER and prints the shell's BROWSER and
#      xdg-open: no BROWSER, no opener's xdg-open, so the CLI has nothing to open its page with;
#   2. the runner container has no opener directory and no Chrome.
# lab-browser: off

OPENER_DIR=/home/orbit/.orbit/browser-opener
K exec -i "$POD" -c runner -- sh -c 'cat > /tmp/lab-cli-login.mjs' < "$L/cli-sign-in/lab-cli-login.mjs" \
  || abort "the lab CLI was copied into the runner container"
COMMAND='timeout 20 node /tmp/lab-cli-login.mjs browser http://10.0.2.2:13791 /tmp/lab-cli-off.result; echo "cli exit $?"
echo "BROWSER=${BROWSER-unset}"; echo "xdg-open=$(command -v xdg-open || echo none)"'

step "1. a session's turn runs the CLI sign-in with the switch off"
session "$SLUG" cli-off-$(date -u +%H%M%S) "Sign the lab CLI in, switch off" \
  "Sign the lab CLI in. FAKE-SH $(printf '%s' "$COMMAND" | base64 -w0) OFF" > "$OUT/session.log" 2>&1 \
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
check "the shell has no BROWSER" grep -qxF "BROWSER=unset" <<<"$TEXT"
check "the shell's xdg-open is not the opener's" test "$(grep -c "^xdg-open=$OPENER_DIR" <<<"$TEXT" || true)" = 0
check "the CLI found no browser to open its page with" grep -qxF "lab-cli: no BROWSER to open the sign-in page with" <<<"$TEXT"
check "nothing said a page opened in the Orbit Cloud browser" test "$(grep -c 'Orbit Cloud browser' <<<"$TEXT" || true)" = 0

step "2. the runner container: no opener, no Chrome"
check "no opener directory in the runner container" in_pod "test ! -e $OPENER_DIR"
check_eq "no Chrome in the runner container" "$(chrome_count)" 0
