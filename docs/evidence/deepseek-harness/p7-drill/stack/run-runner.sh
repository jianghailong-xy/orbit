#!/bin/bash
# run-runner.sh a|b candidate|legacy — a test runner on the P7 stack with its own ORBIT_HOME, no self/engine
# updates and no model key of its own (a Harness session gets its key only from its provider, via dispatch).
# Switching the second argument and restarting is the drill's runner upgrade / rollback.
R=$1; BIN=/var/tmp/p7-stack/bin/orbit-$2
for v in $(env | cut -d= -f1 | grep -E '^(ORBIT_|CLAUDE|ANTHROPIC_|DSH_)'); do unset "$v"; done
export ORBIT_HOME=/var/tmp/p7-stack/runner-$R ORBIT_NO_SELFUPDATE=1 ORBIT_NO_ENGINE_UPDATE=1
export PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
echo "== $(date -u +%FT%TZ) runner-$R starts $($BIN --version) sha256 $(sha256sum $BIN | cut -c1-16)"
cd /var/tmp/p7/work-$R && exec "$BIN" run
