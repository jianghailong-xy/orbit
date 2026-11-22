# browser_open and `orbit browser open [--url]` (task 350AnMTy4jnt1470JHE6T), switch on. Sourced by run.sh once the
# lab is up. Needs the fake model's FAKE-BOPEN and browser-open-shots.mjs, which come with that task's work.
#   0. the browser is stopped: no Chrome in the runner container, the owner's GET /runners/:id/browser not RUNNING;
#   1. a session S on the fake model calls mcp__orbit__browser_open with the url of a page served from the host; the
#      tool's result names the tab; Chrome is now running and shows that page (DevTools, from inside the Pod); the tab
#      the tool answered, opened in headless Chromium as the owner, goes live on the viewer and is shot (open-tool.png);
#   2. `orbit browser open --url <second page>` in the runner container as S: no opener there, so it prints the tab's
#      address; the remote Chrome shows the second page; shot through the viewer again (open-cli.png);
#   3. with ORBIT_BROWSER unset, `orbit browser open` is an unknown command and orbit mcp lists no browser_open;
#   4. the pages' addresses and contents in no log.
# lab-browser: on

EXPECT_TITLE_ONE="Orbit open check"
EXPECT_TITLE_TWO="Orbit open check two"

mkdir -p "$OUT/pages"
printf '%s' "<!doctype html><meta charset=\"utf-8\"><title>$EXPECT_TITLE_ONE</title><body style=\"font:28px sans-serif;margin:60px;background:#e8f4ff\"><h1>T-OPEN-ONE</h1><p>Opened in the runner&#39;s Chrome by browser_open.</p></body>" > "$OUT/pages/open-check.html"
printf '%s' "<!doctype html><meta charset=\"utf-8\"><title>$EXPECT_TITLE_TWO</title><body style=\"font:28px sans-serif;margin:60px;background:#fff4e0\"><h1>T-OPEN-TWO</h1><p>Opened in the runner&#39;s Chrome by orbit browser open --url.</p></body>" > "$OUT/pages/second.html"
serve_pages "$OUT/pages"
serve_web

step "0. the browser is stopped"
echo "--- the owner's GET /runners/:id/browser: $(browser_state)"
check_eq "no Chrome in the runner container before the tool" "$(chrome_count)" 0
check "the owner's state is not RUNNING before the tool" test "$(browser_state | json_field state)" != RUNNING

step "1. session S calls browser_open with a url"
session "$SLUG" browser-open-$(date -u +%H%M%S) "Browser open: the tool" \
  "Open the browser on the check page. FAKE-BOPEN http://10.0.2.2:$PAGES_PORT/open-check.html OPEN" > "$OUT/session.log" 2>&1 \
  || { cat "$OUT/session.log"; abort "session S ran"; }
SID=$(session_id "$OUT/session.log")
echo "session S: $SID"
last_tool_result browser_open > "$OUT/tool-result.json"
echo "--- browser_open's result, as the fake model was sent it"; cat "$OUT/tool-result.json"; echo
TOOL=$(json_field text < "$OUT/tool-result.json")
check_eq "the tool answered without an error" "$(json_field isError < "$OUT/tool-result.json")" false
TAB_PATH=$(python3 -c 'import json,sys,urllib.parse as u
try: print(u.urlparse(json.loads(sys.argv[1]).get("tabUrl") or "").path)
except Exception: print("")' "$TOOL")
check_eq "the tool names the browser tab" "$TAB_PATH" "/runners/$RUNNER/browser"
check_eq "the tool: running" "$(json_field running <<<"$TOOL")" true
for _ in $(seq 30); do cdp_pages | grep -qF "$EXPECT_TITLE_ONE" && break; sleep 2; done
echo "--- the remote Chrome's pages (DevTools in the Pod)"; cdp_pages | tee "$OUT/pages-after-tool.txt"
check "Chrome started in the runner container" test "$(chrome_count)" -gt 0
check "the remote Chrome shows the tool's page" grep -qxF "http://10.0.2.2:$PAGES_PORT/open-check.html | $EXPECT_TITLE_ONE" "$OUT/pages-after-tool.txt"
sleep 35  # a heartbeat after the start, which the owner's state reads
echo "--- the owner's GET /runners/:id/browser: $(browser_state)"
check_eq "the owner's state is RUNNING after the tool" "$(browser_state | json_field state)" RUNNING
echo "--- the tab the tool answered, opened as the owner"
(cd "$R" && node "$L/browser-open-shots.mjs" "http://127.0.0.1:$WEB_PORT" "${TAB_PATH:-/}" "$OUT" open-tool) | tee "$OUT/open-tool.json" || true
check "the tab went live on the viewer and was shot (open-tool.png)" test -s "$OUT/open-tool.png"

step "2. orbit browser open --url in the runner container, as S"
in_pod "env ORBIT_BROWSER=on ORBIT_SESSION_ID=$SID orbit browser open --url http://10.0.2.2:$PAGES_PORT/second.html; echo \"(exit \$?)\"" \
  | tee "$OUT/cli-open.txt" || true
check "the command printed the tab's address" grep -qF "/runners/$RUNNER/browser" "$OUT/cli-open.txt"
check "the command exited 0" grep -qxF "(exit 0)" "$OUT/cli-open.txt"
for _ in $(seq 30); do cdp_pages | grep -qF "$EXPECT_TITLE_TWO" && break; sleep 2; done
echo "--- the remote Chrome's pages (DevTools in the Pod)"; cdp_pages | tee "$OUT/pages-after-cli.txt"
check "the remote Chrome shows the command's page" grep -qxF "http://10.0.2.2:$PAGES_PORT/second.html | $EXPECT_TITLE_TWO" "$OUT/pages-after-cli.txt"
(cd "$R" && node "$L/browser-open-shots.mjs" "http://127.0.0.1:$WEB_PORT" "${TAB_PATH:-/}" "$OUT" open-cli) | tee "$OUT/open-cli.json" || true
check "the tab was shot again (open-cli.png)" test -s "$OUT/open-cli.png"

step "3. with ORBIT_BROWSER unset"
OFF=$(in_pod "env -u ORBIT_BROWSER ORBIT_SESSION_ID=$SID orbit browser open --url http://10.0.2.2:$PAGES_PORT/second.html > /tmp/bo.out 2>&1; echo \"exit \$?: \$(head -1 /tmp/bo.out)\"" || true)
echo "--- $OFF"
check "with ORBIT_BROWSER unset, orbit browser is an unknown command" grep -q 'unknown command' <<<"$OFF"
check "orbit mcp lists browser_open with ORBIT_BROWSER=on" mcp_has browser_open ORBIT_BROWSER=on ORBIT_SESSION_ID=$SID
check "orbit mcp lists no browser_open with ORBIT_BROWSER=off" mcp_lacks browser_open ORBIT_BROWSER=off ORBIT_SESSION_ID=$SID

step "4. the pages' addresses and contents in the logs (must be none)"
for f in "$LOGS/runner.log" "$S/logs/apiserver.log" "$S/logs/link-gateway.log"; do
  check "no page address or content in $(basename "$f")" test "$(grep -ciE "open-check|second\.html|T-OPEN|$PAGES_PORT" "$f" || true)" = 0
done
