#!/usr/bin/env bash
# Usage: collect.sh
# Copies this batch's records from /mnt/data/tmp/<task> into docs/evidence/base-ui-migration/p0-drift-5, under
# the project's evidence-volume rules: no report.json with attachment bodies and no trace.zip (report.summary.json
# instead), screenshots only where the README cites them, the full runs left on /mnt/data until the judgment.
set -euo pipefail
B=/mnt/data/tmp/34cFgyWHIYDslABFPloEM
REPO=/root/.orbit/worktrees/a1f992c4-adcc-5b68-bd13-387124116c3d
E=$REPO/docs/evidence/base-ui-migration/p0-drift-5
mkdir -p "$E"/{tools,attribution/runs,attribution/dists,attribution/environments,attribution/images,compare,checks}
# Tools (the scripts as run; paths point at /mnt/data/tmp/34cFgyWHIYDslABFPloEM and this worktree).
for f in setup-base.sh prepare-tree.sh make-runner.sh p0d5.config.mjs run.sh queue.sh round.sh final-rounds.sh start2.sh \
         negative-control.sh nc-1px.diff merge-check.sh netns-regression.sh summarize-report.py report-summary.py \
         evidence-digest.py compare.cjs compare-summary.py compare-rounds.py attribution.py fixture-chain.py pair-images.py \
         make-reference.py spec-a10.json spec-a11.json nc-analysis.py merge-check-root.sh collect.sh; do
  [ -f "$B/scripts/$f" ] && cp "$B/scripts/$f" "$E/tools/$f"
done
# Attribution runs: meta, screenshot hashes, evidence digest, attachment-free report, command output.
for d in "$B"/runs/*/; do
  l=$(basename "$d"); [ -f "$d/meta.json" ] || continue
  mkdir -p "$E/attribution/runs/$l"
  for f in meta.json snapshots.sha256 evidence-digest.json report.summary.json output.txt; do
    [ -f "$d/$f" ] && cp "$d/$f" "$E/attribution/runs/$l/$f"
  done
  sha256sum < "$d/environment.json" | cut -c1-64 > "$E/attribution/runs/$l/environment.sha256"
done
cp "$B"/dists/*.sha256 "$E/attribution/dists/"
cp "$B/runs/full-fix-base/environment.json" "$E/attribution/environments/environment.json"
(cd "$B/runs" && for d in */; do [ -f "$d/environment.json" ] && printf '%s  %s\n' "$(sha256sum < "$d/environment.json" | cut -c1-64)" "${d%/}"; done) > "$E/attribution/environments/runs.sha256"
cp "$B"/images/*.png "$B/images/index.json" "$E/attribution/images/"
# Comparisons.
for f in "$B"/cmp/*.json; do
  case "$(basename "$f")" in fc-tmp.json|fixture-chain-partial.json) continue ;; esac
  cp "$f" "$E/compare/"
done
echo "collected into $E: $(find "$E" -type f | wc -l) files, $(du -sh "$E" | cut -f1)"
# Official runs: summary, attachment-free report, command output, expectation sources, environment check,
# evidence digest, exit code; failure images only where the README cites them.
for c in base-start base2-start final-round-1 final-round-2 final3-round-1 final3-round-2 negative-control-1px negative-control-1px-final; do
  [ -d "$B/checks/$c" ] || continue
  mkdir -p "$E/checks/$c"
  for f in summary.json report.summary.json command-output.txt sources.json environment-check.txt evidence-digest.json exit.txt patch.diff commit.txt; do
    [ -f "$B/checks/$c/$f" ] && cp "$B/checks/$c/$f" "$E/checks/$c/$f"
  done
done
cp "$B/checks/final-round-compare.json" "$E/checks/final-round-compare.json" 2>/dev/null || true
cp "$B/checks/final3-round-compare.json" "$E/checks/final3-round-compare.json" 2>/dev/null || true
cp "$B/nc-analysis.json" "$E/checks/negative-control-1px/analysis.json" 2>/dev/null || true
cp "$B/nc-analysis-final.json" "$E/checks/negative-control-1px-final/analysis.json" 2>/dev/null || true
for img in base-start/failures/pages.browser.mjs-wiki-chromium-light-desktop/wiki-home-diff.png \
           base-start/failures/pages.browser.mjs-settings-chromium-light-desktop/settings-diff.png \
           negative-control-1px-final/failures/pages.browser.mjs-wiki-chromium-light-desktop/wiki-home-diff.png \
           negative-control-1px-final/failures/pages.browser.mjs-settings-chromium-light-desktop/settings-diff.png; do
  [ -f "$B/checks/$img" ] && mkdir -p "$E/checks/$(dirname "$img")" && cp "$B/checks/$img" "$E/checks/$img"
done
if [ -d "$B/checks/merge-check-final" ]; then
  mkdir -p "$E/checks/merge-check"
  cp "$B/checks/merge-check-final/output-filtered.txt" "$B/checks/merge-check-final/output-full.txt.gz" "$B/checks/merge-check-final/exit.txt" "$B/checks/merge-check-final/disk.txt" "$B/checks/merge-check-final/overlay.txt" "$E/checks/merge-check/" 2>/dev/null || true
fi
mkdir -p "$E/checks/audit"
cp "$B/logs/audit-1d3cd4c70.txt" "$E/checks/audit/audit-1d3cd4c70.txt"
cp "$B/logs/audit-base.txt" "$E/checks/audit/audit-4d77d69b7.txt"
cp "$B/logs/audit-93ab20b8c.txt" "$E/checks/audit/audit-93ab20b8c.txt"
cp "$B/logs/audit-075b7a6c8.txt" "$E/checks/audit/audit-075b7a6c8.txt"
[ -f "$B/attribution.json" ] && cp "$B/attribution.json" "$E/attribution/attribution.json"
[ -f "$B/per-screenshot.md" ] && cp "$B/per-screenshot.md" "$E/attribution/per-screenshot.md"
echo "after checks: $(find "$E" -type f | wc -l) files, $(du -sh "$E" | cut -f1)"
cp "$B/fixture-chain.json" "$E/attribution/fixture-chain.json"
python3 "$B/scripts/compare-summary.py" "$E/compare/summary.json" $(ls "$E"/compare/*__*.json) > /dev/null
echo "final: $(find "$E" -type f | wc -l) files, $(du -sh "$E" | cut -f1)"
