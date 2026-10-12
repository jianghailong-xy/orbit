#!/usr/bin/env bash
# Usage: archive-p0.sh <run-dir> <dest> — one full P0 run (netns-regression.sh output) into the evidence:
# command output, exit, environment, expected-screenshot sources, the raw JSON report, a summary
# (summarize-report.py from p0-drift/tools) and the failure images of failed screenshot assertions.
RUN=$1 DEST=$2
mkdir -p "$DEST"
cp "$RUN"/command-output.txt "$RUN"/exit.txt "$RUN"/environment.json "$RUN"/sources.json "$RUN"/report.json "$DEST"/ 2>/dev/null
python3 /var/tmp/p23b1/scripts/summarize-report.py "$RUN/report.json" "$RUN/sources.json" > "$DEST/summary.json"
[ -d "$RUN/failures" ] && cp -r "$RUN/failures" "$DEST/"
python3 -c "import json; d=json.load(open('$DEST/summary.json')); print(json.dumps({'stats': d['stats'], 'passed': d['passed'], 'expectedFailures': d['expectedFailures'], 'skipped': d['skipped'], 'unexpected': len(d['unexpected']), 'flaky': len(d['flaky'])}))"
