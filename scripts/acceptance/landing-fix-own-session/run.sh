#!/usr/bin/env bash
# Revision 42 part one end to end (docs/project-integration-line-contract.md §12.1–§12.8), on an isolated stack of its
# own: start or converge the stack from this checkout, build and (re)start the runner from it, then the four cases of
# cases.mjs: three in one project on a project branch, and a fresh line in a second project. The stack, the runner and the fake engine are part two's kit
# (scripts/acceptance/landing-measured/), under another Compose project, directory and port range so the two never meet.
# Every query the run records is printed at the end, so this job's output carries the rows. Exit 0 only if every check
# passed.
#
#   bash scripts/acceptance/landing-fix-own-session/run.sh     # LM_RUN tags the project title (default: a timestamp)
#   LM_PROJECT=orbit-link-lfx42 LM_DIR=/mnt/tmp/tmp/lfx42 LM_HTTP_PORT=48086 ... \
#     bash scripts/acceptance/landing-measured/stack.sh down   # afterwards: stop the runner, remove the stack
#
# The image build compiles the apiserver (a heavy step): it runs under LFX_HEAVY_LOCK (flock) when that file exists.
set -uo pipefail
HERE=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)
KIT=$(cd "$HERE/../landing-measured" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
export LM_PROJECT=${LM_PROJECT:-orbit-link-lfx42}
export LM_DIR=${LM_DIR:-/mnt/tmp/tmp/lfx42}
export LM_HTTP_PORT=${LM_HTTP_PORT:-48086} LM_LINK_PORT=${LM_LINK_PORT:-48443} LM_METRICS_PORT=${LM_METRICS_PORT:-48464}
export LM_NATS_PORT=${LM_NATS_PORT:-48422} LM_NATS_MONITOR_PORT=${LM_NATS_MONITOR_PORT:-48822} LM_PEBBLE_PORT=${LM_PEBBLE_PORT:-48500}
export LM_RUN=${LM_RUN:-$(date -u +%m%d%H%M%S)}
LOCK=${LFX_HEAVY_LOCK:-/mnt/tmp/34bc-hpc-heavy.lock}
step() { echo; echo "######## $(date -u +%FT%TZ) $*"; }
heavy() { if [ -f "$LOCK" ]; then flock "$LOCK" "$@"; else "$@"; fi; }

step "source: $(git -C "$REPO" rev-parse HEAD) on $(git -C "$REPO" rev-parse --abbrev-ref HEAD); stack $LM_PROJECT in $LM_DIR"
git -C "$REPO" log --oneline -1
set -e
mkdir -p "$LM_DIR/logs"
step "stack up (images built from this checkout; heavy lock $LOCK)"
heavy bash "$KIT/stack.sh" up > "$LM_DIR/logs/up-$LM_RUN.log" 2>&1 || { tail -40 "$LM_DIR/logs/up-$LM_RUN.log"; exit 1; }
grep -E 'building the apiserver|staging stack .* is up' "$LM_DIR/logs/up-$LM_RUN.log" || true
bash "$KIT/stack.sh" status
docker inspect --format '{{.Name}} {{.Image}} {{.Created}}' "$LM_PROJECT-apiserver" "$LM_PROJECT-web"
# The engine (LFX_ENGINE, default real): the host's Claude Code binary, copied out of /root (the runner's namespace hides
# /root), its model scripted-model.py on 127.0.0.1:$LFX_MODEL_PORT behind the Orbit provider cases.mjs makes. The
# model's log is the file lib.mjs#mcpAnswer reads. LFX_ENGINE=stand-in runs part two's fake-claude instead.
export LFX_ENGINE=${LFX_ENGINE:-real} LFX_MODEL_PORT=${LFX_MODEL_PORT:-48912}
if [ "$LFX_ENGINE" = real ]; then
  step "engine: the real claude CLI, its model scripted on 127.0.0.1:$LFX_MODEL_PORT"
  src=$(readlink -f "${LFX_CLAUDE:-/root/.local/bin/claude}")
  export LFX_CLAUDE_VERSION
  LFX_CLAUDE_VERSION=$(env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT "$src" --version | head -1)
  dst=${LFX_CLAUDE_DIR:-/var/tmp/lfx42-claude}/claude-${LFX_CLAUDE_VERSION%% *}
  [ -x "$dst" ] || { mkdir -p "$(dirname "$dst")"; cp "$src" "$dst.new"; mv "$dst.new" "$dst"; }
  export LM_CLAUDE_BIN=$dst
  echo "claude $LFX_CLAUDE_VERSION from $src as $dst ($(sha256sum "$dst" | cut -c1-16))"
  if [ -f "$LM_DIR/model.pid" ] && kill -0 "$(cat "$LM_DIR/model.pid")" 2>/dev/null; then kill "$(cat "$LM_DIR/model.pid")"; sleep 1; fi
  setsid -f python3 -I "$HERE/scripted-model.py" "$LFX_MODEL_PORT" "$LM_DIR/logs/fake-claude.jsonl" \
    >> "$LM_DIR/logs/scripted-model.out" 2>&1 < /dev/null
  for _ in $(seq 1 20); do pid=$(pgrep -f "scripted-model.py $LFX_MODEL_PORT" | head -1); [ -n "$pid" ] && break; sleep 0.5; done
  echo "${pid:?the scripted model did not start}" > "$LM_DIR/model.pid"
  echo "scripted model pid $pid"
  # The engine's user settings in the runner's HOME: its Bash tool and the orbit MCP tools are allowed.
  mkdir -p "$LM_DIR/runner-userhome/.claude"
  printf '{"permissions":{"allow":["Bash","mcp__orbit"]}}\n' > "$LM_DIR/runner-userhome/.claude/settings.json"
fi
step "runner: build from this checkout and restart"
heavy bash "$KIT/stack.sh" build-runner
bash "$KIT/stack.sh" stop-runner
bash "$KIT/stack.sh" start-runner || echo "(not registered yet: bootstrap registers it)"
cd "$KIT"
node bootstrap.mjs lfx-line | grep -E '^(runner|workspace) |"version"' || true
set +e
step "the four cases (run $LM_RUN)"
node "$HERE/cases.mjs"; rc=$?
step "recorded queries ($LM_DIR/records/$LM_RUN/lfx-cases/queries.txt)"
cat "$LM_DIR/records/$LM_RUN/lfx-cases/queries.txt"
step "result: cases.mjs exit $rc"
exit "$rc"
