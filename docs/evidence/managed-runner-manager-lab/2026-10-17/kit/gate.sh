#!/usr/bin/env bash
# T04 landing gate on the merge tip: the project's merge check step by step, the managed-runner Python
# suite, and every managed-runner pg spec. One log and one exit file per step; a step with an exit
# file is skipped on a rerun. Runs outside the Orbit runner's cgroup (systemd-run, MemoryMax).
set -u
WT=/root/.orbit/worktrees/d13e7278-4d58-5a48-b982-cb8e9806d18f
G=/mnt/data/tmp/t04-34ZtjTuz/gate
mkdir -p "$G"
cd "$WT" || exit 2
echo "head $(git rev-parse HEAD) status '$(git status --porcelain | head -3)' $(date -u +%FT%TZ)" >> "$G/gate.txt"
echo 1000 > /proc/self/oom_score_adj

step() {  # step <name> <command...>
  local name=$1
  shift
  [ -f "$G/$name.exit" ] && { echo "skip $name (exit $(cat "$G/$name.exit"))" >> "$G/gate.txt"; return; }
  local started=$SECONDS
  echo "start $name $(date -u +%FT%TZ)" >> "$G/gate.txt"
  bash -c "$*" > "$G/$name.txt" 2>&1
  local rc=$?
  echo "$rc" > "$G/$name.exit"
  echo "end $name exit=$rc $((SECONDS - started)) s $(date -u +%FT%TZ)" >> "$G/gate.txt"
}

step 00-overlay 'bash scripts/worktree-overlay.sh'
step 01-compose-topology 'npm run test:compose-topology'
step 02-prisma-generate 'npm run prisma:generate'
step 03-build 'npm run build'
step 04-shared 'npm test -w @orbit/shared'
step 05-apiserver 'npm test -w @orbit/apiserver'
step 06-web 'npm test -w @orbit/web'
step 07-managed-runner-python "python3 -B -m unittest discover -s scripts/managed-runner -p '*test*.py' -v"
step 08-managed-runner-pg 'bash scripts/run-pg-spec.sh src/apiserver/src/managed-runners/*.pg.spec.ts'
echo "done $(date -u +%FT%TZ)" >> "$G/gate.txt"
