# A command-line tool's sign-in page opens in the Orbit Cloud browser (task 350B7GkI4U7T9yZnUSTQ9), switch on. Sourced
# by run.sh once the lab is up. The tool is cli-sign-in/lab-cli-login.mjs, a sign-in with a localhost callback that needs
# no real account: its provider is cli-sign-in/authorize.html, served from the host.
#   0. the browser is stopped;
#   1. a Claude Code session's turn runs the tool in its Bash (FAKE-SH), which opens the sign-in page through $BROWSER:
#      the opener starts Chrome, the page is a tab of the runner's Chrome, and the opener's one line names only the
#      host; the turn then calls browser_request_sign_in for that site (FAKE-SIGNIN);
#   2. the owner's card; Open browser shows the provider's page in control through the viewer; the owner clicks Sign
#      in on the viewer; the provider redirects to http://127.0.0.1:PORT/callback, which reaches the tool in the
#      runner, and the remote page says signed in (browser-sign-in-shots.mjs with CLICK_TO_TITLE);
#   3. the tool got its callback and exited 0;
#   4. the owner answers I'm signed in; browser_request_sign_in answers SIGNED_IN to the turn;
#   5. another session's tool opens its page through `xdg-open` from PATH, and its callback completes too;
#   6. the sign-in's state and code in no Orbit log.
# lab-browser: on

PAGES=$OUT/pages
PROVIDER=http://10.0.2.2:$PAGES_PORT
SITE=10.0.2.2:$PAGES_PORT
OPENER_DIR=/home/orbit/.orbit/browser-opener
PROVIDER_TITLE="Lab OAuth: sign in"
SIGNED_IN_TITLE="Lab CLI: signed in"
mkdir -p "$PAGES"
cp "$L/cli-sign-in/authorize.html" "$PAGES/"
serve_pages "$PAGES"
serve_web
K exec -i "$POD" -c runner -- sh -c 'cat > /tmp/lab-cli-login.mjs' < "$L/cli-sign-in/lab-cli-login.mjs" \
  || abort "the lab CLI was copied into the runner container"
K exec -i "$POD" -c runner -- sh -c 'cat > /tmp/lab-click-sign-in.mjs' < "$L/cli-sign-in/click-sign-in.mjs" \
  || abort "the lab's DevTools click was copied into the runner container"

# cli_command MODE: the Bash command a turn runs: the tool in the background (it waits for its callback past the
# command), then what it and the shell said once its opener has returned.
cli_command() {
  cat <<SH
rm -f /tmp/lab-cli-$1.result; setsid nohup node /tmp/lab-cli-login.mjs $1 $PROVIDER /tmp/lab-cli-$1.result > /tmp/lab-cli-$1.log 2>&1 < /dev/null &
for i in \$(seq 150); do grep -qE 'opener exited|did not start' /tmp/lab-cli-$1.log && break; sleep 1; done
cat /tmp/lab-cli-$1.log; echo "BROWSER=\$BROWSER"; echo "xdg-open=\$(command -v xdg-open)"
SH
}
b64() { base64 -w0; }
# bash_results: every result of the Bash tool the fake model was sent, in order, one JSON per line.
bash_results() {
  python3 - "$S/logs/fake-model.jsonl" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    r = json.loads(line)
    for t in r.get('toolResults') or []:
        if t['name'] == 'Bash':
            print(json.dumps({'isError': t['isError'], 'text': t['text']}))
PY
}
open_request() {
  owner_get '/owner-requests?state=open' | python3 -c 'import json,sys
for r in json.load(sys.stdin).get("requests", []):
    if r["kind"] == "BROWSER_SIGN_IN": print(r["id"]); break'
}
# remote_click_sign_in: the provider page's button pressed in the remote Chrome, through DevTools in the Pod.
remote_click_sign_in() { in_pod "node /tmp/lab-click-sign-in.mjs '$PROVIDER_TITLE'"; }

step "0. the browser is stopped"
echo "--- the owner's GET /runners/:id/browser: $(browser_state)"
check_eq "no Chrome in the runner container before the tool" "$(chrome_count)" 0

step "1. a session's turn runs the CLI sign-in through \$BROWSER, then asks the owner"
: > "$OUT/asker.log"   # read below while the session's turn, run in the background, still writes it
session "$SLUG" cli-sign-in-$(date -u +%H%M%S) "Sign the lab CLI in" \
  "Sign the lab CLI in. FAKE-SH $(cli_command browser | b64) CLI FAKE-SIGNIN $SITE SIGNIN" > "$OUT/asker.log" 2>&1 &
ASKER=$!
SID=
for _ in $(seq 90); do SID=$(session_id "$OUT/asker.log"); [ -n "$SID" ] && break; sleep 2; done
[ -n "$SID" ] || { cat "$OUT/asker.log"; abort "the session was made"; }
echo "session: $SID"
REQ=
for _ in $(seq 150); do REQ=$(open_request); [ -n "$REQ" ] && break; sleep 2; done
bash_results | head -1 > "$OUT/bash-browser.json"
echo "--- the Bash tool's result, as the fake model was sent it"; cat "$OUT/bash-browser.json"
BASH_TEXT=$(json_field text < "$OUT/bash-browser.json")
check "the shell's BROWSER is the opener" grep -qxF "BROWSER=$OPENER_DIR/orbit-browser" <<<"$BASH_TEXT"
check "the shell's xdg-open is the opener's" grep -qxF "xdg-open=$OPENER_DIR/xdg-open" <<<"$BASH_TEXT"
check "the opener said the page opened in the Orbit Cloud browser, naming the site" \
  grep -qF "Opened a page of $SITE in the Orbit Cloud browser" <<<"$BASH_TEXT"
check "the opener told the agent to call browser_request_sign_in" grep -qF "browser_request_sign_in with site $SITE" <<<"$BASH_TEXT"
check "the opener exited 0" grep -qxF "lab-cli: the opener exited 0" <<<"$BASH_TEXT"
check "no state, code or path of the sign-in address in the shell's output" \
  test "$(grep -ciE 'LABSTATE|LABSECRET|authorize\.html|redirect_uri' <<<"$BASH_TEXT" || true)" = 0
echo "--- the remote Chrome's pages (DevTools in the Pod)"; cdp_pages | tee "$OUT/pages-after-cli.txt"
check "Chrome started in the runner container" test "$(chrome_count)" -gt 0
check "the provider's sign-in page is a tab of the remote Chrome" grep -qF "| $PROVIDER_TITLE" "$OUT/pages-after-cli.txt"
check "the sign-in card was raised" test -n "$REQ"
[ -n "$REQ" ] || abort "the sign-in card was raised"
owner_get "/owner-requests/$REQ" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(json.dumps({k:d.get(k) for k in ("id","kind","state","title","why","browserSite","askedBySessionId")},indent=1))' \
  | tee "$OUT/card.json"
check_eq "the card names the CLI's site" "$(json_field browserSite < "$OUT/card.json")" "$SITE"

step "2. the owner opens the card, sees the page in control through the viewer, and signs in there"
export IN_POD
IN_POD=$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1:]))' env -u KUBECONFIG "$LAB_KUBECTL" --kubeconfig "$LAB_KUBECONFIG" \
  --context "$LAB_NAME" -n "$NS" exec -i "$POD" -c runner --)
SHOTS=0
(cd "$R" && CLICK_TO_TITLE="$SIGNED_IN_TITLE" node "$L/browser-sign-in-shots.mjs" "http://127.0.0.1:$WEB_PORT" "$SITE" "$OUT" > "$OUT/shots.json") || SHOTS=$?
cat "$OUT/shots.json"
check "the card was shot in Waiting on you (01-sign-in-card.png)" test -s "$OUT/01-sign-in-card.png"
check "Open browser showed the provider's page in control through the viewer (02-browser-tab-in-control.png)" \
  test -s "$OUT/02-browser-tab-in-control.png"
check "the owner's click on the viewer signed in: the remote page is the tool's callback (03-after-owner-sign-in.png)" \
  test "$SHOTS" = 0 -a -s "$OUT/03-after-owner-sign-in.png"
cdp_pages | tee "$OUT/pages-after-owner.txt"
check "the remote Chrome shows the localhost callback's page" grep -qE "^http://127\.0\.0\.1:[0-9]+/callback\?.* \| $SIGNED_IN_TITLE\$" "$OUT/pages-after-owner.txt"

step "3. the CLI got its localhost callback"
in_pod 'cat /tmp/lab-cli-browser.log; echo "result: $(cat /tmp/lab-cli-browser.result 2>/dev/null)"' | tee "$OUT/cli-browser.txt" || true
check "the CLI recorded the sign-in" grep -qxF "result: SIGNED-IN" "$OUT/cli-browser.txt"
check "the CLI said it signed in through the localhost callback" grep -qxF "lab-cli: signed in through the localhost callback" "$OUT/cli-browser.txt"

step "4. the owner answers I'm signed in; the tool reports it to the turn"
echo "--- POST /owner-requests/$REQ/done: $(owner_post "/owner-requests/$REQ/done" '{}' | head -c 200)"
wait "$ASKER" || true
sleep 10
session --wait "$SID" >> "$OUT/asker.log" 2>&1 || true
last_tool_result browser_request_sign_in > "$OUT/sign-in-result.json"
echo "--- browser_request_sign_in's result"; cat "$OUT/sign-in-result.json"; echo
check_eq "browser_request_sign_in answered without an error" "$(json_field isError < "$OUT/sign-in-result.json")" false
check_eq "browser_request_sign_in answered SIGNED_IN" "$(json_field text < "$OUT/sign-in-result.json" | json_field answer)" SIGNED_IN

step "5. another session's CLI opens its page through xdg-open"
session "$SLUG" cli-xdg-$(date -u +%H%M%S) "Sign the lab CLI in through xdg-open" \
  "Sign the lab CLI in. FAKE-SH $(cli_command xdg | b64) XDG" > "$OUT/xdg.log" 2>&1 || true
bash_results | tail -1 > "$OUT/bash-xdg.json"
echo "--- the Bash tool's result"; cat "$OUT/bash-xdg.json"
XDG_TEXT=$(json_field text < "$OUT/bash-xdg.json")
check "xdg-open from PATH reached the opener" grep -qF "Opened a page of $SITE in the Orbit Cloud browser" <<<"$XDG_TEXT"
for _ in $(seq 20); do cdp_pages | grep -qF "| $PROVIDER_TITLE" && break; sleep 2; done
remote_click_sign_in | tee "$OUT/xdg-click.txt" || true
for _ in $(seq 20); do in_pod 'cat /tmp/lab-cli-xdg.result 2>/dev/null' | grep -q SIGNED-IN && break; sleep 2; done
in_pod 'cat /tmp/lab-cli-xdg.log; echo "result: $(cat /tmp/lab-cli-xdg.result 2>/dev/null)"' | tee "$OUT/cli-xdg.txt" || true
check "the xdg-open CLI got its localhost callback" grep -qxF "result: SIGNED-IN" "$OUT/cli-xdg.txt"

step "6. the sign-in's state, code and challenge in Orbit's logs (must be none)"
for f in "$LOGS/runner.log" "$S/logs/apiserver.log" "$S/logs/link-gateway.log"; do
  check "no state, code or challenge in $(basename "$f")" test "$(grep -ciE 'LABSTATE|LABCODE|LABSECRET|redirect_uri' "$f" || true)" = 0
done
