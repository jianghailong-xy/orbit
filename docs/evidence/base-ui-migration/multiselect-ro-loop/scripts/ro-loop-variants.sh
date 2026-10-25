#!/usr/bin/env bash
# ro-loop-variants.sh OUT: P6's ro-loop-variants.sh method re-run on this task's trees, the case ×10 in both WebKit
# phone projects each (case-repeat.sh):
#   pre                  this task's starting point (743d21ab2, the project line after P6 with origin/main merged)
#   pre-with-button      the same tree with a stand-in for the "Open legacy Modal" button (same label, nothing behind
#                        it) put back above the regions, as P6's delivery-with-button variant did
#   base                 P6's parent (f78e93f61): AntD still in the app, the button still drawn, the delivery's spec
#                        copied in as P6's variant ran it
#   base-without-button  the same tree with that button deleted
#   fix                  the delivery (62ab70582)
# The fixture edits are undone after each variant. make-trees.sh first.
set -u
OUT=${1:?outdir}
S=$(cd "$(dirname "$0")" && pwd)
V=/mnt/data/tmp/34dcr9bZPPrl6TDzvXowg/v
D=src/web/src/components/ui/__fixtures__/ChoicesFixture.tsx
SPEC=src/web/ui-migration/choices.browser.mjs
export TMPDIR=/mnt/data/tmp/34dcr9bZPPrl6TDzvXowg/tmp
mkdir -p "$OUT"
cp $V/exp-fix/$SPEC $V/exp-base/$SPEC
variant() { bash "$S/case-repeat.sh" "$2" "$OUT" "$1" 10; }
variant pre $V/exp-pre
sed -i 's|        <Button onClick={() => setDialog(true)}>Open Dialog</Button>|&\n        <Button>Open legacy Modal</Button>|' $V/exp-pre/$D
variant pre-with-button $V/exp-pre
git -C $V/exp-pre checkout -q -- $D
variant base $V/exp-base
sed -i '/<Button onClick={() => setLegacy(true)}>Open legacy Modal<\/Button>/d' $V/exp-base/$D
variant base-without-button $V/exp-base
git -C $V/exp-base checkout -q -- $D
variant fix $V/exp-fix
for dir in $V/exp-pre $V/exp-base; do git -C $dir checkout -q -- src/web; done
echo "scratch trees restored: [$(git -C $V/exp-pre status --short -- src/web | tr '\n' ' ')] [$(git -C $V/exp-base status --short -- src/web | tr '\n' ' ')]"
