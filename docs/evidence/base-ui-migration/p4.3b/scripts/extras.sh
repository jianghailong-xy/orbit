#!/usr/bin/env bash
# extras.sh: the checks the coordinator asked for on 2026-10-09, on the final commits, in scratch trees (make-aux.sh)
# so the formal trees stay as the formal runs left them. Run after formal.sh/analyze.sh/probes.sh. Writes extra/.
#  1. first-page resources per resource (bundle-build.sh, bundle-compare.py): the start, the start with only the
#     stylesheet fix, the reference and the delivery;
#  2. the stylesheets linked in opposite order between the start and the delivery, statically checked for ties
#     (order-ties2.py);
#  3. the lazily loaded graphs' stylesheets and computed styles on the reference and the delivery
#     (probe-lazy-styles.browser.mjs), four environments;
#  4. the session export with the review-turn cards on both trees (exportCardsProbe.test.tsx) and the exported file
#     in eight environments (probe-export-shots.browser.mjs);
#  5. firstPageStylesheet.test.ts as delivered and with each half of the fix taken out (stylesheet-negatives.sh);
#  6. the overlays case "keeps its scroll when the control with focus gives way" with and without the popup focus
#     fix (overlays-gives-way.sh).
# Resumable (a runner restart or a usage stop kills the job): each part leaves extra/.done-<part> when it is through
# and is skipped then. Making the scratch trees again (part 0) clears the later parts' marks; parts 5 and 6 first put
# back the files they edit, in case an interrupted run left them edited.
set -u
V=/mnt/data/tmp/34blYpxEcHMAf4oafuC2W
S=$(cat $V/try/start-commit.txt); DEL=$(cat $V/try/final-head.txt); FIX=$(cat $V/try/final-fix.txt); REF=$(git -C $V/ref rev-parse HEAD)
# The popup focus fix, and the tree just before it (the stylesheet fix, whose Overlay.tsx is the one it changes).
FOCUS=$(git -C $V/try/aux-del log --format=%H -1 --grep='takes focus back without scrolling' 2>/dev/null)
X=$V/extra; mkdir -p $X/probes $X/export
. $V/scripts/memgate.sh
part() { if [ -f "$X/.done-$1" ]; then echo "== extras part $1 already done"; return 1; fi; memgate; }
mark() { touch "$X/.done-$1"; }
echo "start $S, start+fix = $S + $FIX, reference $REF, delivery $DEL ($(date -u +%T))"
if part 0; then rm -f $X/.done-*
bash $V/scripts/make-aux.sh startfix $S $FIX && bash $V/scripts/make-aux.sh ref $REF && bash $V/scripts/make-aux.sh del $DEL || exit 1
for t in startfix ref del; do (cd $V/try/aux-$t/src/web && TMPDIR=$V/tmp scoped nice npx vite build > $V/try/aux-$t-build.log 2>&1; echo "aux-$t build exit $?"); done
mark 0; fi
# 1, 2
if part 12; then
for p in "start $V/start" "startfix $V/try/aux-startfix" "ref $V/try/aux-ref" "del $V/try/aux-del"; do set -- $p; bash $V/scripts/bundle-build.sh $1 $2; done
python3 -I $V/scripts/bundle-compare.py $X/bundle-compare.json start=$V/start startfix=$V/try/aux-startfix ref=$V/try/aux-ref del=$V/try/aux-del > $X/bundle-compare.txt; echo "bundle-compare exit $?"
python3 -I - $V <<'PY'
import json, sys
v = sys.argv[1]
d = json.load(open(f'{v}/extra/bundle-compare.json'))
json.dump(d['builds']['start']['cssModulesInLinkOrder'], open(f'{v}/extra/order-start.json', 'w'), indent=1)
json.dump(d['builds']['del']['cssModulesInLinkOrder'], open(f'{v}/extra/order-delivery.json', 'w'), indent=1)
PY
python3 -I $V/scripts/order-ties2.py $V/try/aux-del $X/order-start.json $X/order-delivery.json > $X/component-order-ties.txt; echo "order-ties exit $?"
mark 12; fi
# 3
if part 3; then
for t in ref del; do nice bash $V/scripts/probe-aux.sh probe-lazy-styles.browser.mjs $t chromium-light-desktop chromium-dark-phone webkit-light-phone webkit-dark-desktop > $X/probes/probe-lazy-styles-$t.txt 2>&1; echo "lazy-styles $t: $(grep -E '[0-9]+ (passed|failed)' $X/probes/probe-lazy-styles-$t.txt | tr -s ' ' | tr '\n' ' ')"; done
mark 3; fi
# 4
if part 4; then
HLJS=/root/.orbit/worktrees/ba9b2bbb-b78b-5991-855c-183de0d5d9e3/node_modules/highlight.js/styles/github.css
for t in ref del; do T=$V/try/aux-$t; mkdir -p $X/export/$t; cp $V/probes/exportCardsProbe.test.tsx $T/src/web/src/lib/
  (cd $T/src/web && TMPDIR=$V/tmp INDEX_CSS=$T/src/web/src/index.css HLJS_CSS=$HLJS EXPORT_OUT=$X/export/$t scoped npx vitest run src/lib/exportCardsProbe.test.tsx > $X/export/$t-vitest.txt 2>&1; echo "export $t vitest exit $?")
  rm -f $T/src/web/src/lib/exportCardsProbe.test.tsx; done
bash $V/scripts/export-shots.sh
python3 -I - $V <<'PY'
import json, os, re, sys
from PIL import Image, ImageChops
v = sys.argv[1]
d = f'{v}/extra/export'
def probes(tree):
    out = {}
    for line in open(f'{v}/extra/probes/probe-export-shots-{tree}.txt', encoding='utf-8'):
        m = re.match(r'\s*PROBE (\S+) (\S+) export (\{.*\})\s*$', line)
        if m: out[m.group(2)] = json.loads(m.group(3))
    return out
pr, pd = probes('ref'), probes('del')
res = {'bodiesIdentical': {}, 'shots': {}, 'computedStylesEqual': {k: pr[k] == pd.get(k) for k in pr},
       'requestedReview': {t: open(f'{d}/{t}/requested-outcome.txt').read().strip() for t in ('ref', 'del')}}
for theme in ('light', 'dark'):
    a = open(f'{d}/ref/returned-{theme}.html', encoding='utf-8').read(); b = open(f'{d}/del/returned-{theme}.html', encoding='utf-8').read()
    res['bodiesIdentical'][theme] = a.split('<body>', 1)[1] == b.split('<body>', 1)[1]
for name in sorted(os.listdir(f'{d}/shots/ref')):
    A = open(f'{d}/shots/ref/{name}', 'rb').read(); B = open(f'{d}/shots/del/{name}', 'rb').read()
    ia, ib = Image.open(f'{d}/shots/ref/{name}').convert('RGB'), Image.open(f'{d}/shots/del/{name}').convert('RGB')
    box = ImageChops.difference(ia, ib).getbbox() if ia.size == ib.size else 'size'
    res['shots'][name] = {'size': list(ia.size), 'bytesEqual': A == B, 'differingBox': box}
json.dump(res, open(f'{d}/compare.json', 'w'), indent=1, ensure_ascii=False)
print('export compare:', json.dumps({'bodies': res['bodiesIdentical'], 'bytesEqual': sum(x['bytesEqual'] for x in res['shots'].values()), 'shots': len(res['shots']), 'styles': all(res['computedStylesEqual'].values())}))
PY
mark 4; fi
# 5
if part 5; then git -C $V/try/aux-del checkout -q -- src/web/vite.config.ts src/web/src/main.tsx
bash $V/scripts/stylesheet-negatives.sh > $X/stylesheet-test-negatives.txt 2>&1; echo "stylesheet negatives: $(grep -c 'vitest exit' $X/stylesheet-test-negatives.txt) runs"
mark 5; fi
# 6
T=$V/try/aux-del
if part 6; then git -C $T checkout -q -- src/web/src/components/ui/Overlay.tsx
bash $V/scripts/overlays-gives-way.sh with-fix
cp $T/src/web/src/components/ui/Overlay.tsx $V/try/Overlay.tsx.final
FOCUS=$(git -C $T log --format=%H -1 --grep='takes focus back without scrolling'); echo "popup focus fix $FOCUS; Overlay.tsx from its parent"
git -C $T show $FOCUS^:src/web/src/components/ui/Overlay.tsx > $T/src/web/src/components/ui/Overlay.tsx
bash $V/scripts/overlays-gives-way.sh without-fix
git -C $T checkout -q -- src/web/src/components/ui/Overlay.tsx; git -C $T status --short | head -3
mark 6; fi
echo "== extras done $(date -u +%T)"
