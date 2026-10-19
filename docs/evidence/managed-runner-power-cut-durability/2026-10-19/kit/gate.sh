#!/usr/bin/env bash
# T02c landing gate on the branch tip (origin/project/34ZteKCnYMpKY46f63Leb and origin/main already in it): the
# project's merge check step by step, then the managed-runner Python suite and runner-go's go test (-count=1: run, not
# read from the cache). One log and one exit file per step; a step with an exit file is skipped on a rerun. Runs
# outside the Orbit runner's cgroup (systemd-run, MemoryMax).
#   gate.sh WORKTREE GATE_DIR
set -u
WT=${1:?usage: gate.sh WORKTREE GATE_DIR}
G=${2:?usage: gate.sh WORKTREE GATE_DIR}
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
step 07-managed-runner-python "env -u LAB_TEST_SERVER_DIR python3 -B -m unittest discover -s scripts/managed-runner -p '*test*.py' -v"
step 08-runner-go 'cd src/runner-go && go version && go test -count=1 ./...'
echo "done $(date -u +%FT%TZ)" >> "$G/gate.txt"
