#!/bin/bash
# The first delivery's iPhone probe results against the rerun on 550cefd49: the test outcome of each, the
# accessibility trees and the balance requests with run-specific noise (element addresses, pid, clock)
# taken out, and every picture pixel by pixel.
set -u
V1=5550dbff6033c792778c8d73266150fc240ede24
V2=9c5a7ffff734a5617332fc922f299fe8d9140bcd
w=/var/tmp/ds-balance-ios-cmp
rm -rf "$w"; mkdir -p "$w/v1" "$w/v2"
git archive "$V1" dsb-shots/ios | tar -x -C "$w/v1"
git archive "$V2" dsb-shots/ios | tar -x -C "$w/v2"
a="$w/v1/dsb-shots/ios"; b="$w/v2/dsb-shots/ios"
echo "v1 = ${V1:0:9}: $(git log -1 --format=%s "$V1")"
echo "v2 = ${V2:0:9}: $(git log -1 --format=%s "$V2")"
for c in "$V1" "$V2"; do
  echo "${c:0:9} tests: $(git show "$c:dsb-shots/summary-build-ios.txt" | grep -E 'Executed [0-9]+ tests' | head -1 | sed 's/^[[:space:]]*//') $(git show "$c:dsb-shots/summary-build-ios.txt" | grep -oE '\*\* TEST [A-Z]+ \*\*' | head -1)"
done

norm() { sed -E 's/0x[0-9a-f]+/0xADDR/g; s/pid: [0-9]+/pid: N/g' "$1"; }
echo "== accessibility trees (addresses and pid taken out)"
for f in $(cd "$a" && ls tree-*.txt); do
  d=$(diff <(norm "$a/$f") <(norm "$b/$f"))
  if [ -z "$d" ]; then echo "same $f"; else
    echo "DIFF $f: $(grep -c '^<' <<<"$d") line(s) changed:"
    for n in $(grep -oE '^[0-9]+' <<<"$d" | sort -un); do
      echo "   v1 line $n: $(sed -n "${n}p" "$a/$f" | sed -E 's/0x[0-9a-f]+/0xADDR/; s/^[[:space:]]+//')"
      echo "   v2 line $n: $(sed -n "${n}p" "$b/$f" | sed -E 's/0x[0-9a-f]+/0xADDR/; s/^[[:space:]]+//')"
      echo "   inside: $(sed -n "$((n - 1))p" "$b/$f" | sed -E 's/0x[0-9a-f]+/0xADDR/; s/^[[:space:]]+//')"
    done
  fi
done

echo "== balance requests the app sent (clock taken out, as a multiset)"
if diff <(sed -E 's/^[0-9:]+ //' "$a/balance-requests.txt" | sort) <(sed -E 's/^[0-9:]+ //' "$b/balance-requests.txt" | sort) >/dev/null; then
  echo "same $(wc -l < "$a/balance-requests.txt") requests, refresh=1 presses: $(grep -c 'refresh=1' "$b/balance-requests.txt")"
else
  echo "DIFFERENT requests:"; diff <(sed -E 's/^[0-9:]+ //' "$a/balance-requests.txt" | sort) <(sed -E 's/^[0-9:]+ //' "$b/balance-requests.txt" | sort)
fi

echo "== pictures"
python3 -I /var/tmp/ds-balance-web-compare.py "$a" "$b" | grep -v 'checks-'
