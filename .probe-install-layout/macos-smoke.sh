#!/usr/bin/env bash
# TEMPORARY (probe branch, never merged). macOS smoke of the ~/.orbit/bin install layout, task
# 34al3VPASPhgbwJVoVXkR: install.sh as the runner account (not root, passwordless sudo), a hand
# `orbit register` (LaunchAgent), and a legacy root-owned install moved by `sudo orbit upgrade`.
# A stand-in control plane on 127.0.0.1:8765 serves install.sh, /dl and the register call.
set -uo pipefail
step() { printf '\n==== %s\n' "$*"; }
show() { printf '$ %s\n' "$*"; bash -c "$*"; }
D="$RUNNER_TEMP/orbit-layout"
mkdir -p "$D/dl" "$D/bin"
SHA="$(git rev-parse HEAD)"
LD="-s -w -X main.defaultServer=http://127.0.0.1:8765"
KEY="darwin-$(uname -m | sed 's/x86_64/x64/')"
(
  cd src/runner-go
  CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags "$LD -X main.version=0.1.215 -X main.sourceSHA=$SHA" -o "$D/bin/orbit-0.1.215" .
  CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags "$LD -X main.version=0.1.216 -X main.sourceSHA=$SHA" -o "$D/dl/orbit-$KEY" .
  gzip -9 -f "$D/dl/orbit-$KEY"
  go run ./cmd/release-manifest 0.1.216 ../../contracts/runner-write-protocol.json "$D/dl/version.json" "$D/dl/orbit-$KEY.gz"
) || exit 1
(cd .probe-install-layout/fakecp && go build -o "$D/bin/fakecp" .) || exit 1
sed "s|https://orbitd.io|http://127.0.0.1:8765|g" src/web/public/install.sh > "$D/install.sh"
"$D/bin/fakecp" "$D" 127.0.0.1:8765 > "$D/fakecp.log" 2>&1 &
for _ in $(seq 50); do curl -fsS -o /dev/null http://127.0.0.1:8765/dl/version.json && break; sleep 0.2; done
PLIST="$HOME/Library/LaunchAgents/com.orbit.runner.plist"

step "environment"
show "sw_vers; uname -m; id; ls -ld /usr/local/bin; ls -l /usr/local/bin/orbit 2>&1; ls -la ~/.orbit 2>&1; cat $D/dl/version.json"

step "A. install.sh as $(id -un) (uid $(id -u), not root): sudo only for the /usr/local/bin link"
show "curl -fsSL http://127.0.0.1:8765/install.sh | ORBIT_NO_REGISTER=1 bash"
step "A result"
show "ls -l /usr/local/bin/orbit ~/.orbit/bin/orbit"
show "stat -f '%Su:%Sg %Lp %N' ~/.orbit ~/.orbit/bin ~/.orbit/bin/orbit"
show "readlink /usr/local/bin/orbit; command -v orbit; orbit version"

step "A2. orbit register by hand: the LaunchAgent runs the resolved ~/.orbit/bin/orbit"
show "orbit register --server http://127.0.0.1:8765 --token demo-enroll --name layout-probe-mac --no-auto-install-engines 2>&1 | grep -E 'registered runner|oving orbit|LaunchAgent|Plist:|Logs:|note:|failed'"
show "plutil -p $PLIST"
show "grep -n ORBIT_NO_SELFUPDATE $PLIST || echo 'no ORBIT_NO_SELFUPDATE in the LaunchAgent'"
show "sleep 3; launchctl print gui/$(id -u)/com.orbit.runner 2>&1 | grep -E '^\s*(program|state|path) =' || launchctl list | grep com.orbit.runner || echo 'not loaded'"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null

step "C. legacy: a root-owned binary and a LaunchAgent naming it, then one sudo orbit upgrade"
rm -f "$PLIST"; sudo rm -f /usr/local/bin/orbit; rm -rf ~/.orbit/bin
LEG=/usr/local/bin
if [ "$(stat -f %u /usr/local/bin)" != 0 ]; then
  LEG=/usr/local/orbit-legacy/bin   # this image's /usr/local/bin is not root's: stand in a directory that is
  sudo mkdir -p "$LEG"
fi
sudo install -m 0755 -o root -g wheel "$D/bin/orbit-0.1.215" "$LEG/orbit"
# The LaunchAgent an older `orbit register` wrote: the runner runs as this account, from root's directory.
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.orbit.runner</string>
  <key>ProgramArguments</key>
  <array>
    <string>$LEG/orbit</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ORBIT_HOME</key><string>$HOME/.orbit</string>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ExitTimeOut</key><integer>180</integer>
  <key>StandardOutPath</key><string>$HOME/.orbit/runner.log</string>
  <key>StandardErrorPath</key><string>$HOME/.orbit/runner.log</string>
</dict>
</plist>
PL
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>&1 || echo "(legacy agent did not load)"
show "ls -l $LEG/orbit; stat -f '%Su:%Sg %N' $(dirname "$LEG/orbit"); plutil -extract ProgramArguments.0 raw $PLIST"
show "printf 'HOME under sudo: '; sudo printenv HOME"
show "sudo $LEG/orbit upgrade"
step "C result"
show "ls -l $LEG/orbit ~/.orbit/bin/orbit"
show "stat -f '%Su:%Sg %Lp %N' ~/.orbit ~/.orbit/bin ~/.orbit/bin/orbit"
show "plutil -extract ProgramArguments.0 raw $PLIST; grep -n ORBIT_NO_SELFUPDATE $PLIST || echo 'no ORBIT_NO_SELFUPDATE in the LaunchAgent'"
show "sleep 3; launchctl print gui/$(id -u)/com.orbit.runner 2>&1 | grep -E '^\s*(program|state) =' || echo 'not loaded'"
show "~/.orbit/bin/orbit version"
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null

step "control-plane requests"
cat "$D/fakecp.log"
