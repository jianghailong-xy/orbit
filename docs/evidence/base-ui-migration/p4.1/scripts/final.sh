#!/usr/bin/env bash
# After followup.sh: the standard P0 regression once more (its report copied out at once), the P0-harness
# isolation of the WebKit phone notice (as is / one forced layout read), and the probes for the evidence:
# toast root cause on both trees, first frame of the floating layers in dialogs on both trees.
set -u
R=/var/tmp/p4.1-293463/runs
DEL=/root/.orbit/worktrees/3402ff96-4293-56f4-8940-d723dd9fa681
REFUI=/var/tmp/p4.1-293463/tip/src/web/ui-migration
EV=$DEL/docs/evidence/base-ui-migration/p4.1
until grep -q '^== done' /root/.orbit/runs/3402ff96-4293-56f4-8940-d723dd9fa681/bgj_d6836b24923d.output 2>/dev/null; do sleep 10; done
ns() { unshare -n bash -c 'ip link set lo up && exec "$@"' bash "$@"; }
head_of() { echo "head: $(git -C $DEL rev-parse HEAD)"; echo "uncommitted:"; git -C $DEL status --short; }
echo "== f-p0-standard-2 $(date -u +%T)"
{ head_of; echo "argv: npx playwright test --config ui-migration/playwright.config.mjs"; } > $R/f-p0-standard-2.log
( cd $DEL/src/web && ns npx playwright test --config ui-migration/playwright.config.mjs ) >> $R/f-p0-standard-2.log 2>&1; echo "exit=$?" >> $R/f-p0-standard-2.log
rm -rf $R/f-p0-standard-2-out; mkdir -p $R/f-p0-standard-2-out
cp -a $DEL/src/web/.ui-migration-results/report.json $DEL/src/web/.ui-migration-results/environment.json $R/f-p0-standard-2-out/ 2>/dev/null
cp -a $DEL/src/web/.ui-migration-results/expected-screenshots/sources.json $R/f-p0-standard-2-out/expected-sources.json
for d in $DEL/src/web/.ui-migration-results/*-webkit-*-phone; do [ -f $d/profile-validation-diff.png ] && cp -a $d $R/f-p0-standard-2-out/; done
grep -E "^\s+[0-9]+ (passed|failed|flaky|skipped)|^exit=" $R/f-p0-standard-2.log
for force in 0 1; do
  name=iso-force$force
  echo "== $name $(date -u +%T)"
  { head_of; echo "argv: ISO_FORCE=$force npx playwright test --config /var/tmp/p4.1-293463/isolation/isolation.config.mjs --project chromium-light-phone --project webkit-light-phone --project webkit-dark-phone"; } > $R/$name.log
  ( cd $DEL/src/web && ISO_FORCE=$force ISO_OUTPUT=$R/$name-out ns npx playwright test --config /var/tmp/p4.1-293463/isolation/isolation.config.mjs --project chromium-light-phone --project webkit-light-phone --project webkit-dark-phone ) >> $R/$name.log 2>&1
  echo "exit=$?" >> $R/$name.log
  grep -E "^\s+[0-9]+ (passed|failed|flaky|skipped)|pixels \(ratio|^exit=" $R/$name.log | sort -u
done
echo "== probes $(date -u +%T)"
for side in reference delivery; do
  port=4302; ui=$REFUI; [ $side = delivery ] && { port=4304; ui=$DEL/src/web/ui-migration; }
  { echo '{'; first=1
    for probe in steps readsBetween forcedRead delayed; do
      [ $first = 1 ] || echo ','; first=0
      echo "\"$probe\":"; node $EV/toast-root-cause/run.mjs http://127.0.0.1:$port $ui $probe || echo null
    done; echo '}'; } > $R/toast-$side.json 2> $R/toast-$side.err
  python3 -I -c "import json,sys; json.load(open(sys.argv[1])); print(sys.argv[1], 'ok')" $R/toast-$side.json
done
for side in ref del; do
  port=4302; ui=$REFUI; [ $side = del ] && { port=4304; ui=$DEL/src/web/ui-migration; }
  for env in "light phone chromium" "light desktop chromium" "light phone webkit"; do
    set -- $env
    out=$R/frames-$side-$3-$2.json
    { echo '{"select":'; MOBILE_ALL=1 node /var/tmp/p4.1-293463/scripts/probe.mjs http://127.0.0.1:$port $ui selectFrames $1 $2 $3; echo ',"popconfirm":'; MOBILE_ALL=1 node /var/tmp/p4.1-293463/scripts/probe.mjs http://127.0.0.1:$port $ui popFrames $1 $2 $3; echo '}'; } > $out 2>$out.err
    echo "$out $(python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); print(json.dumps(d)[:300])" $out 2>&1)"
  done
done
echo "== done $(date -u +%T)"
