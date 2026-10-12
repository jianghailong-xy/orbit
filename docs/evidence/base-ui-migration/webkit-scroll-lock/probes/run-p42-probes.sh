#!/usr/bin/env bash
# Usage: run-p42-probes.sh <tree> <tree label> — P4.2's real-page probes (docs/evidence/base-ui-migration/p4.2/
# probes: the Codex pool steps and the Claude pool steps) on <tree>'s existing production build, all eight
# projects; each finished probe appends its JSON lines (TREE=<label>) to probes/p42-probes.jsonl once and leaves a
# .done marker, so a rerun after an interruption only repeats the probe that did not finish.
T=$1 L=$2
P=/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj/probes
for probe in probe-dialog-scroll.browser.mjs probe-dialog-gutter.browser.mjs; do
  n="p42probes-$L-${probe%%.*}"
  [ -e "$P/$n.done" ] && continue
  if [ -e "$P/$n.jsonl" ]; then mkdir -p "$P/../trash/partial"; mv "$P/$n.jsonl" "$P/../trash/partial/$n.$(date +%s).jsonl"; fi
  TREE=$L /mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj/bin/run-probe.sh "$T" "$n" "$probe" || exit 1
  [ "$(wc -l < "$P/$n.jsonl")" -eq 8 ] || { echo "$n: expected 8 lines"; exit 1; }
  cat "$P/$n.jsonl" >> "$P/p42-probes.jsonl" && touch "$P/$n.done"
done
