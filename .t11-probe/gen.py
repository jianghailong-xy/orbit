#!/usr/bin/env python3
"""TEMPORARY evidence probe (shots branch only; see README.md).

The real app's Info.plist with ATS off, so the probe build can reach the stub on 127.0.0.1 (the
simulator shares the host's loopback), and without the remote-notification background mode, which a
throwaway build signed to run locally cannot back.

usage: gen.py <repo root> <probe dir>
"""
import plistlib
import sys
from pathlib import Path

root, probe = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
out = probe / "ios/Generated"
out.mkdir(parents=True, exist_ok=True)
with (root / "src/ios/Support/Info.plist").open("rb") as fh:
    plist = plistlib.load(fh)
plist["NSAppTransportSecurity"] = {"NSAllowsArbitraryLoads": True}
plist.pop("UIBackgroundModes", None)
with (out / "Info-probe.plist").open("wb") as fh:
    plistlib.dump(plist, fh)
print("==> generated Info-probe.plist (ATS off)")
