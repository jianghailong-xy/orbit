# The sign-in request's banner in the browser tab (task 350AnMXBbjVsmWk8ZJUxj), switch on. Sourced by run.sh once the
# lab is up. Board docs/mocks/runner-browser/03-agent-tools.html ①, notes ④ ⑤.
#   1. session A's turn (Claude Code on the fake model) navigates the runner's Chrome to a sign-in page (FAKE-NAV), then
#      calls browser_request_sign_in (FAKE-SIGNIN) and waits; after the answer it navigates on (FAKE-NAV) and answers;
#   2. as the owner, in headless Chromium (browser-sign-in-banner-shots.mjs): the card's Open browser opens the tab in
#      control, live, on the sign-in page, with the banner above the bar; Done stops control and the card stays PENDING;
#      I'm signed in answers it DONE and the banner goes;
#   3. the tool answered the turn SIGNED_IN, and the turn carried on: its next navigation reached the remote Chrome and
#      the transcript holds that call and the turn's last answer after the sign-in result;
#   4. session B's turn asks again; the card's Not now (POST …/decline, reason "Not now", as the card sends it) answers
#      the tool NOT_NOW.
# lab-browser: on

SITE=login.lab.test
LOGIN_TITLE="Sign in to Lab Site"
AFTER_TITLE="Orbit banner after sign-in"

mkdir -p "$OUT/pages"
printf '%s' "<!doctype html><meta charset=\"utf-8\"><title>$LOGIN_TITLE</title><body style=\"font:16px sans-serif;background:#f6f8fa\"><div style=\"width:340px;margin:80px auto;padding:24px;background:#fff;border:1px solid #d0d7de;border-radius:6px\"><h2 style=\"margin-top:0\">$LOGIN_TITLE</h2><label>Username or email<br><input style=\"width:100%;padding:6px;margin:6px 0 14px\"></label><label>Password<br><input type=\"password\" style=\"width:100%;padding:6px;margin:6px 0 18px\"></label><button style=\"width:100%;padding:8px;background:#1f883d;color:#fff;border:0;border-radius:6px\">Sign in</button></div></body>" > "$OUT/pages/login.html"
printf '%s' "<!doctype html><meta charset=\"utf-8\"><title>$AFTER_TITLE</title><body style=\"font:28px sans-serif;margin:60px\"><h1>T-BANNER-AFTER</h1><p>The agent carried on after the owner signed in.</p></body>" > "$OUT/pages/after.html"
serve_pages "$OUT/pages"
serve_web
LOGIN_URL=http://10.0.2.2:$PAGES_PORT/login.html
AFTER_URL=http://10.0.2.2:$PAGES_PORT/after.html
IN_POD=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' \
  "$LAB_KUBECTL" --kubeconfig "$LAB_KUBECONFIG" --context "$LAB_NAME" -n "$NS" exec -i "$POD" -c runner --)

# open_card SID: the PENDING BROWSER_SIGN_IN request session SID filed, waited for; prints its id.
open_card() {
  local id=
  for _ in $(seq 90); do
    id=$(owner_get "/owner-requests?state=open" | python3 -c '
import json,sys
try: rows = json.load(sys.stdin).get("requests", [])
except Exception: rows = []
print(next((r["id"] for r in rows if r["kind"] == "BROWSER_SIGN_IN" and r["state"] == "PENDING" and r["askedBySessionId"] == sys.argv[1]), ""))' "$1")
    [ -n "$id" ] && break; sleep 2
  done
  [ -n "$id" ] || return 1
  echo "$id"
}
# ask_in_turn NAME PROMPT: a session whose turn is left running; sets SID and ASKER.
ask_in_turn() {
  session "$SLUG" banner-$1-$(date -u +%H%M%S) "Export the monthly report ($1)" "$2" > "$OUT/$1.log" 2>&1 &
  ASKER=$!; SID=
  for _ in $(seq 90); do SID=$(session_id "$OUT/$1.log"); [ -n "$SID" ] && break; sleep 2; done
  [ -n "$SID" ] || { cat "$OUT/$1.log"; abort "session $1 was made"; }
  echo "session $1: $SID"
}
# settle_turn: the asking turn, waited for once answered (session.py stops at AWAITING_INPUT, which the wait is).
settle_turn() {
  wait "$ASKER" || true
  sleep 10
  session --wait "$SID" >> "$OUT/answers.log" 2>&1 || true
}
signin_answer() { last_tool_result browser_request_sign_in | json_field text | json_field answer; }

step "1. session A goes to the sign-in page and asks the owner to sign in"
ask_in_turn signed-in "Export the report. FAKE-NAV $LOGIN_URL LOGIN FAKE-SIGNIN $SITE BANNER FAKE-NAV $AFTER_URL AFTER"
A=$SID
CARD=$(open_card "$A") || abort "the sign-in card appeared"
check "the sign-in card appeared" true
echo "--- the card: $(owner_get "/owner-requests/$CARD" | python3 -c 'import json,sys;d=json.load(sys.stdin);print({k:d.get(k) for k in ("kind","state","title","browserSite","browserRunnerId","askedBySessionTitle")})')"
for _ in $(seq 30); do cdp_pages | grep -qF "$LOGIN_TITLE" && break; sleep 2; done
echo "--- the remote Chrome while the agent waits"; cdp_pages | tee "$OUT/pages-waiting.txt"
check "the remote Chrome is on the sign-in page while the agent waits" grep -qF "$LOGIN_TITLE" "$OUT/pages-waiting.txt"

step "2. the owner: Open browser, Done, then I'm signed in"
(cd "$R" && IN_POD="$IN_POD" node "$L/browser-sign-in-banner-shots.mjs" "http://127.0.0.1:$WEB_PORT" "$SITE" "$OUT") \
  | tee "$OUT/banner.json" || true
shot() { python3 - "$OUT/banner.json" "$@" <<'PY'
import json, sys
r = json.load(open(sys.argv[1])); what, key = sys.argv[2], sys.argv[3]
s = next((s for s in r.get('steps', []) if s['what'].startswith(what)), {})
v = s.get(key)
print(json.dumps(v) if isinstance(v, (list, dict, bool)) else ('' if v is None else v))
PY
}
check_eq "Open browser opened the browser tab" "$(shot 'Open browser' path)" "/runners/$RUNNER/browser"
check_eq "the tab opened in control" "$(shot 'Open browser' controlling)" 1
check_eq "the banner names the site and the session" "$(shot 'Open browser' banner)" "Sign in to $SITE, asked by “Export the monthly report (signed-in)”"
check_eq "the banner's button is I'm signed in" "$(shot 'Open browser' bannerButton)" "I’m signed in"
check_eq "the banner is above the bar" "$(shot 'Open browser' bannerAboveBar)" true
check "the tab opened on the page the agent was at" grep -qF "$LOGIN_TITLE" <<<"$(shot 'Open browser' remotePages)"
check "the tab was shot with the banner (banner-in-control.png)" test -s "$OUT/banner-in-control.png"
check_eq "Done stopped control" "$(shot 'Done pressed' controlling)" 0
check_eq "after Done the banner stays" "$(shot 'Done pressed' banners)" 1
check_eq "after Done the card is still open" "$(shot 'Done pressed' requestState)" PENDING
check_eq "I'm signed in answered the card" "$(shot 'I’m signed in pressed' requestState)" DONE
check_eq "after I'm signed in the banner is gone" "$(shot 'I’m signed in pressed' banners)" 0

step "3. the agent carries on"
settle_turn
last_tool_result browser_request_sign_in > "$OUT/sign-in-result.json"
echo "--- browser_request_sign_in's result, as the model was sent it"; cat "$OUT/sign-in-result.json"; echo
check_eq "the tool answered the turn SIGNED_IN" "$(signin_answer)" SIGNED_IN
for _ in $(seq 30); do cdp_pages | grep -qF "$AFTER_TITLE" && break; sleep 2; done
echo "--- the remote Chrome after the answer"; cdp_pages | tee "$OUT/pages-after.txt"
check "the agent's next navigation reached the remote Chrome" grep -qF "$AFTER_TITLE" "$OUT/pages-after.txt"
python3 - "$SESSIONS/$A.json" "$AFTER_URL" > "$OUT/transcript-after-sign-in.txt" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); events = d['events']
dump = [json.dumps(e) for e in events]
signed = next((i for i, s in enumerate(dump) if 'SIGNED_IN' in s), None)
print('session', d.get('id', ''), 'events', len(events), 'sign-in result at', signed)
for i, (e, s) in enumerate(zip(events, dump)):
    if signed is not None and i >= signed:
        print(i, e.get('type'), s[:300])
nav = next((i for i, s in enumerate(dump) if signed is not None and i > signed and sys.argv[2] in s), None)
print('NEXT-NAVIGATION-AFTER-SIGN-IN', 'yes' if nav is not None else 'no')
PY
cat "$OUT/transcript-after-sign-in.txt" | head -40
check "the transcript holds the agent's next call after the sign-in result" grep -qx 'NEXT-NAVIGATION-AFTER-SIGN-IN yes' "$OUT/transcript-after-sign-in.txt"
STATE=$(owner_get "/sessions/$A" | json_field runStatus)
echo "--- session A's run: $STATE"
check "session A's turn ended without an error" test "$STATE" != FAILED

step "4. session B asks again; the card's Not now"
ask_in_turn not-now "Export the report. FAKE-SIGNIN $SITE NOTNOW"
CARD=$(open_card "$SID") || abort "the second sign-in card appeared"
echo "--- Not now: $(owner_post "/owner-requests/$CARD/decline" '{"reason":"Not now"}' | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("state"), d.get("resolutionNote"))')"
settle_turn
check_eq "Not now answered the tool NOT_NOW" "$(signin_answer)" NOT_NOW
