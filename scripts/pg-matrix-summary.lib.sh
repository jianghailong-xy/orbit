# What `scripts/project-pg-matrix.sh` measures its children by: the reporter it makes each one use,
# and the parser that decides whether the summary that comes back can be believed. Sourced by that
# script and exercised on its own by `scripts/pg-matrix-summary-selftest.sh`; it runs nothing.
#
# Node 23 changed the default reporter of `node --test` from TAP to spec — with or without a TTY —
# so a child left to the default prints `ℹ tests 15` where this harness reads `# tests 15`. Every
# count came back empty, each fell back to 0, the footer printed `tests=0 pass=0 fail=0` and the run
# still exited 0. Nothing turned red; the numbers simply stopped being evidence. Two things follow
# from that, and both of them live here rather than in the caller's environment.
#
#   1. The harness names the reporter. Naming it in argv is not enough by itself: NODE_OPTIONS is
#      parsed as though it came first and `--test-reporter` accumulates rather than overrides, so a
#      caller's `NODE_OPTIONS=--test-reporter=spec` plus this script's `--test-reporter=tap` is
#      either two reporters interleaved on one stdout or — when reporters and destinations do not
#      pair up one for one — `ERR_INVALID_ARG_VALUE` before a single test runs. So the child's
#      NODE_OPTIONS is stripped of the `--test*` options, which are the ones that decide what runs
#      and how it is reported, and argv pins the rest.
#   2. A summary this cannot vouch for is RED. Absent, non-numeric, zero, or not adding up: each of
#      those is a reason and no counts, never 0/0/0 folded quietly into the totals.

# Every `node --test` child of the matrix runs under exactly these.
PG_MATRIX_NODE_TEST_ARGS=(--test --test-concurrency=1 --test-reporter=tap --test-reporter-destination=stdout)

# NODE_OPTIONS as the child should see it: whatever the caller set, minus the `--test*` options.
pg_matrix_child_node_options() {
  local tokens=() kept=() drop_value=0 tok
  read -ra tokens <<<"${NODE_OPTIONS:-}"
  for tok in ${tokens[@]+"${tokens[@]}"}; do
    # `--test-reporter tap` is two tokens in NODE_OPTIONS as much as `--test-reporter=tap` is one.
    if [ "$drop_value" = 1 ]; then
      drop_value=0
      [ "${tok#-}" = "$tok" ] && continue
    fi
    case "$tok" in
      --test*=*) continue ;;
      --test*)   drop_value=1; continue ;;
    esac
    kept+=("$tok")
  done
  echo "${kept[*]:-}"
}

# Reads one child's captured output on stdin, writes one tab-separated record:
#
#   tests <TAB> pass <TAB> fail <TAB> skipped <TAB> reason
#
# `reason` is empty exactly when the TAP summary was whole, numeric, non-zero and self-consistent.
# When it is set the four counts are 0: a summary that cannot be vouched for adds nothing to the
# totals and makes its spec RED.
pg_matrix_summary() {
  local out; out="$(cat)"
  local field raw missing='' unparsable='' reason='' sum
  local -A n=()
  for field in tests pass fail cancelled skipped todo; do
    raw="$(printf '%s\n' "$out" | sed -n "s/^# $field //p" | tail -1)"
    if [ -z "$raw" ]; then missing="${missing:+$missing,} # $field"; continue; fi
    case "$raw" in
      *[!0-9]*) unparsable="${unparsable:+$unparsable,} # $field \"$raw\"" ;;
      *)        n[$field]="$raw" ;;
    esac
  done
  if [ -n "$missing" ]; then
    reason="no TAP summary line for:$missing (a reporter other than tap?)"
  elif [ -n "$unparsable" ]; then
    reason="TAP summary is not a number:$unparsable"
  elif [ "${n[tests]}" -eq 0 ]; then
    reason="TAP summary says tests=0 (nothing ran)"
  else
    sum=$(( ${n[pass]} + ${n[fail]} + ${n[cancelled]} + ${n[skipped]} + ${n[todo]} ))
    [ "$sum" -ne "${n[tests]}" ] &&
      reason="TAP summary does not add up: tests=${n[tests]}, pass+fail+cancelled+skipped+todo=$sum"
  fi
  if [ -n "$reason" ]; then
    printf '0\t0\t0\t0\t%s\n' "$reason"
  else
    printf '%s\t%s\t%s\t%s\t\n' "${n[tests]}" "${n[pass]}" "${n[fail]}" "${n[skipped]}"
  fi
}
