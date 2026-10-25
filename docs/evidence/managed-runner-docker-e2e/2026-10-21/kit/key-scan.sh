#!/usr/bin/env bash
# Where the owner's DeepSeek key does NOT appear: counts of matching lines only, never the key or a matching line.
#   key-scan.sh [EXTRA_DIR...]     (EXTRA_DIR: e.g. the evidence directory in the checkout)
set -uo pipefail
W=${D4_DIR:-/mnt/data/tmp/34hJ7RzpqTB13BmLR8uQv}
KEY=/mnt/data/managed-runner-lab/secrets/deepseek-api-key
count() { local n; n=$(grep -a -c -F -f "$KEY" 2>/dev/null); echo "${n:-0}"; }
# Controls: the pattern matches the key file itself (one line), and nothing in an unrelated file.
echo "control: the key file itself: $(count <"$KEY") line(s); /etc/hostname: $(count </etc/hostname)"
[ "$(wc -l <"$KEY")" -le 1 ] && [ -z "$(grep -c '^$' "$KEY" | grep -v '^0$')" ] && echo "control: the pattern file has no empty line"
for path in "$W/logs" "$W/records" "$W/kit" "$W/prompts" "$@"; do
  [ -e "$path" ] || continue
  files=$(find "$path" -type f | wc -l)
  hits=$(grep -r -a -l -F -f "$KEY" "$path" 2>/dev/null | wc -l)
  echo "$path: $files files, $hits with the key"
done
if [ ! -f "$W/mr/channel.json" ]; then echo "the stack is removed: no container, journal or database left to scan"; exit 0; fi
for c in d4-pg d4-docker-channel $(docker ps -aq --filter label=orbit.managed-runner.kind=runner --filter "label=orbit.managed-runner.instance=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["instanceId"])' "$W/mr/channel.json")"); do
  echo "docker logs $(docker inspect -f '{{.Name}}' "$c"): $(docker logs "$c" 2>&1 | wc -l) lines, $(docker logs "$c" 2>&1 | count) with the key"
done
echo "journal of d4-apiserver and d4-door: $(journalctl -u d4-apiserver -u d4-door --no-pager 2>/dev/null | wc -l) lines, $(journalctl -u d4-apiserver -u d4-door --no-pager 2>/dev/null | count) with the key"
echo "the test database (pg_dump, provider keys are stored encrypted): $(docker exec d4-pg pg_dump -U orbit -d orbit 2>/dev/null | wc -l) lines, $(docker exec d4-pg pg_dump -U orbit -d orbit 2>/dev/null | count) with the key"
