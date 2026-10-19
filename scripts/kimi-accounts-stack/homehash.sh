#!/usr/bin/env bash
# homehash.sh DIR — every entry under a Kimi home as "<mode> <sha256|dir|link> <path>", sorted, then one digest of
# the list. Contents are never printed (credentials live there); bin/ is skipped (the engine updater's).
set -euo pipefail
d=$1
cd "$d"
find . -path ./bin -prune -o -print | LC_ALL=C sort | while read -r p; do
  if [ -L "$p" ]; then echo "$(stat -c %a "$p") link:$(readlink "$p") $p"
  elif [ -d "$p" ]; then echo "$(stat -c %a "$p") dir $p"
  else echo "$(stat -c %a "$p") $(sha256sum < "$p" | cut -c1-16) $p"; fi
done > /tmp/homehash.$$
cat /tmp/homehash.$$
echo "digest $(sha256sum < /tmp/homehash.$$ | cut -c1-16) ($(wc -l < /tmp/homehash.$$) entries) $d"
rm -f /tmp/homehash.$$
