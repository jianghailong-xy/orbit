# Claude region check: what each `claude` start sends Anthropic

Measured on 2026-11-01 on Claude Code 2.1.316 (the native build), for task 34pVMqrcXlTdmVm2n6i1d. These results back
the gates in `census.md`.

## Method

- **Network:** a namespace with only loopback (`unshare -n`). Nothing can leave the machine.
- **Logins:** every login and key is fake. Each case gets its own `HOME` and `CLAUDE_CONFIG_DIR`, holding a
  `.credentials.json` with a valid, expired or no Claude OAuth login.
- **Recorder:** `HTTPS_PROXY` points at a recorder on 127.0.0.1. It answers `CONNECT` and terminates TLS with a
  throwaway CA, which the CLI trusts through `NODE_EXTRA_CA_CERTS`. For each request it logs the host, method and path,
  and which credential headers it carried (name and a short prefix of the value).
- **Answers:** a fake DeepSeek answers `api.deepseek.com` (the Anthropic Messages API, streamed). Every other host
  gets `503`.
- **Two kinds of token:**
  - `sk-ant-oat01…` is the stored Claude login.
  - `sk-deepseek…` is the DeepSeek key, given as `ANTHROPIC_AUTH_TOKEN` with
    `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`.
- **Cross-check:** a first pass recorded only the `CONNECT` targets, plus `strace -e connect`. It found no connection
  that skipped the proxy.

## Results

"Bearer login" means `authorization: Bearer sk-ant-oat01…`: the stored Claude login was sent.

### Claude Code on Anthropic

| Command | Login stored | Requests to Anthropic |
| --- | --- | --- |
| `claude --version` | valid, expired | none |
| `claude -p /help` (no model call) | valid | Bearer login to `/api/claude_cli/bootstrap`, `/api/claude_code_penguin_mode`, `/api/oauth/profile`, `/api/eval/…`, `/api/event_logging/v2/batch`; `/mcp-registry/v0/servers` with no credential |
| `claude -p /help` with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | valid | Bearer login to `/api/oauth/profile`, nothing else: the variable is not enough for a `claude` that talks to Anthropic, which is why those starts are gated rather than quieted |
| `claude auth status` | valid | Bearer login to `/api/oauth/profile` |
| `claude auth status` | expired | the same, plus `POST platform.claude.com/v1/oauth/token` (the refresh) |
| `claude update`, `claude install` | valid | Bearer login to `/api/oauth/profile`, `/api/eval/…`, `/api/event_logging/v2/batch`; `downloads.claude.ai/claude-code-releases/latest` with no credential |
| `claude update`, `claude install` | none | `/api/event_logging/v2/batch` and the downloads check, both with no credential |

### Claude Code on DeepSeek, with a Claude login stored

| Start | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | Requests to Anthropic | To DeepSeek |
| --- | --- | --- | --- |
| A turn: `-p --input-format stream-json …`, the runner's flags with `--prompt-suggestions`, two user messages | unset | Bearer login to `/api/claude_cli/bootstrap` and `/api/claude_code_penguin_mode`; `/mcp-registry/v0/servers` and 4× `/api/event_logging/v2/batch` with no credential | both turns and the prompt-suggestion request, with the DeepSeek key; both replies and one `prompt_suggestion` frame come back |
| The same turn | `1` | **none** | the same: both turns, the prompt-suggestion request, both replies and the `prompt_suggestion` frame |
| `-p <commit prompt> --output-format text` | `1` | none | one request, answered |
| `-p --setting-sources user "/model sonnet"` | `1` | none | none |
| `-p /help` | unset | Bearer login to `/api/claude_cli/bootstrap` and `/api/claude_code_penguin_mode`; `/mcp-registry/v0/servers` and event logging with no credential | none |
| `-p /help` | `1` | none | none |
| `claude auth status` | unset, `1` | none | none |
| `claude update` | unset | `/api/event_logging/v2/batch` with no credential; the downloads check | none |
| `claude update`, `claude install` | `1` | none; the downloads check still runs, so the variable does not stop an explicit update | none |

### What the variable turns off in that turn

Read from the `system/init` frame of the two runs, with and without the variable:

- `analytics_disabled` and `product_feedback_disabled` become `true`.
- The built-in `cc-plugin-telemetry` plugin is not loaded.
- The Design feature is gone: the skills `design` and `design-sync`, the commands `/design`, `/design-consent`,
  `/design-revoke` and `/design-sync`, and the tool `DesignSync`.

The replies, the prompt suggestion and every other field of the frame are the same.

## What follows for the runner

- Any `claude` start can carry a stored login to Anthropic, even one that asks no model anything. So the runner's own
  starts wait while blocked where they would talk to Anthropic (`claudeStartBlocked`).
- `auth status`, `update` and `install` send nothing credentialed without a stored login, so they wait only where one
  is stored (`claudeLoginBlocked`).
- Claude Code on another provider's key still sends a stored Claude login to Anthropic as it starts. With the variable
  it sends Anthropic nothing and keeps its turn, reply and suggestion, so every such start runs with it while blocked
  (`claudeQuietEnv`).
