#!/usr/bin/env bash
# Usage: dedupe-actuals.sh  — for every finished run, delete output/**/<name>-actual.png only where it is
# byte-identical to snapshots/<project>/<name>.png (update mode writes both); anything else is kept.
for run in /var/tmp/p0d2/runs/*/; do
  python3 -c "import json,sys; sys.exit(0 if 'exit' in json.load(open(sys.argv[1])) else 1)" "$run/meta.json" 2>/dev/null || continue
  find "$run/output" -name '*-actual.png' 2>/dev/null | while read -r f; do
    dir=$(basename "$(dirname "$f")"); project=$(echo "$dir" | grep -oE '(chromium|webkit)-(light|dark)-(desktop|phone)$')
    name=$(basename "$f" | sed 's/-actual\.png$/.png/')
    [ -n "$project" ] && cmp -s "$f" "$run/snapshots/$project/$name" && rm -f "$f"
  done
done
