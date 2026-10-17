#!/usr/bin/env bash
# Usage: keep-run.sh <run dir of netns-regression.sh> <evidence dir>
# Keeps a P0 regression run in the evidence: the command output, exit code, expected-screenshot sources,
# the report (gzip) and its summary (p0-drift-2/tools/summarize-report.py), the failure attachments, and
# whether the run's environment record is byte-identical to P0.2's.
set -euo pipefail
REPO=$(cd "$(dirname "$0")" && git rev-parse --show-toplevel)
RUN=$1 OUT=$2
mkdir -p "$OUT"
cp "$RUN/command-output.txt" "$RUN/exit.txt" "$RUN/sources.json" "$OUT/"
python3 "$REPO/docs/evidence/base-ui-migration/p0-drift-2/tools/summarize-report.py" "$RUN/report.json" "$RUN/sources.json" > "$OUT/summary.json"
gzip -n -c "$RUN/report.json" > "$OUT/report.json.gz"
if cmp -s "$RUN/environment.json" "$REPO/docs/evidence/base-ui-migration/p0.2/environment.json"; then r=identical; else r=DIFFERENT; fi
echo "environment.json $(sha256sum < "$RUN/environment.json" | cut -c1-64): $r to p0.2/environment.json" > "$OUT/environment-check.txt"
rm -rf "$OUT/failures"; [ -d "$RUN/failures" ] && cp -r "$RUN/failures" "$OUT/failures"
cat "$OUT/environment-check.txt" "$OUT/exit.txt"
