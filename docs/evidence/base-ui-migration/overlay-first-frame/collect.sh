#!/usr/bin/env bash
# Copy the slim part of the raw runs (/mnt/data/tmp/overlay-first-frame-34brok/runs/<label>, written by the queue)
# into this directory, as the project's evidence-size rule asks:
#   runs/<label>/  report.summary.json (../p2-keyboard-window-2/slim.py: titles, projects, statuses, durations,
#                  retries, errors, attachment names and body SHA-256, no bodies), environment.json, meta.json (the
#                  queue's record: command, tree, commit, Web changes and their diff hash, times, load, exit code) and
#                  output.txt (the run's console output); for the merge check on NVMe also overlay.txt (the
#                  dependency overlay's output) and disk.txt (df of the tree);
#   first-frames.json  summarize.py over the first-frame test's runs (fixed tree and reference);
#   compare/       ../p3.2/compare_runs.py for the pilot and P4.1 suites, reference vs fixed, and its summary;
#   probes/        the probes' JSON and the pictures the README shows.
# usage: collect.sh <label> ...   (labels whose raw run exists; re-running replaces their slim copy)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
raw=/mnt/data/tmp/overlay-first-frame-34brok/runs
slim=$here/../p2-keyboard-window-2/slim.py
for label in "$@"; do
  src=$raw/$label
  [ -e "$src/meta.json" ] || { echo "$label: no record"; continue; }
  dst=$here/runs/$label
  rm -rf "$dst"
  if [ -e "$src/results/report.json" ]; then
    [ -e "$src/environment.json" ] && cp "$src/environment.json" "$src/results/environment.json"
    python3 -B "$slim" "$src/results" "$dst" > /dev/null  # creates $dst
  else
    mkdir -p "$dst"
  fi
  cp "$src/meta.json" "$src/output.txt" "$dst/"
  for extra in overlay.txt disk.txt; do [ -e "$src/$extra" ] && cp "$src/$extra" "$dst/"; done
  echo "$label: $(du -sh "$dst" | cut -f1)"
done
