#!/usr/bin/env bash
# The tip-start run's nine failures against the same-commit originals: each failure's expected image must be the
# expectation its globalSetup assembled (runs/expected-pre) and its actual image the after original of b2568f28d.
set -euo pipefail
S=/mnt/data/tmp/34cfhmpygHQdZxRznyVH9
cd $S/runs
{ echo "# tip-start (b2568f28d, before the registration): each failure's expected and actual image against expected-pre (the expectations its globalSetup assembled) and the after original of the same-commit run on b2568f28d"
  for p in webkit-light-desktop webkit-dark-desktop webkit-dark-phone; do
    for t in settings:settings-saved profile:profile-validation session:notification-error; do
      test=${t%%:*}; n=${t##*:}; f=tip-start/failures/pages.browser.mjs-$test-$p
      echo "$p/$n.png expected $(sha256sum < $f/$n-expected.png | cut -c1-12) $(cmp -s $f/$n-expected.png expected-pre/$p/$n.png && echo '= expected-pre' || echo '!= expected-pre') actual $(sha256sum < $f/$n-actual.png | cut -c1-12) $(cmp -s $f/$n-actual.png after-b2568f28d/snapshots/$p/$n.png && echo '= after original' || echo '!= after original')"
    done
  done; } > $S/checks/tip-start-vs-originals.txt
cat $S/checks/tip-start-vs-originals.txt
