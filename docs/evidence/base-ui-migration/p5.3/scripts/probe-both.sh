#!/usr/bin/env bash
# probe-both.sh SCENARIO.mjs [SELECTORS-JSON]: run probe.mjs against both trees' builds (ref :4374, del :4373), side by side,
# in a private network namespace with each tree's vite preview. Output: probe-ref.txt, probe-del.txt in the cwd.
# Stops only the two servers it started (their process groups): a pattern would also stop a Playwright run's preview.
# REF_DIR / DEL_DIR (env) name other checkouts to serve (the formal trees v1/ref, v1/del); defaults: v1/dev-ref, the worktree.
set -u
V=/mnt/data/tmp/34Za39Ov1yysHZaYL6wgJ/v1
WT=/root/.orbit/worktrees/4071e471-3592-5308-a8bb-f597b81ac833
S=/mnt/data/tmp/34Za39Ov1yysHZaYL6wgJ/scripts
scenario=$(realpath "$1"); export SELECTORS=${2:-'[]'}; out=$PWD
REF_DIR=${REF_DIR:-$V/dev-ref}; DEL_DIR=${DEL_DIR:-$WT}
systemd-run --scope --quiet -p MemoryMax=6G unshare -n bash -c "
  ip link set lo up
  (cd $REF_DIR/src/web && exec setsid npx vite preview --host 127.0.0.1 --port 4374 --strictPort > /dev/null 2>&1) & ref=\$!
  (cd $DEL_DIR/src/web && exec setsid npx vite preview --host 127.0.0.1 --port 4373 --strictPort > /dev/null 2>&1) & del=\$!
  for i in \$(seq 1 50); do curl -s -o /dev/null http://127.0.0.1:4374/ && curl -s -o /dev/null http://127.0.0.1:4373/ && break; sleep 0.2; done
  cd $WT/src/web
  PORT=4374 SHOT=\${SHOT_REF:-} node $S/probe.mjs $scenario > $out/probe-ref.txt 2>&1
  PORT=4373 SHOT=\${SHOT_DEL:-} node $S/probe.mjs $scenario > $out/probe-del.txt 2>&1
  kill -- -\$ref -\$del 2>/dev/null
"
