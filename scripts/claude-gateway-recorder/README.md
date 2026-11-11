# Recording what Claude Code sends to an Anthropic endpoint

The fixtures in `src/apiserver/src/providers/fixtures/claude-cli-<version>/` were recorded with these three scripts.
They feed the spec of the Claude-on-OpenAI gateway's translator (`src/apiserver/src/providers/anthropic-gateway.spec.ts`,
design `docs/claude-engine-openai-gateway-design.md` §8).

- `recorder.mjs` is a fake Anthropic endpoint on `127.0.0.1:18555`. It writes every request to `rec/<scenario>/NNN-<role>.json`
  and answers from a small script for each scenario (thinking with an `orbit1.` signature, two parallel tool calls, Read on
  a PNG, an Agent call, ToolSearch then WebFetch, a "prompt is too long" 400, …).
- `drive.sh <scenario> <prompt> [claude args]` runs the claude CLI with the runner's flags (`claude_spawn.go`) and the
  environment of `custom-provider.ts` `injectedEnv`'s `claudeEnv` block. Its base URL is `http://127.0.0.1:18555/s/<scenario>`.
  It uses a fresh `HOME` and `CLAUDE_CONFIG_DIR`, so no sign-in, memory or settings of the machine reach the recording.
  `PROMPT2` and `PROMPT3` add later turns. `HAIKU` sets `ANTHROPIC_DEFAULT_HAIKU_MODEL`.
- `sanitize.py <rec dir> <fixtures dir>` keeps the headers that matter and replaces device ids, session ids, agent ids
  and scratch paths. Requests whose tools equal the first request's tools store `"$basic.tools"` in their place.

Re-record whenever the CLI version the runners install changes:

```sh
mkdir -p /scratch/rec-root && cd /scratch/rec-root && mkdir -p rec work && git -C work init -q
node <repo>/scripts/claude-gateway-recorder/recorder.mjs &        # from /scratch/rec-root
<repo>/scripts/claude-gateway-recorder/drive.sh basic "Say hello."
for L in low medium high xhigh max; do <repo>/scripts/claude-gateway-recorder/drive.sh effort-$L "Say ok." --effort $L; done
# … the scenarios listed in sanitize.py's SC table
python3 -I <repo>/scripts/claude-gateway-recorder/sanitize.py rec <repo>/src/apiserver/src/providers/fixtures/claude-cli-<version>
```

`work/red.png` must exist (any small PNG) for the `image` scenario.
