# browser_clear_logins behind the owner's card (task 350AnMV2ZQ7bsukmUPn9Z), switch on. Sourced by run.sh once the lab
# is up. Needs the fake model's FAKE-BCLEAR, which comes with that task's work.
#   1. session S's turn navigates the runner's Chrome (FAKE-NAV): the profile directory exists;
#   2. a session's turn calls browser_clear_logins (FAKE-BCLEAR); the owner's card appears and the owner DECLINES it;
#      the tool answers DECLINED, and after the next beats Chrome runs on and the profile directory is still there;
#   3. another session's turn calls it; the owner CONFIRMS; the tool answers CONFIRMED, the runner reports the clear
#      (profileClearedAt) and the profile directory is gone;
#   4. no site name or cookie in any log.
# The call is made by a session's turn, as an agent makes it: a card filed outside any turn or runner-hosted job is read
# by nobody, so the owner's PENDING list leaves it out and the reaper expires it (sessions.service.ts stillBeingAsked).
# lab-browser: on

# The session's pending orbit_browser_clear_logins card, waited for; prints its id.
pending_card() {
  local sid=$1 id=
  for _ in $(seq 60); do
    id=$(owner_get "/sessions/$sid/approvals?status=PENDING&toolName=orbit_browser_clear_logins" | python3 -c '
import json,sys
try: d = json.load(sys.stdin)
except Exception: d = []
rows = d if isinstance(d, list) else d.get("approvals", d.get("items", []))
print(rows[0]["id"] if rows else "")')
    [ -n "$id" ] && break; sleep 2
  done
  [ -n "$id" ] || return 1
  echo "$id"
}
show_card() {
  owner_get "/sessions/$1/approvals?toolName=orbit_browser_clear_logins" | python3 -c '
import json,sys
d = json.load(sys.stdin); rows = d if isinstance(d, list) else d.get("approvals", d.get("items", []))
for r in rows:
    if r["id"] == sys.argv[1]: print("card", r["id"], r["status"], r["toolName"]); print("  copy:", r["input"].get("description")); print("  runner:", r["input"].get("runnerName"))' "$2"
}
# ask_in_turn NAME WORD: a session whose turn calls browser_clear_logins, left running; sets SID and ASKER.
ask_in_turn() {
  session "$SLUG" clear-$1-$(date -u +%H%M%S) "Browser clear logins: $1" "Clear the saved logins. FAKE-BCLEAR $2" > "$OUT/$1.log" 2>&1 &
  ASKER=$!; SID=
  for _ in $(seq 90); do SID=$(session_id "$OUT/$1.log"); [ -n "$SID" ] && break; sleep 2; done
  [ -n "$SID" ] || { cat "$OUT/$1.log"; abort "session $1 was made"; }
  echo "session $1: $SID"
}
# tool_answer SID: the outcome browser_clear_logins answered the turn, from the session's saved events.
tool_answer() {
  python3 - "$SESSIONS/$1.json" <<'PY'
import json, re, sys
d = json.load(open(sys.argv[1]))
for e in d['events']:
    m = re.search(r'\\*"outcome\\*":\s*\\*"(CONFIRMED|DECLINED|EXPIRED)', json.dumps(e.get('payload', e)))
    if m:
        print(m.group(1)); sys.exit(0)
print('NONE')
PY
}
# answer_card NAME BEHAVIOR: the owner answers the pending card of the asking session, then the turn is waited for.
answer_card() {
  local card
  card=$(pending_card "$SID") || abort "the owner's card appeared ($1)"
  check "the owner's card appeared ($1)" true
  show_card "$SID" "$card"
  echo "--- the owner answers $2: $(owner_post "/sessions/$SID/approvals/$card/decision" "{\"behavior\":\"$2\"}" | head -c 200)"
  wait "$ASKER" || true
  sleep 10
  # session.py stops waiting once the session leaves RUNNING, which the card does: wait again for the answered turn.
  session --wait "$SID" >> "$OUT/answers.log" 2>&1 || true
  show_card "$SID" "$card"
}

step "1. session S starts the browser"
session "$SLUG" clear-$(date -u +%H%M%S) "Browser clear logins: the asker" \
  "Open the browser. FAKE-NAV data:text/html,T-CLEAR-PAGE OPEN" > "$OUT/session.log" 2>&1 || { cat "$OUT/session.log"; abort "session S ran"; }
echo "session S: $(session_id "$OUT/session.log")"
sleep 40
echo "chrome processes: $(chrome_count)"; echo "--- state"; browser_state
profile_present || abort "the profile directory exists after a navigation"
check "the profile directory exists after a navigation" true

step "2. a session's turn calls browser_clear_logins; the owner declines"
ask_in_turn decline NO
check_eq "no clear requested before the answer" "$(browser_state | json_field clearRequestedAt)" ""
answer_card decline deny
check_eq "the tool answered the turn DECLINED" "$(tool_answer "$SID")" DECLINED
sleep 40
echo "--- after two beats:"; browser_state
check "Chrome runs on after a decline" test "$(chrome_count)" -gt 0
check "the profile directory is still there after a decline" profile_present
check_eq "nothing was cleared after a decline" "$(browser_state | json_field profileClearedAt)" ""

step "3. another session's turn calls browser_clear_logins; the owner confirms"
ask_in_turn confirm YES
answer_card confirm allow
check_eq "the tool answered the turn CONFIRMED" "$(tool_answer "$SID")" CONFIRMED
cleared=
for _ in $(seq 30); do cleared=$(browser_state | json_field profileClearedAt); [ -n "$cleared" ] && break; sleep 3; done
echo "--- state once the runner reported the clear"; browser_state
check "the runner reported the clear (profileClearedAt)" test -n "$cleared"
in_pod "ls -la /home/orbit/.orbit/browser" || true
check "the profile directory is gone after a confirm" in_pod "test ! -e $PROFILE_DIR"

step "4. site names and cookies in the logs (must be none)"
for f in "$LOGS/runner.log" "$S/logs/apiserver.log" "$S/logs/link-gateway.log"; do
  check "no page name or cookie in $(basename "$f")" test "$(grep -ciE 'T-CLEAR-PAGE|cookie' "$f" || true)" = 0
done
