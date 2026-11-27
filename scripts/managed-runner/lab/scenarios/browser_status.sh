# browser_status and `orbit browser status` (task 350AnMRp3HcHFFmwOc2tk), switch on. Sourced by run.sh once the lab is up.
#   1. session H's turn navigates the runner's Chrome (taking the browser lease) and the fake model holds the answer to
#      that tool result open (FAKE-HOLD), so H's turn, and the lease, last;
#   2. meanwhile session S's turn calls mcp__orbit__browser_status: running, H holds the lease, saved logins only as a
#      yes/no;
#   3. `orbit browser status --json` in the runner container as S says the same; with ORBIT_BROWSER unset the command
#      is unknown, and `orbit mcp` lists browser_status only with ORBIT_BROWSER=on;
#   4. no site name or cookie in any log.
# lab-browser: on

step "1. session H takes the browser and holds its turn"
session "$SLUG" status-holder-$(date -u +%H%M%S) "Browser status: the holder" \
  "Hold the browser. FAKE-NAV data:text/html,T-STATUS-PAGE HOLD FAKE-HOLD 150" > "$OUT/holder.log" 2>&1 &
HOLDER=$!
H=
for _ in $(seq 60); do H=$(session_id "$OUT/holder.log"); [ -n "$H" ] && break; sleep 2; done
[ -n "$H" ] || { cat "$OUT/holder.log"; abort "session H was made"; }
echo "session H: $H"
for _ in $(seq 60); do [ "$(chrome_count)" -gt 0 ] && break; sleep 3; done
check "Chrome runs in the runner container once H navigated" test "$(chrome_count)" -gt 0
sleep 40  # at least one heartbeat after the navigation, which is what the status reads

step "2. session S reads the status while H holds the browser"
session "$SLUG" status-reader-$(date -u +%H%M%S) "Browser status: the reader" \
  "Read the browser's status. FAKE-BSTATUS READ" > "$OUT/reader.log" 2>&1 || { cat "$OUT/reader.log"; abort "session S ran"; }
S_ID=$(session_id "$OUT/reader.log")
echo "session S: $S_ID"
last_tool_result browser_status > "$OUT/tool-result.json"
echo "--- browser_status's result, as the fake model was sent it"; cat "$OUT/tool-result.json"; echo
TOOL=$(json_field text < "$OUT/tool-result.json")
check_eq "the tool answered without an error" "$(json_field isError < "$OUT/tool-result.json")" false
check_eq "the tool: enabled" "$(json_field enabled <<<"$TOOL")" true
check_eq "the tool: running" "$(json_field running <<<"$TOOL")" true
check_eq "the tool: the runner" "$(json_field runnerId <<<"$TOOL")" "$RUNNER"
check_eq "the tool: H holds the lease" "$(json_field holderSessionId <<<"$TOOL")" "$H"
check "the tool: viewers is a count" python3 -c 'import json,sys;assert isinstance(json.loads(sys.argv[1])["viewers"], int)' "$TOOL"
check "the tool: saved logins only as yes or no" python3 -c 'import json,sys;assert isinstance(json.loads(sys.argv[1])["savedLogins"], bool)' "$TOOL"

step "3. the CLI and orbit mcp in the runner container, as S"
CLI=$(in_pod "env ORBIT_BROWSER=on ORBIT_SESSION_ID=$S_ID orbit browser status --json" || true)
echo "--- ORBIT_BROWSER=on orbit browser status --json"; echo "$CLI"
check_eq "the command: running" "$(json_field running <<<"$CLI")" true
check_eq "the command: H holds the lease" "$(json_field holderSessionId <<<"$CLI")" "$H"
OFF=$(in_pod "env -u ORBIT_BROWSER ORBIT_SESSION_ID=$S_ID orbit browser status > /tmp/bs.out 2>&1; echo \"exit \$?: \$(head -1 /tmp/bs.out)\"" || true)
echo "--- with ORBIT_BROWSER unset: $OFF"
check "with ORBIT_BROWSER unset, orbit browser is an unknown command" grep -q 'unknown command' <<<"$OFF"
check "orbit mcp lists browser_status with ORBIT_BROWSER=on" mcp_has browser_status ORBIT_BROWSER=on ORBIT_SESSION_ID=$S_ID
check "orbit mcp lists no browser_status with ORBIT_BROWSER=off" mcp_lacks browser_status ORBIT_BROWSER=off ORBIT_SESSION_ID=$S_ID

step "waiting for H's turn to end"
wait "$HOLDER" || true
tail -3 "$OUT/holder.log" | cut -c1-300

step "4. site names and cookies in the logs (must be none)"
for f in "$LOGS/runner.log" "$S/logs/apiserver.log" "$S/logs/link-gateway.log"; do
  check "no page name or cookie in $(basename "$f")" test "$(grep -ciE 'T-STATUS-PAGE|cookie' "$f" || true)" = 0
done
