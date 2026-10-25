#!/bin/bash
# On the HPC host: D10's rounds, one after another, each followed by its summary. A line `switch <variant>` moves the
# deployment and every loaded runner to that variant's image first (image.sh, then d10.py cycle).
#   matrix.sh <plan file>
# A plan line: `<label> <variant> <runners> <load seconds> <cycles> <files> <think ms> [<runner commit every n turns>
# [<stagger seconds>]]`,
# or `switch <variant>`.
set -euo pipefail
T=/mnt/data/tmp/34ilx9dqVOKBeYZObuIjI
BASE="$(cat "$T/installed-image.txt")"
# The plan is read on its own descriptor: the commands below must not take it as their input.
while read -r -u 3 label variant runners seconds cycles files think commit_every stagger; do
  case "$label" in ''|'#'*) continue ;; esac
  if [ "$label" = switch ]; then
    echo "== $(date -u +%FT%TZ) switch to $variant"
    docker exec d10-dind bash /kit/image.sh "$variant" "$BASE" </dev/null
    python3 -B "$T/kit/d10.py" cycle "$variant" </dev/null | grep -E '"step": "every loaded runner' || { echo "cycle to $variant failed"; exit 1; }
    continue
  fi
  echo "== $(date -u +%FT%TZ) round $label: $variant, $runners runners, ${seconds}s, $cycles cycles of $files files, think ${think} ms, runner commit every ${commit_every:-1} turns, stagger ${stagger:-0}s"
  python3 -B "$T/kit/d10.py" round "$label" "$variant" "$runners" "$seconds" "$cycles" "$files" "$think" "${commit_every:-1}" "${stagger:-0}" </dev/null | grep -E '"round"|"step": "round' | cut -c1-400
  python3 -B "$T/kit/summarize.py" "$T/evidence/rounds/$label" </dev/null
done 3<"$1"
echo "== $(date -u +%FT%TZ) plan done"
