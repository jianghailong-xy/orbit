#!/usr/bin/env bash
# Usage: collect.sh
# Copies this batch's records from /mnt/data/tmp/34dI9lY63LC7ZEZHbJ4bG into docs/evidence/base-ui-migration/p0-drift-8,
# under the project's evidence-volume rules: no report.json with attachment bodies and no trace.zip
# (report.summary.json instead), screenshots only where the README cites them, the full runs left on /mnt/data until
# the judgment. As p0-drift-7/tools/collect.sh.
set -euo pipefail
B=/mnt/data/tmp/34dI9lY63LC7ZEZHbJ4bG
REPO=/root/.orbit/worktrees/29948cd5-4699-56fe-be2f-3864e2bd39a6
E=$REPO/docs/evidence/base-ui-migration/p0-drift-8
mkdir -p "$E"/{tools,attribution/runs,attribution/dists,attribution/images,compare,checks}
# Tools, as run (paths point at /mnt/data/tmp/34dI9lY63LC7ZEZHbJ4bG and this worktree).
for f in "$B"/scripts/*; do if [ -f "$f" ]; then cp "$f" "$E/tools/$(basename "$f")"; fi; done
# Attribution runs: meta, screenshot hashes, evidence digest, attachment-free report.
for d in "$B"/runs/*/; do
  l=$(basename "$d"); [ -f "$d/meta.json" ] || continue
  mkdir -p "$E/attribution/runs/$l"
  for f in meta.json snapshots.sha256 evidence-digest.json; do
    [ -f "$d/$f" ] && cp "$d/$f" "$E/attribution/runs/$l/$f"
  done
  # No attribution run failed (every one exited 0 with 252 screenshots), so no report summary is kept for them: each
  # run's stats are in meta.json and its per-test unhandled requests and page errors in evidence-digest.json.
  sha256sum < "$d/environment.json" | cut -c1-64 > "$E/attribution/runs/$l/environment.sha256"
done
cp "$B"/dists/*.sha256 "$E/attribution/dists/"
# The per-screenshot attribution (attribution.py) and its table.
cp "$B/attribution/attribution.json" "$B/attribution/per-screenshot.md" "$E/attribution/"
# Pairwise comparisons (compare.cjs rows) and their one-line summaries.
cp "$B"/cmp/*.json "$E/compare/"
# Formal checks: command output, summaries, sources, evidence digests, environment checks; failure images only where
# the README cites them (cited-failures.txt, paths relative to checks/).
for d in "$B"/checks/*/; do
  l=$(basename "$d"); mkdir -p "$E/checks/$l"
  for f in command-output.txt summary.json summary.txt sources.json evidence-digest.json environment-check.txt exit.txt \
           report.summary.json patch.diff commit.txt analysis.json output-filtered.txt disk.txt overlay.txt output-full.txt.gz; do
    [ -f "$d/$f" ] && cp "$d/$f" "$E/checks/$l/$f"
  done
  true
done
# Round-by-round comparisons and the antd audit outputs.
cp "$B"/checks/*.json "$E/checks/"
mkdir -p "$E/checks/audit" && cp "$B"/checks/audit/*.txt "$E/checks/audit/"
if [ -f "$B/cited-failures.txt" ]; then
  while read -r rel; do mkdir -p "$E/checks/$(dirname "$rel")"; cp "$B/checks/$rel" "$E/checks/$rel"; done < "$B/cited-failures.txt"
fi
if [ -d "$B/images" ]; then cp "$B"/images/* "$E/attribution/images/"; fi
du -sh "$E"; find "$E" -type f | wc -l
