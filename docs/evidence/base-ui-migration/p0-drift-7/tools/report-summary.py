#!/usr/bin/env python3
"""Usage: report-summary.py <report.json> <report.summary.json>

The Playwright JSON report with every attachment body removed (project evidence-volume rule, 2026-10-07):
titles, projects, statuses, durations, retries, error messages and attachment names/paths stay as recorded."""
import json, sys
r = json.load(open(sys.argv[1]))
removed = 0
def strip(o):
    global removed
    if isinstance(o, dict):
        for a in o.get('attachments', []) if isinstance(o.get('attachments'), list) else []:
            if isinstance(a, dict) and 'body' in a:
                del a['body']; removed += 1
        for v in o.values(): strip(v)
    elif isinstance(o, list):
        for v in o: strip(v)
strip(r)
json.dump(r, open(sys.argv[2], 'w'), indent=1)
open(sys.argv[2], 'a').write('\n')
print(sys.argv[2], 'attachment bodies removed:', removed)
