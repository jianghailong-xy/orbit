#!/bin/bash
# drive.sh <scenario> <prompt> [extra claude args...]   (PROMPT2/PROMPT3 env: later turns, GAP seconds apart)
# Runs the shipped claude CLI the way the runner does (claude_spawn.go flags), with the env of
# custom-provider.ts injectedEnv's claudeEnv block, against the recorder.
set -u
SC=$1; PROMPT=$2; shift 2
ROOT=${ROOT:-$PWD}
CLAUDE=${CLAUDE:-$(command -v claude)}
H=$ROOT/home-$SC; rm -rf "$H"; mkdir -p "$H/.claude"
W=$ROOT/work; mkdir -p "$W"
cd "$W"
mk() { python3 -I -c 'import json,sys;print(json.dumps({"type":"user","message":{"role":"user","content":[{"type":"text","text":sys.argv[1]}]}}))' "$1"; }
{
  mk "$PROMPT"
  for p in "${PROMPT2:-}" "${PROMPT3:-}"; do [ -n "$p" ] && { sleep "${GAP:-8}"; mk "$p"; }; done
} |
env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$H" CLAUDE_CONFIG_DIR="$H/.claude" TERM=dumb IS_SANDBOX=1 \
  ANTHROPIC_BASE_URL="${BASE:-http://127.0.0.1:18555/s/$SC}" \
  ANTHROPIC_AUTH_TOKEN="${TOKEN:-orbit-gwk-FAKE-TOKEN-FOR-RECORDING}" \
  ANTHROPIC_MODEL="${MODEL:-gpt-5.5}" \
  ENABLE_CLAUDEAI_MCP_SERVERS=0 \
  CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP=1 \
  CLAUDE_CODE_INLINE_TOOLS=false \
  CLAUDE_CODE_MAX_CONTEXT_TOKENS=${MAXCTX:-350000} \
  ${HAIKU:+ANTHROPIC_DEFAULT_HAIKU_MODEL=$HAIKU} \
  ${EXTRA_ENV:-} \
  timeout 240 "$CLAUDE" -p --input-format stream-json --output-format stream-json --include-partial-messages \
    --replay-user-messages --verbose --model "${MODEL:-gpt-5.5}" --permission-mode bypassPermissions "$@" \
  > "$ROOT/rec/$SC.stdout.jsonl" 2> "$ROOT/rec/$SC.stderr.txt"
echo "exit=$? scenario=$SC"
