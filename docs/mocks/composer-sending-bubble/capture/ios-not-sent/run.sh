#!/usr/bin/env bash
# Photographs the built iPhone app's Not sent states on an iPhone 17 Pro Simulator: a send the server never
# answers (Not sent at 20 s) and one it refuses (409, the session has ended), then that one put back. Run on a
# Mac with Xcode and XcodeGen, from anywhere in the repository; PNGs land in .nsb-probe/shots/. Never commit
# .nsb-probe.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$(git -C "$here" rev-parse --show-toplevel)"
if [ "$(git config --get core.sparseCheckout || true)" = true ]; then
  git sparse-checkout add docs/evidence/claude-region-check-apple
fi
rm -rf .nsb-probe && cp -R docs/evidence/claude-region-check-apple/probe-harness .nsb-probe
cp "$here/NotSentShotTests.swift" .nsb-probe/UITests/RegionShotTests.swift
python3 "$here/patch_stub.py" .nsb-probe/stub.py
python3 - <<'PY'
p = ".nsb-probe/project.yml"
s = open(p).read().replace('          - "OrbitApp.swift"\n',
                           '          - "OrbitApp.swift"\n          - "MenuBarIcon.swift"\n')
open(p, "w").write(s)
p = ".nsb-probe/run.sh"
s = open(p).read()
a = s.index("IPHONE_UDID=$(xcrun simctl list devices available -j")
b = s.index('echo "==> iPhone $IPHONE_UDID')
s = s[:a] + """IPHONE_UDID=$(xcrun simctl list devices available | grep -m1 'iPhone 17 Pro (' | grep -oE '[0-9A-F-]{36}')
[ -n "$IPHONE_UDID" ] || { echo "no iPhone 17 Pro simulator"; exit 1; }
""" + s[b:]
open(p, "w").write(s)
PY
bash .nsb-probe/run.sh
