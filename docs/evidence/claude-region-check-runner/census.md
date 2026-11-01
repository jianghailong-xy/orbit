# Claude region check: the runner's census

Every place `src/runner-go` starts `claude` or calls an Anthropic host. Each row says what stops it while the region
check answers blocked, and what keeps it off Anthropic when it runs anyway, or why it needs neither
(`docs/claude-region-check-contract.md`, "The runner's other requests to Anthropic"). `census.py`, in this directory,
writes this file and checks it against the code:

    cd src/runner-go && python3 -I ../../docs/evidence/claude-region-check-runner/census.py . --markdown

The gates, all in `claude_region.go`:

- `claudeRegionRefusal`: an Anthropic-bound Claude turn, on an answer under a minute old (the runner task, §10).
- `claudeConnectionBlocked`: the usage read and the Claude sign-in, on that same answer.
- `claudeStartBlocked`: a `claude` the runner starts for itself, when that `claude` is Anthropic-bound (①).
- `claudeLoginBlocked`: the same, but only where a login or key is stored (`auth status`, update, install).
- `claudeQuietEnv`: a `claude` that runs while blocked because it is not Anthropic-bound gets
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. That is decided from the last decided answer the check holds
  (`claudeStartsQuiet`), with no request and no wait.

| File | Function | Starts or calls | While blocked | When it runs, off Anthropic | Why |
| --- | --- | --- | --- | --- | --- |
| `session.go` | `runSessionProcess` | a session's claude: cold start (ensureEngine, then the runtime) | `claudeRegionRefusal` | — | Anthropic-bound turns refused before anything is installed or spawned (§10, runner task) |
| `session.go` | `runClaudeSessionProcess` | spawnClaude; a message written to the running claude | `claudeRegionRefusal` | — | delivery refused (§10); the spawn happens only past runSessionProcess's gate |
| `claude_spawn.go` | `spawnClaude` | the session's claude, first spawn and respawn | — | `claudeQuietEnv` | gated by its caller; a session on another provider's key runs quiet while blocked |
| `login.go` | `start` | claude auth login under script (pty) | `claudeConnectionBlocked` | — | refused with the sign-in sentence before a slot is added or anything runs |
| `login.go` | `ptyCommand` | script around claude auth login | — | — | only called from start, for Claude's flow, after its gate |
| `planusage.go` | `fetch` | GET api.anthropic.com/api/oauth/usage | `claudeConnectionBlocked` | — | no read and no token refresh while blocked |
| `planusage.go` | `refreshClaudeToken` | claude -p /help, to refresh a token for a usage read | — | — | only called from claudeUsageRead.login, after fetch's gate |
| `worktree.go` | `generateCommitMessage` | claude -p &lt;prompt + diff&gt; --model sonnet | `claudeStartBlocked` | `claudeQuietEnv` | the diffstat message instead |
| `transcript_rebuild.go` | `summarizeReplayHead` | claude -p &lt;prompt + digest&gt; --model sonnet | `claudeStartBlocked` | `claudeQuietEnv` | the mechanical digest instead |
| `slash_registry.go` | `ensureClaudeSlashRegistry` | probeClaudeSlashAssets | `claudeStartBlocked` | — | the registry keeps what it has |
| `slash_registry.go` | `probeClaudeSlashAssets` | claude -p /help (the slash-command registry) | — | `claudeQuietEnv` | only called from ensureClaudeSlashRegistry, after its gate |
| `claude_models.go` | `fetchClaudeModelCatalog` | the three catalog probes below | `claudeStartBlocked` | — | the round fails and the catalog stays (mergeModelCatalog) |
| `claude_models.go` | `resolveClaudeModelName` | claude -p /model &lt;alias&gt; | — | `claudeQuietEnv` | only called from fetchClaudeModelCatalog, after its gate |
| `claude_models.go` | `fetchClaudeContextWindow` | claude -p /context | — | `claudeQuietEnv` | only called from fetchClaudeModelCatalog, after its gate |
| `claude_models.go` | `fetchClaudeModelCapabilities` | claude -p /fast | — | `claudeQuietEnv` | only called from fetchClaudeModelCatalog, after its gate |
| `doctor.go` | `probeAuthIn` | claude auth status (Default and every account) | `claudeLoginBlocked` | `claudeQuietEnv` | measured: sends a stored login to /api/oauth/profile; unknown while blocked with a login |
| `engineupdate.go` | `updateEngine` | sh -c 'claude update' | `claudeLoginBlocked` | `claudeQuietEnv` | measured: sends a stored login to api.anthropic.com; skipped and recorded while blocked with a login |
| `engineinstall.go` | `installEngineNow` | sh -c &lt;installer&gt; (claude install), the Install button | `claudeLoginBlocked` | `claudeQuietEnv` | measured as update; refused with why while blocked with a login |
| `engineinstall.go` | `ensureEngine` | sh -c &lt;installer&gt; (claude install), on demand | `claudeLoginBlocked` | `claudeQuietEnv` | measured as update; refused with why while blocked with a login |
| `engineupdate.go` | `latestEngineVersion` | GET downloads.claude.ai/claude-code-releases/latest | — | — | a plain GET with no credential |
| `doctor.go` | `engineVersion` | claude --version | — | — | measured: connects nowhere |
| `doctor.go` | `engineStarts` | claude --version | — | — | measured: connects nowhere |
| `transcript_rebuild.go` | `claudeCLIVersion` | claude --version | — | — | measured: connects nowhere |
| `doctor.go` | `signInEngine` | claude auth login (doctor, interactive) | — | — | runDoctor offers it only while its own fresh check is not blocked |
| `doctor.go` | `loginHelpMentions` | &lt;engine&gt; &lt;login args&gt; --help | — | — | never claude: asked for codex's --device-auth and kimi's --region only |
| `doctor.go` | `runInstallCmd` | the installer (doctor, interactive) | — | — | a person at their own terminal, asked first |
| `main.go` | `resumeCommand` | claude --resume (orbit resume) | — | — | a person at their own terminal |
| `antigravity_google.go` | `antigravityGoogleCommand` | agy | — | — | not claude |
| `doctor.go` | `codexLoginStatus` | codex login status | — | — | not claude |
| `doctor.go` | `probeKimiACPAuth` | kimi acp | — | — | not claude |
| `kimi_region.go` | `probeKimiLoginRegion` | kimi provider list | — | — | not claude |
| `hostd_update.go` | `probeCmd` | the orbit binary | — | — | not claude |
| `selfupdate.go` | `probeAsThisProcess` | the orbit binary | — | — | not claude |

How it is checked:

- Every site the patterns in `census.py` find in the non-test sources belongs to a row. The patterns cover an exec of
  `claude`, `commitMsgEngine`, a `binPath` or a `path`; `sh -c` of an installer or update command; `ptyCommand`;
  `planUsageURL`; a release feed URL; and `spawnClaude`.
- Each row's gate and quiet helper appear in its function.
- Each "only called from" holds for every call site.

A `claude` started under a name those patterns miss would not be found. What each start sends was measured on Claude
Code 2.1.316 (`measurements.md`).
