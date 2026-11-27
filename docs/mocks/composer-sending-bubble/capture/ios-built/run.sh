#!/usr/bin/env bash
# Photographs the built iPhone app's Sending… and Sent states on an iPhone 17 Pro Simulator. Run on a Mac with
# Xcode and XcodeGen, from anywhere in the repository; PNGs land in .sbb-probe/shots/. Never commit .sbb-probe.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$(git -C "$here" rev-parse --show-toplevel)"
if [ "$(git config --get core.sparseCheckout || true)" = true ]; then
  git sparse-checkout add docs/evidence/claude-region-check-apple
fi
rm -rf .sbb-probe && cp -R docs/evidence/claude-region-check-apple/probe-harness .sbb-probe
cp "$here/SendingShotTests.swift" .sbb-probe/UITests/RegionShotTests.swift
python3 "$here/patch_stub.py" .sbb-probe/stub.py
python3 - <<'PY'
p = ".sbb-probe/project.yml"
s = open(p).read().replace('          - "OrbitApp.swift"\n',
                           '          - "OrbitApp.swift"\n          - "MenuBarIcon.swift"\n')
open(p, "w").write(s)
p = ".sbb-probe/run.sh"
s = open(p).read()
a = s.index("IPHONE_UDID=$(xcrun simctl list devices available -j")
b = s.index('echo "==> iPhone $IPHONE_UDID')
s = s[:a] + """IPHONE_UDID=$(xcrun simctl list devices available | grep -m1 'iPhone 17 Pro (' | grep -oE '[0-9A-F-]{36}')
[ -n "$IPHONE_UDID" ] || { echo "no iPhone 17 Pro simulator"; exit 1; }
""" + s[b:]
open(p, "w").write(s)
PY
bash .sbb-probe/run.sh
