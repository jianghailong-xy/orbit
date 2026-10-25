#!/usr/bin/env bash
# Targeted vitest run of the files the P5.1 switch touches (or that render what it touches).
set -uo pipefail
cd /root/.orbit/worktrees/9f22d16e-3f30-5541-a5ef-91972ffc7911/src/web
out=/mnt/data/tmp/34Za39L1H6V82d2sobzPY/runs
mkdir -p "$out"
name="${1:-focus}"
echo "== $(date -u +%FT%TZ) load: $(cut -d' ' -f1-3 /proc/loadavg) free: $(free -m | awk '/Mem:/{print $7}')MB HEAD $(git rev-parse --short HEAD)"
/mnt/data/tmp/34Za39L1H6V82d2sobzPY/scripts/capped.sh 5G npx vitest run \
  src/components/ui/Avatar.test.tsx src/components/ui/Menu.test.tsx src/components/ui/Menu.footer.test.tsx src/components/ui/Popover.test.tsx \
  src/components/ui/boundary.test.ts src/components/ui/Tooltip.test.tsx src/components/ui/Floating.test.tsx \
  src/components/TasksSidePanel src/components/SessionSearch src/components/SessionOutputs src/components/PlanUsageIndicator \
  src/components/NewSessionProviderHero src/components/MergeRecoveryPanel \
  src/components/WorkspaceView.sessionFolders.test.tsx src/components/WorkspaceView.projectSessions.test.tsx \
  src/components/WorkspaceView.sessionProjects.test.tsx src/components/WorkspaceView.codexAccount.test.tsx \
  src/components/WorkspaceView.poolAccount.test.tsx src/components/WorkspaceView.loginPool.test.tsx \
  src/components/WorkspaceView.commitResultMessage.test.tsx src/indexCss.test.ts src/copyLanguage.test.ts \
  --maxWorkers=2 --reporter=default --reporter=json --outputFile.json="$out/$name.json" 2>&1 | sed -r 's/\x1B\[[0-9;]*[A-Za-z]//g'
code=${PIPESTATUS[0]}
echo "== exit $code $(date -u +%FT%TZ)"
exit $code
