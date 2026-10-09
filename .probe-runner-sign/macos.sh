#!/usr/bin/env bash
# TEMPORARY (probe branch, never merged; task 34ckUsDB9IxmvzLjTCxWI). Takes the releases build.sh
# made on Linux and checks, on a real Mac, what the Developer ID signature changes:
#   A. what codesign reads from a binary rcodesign signed: identifier, hardened runtime, entitlements,
#      timestamp, designated requirement;
#   B. whether a requirement recorded for v0.1.900 is still met by v0.1.901 (what TCC checks a
#      stored answer against), signed and ad hoc;
#   C. both architectures run (x64 under Rosetta), the hardened runtime included;
#   D. a LaunchAgent running signed v0.1.900 updates itself to v0.1.901 from a local /dl (sha256
#      checked) and re-executes, for each architecture;
#   F. whether a .p12 that macOS exports (Security framework, as Keychain Access) is one rcodesign
#      0.29 can read. (TCC itself cannot be exercised here: SIP is off on these runners, and a
#      LaunchAgent read ~/Documents with no TCC request at all in run 37890023855.)
set -uo pipefail
DISTS="$1"
OUT="$2"
PROBE="$(cd "$(dirname "$0")" && pwd)"
D="$RUNNER_TEMP/sign-probe"
mkdir -p "$D" "$OUT"
UID_="$(id -u)"
SUMMARY="$OUT/SUMMARY.txt"
: > "$SUMMARY"
pass() { echo "PASS: $*" | tee -a "$SUMMARY"; }
fail() { echo "FAIL: $*" | tee -a "$SUMMARY"; }
note() { echo "NOTE: $*" | tee -a "$SUMMARY"; }
step() { printf '\n==== %s\n' "$*"; }
show() { printf '$ %s\n' "$*"; bash -c "$*" 2>&1; }

for set in signed-v900 signed-v901 adhoc-v900 adhoc-v901; do
  for p in darwin-arm64 darwin-x64; do
    gzip -dc "$DISTS/$set/orbit-$p.gz" > "$D/$set-$p" && chmod +x "$D/$set-$p"
  done
done
ROSETTA=no
arch -x86_64 /usr/bin/true 2>/dev/null && ROSETTA=yes

step "environment"
show "sw_vers; uname -m; id; csrutil status; echo rosetta=$ROSETTA"
show "for s in signed-v900 signed-v901 adhoc-v900 adhoc-v901; do cat $DISTS/\$s/version.json; echo; done"

step "A. the signature as codesign reads it"
for p in darwin-arm64 darwin-x64; do
  b="$D/signed-v900-$p"
  show "codesign -dv --verbose=4 $b"
  show "codesign -d --entitlements - --xml $b; echo"
  show "codesign -d -r- $b"
  show "codesign --verify --strict --verbose=4 $b"
  show "spctl --assess --type execute -vv $b"
  info="$(codesign -dv --verbose=4 "$b" 2>&1)"
  grep -q '^Identifier=com.orbit.runner$' <<<"$info" && pass "A $p: Identifier=com.orbit.runner" || fail "A $p: identifier"
  grep -q 'flags=0x10000(runtime)' <<<"$info" && pass "A $p: hardened runtime flag" || fail "A $p: no hardened runtime flag"
  grep -q '^Timestamp=' <<<"$info" && pass "A $p: secure timestamp" || fail "A $p: no secure timestamp"
  codesign --verify --strict "$b" 2>/dev/null && pass "A $p: codesign --verify --strict" || fail "A $p: codesign --verify --strict"
  codesign -d --entitlements - --xml "$b" 2>/dev/null | grep -q 'com.apple.security.automation.apple-events' \
    && pass "A $p: entitlements embedded" || fail "A $p: entitlements missing"
done
show "codesign -dv --verbose=4 $D/adhoc-v900-darwin-arm64"

step "B. the designated requirement v0.1.900 records, checked against v0.1.901"
for kind in signed adhoc; do
  dr="$(codesign -d -r- "$D/$kind-v900-darwin-arm64" 2>&1 | sed -n 's/^#* *designated => //p')"
  echo "$kind v0.1.900 designated requirement: $dr"
  if codesign --verify --test-requirement="=$dr" "$D/$kind-v901-darwin-arm64"; then met=yes; else met=no; fi
  echo "$kind v0.1.901 meets it: $met"
  case "$kind:$met" in
    signed:yes) pass "B signed: v0.1.901 meets v0.1.900's designated requirement" ;;
    adhoc:no) pass "B ad hoc (control): v0.1.901 does not meet v0.1.900's cdhash requirement" ;;
    *) fail "B $kind: met=$met" ;;
  esac
done

step "C. both architectures run"
show "$D/signed-v900-darwin-arm64 version"
[ "$("$D/signed-v900-darwin-arm64" version 2>/dev/null)" = 0.1.900 ] && pass "C arm64 runs" || fail "C arm64 does not run"
show "$D/signed-v900-darwin-arm64 capabilities --json | head -c 400; echo"
if [ "$ROSETTA" = yes ]; then
  show "arch -x86_64 $D/signed-v900-darwin-x64 version"
  [ "$(arch -x86_64 "$D/signed-v900-darwin-x64" version 2>/dev/null)" = 0.1.900 ] && pass "C x64 runs under Rosetta" || fail "C x64 does not run"
else
  note "C x64 not run: no Rosetta on this runner"
fi

# serve DIR PORT starts a /dl at 127.0.0.1:PORT holding DIR's release.
serve() {
  local www="$D/www-$2"
  rm -rf "$www"; mkdir -p "$www/dl"; cp "$1"/* "$www/dl/"
  python3 -I "$PROBE/fakecp.py" "$www" "$2" > "$D/http-$2.log" 2>&1 &
  for _ in $(seq 50); do curl -fsS -o /dev/null "http://127.0.0.1:$2/dl/version.json" && return 0; sleep 0.2; done
  return 1
}
# agent LABEL HOME LOG starts ~/.orbit/bin/orbit run as a LaunchAgent, the keys service.go writes.
agent() {
  local plist="$HOME/Library/LaunchAgents/$1.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HOME/.orbit/bin/orbit</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ORBIT_HOME</key><string>$2</string>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ExitTimeOut</key><integer>180</integer>
  <key>StandardOutPath</key><string>$3</string>
  <key>StandardErrorPath</key><string>$3</string>
</dict>
</plist>
PL
  launchctl bootstrap "gui/$UID_" "$plist"
}
stop_agent() {
  launchctl bootout "gui/$UID_/$1" 2>/dev/null
  rm -f "$HOME/Library/LaunchAgents/$1.plist"
  sleep 2
}
# wait_for FILE TEXT SECONDS
wait_for() {
  for _ in $(seq "$3"); do grep -q "$2" "$1" 2>/dev/null && return 0; sleep 1; done
  return 1
}
config() {
  mkdir -p "$1"; chmod 700 "$1"
  printf '{"serverUrl":"http://127.0.0.1:%s","runnerId":"sign-probe","runnerToken":"sign-probe-token","name":"sign-probe"}\n' "$2" > "$1/config.json"
  chmod 600 "$1/config.json"
}

step "D. a LaunchAgent on signed v0.1.900 updates itself to v0.1.901 and re-executes"
serve "$DISTS/signed-v901" 8765 || fail "D: /dl did not come up"
for p in darwin-arm64 darwin-x64; do
  if [ "$p" = darwin-x64 ] && [ "$ROSETTA" != yes ]; then note "D x64 skipped: no Rosetta"; continue; fi
  label="com.orbit.signprobe.$p"
  H="$HOME/orbit-sign-probe-$p"; LOG="$HOME/orbit-sign-probe-$p.log"
  rm -rf "$H" "$LOG"; config "$H" 8765
  mkdir -p "$HOME/.orbit/bin"; rm -f "$HOME/.orbit/bin/orbit"
  cp "$D/signed-v900-$p" "$HOME/.orbit/bin/orbit"
  dr="$(codesign -d -r- "$HOME/.orbit/bin/orbit" 2>&1 | sed -n 's/^#* *designated => //p')"
  start="$(date '+%Y-%m-%d %H:%M:%S')"
  agent "$label" "$H" "$LOG"
  if wait_for "$LOG" "orbit updated to 0.1.901" 120; then
    sleep 8
    show "head -c 4000 $LOG"
    show "launchctl print gui/$UID_/$label | grep -E '^\s*(state|pid|runs|last exit code|program) ='"
    pid="$(launchctl print "gui/$UID_/$label" | sed -n 's/^[[:space:]]*pid = //p' | head -n1)"
    runs="$(launchctl print "gui/$UID_/$label" | sed -n 's/^[[:space:]]*runs = //p' | head -n1)"
    show "ps -o pid,lstart,command -p ${pid:-0}"
    show "$HOME/.orbit/bin/orbit version; codesign -dv $HOME/.orbit/bin/orbit"
    [ "$("$HOME/.orbit/bin/orbit" version 2>/dev/null)" = 0.1.901 ] && pass "D $p: ~/.orbit/bin/orbit is 0.1.901 after the update" || fail "D $p: installed version"
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && pass "D $p: the agent is running (pid $pid, launchd runs=$runs)" || fail "D $p: agent not running"
    [ "$runs" = 1 ] && pass "D $p: one launchd run: the update re-executed in place, nothing was killed and relaunched" || fail "D $p: launchd runs=$runs"
    grep -q "sha256" "$LOG" && fail "D $p: the log mentions a sha256 problem" || pass "D $p: sha256 check passed (no digest complaint)"
    if codesign --verify --test-requirement="=$dr" "$HOME/.orbit/bin/orbit"; then pass "D $p: installed 0.1.901 meets 0.1.900's designated requirement"; else fail "D $p: requirement not met"; fi
    codesign -dv "$HOME/.orbit/bin/orbit" 2>&1 | grep -q '^Identifier=com.orbit.runner$' && pass "D $p: installed binary is com.orbit.runner" || fail "D $p: installed identifier"
  else
    fail "D $p: no update within 120s"
    show "cat $LOG"
  fi
  show "sudo log show --start '$start' --predicate 'eventMessage CONTAINS[c] \"code signature\" OR eventMessage CONTAINS[c] \"cs_invalid\" OR eventMessage CONTAINS[c] \"CODE SIGNING\"' | grep -i orbit | head -20 || true"
  stop_agent "$label"
done

step "F. a .p12 exported by macOS's Security framework (as Keychain Access does), read by rcodesign 0.29"
KC="$D/probe.keychain-db"
security create-keychain -p probe "$KC" && security unlock-keychain -p probe "$KC"
security import "$DISTS/identity/probe.p12" -k "$KC" -P "$(head -n1 "$DISTS/identity/password")" -A -t cert -f pkcs12
perl -e 'alarm 60; exec @ARGV' security export -k "$KC" -t identities -f pkcs12 -P exported-pass -o "$D/exported.p12"
show "ls -l $D/exported.p12"
show "openssl version; openssl pkcs12 -in $D/exported.p12 -info -noout -passin pass:exported-pass"
curl -fsSL -o "$D/rcodesign-macos.tar.gz" \
  https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign/0.29.0/apple-codesign-0.29.0-macos-universal.tar.gz
echo "d98372d5524226ccf9dc0eda03d4e4f5826182dabb2fc3f2bd303ed9113a748d  $D/rcodesign-macos.tar.gz" | shasum -a 256 -c -
tar -xzf "$D/rcodesign-macos.tar.gz" -C "$D"
RC="$D/apple-codesign-0.29.0-macos-universal/rcodesign"
printf 'exported-pass\n' > "$D/exported.password"
cp "$D/adhoc-v900-darwin-arm64" "$D/f-bin"
if "$RC" sign --p12-file "$D/exported.p12" --p12-password-file "$D/exported.password" \
    --binary-identifier com.orbit.runner --timestamp-url none "$D/f-bin" > "$D/f-sign.log" 2>&1; then
  pass "F rcodesign 0.29 signs with a .p12 that macOS exported"
else
  fail "F rcodesign 0.29 cannot read a .p12 that macOS exported: $(tail -n1 "$D/f-sign.log")"
fi
show "cat $D/f-sign.log"
security delete-keychain "$KC"

step "summary"
cat "$SUMMARY"
! grep -q '^FAIL' "$SUMMARY"
