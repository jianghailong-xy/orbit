#!/usr/bin/env bash
# Photographs the built iPhone app's new-session first message on an iPhone 17 Pro Simulator: Sending…, Not sent
# after 20 s unanswered, Not sent refused (409), and that message put back. Run on a Mac with Xcode and XcodeGen,
# from anywhere in the repository; PNGs land in .nsn-probe/shots/. Never commit .nsn-probe.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$(git -C "$here" rev-parse --show-toplevel)"
if [ ! -d docs/evidence/claude-region-check-apple/probe-harness ] \
   && [ "$(git config --get core.sparseCheckout || true)" = true ]; then
  git sparse-checkout add docs/evidence/claude-region-check-apple
fi
rm -rf .nsn-probe && cp -R docs/evidence/claude-region-check-apple/probe-harness .nsn-probe
cp "$here/NewSessionShotTests.swift" .nsn-probe/UITests/RegionShotTests.swift
python3 "$here/patch_stub.py" .nsn-probe/stub.py
python3 - <<'PY'
# The harness lands on a session; this one lands on the workspace's new-session page.
p = ".nsn-probe/ProbeArgs.swift"
s = open(p).read()
old = '        if let session = value("-probe.session") {'
assert s.count(old) == 1
s = s.replace(old, '''        if let agent = value("-probe.compose") {
            for _ in 0..<2 {
                model.openAgent(agent)
                try? await Task.sleep(for: .seconds(1))
            }
            model.newSessionInCurrentAgent()
            try? await Task.sleep(for: .seconds(2))
        } else if let session = value("-probe.session") {''')
open(p, "w").write(s)
p = ".nsn-probe/project.yml"
s = open(p).read().replace('          - "OrbitApp.swift"\n',
                           '          - "OrbitApp.swift"\n          - "MenuBarIcon.swift"\n')
open(p, "w").write(s)
p = ".nsn-probe/run.sh"
s = open(p).read()
a = s.index("IPHONE_UDID=$(xcrun simctl list devices available -j")
b = s.index('echo "==> iPhone $IPHONE_UDID')
s = s[:a] + """IPHONE_UDID=${NSN_UDID:-$(xcrun simctl list devices available | grep -m1 'iPhone 17 Pro (' | grep -oE '[0-9A-F-]{36}')}
[ -n "$IPHONE_UDID" ] || { echo "no iPhone 17 Pro simulator"; exit 1; }
""" + s[b:]
open(p, "w").write(s)
PY
# Another run on this Mac may hold 8765: NSN_PORT moves the stub, and every place that names it, elsewhere.
if [ -n "${NSN_PORT:-}" ]; then
  grep -rl 8765 .nsn-probe --include=run.sh --include=stub.py --include=*.swift | xargs sed -i '' "s/8765/$NSN_PORT/g"
fi
bash .nsn-probe/run.sh
