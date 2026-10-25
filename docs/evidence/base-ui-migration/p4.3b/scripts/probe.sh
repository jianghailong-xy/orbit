#!/usr/bin/env bash
# probe.sh PROBE_FILE TREE PROJECTS...: run one probe spec (copied in untracked, removed after) on ref or del.
set -u
V=/mnt/data/tmp/34blYpxEcHMAf4oafuC2W
file=$1; tree=$2; shift 2
projects=(); for p in "$@"; do projects+=(--project "$p"); done
export TMPDIR=$V/tmp
. $V/scripts/memgate.sh
cp $V/probes/$file $V/probes/probe.config.mjs $V/$tree/src/web/ui-migration/
( cd $V/$tree/src/web && scoped unshare -n bash -c 'ip link set lo up && exec "$@"' bash env TREE=$tree PROBE_MATCH=$file PROBE_OUTPUT=$V/try/probe-out-$tree \
  env ${PROBE_DEBUG:+DEBUG=$PROBE_DEBUG} npx playwright test --config ui-migration/probe.config.mjs "${projects[@]}" --reporter=list 2>&1 | grep -E "${PROBE_GREP:-PROBE|passed|failed|Error}" )
rm -f $V/$tree/src/web/ui-migration/$file $V/$tree/src/web/ui-migration/probe.config.mjs
