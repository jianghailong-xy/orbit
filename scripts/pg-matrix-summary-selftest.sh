#!/usr/bin/env bash
# The counterexamples `scripts/pg-matrix-summary.lib.sh` has to answer. No container, no database,
# no apiserver build — it runs anywhere bash and node do:
#
#   bash scripts/pg-matrix-summary-selftest.sh
#   PCC_SELFTEST_NODES="/usr/bin/node /tmp/node26/bin/node" bash scripts/pg-matrix-summary-selftest.sh
#
# The regression it exists for is not "a spec broke". It is that the matrix summed a run of children
# that never printed the counters it reads, called the result `tests=0 pass=0 fail=0` and exited 0.
# So the cases below are all about the reading: a spec-reporter transcript, a truncated one, counts
# that are absent, zero, not numbers, or that do not add up — each has to come back with a reason,
# and none of them may come back as a quiet zero. The last case runs a real `node --test` child
# through the same argv and the same scrubbed NODE_OPTIONS the matrix gives its children, under
# every node binary in PCC_SELFTEST_NODES, and requires one identical non-zero record from all of
# them: that is the Node 22 / Node 26 agreement the parsing depends on, asserted rather than
# remembered.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$DIR/pg-matrix-summary.lib.sh" || exit 1

failed=0
check() { # name expected actual
  if [ "$2" = "$3" ]; then
    printf 'ok   %s\n' "$1"
  else
    printf 'FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"
    failed=$((failed+1))
  fi
}
record()  { printf '%s\n' "$1" | pg_matrix_summary; }            # the whole tab-separated record
reason()  { record "$1" | cut -f5; }                             # the reason field alone
because() { printf '%s' "${1%%:*}"; }                            # its leading phrase

TAP_OK=$'TAP version 13\nok 1 - a\n1..1\n# tests 7\n# suites 0\n# pass 3\n# fail 1\n# cancelled 0\n# skipped 2\n# todo 1\n# duration_ms 118.7'

# 1. What Node 23+ prints by default. Every counter this parser reads is absent, which is the whole
#    bug: it used to be four fallbacks to 0 and a green run.
SPEC_REPORTER=$'▶ suite\n  ✔ a (0.4ms)\n▶ suite (1.2ms)\n\nℹ tests 7\nℹ suites 0\nℹ pass 7\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0'
check 'spec-reporter transcript is not a summary' \
  'no TAP summary line for' "$(because "$(reason "$SPEC_REPORTER")")"
check 'spec-reporter transcript contributes no counts' \
  '0 0 0 0' "$(record "$SPEC_REPORTER" | cut -f1-4 | tr '\t' ' ')"

# 2. A child that died before the summary — a crash, a SIGKILL, a `timeout`.
check 'no output at all' 'no TAP summary line for' "$(because "$(reason '')")"
check 'truncated before the summary' 'no TAP summary line for' \
  "$(because "$(reason $'TAP version 13\nok 1 - a\n1..1')")"

# 3. Half a summary is not a summary.
check 'summary missing # pass' 'no TAP summary line for' \
  "$(because "$(reason "$(printf '%s\n' "$TAP_OK" | grep -v '^# pass ')")")"
check 'summary missing # todo' 'no TAP summary line for' \
  "$(because "$(reason "$(printf '%s\n' "$TAP_OK" | grep -v '^# todo ')")")"

# 4. A whole, consistent summary of nothing. Node exits 0 for it, so nothing else would notice.
check 'tests=0' 'TAP summary says tests=0 (nothing ran)' \
  "$(reason "$(printf '%s\n' "$TAP_OK" | sed 's/^# tests 7/# tests 0/; s/^# pass 3/# pass 0/; s/^# fail 1/# fail 0/; s/^# skipped 2/# skipped 0/; s/^# todo 1/# todo 0/')")"

# 5. Numbers that are not numbers.
check 'non-numeric count' 'TAP summary is not a number' \
  "$(because "$(reason "$(printf '%s\n' "$TAP_OK" | sed 's/^# tests 7/# tests seven/')")")"

# 6. Counts that disagree with each other — a summary from two runs, or one this parser misread.
check 'counts do not add up' 'TAP summary does not add up' \
  "$(because "$(reason "$(printf '%s\n' "$TAP_OK" | sed 's/^# pass 3/# pass 4/')")")"

# 7. What a good one is worth, including a spec that printed a line looking like a counter of its
#    own before the runner printed the real ones.
check 'a whole summary reads back' $'7\t3\t1\t2\t' "$(record "$TAP_OK")"
check "a spec's own output does not shadow the summary" $'7\t3\t1\t2\t' \
  "$(record "$(printf '# tests 999\n%s\n' "$TAP_OK")")"

# 8. The reporter is the harness's to choose, so the caller's `--test*` options go and the rest stay.
scrubbed() { NODE_OPTIONS="$1" pg_matrix_child_node_options; }
check 'unset NODE_OPTIONS scrubs to nothing'   ''                       "$(pg_matrix_child_node_options)"
check 'joined --test-reporter is dropped'      ''                       "$(scrubbed '--test-reporter=spec')"
check 'split --test-reporter drops its value'  ''                       "$(scrubbed '--test-reporter spec')"
check 'a destination is dropped with it'       ''                       "$(scrubbed '--test-reporter=spec --test-reporter-destination=stdout')"
check 'other options are the caller’s to keep' '--max-old-space-size=4096' \
  "$(scrubbed '--max-old-space-size=4096 --test-reporter=spec')"
check 'a kept option keeps its own value'      '--max-old-space-size 4096' \
  "$(scrubbed '--test-name-pattern foo --max-old-space-size 4096')"

# 9. A real child, under every node binary offered, run exactly the way the matrix runs one: the
#    same argv, the same scrubbed NODE_OPTIONS, a hostile reporter in the caller's environment.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/child.test.js" <<'JS'
const { test } = require('node:test');
test('one', () => {});
test('two', () => {});
test('three', { skip: true }, () => {});
JS
child() { NODE_OPTIONS="$(pg_matrix_child_node_options)" "$1" "${PG_MATRIX_NODE_TEST_ARGS[@]}" "$TMP/child.test.js" 2>&1; }
agreed=''
for nodebin in ${PCC_SELFTEST_NODES:-${NODE:-node}}; do
  v="$("$nodebin" -v 2>/dev/null)" || { printf 'FAIL %s is not a node binary\n' "$nodebin"; failed=$((failed+1)); continue; }
  # What the same child does with nobody choosing: TAP through Node 22, spec from Node 23 on. Not an
  # assertion — it is the reason the run above cannot be left to the default, printed per version.
  bare="$(reason "$(env -u NODE_OPTIONS "$nodebin" --test --test-concurrency=1 "$TMP/child.test.js" 2>&1)")"
  printf 'note %s (%s) left to its own default: %s\n' "$nodebin" "$v" "${bare:-a readable TAP summary}"
  for hostile in '' '--test-reporter=spec' '--test-reporter spec' '--test-reporter=spec --test-reporter-destination=stdout'; do
    got="$(record "$(NODE_OPTIONS="$hostile" child "$nodebin")")"
    check "$v with NODE_OPTIONS='$hostile'" $'3\t2\t0\t1\t' "$got"
  done
  [ -z "$agreed" ] && agreed="$(record "$(child "$nodebin")")"
  check "$v agrees with the first node binary" "$agreed" "$(record "$(child "$nodebin")")"
done

[ "$failed" = "0" ] && { echo "==> OK"; exit 0; }
echo "==== $failed check(s) failed ===="
exit 1
