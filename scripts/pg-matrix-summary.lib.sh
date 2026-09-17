# What `scripts/project-pg-matrix.sh` measures its children by: the reporter it makes each one use,
# the parser that decides whether the summary that comes back can be believed, and the two readers
# that turn a child's captured output into what a spec that is not clean has to say for itself —
# the tail of its own TAP output, and whether that text reads as the host rather than the product.
# Sourced by that script and exercised on its own by `scripts/pg-matrix-summary-selftest.sh`; it
# runs nothing.
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

# Reads one child's captured output on stdin and writes the part of it that says WHY it was not
# clean, for the caller to print under the spec's line. A matrix that reports `rc=1` and nothing
# else sends the reader to a file that may not exist any more — or, in a CI run, to an artifact
# whose name they have to know.
#
# The two shapes are the reason this prints what it prints:
#
#   * A child that FAILED AN ASSERTION prints `not ok <n> - <case>` and the diagnostic block
#     indented under it: what the case expected, what it saw, where it threw. Those blocks are what
#     comes back, followed by the TAP summary lines the caller reads its counts from, so a reader
#     can check the counts against the cases rather than take them on faith.
#   * A child that was KILLED or died before any of that — the `timeout` backstop, a crash while
#     loading a module, an OOM — prints no `not ok` at all, and its reason is at the END of what it
#     did manage to print. For that shape the last $1 lines come back instead, which is where the
#     stack trace is, or where the last case that did complete can be seen.
#
# Bounded by $1 lines (default 40) with an explicit marker in the output, so that one thoroughly
# broken spec cannot push the rest of the matrix out of the reader's scrollback.
pg_matrix_failure_tail() {
  awk -v max="${1:-40}" '
    { line[NR] = $0 }
    END {
      shown = 0; n = 0
      for (i = 1; i <= NR; i++) {
        if (line[i] !~ /^[[:space:]]*not ok( |$)/) continue
        if (n >= max) { print "... (truncated at " max " lines)"; exit }
        print line[i]; n++; shown = 1
        # The case line, then everything indented under it: the `---` block node prints, and for a
        # nested subtest the indented cases inside it. The block ends at the next line that starts
        # in column 0, which is also what keeps one failing case out of the next one block.
        for (j = i + 1; j <= NR; j++) {
          if (line[j] !~ /^[[:space:]]/) break
          if (n >= max) { print "... (truncated at " max " lines)"; exit }
          print line[j]; n++
        }
      }
      if (!shown) {
        print "... (no `not ok` line: the child died before it failed a case — these are its last " max " lines)"
        start = NR - max + 1; if (start < 1) start = 1
        for (i = start; i <= NR; i++) print line[i]
        exit
      }
      # The summary, in the order pg_matrix_summary reads it, last occurrence of each — the same
      # `tail -1` that decides which numbers the counts above came from.
      split("tests pass fail cancelled skipped todo", field, " ")
      for (k = 1; k <= 6; k++) {
        last = ""
        for (i = 1; i <= NR; i++) if (line[i] ~ ("^# " field[k] " ")) last = line[i]
        if (last != "") print last
      }
    }'
}

# Reads one child's captured output on stdin and says whether the text it left behind reads as the
# HOST rather than as the product: a timeout, a refused or reset connection, a pool with nothing
# left in it, a statement the server cancelled, Prisma's own interactive-transaction deadlines —
# the 5s query deadline, the deadline for STARTING the transaction (`Unable to start a transaction
# in the given time.`, which is the form this host produces most under load, because a pool slot
# that cannot be had in five seconds is exactly what saturation looks like from inside the client).
# Meant to be given the failure tail rather than the whole transcript, so that a passing case named
# `deadlock_timeout is pinned` cannot answer for a failing one.
#
# This LABELS; it never excuses. A failure the second run did not reproduce is reported either way,
# and this only decides which of two sentences the line under it carries.
pg_matrix_failure_is_load_shaped() {
  grep -Eqi 'timed out|timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EPIPE|Connection terminated|too many clients|server closed the connection|terminating connection|57014|57P01|expired transaction|Unable to start a transaction' || return 1
}

# Did this child FAIL A CASE at all? Reads the same captured output. A child that was killed — the
# `timeout` backstop, an OOM, anything that TERMs it — has no `not ok` in it, and "no case failed"
# is a different sentence from "a case failed and here is what it said": the second one is a claim
# about the product that a killed process did not make.
pg_matrix_failure_failed_a_case() {
  grep -Eq '^[[:space:]]*not ok( |$)' || return 1
}

# Reads a child's failure tail — what `pg_matrix_failure_tail` writes — on stdin and writes the one
# sentence the matrix prints under that spec's line to say what its first run left behind:
#
#   * NO CASE EVER FAILED — the child was killed, and it made no claim about the product. This is the
#     shape a 600s backstop, an OOM, or anything else that signals the process produces, and it is
#     why the two readers above are separate questions. `pg_matrix_failure_tail` always writes at
#     least its own marker line, so a child that managed to print nothing at all lands here too.
#   * A CASE DID FAIL, and its text either names the host (a timeout, a connection, a transaction
#     deadline) or does not.
#
# The second case is the one to be careful with: `is_load_shaped` answering "no" does NOT mean the
# failure is the product's. A timing assertion that expects a debounce window to fold eleven
# crossings into one fails on a host where nothing finishes on time, and its text is a plain
# ERR_ASSERTION. That is why the second run, and not this sentence, is what decides.
pg_matrix_failure_shape() {
  local tail_text; tail_text="$(cat)"
  if ! printf '%s\n' "$tail_text" | pg_matrix_failure_failed_a_case; then
    echo "the child was killed before it failed a case — none of what it left behind is an assertion failure"
  elif printf '%s\n' "$tail_text" | pg_matrix_failure_is_load_shaped; then
    echo "load-shaped failure text: a timeout or a connection, not a failed assertion"
  else
    echo "its failure text is NOT timeout/connection-shaped — read it"
  fi
}
