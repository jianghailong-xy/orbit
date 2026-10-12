#!/usr/bin/env bash
# probe-aux.sh PROBE_FILE NAME PROJECTS...: probe.sh for a scratch tree try/aux-NAME (make-aux.sh, built with vite
# build): the probe spec copied in (untracked) and removed after, in its own network namespace.
set -u
V=/mnt/data/tmp/34blYpxEcHMAf4oafuC2W
file=$1; name=$2; shift 2
T=$V/try/aux-$name
projects=(); for p in "$@"; do projects+=(--project "$p"); done
export TMPDIR=$V/tmp
. $V/scripts/memgate.sh
cp $V/probes/$file $V/probes/probe.config.mjs $T/src/web/ui-migration/
( cd $T/src/web && scoped unshare -n bash -c 'ip link set lo up && exec "$@"' bash env TREE=$name PROBE_MATCH=$file PROBE_OUTPUT=$V/try/probe-out-aux-$name \
  npx playwright test --config ui-migration/probe.config.mjs "${projects[@]}" --reporter=list 2>&1 | grep -E "${PROBE_GREP:-PROBE|passed|failed|Error}" )
rm -f $T/src/web/ui-migration/$file $T/src/web/ui-migration/probe.config.mjs
