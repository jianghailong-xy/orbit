#!/usr/bin/env bash
# clean-install.sh COMMIT: a fresh checkout of COMMIT on /mnt/data with nothing borrowed (no node_modules, no dist),
# `npm ci` from its lockfile, what npm says about antd and the icons, the web build, and what the build ships.
set -uo pipefail
COMMIT=${1:?commit}
T=/mnt/data/tmp/34Za39RS6A28G7xPqMD0p
C=$T/v1/clean
WT=/root/.orbit/worktrees/05c9af49-f99c-506f-b2c2-2c26a5edc79e
export TMPDIR=$T/tmp
mkdir -p "$TMPDIR"
if [ -d "$C" ]; then git -C "$WT" worktree remove --force "$C"; fi
git -C "$WT" worktree add -q --detach "$C" "$COMMIT"
cd "$C"
echo "== checkout $(git rev-parse HEAD), node_modules present: $(ls -d node_modules src/web/node_modules 2>/dev/null | wc -l)"
echo "== node $(node --version), npm $(npm --version)"
echo "== npm ci"; npm ci --no-audit --no-fund 2>&1 | tail -3; echo "npm ci exit=${PIPESTATUS[0]}"
echo "== npm ls antd --all (workspace @orbit/web)"; npm ls antd -w @orbit/web --all 2>&1; echo "exit=$?"
echo "== npm ls antd --all (whole tree)"; npm ls antd --all 2>&1; echo "exit=$?"
echo "== npm explain antd"; npm explain antd 2>&1 | head -5; echo "exit=${PIPESTATUS[0]}"
echo "== npm ls @ant-design/icons -w @orbit/web --all"; npm ls @ant-design/icons -w @orbit/web --all 2>&1; echo "exit=$?"
echo "== installed @ant-design and @rc-component packages"; ls -d node_modules/@ant-design/* node_modules/@rc-component/* 2>/dev/null
echo "== any directory named antd under node_modules"; find node_modules src/*/node_modules -type d -name antd 2>/dev/null | head; echo "(end)"
echo "== npm run build -w @orbit/web"; npm run build -w @orbit/web 2>&1 | grep -E "error|✓ built|tsc" | tail -5; echo "build exit=${PIPESTATUS[0]}"
echo "== dist scan"; node "$WT/docs/evidence/base-ui-migration/p6/scripts/dist-scan.mjs" src/web/dist | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps({k: d[k] for k in ('totals', 'bytes', 'gzip', 'antClassSample')}))"
