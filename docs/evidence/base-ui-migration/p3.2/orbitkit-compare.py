#!/usr/bin/env python3
"""Failing OrbitKit test cases of two `swift test` logs: usage orbitkit-compare.py TIP_LOG DELIVERY_LOG

Lists, from XCTest's `Test Case '…' failed` lines, the cases failing on each tree, those failing only
on the delivery (what the batch broke) and only on the tip, plus each log's `Executed …` summary.
Exits 1 if the delivery fails a case the tip passes. Reads only."""
import json
import re
import sys

def read(path):
    text = open(path, errors='replace').read()
    failed = sorted(set(re.findall(r"Test Case '([^']+)' failed", text)))
    # The whole run's line is the one with the largest count (each suite prints its own).
    executed = re.findall(r'Executed (\d+) tests?, with [^\n]*', text)
    lines = re.findall(r'Executed \d+ tests?, with [^\n]*', text)
    return failed, max(zip(map(int, executed), lines))[1] if lines else None

tip, tip_summary = read(sys.argv[1])
delivery, delivery_summary = read(sys.argv[2])
result = {'tip': {'summary': tip_summary, 'failed': tip}, 'delivery': {'summary': delivery_summary, 'failed': delivery},
          'onlyDelivery': sorted(set(delivery) - set(tip)), 'onlyTip': sorted(set(tip) - set(delivery))}
json.dump(result, sys.stdout, indent=1)
print()
sys.exit(1 if result['onlyDelivery'] else 0)
