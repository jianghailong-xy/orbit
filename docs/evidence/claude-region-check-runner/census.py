"""The Claude region check's runner census (docs/claude-region-check-contract.md, "The runner's other requests").

Every place src/runner-go starts `claude` or calls an Anthropic host, each with what stops it while the region check
answers blocked and what keeps it off Anthropic when it runs anyway, or why it needs neither.

    python3 -I census.py <src/runner-go>             check the table against the code; exit 1 on a mismatch
    python3 -I census.py <src/runner-go> --markdown  the same, printed as census.md

The check: every site the patterns below find in the non-test sources belongs to an entry; each entry's gate and
quiet helper appear in its function; and each "only called from" holds for every call site.
"""
import glob
import os
import re
import sys

GATE_BY_TURN = "claudeRegionRefusal"
# (file, function, what it starts or calls, gate while blocked, quiet helper, why)
CENSUS = [
    ("session.go", "runSessionProcess", "a session's claude: cold start (ensureEngine, then the runtime)", GATE_BY_TURN, None,
     "Anthropic-bound turns refused before anything is installed or spawned (§10, runner task)"),
    ("session.go", "runClaudeSessionProcess", "spawnClaude; a message written to the running claude", GATE_BY_TURN, None,
     "delivery refused (§10); the spawn happens only past runSessionProcess's gate"),
    ("claude_spawn.go", "spawnClaude", "the session's claude, first spawn and respawn", None, "claudeQuietEnv",
     "gated by its caller; a session on another provider's key runs quiet while blocked"),
    ("login.go", "start", "claude auth login under script (pty)", "claudeConnectionBlocked", None,
     "refused with the sign-in sentence before a slot is added or anything runs"),
    ("login.go", "ptyCommand", "script around claude auth login", None, None,
     "only called from start, for Claude's flow, after its gate"),
    ("planusage.go", "fetch", "GET api.anthropic.com/api/oauth/usage", "claudeConnectionBlocked", None,
     "no read and no token refresh while blocked"),
    ("planusage.go", "refreshClaudeToken", "claude -p /help, to refresh a token for a usage read", None, None,
     "only called from claudeUsageRead.login, after fetch's gate"),
    ("worktree.go", "generateCommitMessage", "claude -p <prompt + diff> --model sonnet", "claudeStartBlocked", "claudeQuietEnv",
     "the diffstat message instead"),
    ("transcript_rebuild.go", "summarizeReplayHead", "claude -p <prompt + digest> --model sonnet", "claudeStartBlocked", "claudeQuietEnv",
     "the mechanical digest instead"),
    ("slash_registry.go", "ensureClaudeSlashRegistry", "probeClaudeSlashAssets", "claudeStartBlocked", None,
     "the registry keeps what it has"),
    ("slash_registry.go", "probeClaudeSlashAssets", "claude -p /help (the slash-command registry)", None, "claudeQuietEnv",
     "only called from ensureClaudeSlashRegistry, after its gate"),
    ("claude_models.go", "fetchClaudeModelCatalog", "the three catalog probes below", "claudeStartBlocked", None,
     "the round fails and the catalog stays (mergeModelCatalog)"),
    ("claude_models.go", "resolveClaudeModelName", "claude -p /model <alias>", None, "claudeQuietEnv",
     "only called from fetchClaudeModelCatalog, after its gate"),
    ("claude_models.go", "fetchClaudeContextWindow", "claude -p /context", None, "claudeQuietEnv",
     "only called from fetchClaudeModelCatalog, after its gate"),
    ("claude_models.go", "fetchClaudeModelCapabilities", "claude -p /fast", None, "claudeQuietEnv",
     "only called from fetchClaudeModelCatalog, after its gate"),
    ("doctor.go", "probeAuthIn", "claude auth status (Default and every account)", "claudeLoginBlocked", "claudeQuietEnv",
     "measured: sends a stored login to /api/oauth/profile; unknown while blocked with a login"),
    ("engineupdate.go", "updateEngine", "sh -c 'claude update'", "claudeLoginBlocked", "claudeQuietEnv",
     "measured: sends a stored login to api.anthropic.com; skipped and recorded while blocked with a login"),
    ("engineinstall.go", "installEngineNow", "sh -c <installer> (claude install), the Install button", "claudeLoginBlocked", "claudeQuietEnv",
     "measured as update; refused with why while blocked with a login"),
    ("engineinstall.go", "ensureEngine", "sh -c <installer> (claude install), on demand", "claudeLoginBlocked", "claudeQuietEnv",
     "measured as update; refused with why while blocked with a login"),
    ("engineupdate.go", "latestEngineVersion", "GET downloads.claude.ai/claude-code-releases/latest", None, None,
     "a plain GET with no credential"),
    ("doctor.go", "engineVersion", "claude --version", None, None, "measured: connects nowhere"),
    ("doctor.go", "engineStarts", "claude --version", None, None, "measured: connects nowhere"),
    ("transcript_rebuild.go", "claudeCLIVersion", "claude --version", None, None, "measured: connects nowhere"),
    ("doctor.go", "signInEngine", "claude auth login (doctor, interactive)", None, None,
     "runDoctor offers it only while its own fresh check is not blocked"),
    ("doctor.go", "loginHelpMentions", "<engine> <login args> --help", None, None,
     "never claude: asked for codex's --device-auth and kimi's --region only"),
    ("doctor.go", "runInstallCmd", "the installer (doctor, interactive)", None, None, "a person at their own terminal, asked first"),
    ("main.go", "resumeCommand", "claude --resume (orbit resume)", None, None, "a person at their own terminal"),
    ("antigravity_google.go", "antigravityGoogleCommand", "agy", None, None, "not claude"),
    ("doctor.go", "codexLoginStatus", "codex login status", None, None, "not claude"),
    ("doctor.go", "probeKimiACPAuth", "kimi acp", None, None, "not claude"),
    ("kimi_region.go", "probeKimiLoginRegion", "kimi provider list", None, None, "not claude"),
    ("hostd_update.go", "probeCmd", "the orbit binary", None, None, "not claude"),
    ("selfupdate.go", "probeAsThisProcess", "the orbit binary", None, None, "not claude"),
]
# Every non-test call of these runs inside the named functions.
CALLERS = {
    "refreshClaudeToken": {"login"},
    "probeClaudeSlashAssets": {"ensureClaudeSlashRegistry"},
    "fetchClaudeContextWindow": {"fetchClaudeModelCatalog"},
    "fetchClaudeModelCapabilities": {"fetchClaudeModelCatalog"},
    "resolveClaudeModelName": {"fetchClaudeModelCatalog"},
    "spawnClaude": {"runClaudeSessionProcess"},
    "ptyCommand": {"start"},
    "signInEngine": {"runDoctor"},
}
HEADER = """
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
"""
FOOTER = """
How it is checked:

- Every site the patterns in `census.py` find in the non-test sources belongs to a row. The patterns cover an exec of
  `claude`, `commitMsgEngine`, a `binPath` or a `path`; `sh -c` of an installer or update command; `ptyCommand`;
  `planUsageURL`; a release feed URL; and `spawnClaude`.
- Each row's gate and quiet helper appear in its function.
- Each "only called from" holds for every call site.

A `claude` started under a name those patterns miss would not be found. What each start sends was measured on Claude
Code 2.1.316 (`measurements.md`).
"""
SITE = re.compile(r'exec\.Command(Context)?\([^)]*("claude"|commitMsgEngine|binPath|cmdStr|spec\.installCmd|path, args)'
                  r'|ptyCommand\(|planUsageURL|spec\.latestURL|"claude", claudeTokenRefreshArgs|spawnClaude\(procCtx')
FUNC = re.compile(r'^func (\([^)]*\) )?([A-Za-z0-9_]+)\(')


def functions(path):
    out, name, start = [], None, 0
    lines = open(path, encoding="utf-8").read().split("\n")
    for i, line in enumerate(lines, 1):
        m = FUNC.match(line)
        if m:
            if name:
                out.append((name, start, i - 1))
            name, start = m.group(2), i
    if name:
        out.append((name, start, len(lines)))
    return out, lines


def check(root):
    problems = []
    for path in sorted(glob.glob(os.path.join(root, "*.go"))):
        base = os.path.basename(path)
        if base.endswith("_test.go"):
            continue
        funcs, lines = functions(path)
        for name, start, end in funcs:
            for off, line in enumerate(lines[start - 1:end]):
                if line.lstrip().startswith("//") or not SITE.search(line):
                    continue
                if not any(e[0] == base and e[1] == name for e in CENSUS):
                    problems.append(f"unaccounted site {base}:{start + off} in {name}: {line.strip()}")
    for file, func, _, gate, quiet, _ in CENSUS:
        funcs, lines = functions(os.path.join(root, file))
        match = [f for f in funcs if f[0] == func]
        if not match:
            problems.append(f"{file}: no func {func}")
            continue
        _, start, end = match[0]
        body = "\n".join(lines[start - 1:end])
        for symbol in (gate, quiet):
            if symbol and symbol not in body:
                problems.append(f"{file} {func}: {symbol} missing")
    for callee, allowed in CALLERS.items():
        found = set()
        for path in sorted(glob.glob(os.path.join(root, "*.go"))):
            if path.endswith("_test.go"):
                continue
            funcs, lines = functions(path)
            for name, start, end in funcs:
                for line in lines[start - 1:end]:
                    code = line.split("//", 1)[0]
                    if re.search(r"\b" + callee + r"\(", code) and not code.startswith("func "):
                        found.add(name)
        if not found or not found <= allowed:
            problems.append(f"callers of {callee}: {sorted(found)}, want within {sorted(allowed)}")
    return problems


def markdown():
    rows = ["| File | Function | Starts or calls | While blocked | When it runs, off Anthropic | Why |",
            "| --- | --- | --- | --- | --- | --- |"]
    def cell(text):
        return text.replace("<", "&lt;").replace(">", "&gt;").replace("|", "\\|")
    for file, func, what, gate, quiet, why in CENSUS:
        rows.append(f"| `{file}` | `{func}` | {cell(what)} | {('`' + gate + '`') if gate else '—'} | "
                    f"{('`' + quiet + '`') if quiet else '—'} | {cell(why)} |")
    return "\n".join(rows)


if __name__ == "__main__":
    root = sys.argv[1]
    problems = check(root)
    if "--markdown" in sys.argv:
        print(HEADER.strip() + "\n\n" + markdown() + "\n\n" + FOOTER.strip())
    for p in problems:
        print("PROBLEM:", p, file=sys.stderr)
    if not problems and "--markdown" not in sys.argv:
        print(f"{len(CENSUS)} entries; every site accounted for, every gate and quiet helper in place, every caller as listed")
    sys.exit(1 if problems else 0)
