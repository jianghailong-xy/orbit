package main

import (
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// codexAutoApprovalContext describes the roots that Auto may use without asking. The context is
// only a request-level classifier; it never expands the execution scope on its own.
type codexAutoApprovalContext struct {
	workspaceRoots []string
	tempRoots      []string
	// readOnlyRoots are known repository roots that Auto may inspect with the small
	// read-only Git grammar below. They are deliberately separate from workspaceRoots:
	// seeing a repository is safe for status/log, but it must not grant writes there.
	readOnlyRoots []string
}

func codexAutoApprovalContextFor(execDir, upDir string, readOnlyRoots ...string) codexAutoApprovalContext {
	return codexAutoApprovalContext{
		workspaceRoots: []string{execDir, upDir},
		tempRoots:      []string{upDir},
		readOnlyRoots:  append([]string(nil), readOnlyRoots...),
	}
}

func codexRuntimeWorkspaceRoots(permissionMode string, job *ClaimedSession, execDir, upDir string) []string {
	roots := []string{execDir, upDir}
	if permissionMode == "auto" {
		if job != nil && job.WT != nil && job.WT.RepoDir != "" {
			// A linked worktree stores its index and worktree metadata in the shared repository's
			// .git directory. Grant that metadata directory alone so local git commands do not
			// become boundary crossings; the repository's source files remain outside.
			roots = append(roots, filepath.Join(job.WT.RepoDir, ".git"))
		}
		// The session's Go and npm caches live in the runner-owned shared cache root, and the
		// sandbox makes everything else under ORBIT_HOME read-only. Without this grant a
		// sandboxed `go build` fails on GOCACHE with "read-only file system" and the agent
		// invents a cache directory of its own (cache_root.go).
		roots = append(roots, runnerCacheRoot())
	}
	return roots
}

func codexSandboxPolicy(permissionMode string, job *ClaimedSession, execDir, upDir string) map[string]interface{} {
	if permissionMode == "auto" {
		return map[string]interface{}{
			"type":          "workspaceWrite",
			"writableRoots": codexRuntimeWorkspaceRoots(permissionMode, job, execDir, upDir),
			"networkAccess": false,
		}
	}
	return map[string]interface{}{"type": "dangerFullAccess"}
}

func codexSandboxMode(permissionMode string) string {
	if permissionMode == "auto" {
		return "workspace-write"
	}
	return "danger-full-access"
}

// codexAutoApproval answers the narrow, request-level part of Auto's policy. An undecided result
// is deliberately sent to the normal approval card: Auto reduces routine interruptions, while
// keeping a human in the loop for boundaries and high-impact operations.
func codexAutoApproval(request codexApprovalRequest, params map[string]interface{}, autoContext codexAutoApprovalContext) (allowed, decided bool) {
	if request.mcpTool {
		return false, false
	}
	if len(autoContext.workspaceRoots) == 0 {
		return false, false
	}
	if request.fileChange {
		// A grantRoot means Codex is asking to expand the write boundary. The sandbox may still
		// reject the change, so let the owner decide before attempting it.
		if firstString(params, "grantRoot", "grant_root") != "" {
			return false, false
		}
		return true, true
	}

	if firstString(params, "kind") == "writeStdin" {
		return false, false
	}
	if firstString(params, "grantRoot", "grant_root") != "" || codexAutoAdditionalPermissionRequested(params) {
		return false, false
	}

	cwd := firstString(params, "cwd")
	if cwd == "" {
		cwd = autoContext.workspaceRoots[0]
	}
	command := strings.TrimSpace(firstString(params, "command"))
	if command == "" {
		return false, false
	}
	insideWorkspace := codexPathWithinRoots(cwd, autoContext.workspaceRoots)
	insideReadOnlyRoot := codexPathWithinRoots(cwd, autoContext.readOnlyRoots)
	readOnlyRoots := append(append([]string{}, autoContext.workspaceRoots...), autoContext.readOnlyRoots...)
	readOnlyGit := codexAutoReadOnlyGitCommand(command, cwd, readOnlyRoots)
	if !insideWorkspace && !insideReadOnlyRoot {
		return false, false
	}
	if !insideWorkspace && !readOnlyGit {
		return false, false
	}
	if (codexAutoCommandTargetsOutsideRoots(command, cwd, autoContext.workspaceRoots) && !readOnlyGit) ||
		codexAutoCommandNeedsApproval(command, autoContext.tempRoots) {
		return false, false
	}
	return true, true
}

func codexAutoAdditionalPermissionRequested(params map[string]interface{}) bool {
	for _, key := range []string{"networkApprovalContext", "proposedExecpolicyAmendment"} {
		if params[key] != nil {
			return true
		}
	}
	additional := mapValue(params["additionalPermissions"])
	if additional == nil {
		return false
	}
	if network := mapValue(additional["network"]); network != nil {
		if enabled, ok := network["enabled"].(bool); ok && !enabled && len(network) == 1 {
			// Codex sometimes echoes an explicit disabled overlay. It does not expand access.
		} else {
			return true
		}
	} else if additional["network"] != nil {
		return true
	}
	if filesystem := mapValue(additional["fileSystem"]); filesystem != nil {
		for _, key := range []string{"entries", "read", "write"} {
			if values, ok := filesystem[key].([]interface{}); ok && len(values) > 0 {
				return true
			}
		}
		if filesystem["globScanMaxDepth"] != nil {
			return true
		}
	} else if additional["fileSystem"] != nil {
		return true
	}
	return false
}

func codexPathWithinRoots(path string, roots []string) bool {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	absolute = filepath.Clean(absolute)
	for _, root := range roots {
		rootAbsolute, err := filepath.Abs(root)
		if err != nil {
			continue
		}
		rootAbsolute = filepath.Clean(rootAbsolute)
		if absolute == rootAbsolute || strings.HasPrefix(absolute, rootAbsolute+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

func codexAutoCommandNeedsApproval(command string, tempRoots []string) bool {
	lower := strings.ToLower(command)
	for _, word := range []string{
		"wget", "ssh", "scp", "socat", "sudo", "doas", "printenv",
		"chmod", "chown", "mkfs", "shutdown", "reboot", "poweroff", "launchctl", "systemctl",
	} {
		if codexShellWord(lower, word) {
			return true
		}
	}
	if codexShellWord(lower, "curl") && !codexAutoLocalHealthProbe(command) {
		return true
	}
	for _, phrase := range []string{
		"git push", "git remote add", "git reset --hard", "git clean", "git fetch", "git pull", "git clone",
		"git branch -d", "git update-ref", "git worktree",
		"npm install", "npm ci", "pnpm install", "yarn install", "pip install", "go get", "cargo add", "docker pull",
		"dd if=", "python -c", "python3 -c", "node -e", "perl -e", "ruby -e",
		"/etc/shadow", ".ssh/", ".aws/", ".netrc", ".env", "auth.json", "id_rsa", "id_ed25519",
		"openai_api_key", "anthropic_api_key", "rm -rf", "rm -r ",
	} {
		if strings.Contains(lower, phrase) {
			if strings.Contains(phrase, "rm -") && codexTempCleanupCommand(command, tempRoots) {
				continue
			}
			return true
		}
	}
	return false
}

// codexAutoReadOnlyGitCommand recognizes the narrow read-only Git status checks that may inspect
// a runner-known repository root outside the session worktree. Keeping this separate from the
// normal workspace roots matters: it does not grant writes to that repository, and a command that
// is not one of these exact read-only forms still crosses the normal approval boundary.
func codexAutoReadOnlyGitCommand(command, cwd string, roots []string) bool {
	if len(roots) == 0 {
		return false
	}
	command = strings.TrimSpace(command)
	if body, wrapped := codexShellWrapperBody(command); wrapped {
		command = body
	}
	segments, ok := codexReadOnlyGitSegments(command)
	if !ok || len(segments) == 0 {
		return false
	}
	for _, segment := range segments {
		words, rest := codexShellWordsUntilOperator(strings.TrimSpace(segment))
		if rest != "" || len(words) < 2 {
			return false
		}
		i := 0
		for i < len(words) && codexShellEnvAssignment(words[i]) {
			i++
		}
		if i >= len(words) || filepath.Base(words[i]) != "git" {
			return false
		}
		args := words[i+1:]
		action, actionArgs, ok := codexReadOnlyGitAction(args)
		if !ok || !codexReadOnlyGitActionArgsAllowed(action, actionArgs) {
			return false
		}
		if codexAutoCommandTargetsOutsideRoots(segment, cwd, roots) {
			return false
		}
	}
	return true
}

func codexShellEnvAssignment(word string) bool {
	name, _, ok := strings.Cut(word, "=")
	if !ok || name == "" {
		return false
	}
	for i, r := range name {
		if !(r == '_' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || i > 0 && r >= '0' && r <= '9') {
			return false
		}
	}
	return true
}

func codexReadOnlyGitAction(args []string) (string, []string, bool) {
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "-C" || arg == "--git-dir" || arg == "--work-tree" || arg == "-c":
			if i+1 >= len(args) {
				return "", nil, false
			}
			i++
		case strings.HasPrefix(arg, "-C") && len(arg) > 2,
			strings.HasPrefix(arg, "--git-dir="),
			strings.HasPrefix(arg, "--work-tree="),
			strings.HasPrefix(arg, "-c") && len(arg) > 2,
			arg == "--no-pager", arg == "--paginate", arg == "--no-replace-objects":
		default:
			if strings.HasPrefix(arg, "-") {
				return "", nil, false
			}
			return arg, args[i+1:], true
		}
	}
	return "", nil, false
}

func codexReadOnlyGitActionArgsAllowed(action string, args []string) bool {
	allowed := map[string]map[string]bool{
		"status": {
			"-s": true, "--short": true, "-b": true, "--branch": true,
			"--porcelain": true, "--ahead-behind": true, "--ignored": true,
			"--untracked-files": true, "--untracked-files=no": true,
			"--untracked-files=normal": true, "--untracked-files=all": true,
		},
		"log": {
			"-1": true, "--oneline": true, "--decorate": true, "--no-decorate": true,
			"--stat": true, "--shortstat": true, "--graph": true,
		},
		"rev-parse": {
			"HEAD": true, "--short": true, "--verify": true, "--show-toplevel": true,
			"--abbrev-ref": true, "--is-inside-work-tree": true,
		},
		"branch": {"--show-current": true, "--list": true, "-a": true, "--all": true},
	}
	for _, arg := range args {
		if !allowed[action][arg] {
			return false
		}
	}
	return allowed[action] != nil
}

func codexReadOnlyGitSegments(command string) ([]string, bool) {
	segments := []string{}
	start := 0
	var quote byte
	for i := 0; i < len(command); i++ {
		c := command[i]
		if quote != 0 {
			if c == '\\' && quote == '"' && i+1 < len(command) {
				i++
				continue
			}
			if c == quote {
				quote = 0
			}
			continue
		}
		switch c {
		case '\'', '"':
			quote = c
		case '&':
			if i+1 >= len(command) || command[i+1] != '&' {
				return nil, false
			}
			segments = append(segments, command[start:i])
			i++
			start = i + 1
		case ';', '|', '\n':
			return nil, false
		}
	}
	if quote != 0 {
		return nil, false
	}
	segments = append(segments, command[start:])
	return segments, true
}

var (
	codexLocalHealthLoop = regexp.MustCompile(`(?is)^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+\$\(\s*seq\s+([0-9]+)\s+([0-9]+)\s*\)\s*;\s*do\s+(.+?)\s*;\s*done$`)
	codexLocalHealthBody = regexp.MustCompile(`(?is)^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\$\(\s*curl\s+(.+?)\s*\)\s*;\s*printf\s+(.+)$`)
)

// codexAutoLocalHealthProbe is the one network-shaped exception in Auto's command guard. It is
// intentionally narrower than "curl localhost": only a bounded GET/HEAD probe to loopback is
// accepted, with output discarded or reduced to an HTTP status. That covers the health checks the
// runner uses without turning an approval for curl into permission to upload data or reach a remote
// host. Anything that does not fit this small grammar keeps the normal human/reviewer path.
func codexAutoLocalHealthProbe(command string) bool {
	body, wrapped := codexShellWrapperBody(command)
	if wrapped {
		command = body
	} else {
		command = strings.TrimSpace(command)
	}
	command = strings.ReplaceAll(command, "'\"'\"'", "'")
	if match := codexLocalHealthLoop.FindStringSubmatch(command); match != nil {
		start, errStart := strconv.Atoi(match[2])
		end, errEnd := strconv.Atoi(match[3])
		if errStart != nil || errEnd != nil || start < 0 || end < start || end-start >= 20 {
			return false
		}
		body := codexLocalHealthBody.FindStringSubmatch(match[4])
		if body == nil || !codexLocalHealthPrintf(body[3], match[1], body[1]) {
			return false
		}
		return codexLocalCurlArgs(body[2])
	}
	if strings.HasPrefix(strings.ToLower(command), "curl ") {
		return codexLocalCurlArgs(strings.TrimSpace(command[len("curl"):]))
	}
	return false
}

func codexShellWrapperBody(command string) (string, bool) {
	trimmed := strings.TrimSpace(command)
	words, rest := codexShellWordsUntilOperator(trimmed)
	if len(words) == 3 && strings.TrimSpace(rest) == "" && (words[1] == "-c" || words[1] == "-lc") {
		switch filepath.Base(words[0]) {
		case "bash", "sh", "dash", "zsh", "ksh":
			return words[2], true
		}
	}
	fields := strings.Fields(trimmed)
	if len(fields) < 3 || (fields[1] != "-c" && fields[1] != "-lc") {
		return "", false
	}
	switch filepath.Base(fields[0]) {
	case "bash", "sh", "dash", "zsh", "ksh":
	default:
		return "", false
	}
	bodyStart := strings.Index(trimmed, fields[2])
	if bodyStart < 0 {
		return "", false
	}
	body := strings.TrimSpace(trimmed[bodyStart:])
	if len(body) < 2 || (body[0] != '\'' && body[0] != '"') || body[len(body)-1] != body[0] {
		return "", false
	}
	return body[1 : len(body)-1], true
}

func codexLocalHealthPrintf(format, loopVariable, resultVariable string) bool {
	format = strings.TrimSpace(format)
	if !strings.HasPrefix(format, "'") && !strings.HasPrefix(format, `"`) {
		return false
	}
	quote := format[0]
	close := strings.IndexByte(format[1:], quote)
	if close < 0 {
		return false
	}
	close++
	if format[1:close] != "%02d %s\\n" {
		return false
	}
	rest := strings.TrimSpace(format[close+1:])
	want := `"$` + loopVariable + `" "$` + resultVariable + `"`
	return rest == want
}

func codexLocalCurlArgs(raw string) bool {
	raw = strings.TrimSpace(raw)
	if at := strings.Index(raw, "||"); at >= 0 {
		fallback := strings.TrimSpace(raw[at+2:])
		if fallback != "printf '000'" && fallback != `printf "000"` && fallback != "printf 000" {
			return false
		}
		raw = strings.TrimSpace(raw[:at])
	}
	if strings.ContainsAny(raw, ";&|<") {
		return false
	}
	words, rest := codexShellWordsUntilOperator(raw)
	if rest != "" || len(words) == 0 {
		return false
	}
	maxTimeout := -1
	urls := 0
	for i := 0; i < len(words); i++ {
		word := strings.Trim(words[i], "'\"")
		switch word {
		case "-s", "-S", "-sS", "--silent", "--show-error", "-f", "--fail", "-I", "--head", "2>/dev/null":
			continue
		case "-m", "--max-time", "--connect-timeout":
			if i+1 >= len(words) {
				return false
			}
			i++
			value, err := strconv.Atoi(strings.Trim(words[i], "'\""))
			if err != nil || value < 0 || value > 10 {
				return false
			}
			maxTimeout = value
		case "-o":
			if i+1 >= len(words) || strings.Trim(words[i+1], "'\"") != "/dev/null" {
				return false
			}
			i++
		case "-w", "--write-out":
			if i+1 >= len(words) || strings.Trim(words[i+1], "'\"") != "%{http_code}" {
				return false
			}
			i++
		default:
			if !codexLocalHealthURL(word) {
				return false
			}
			urls++
		}
	}
	return urls == 1 && maxTimeout >= 0
}

func codexLocalHealthURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" || u.User != nil || u.Host == "" || u.Fragment != "" {
		return false
	}
	if port := u.Port(); port != "" {
		value, err := strconv.Atoi(port)
		if err != nil || value < 1 || value > 65535 {
			return false
		}
	}
	host := strings.ToLower(u.Hostname())
	return host == "127.0.0.1" || host == "localhost" || host == "::1"
}

// codexAutoCommandTargetsOutsideRoots recognizes Git's explicit path selectors. Checking only
// the request cwd is insufficient for commands such as `git -C /other/checkout status`: Git reads
// the checkout named by -C, not the process cwd. Unknown or variable selectors fail closed because
// Auto must be able to prove the target is inside the session's workspace before skipping a card.
func codexAutoCommandTargetsOutsideRoots(command, cwd string, roots []string) bool {
	if len(roots) == 0 {
		return true
	}
	// Codex wraps shell commands in bash -lc. Parse that quoting layer before
	// inspecting Git arguments, including any command after the wrapper.
	outer, rest := codexShellWordsUntilOperator(command)
	if len(outer) == 3 && (outer[1] == "-c" || outer[1] == "-lc") {
		switch filepath.Base(outer[0]) {
		case "bash", "sh", "dash", "zsh", "ksh":
			return codexAutoCommandTargetsOutsideRoots(outer[2], cwd, roots) ||
				(rest != "" && codexAutoCommandTargetsOutsideRoots(rest, cwd, roots))
		}
	}
	lower := strings.ToLower(command)
	for search := 0; search < len(lower); {
		relative := strings.Index(lower[search:], "git")
		if relative < 0 {
			break
		}
		at := search + relative
		if !codexShellWordAt(lower, at, len("git")) || (at > 0 && (lower[at-1] == '-' || lower[at-1] == '.')) {
			search = at + len("git")
			continue
		}
		suffixStart := at + len("git")
		// A quoted executable (`"git" -C ...`) leaves the closing quote just
		// after the word. Skip it before tokenizing the options.
		if suffixStart < len(command) && (command[suffixStart] == '\'' || command[suffixStart] == '"') {
			suffixStart++
		}
		tokens, _ := codexShellWordsUntilOperator(command[suffixStart:])
		gitDir := cwd
		var paths []string
		for i := 0; i < len(tokens); i++ {
			token := tokens[i]
			// Git's `--` ends its option list; a later `-C` is an argument, not a
			// path selector.
			if token == "--" {
				break
			}
			path, needsNext, matched := codexGitPathOption(token)
			if !matched {
				continue
			}
			if needsNext {
				if i+1 >= len(tokens) {
					// There is no path to prove safe, so a malformed selector must not
					// silently become an automatic approval.
					return true
				}
				i++
				path = tokens[i]
			}
			if !codexGitPathChangesDirectory(token) {
				// Relative --git-dir/--work-tree values use the cwd after all -C
				// options, regardless of where those options appeared.
				paths = append(paths, path)
				continue
			}
			resolved, ok := codexResolvePathFrom(path, gitDir)
			if !ok || !codexPathWithinRoots(resolved, roots) {
				return true
			}
			gitDir = resolved
		}
		for _, path := range paths {
			if !codexPathWithinRootsFrom(path, gitDir, roots) {
				return true
			}
		}
		search = at + len("git")
	}
	return false
}

func codexGitPathOption(token string) (path string, needsNext, matched bool) {
	switch {
	case token == "-C" || token == "--git-dir" || token == "--work-tree":
		return "", true, true
	case strings.HasPrefix(token, "-C") && len(token) > len("-C"):
		return token[len("-C"):], false, true
	case strings.HasPrefix(token, "--git-dir="):
		return strings.TrimPrefix(token, "--git-dir="), false, true
	case strings.HasPrefix(token, "--work-tree="):
		return strings.TrimPrefix(token, "--work-tree="), false, true
	default:
		return "", false, false
	}
}

func codexGitPathChangesDirectory(token string) bool {
	return strings.HasPrefix(token, "-C")
}

func codexPathWithinRootsFrom(path, cwd string, roots []string) bool {
	resolved, ok := codexResolvePathFrom(path, cwd)
	return ok && codexPathWithinRoots(resolved, roots)
}

func codexResolvePathFrom(path, cwd string) (string, bool) {
	if path == "" || strings.HasPrefix(path, "~") || strings.ContainsAny(path, "$`*?") {
		return "", false
	}
	if !filepath.IsAbs(path) {
		if cwd == "" {
			return "", false
		}
		path = filepath.Join(cwd, path)
	}
	return filepath.Clean(path), true
}

// codexShellWordsUntilOperator is intentionally a small lexer, not a shell interpreter. It only
// needs to preserve quoted Git path arguments and stop before a subsequent shell command. Anything
// it cannot resolve remains conservative through codexPathWithinRootsFrom.
func codexShellWordsUntilOperator(command string) ([]string, string) {
	words := []string{}
	current := strings.Builder{}
	var quote byte
	flush := func() {
		if current.Len() > 0 {
			words = append(words, current.String())
			current.Reset()
		}
	}
	for i := 0; i < len(command); i++ {
		c := command[i]
		if quote != 0 {
			switch {
			case c == quote:
				quote = 0
			case c == '\\' && quote == '"' && i+1 < len(command):
				i++
				current.WriteByte(command[i])
			default:
				current.WriteByte(c)
			}
			continue
		}
		switch c {
		case '\'', '"':
			quote = c
		case '\\':
			if i+1 < len(command) {
				i++
				current.WriteByte(command[i])
			}
		case ' ', '\t', '\r':
			flush()
		case ';', '&', '|', '\n':
			flush()
			return words, command[i+1:]
		default:
			current.WriteByte(c)
		}
	}
	flush()
	return words, ""
}

func codexShellWord(command, word string) bool {
	for start := 0; ; {
		at := strings.Index(command[start:], word)
		if at < 0 {
			return false
		}
		at += start
		if codexShellWordAt(command, at, len(word)) {
			return true
		}
		start = at + len(word)
	}
}

func codexShellWordAt(command string, at, length int) bool {
	if at < 0 || at+length > len(command) {
		return false
	}
	return (at == 0 || !codexShellWordChar(command[at-1])) &&
		(at+length == len(command) || !codexShellWordChar(command[at+length]))
}

func codexShellWordChar(value byte) bool {
	return (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') ||
		(value >= '0' && value <= '9') || value == '_'
}

// codexTempCleanupCommand permits the cleanup shape used for a session's temporary upload
// directory, while rejecting an unscoped recursive delete. It accepts both a literal child path
// and the common `ROOT=/uploads/session; rm -rf "$ROOT"` form.
func codexTempCleanupCommand(command string, tempRoots []string) bool {
	if len(tempRoots) == 0 {
		return false
	}
	segments := strings.FieldsFunc(command, func(r rune) bool {
		return r == ';' || r == '&' || r == '|' || r == '\n'
	})
	if len(segments) == 0 {
		return false
	}
	assignedRoots := map[string]bool{}
	for _, segment := range segments {
		for _, token := range strings.Fields(segment) {
			token = strings.Trim(token, "'\"")
			equal := strings.IndexByte(token, '=')
			if equal <= 0 {
				continue
			}
			name := strings.TrimSpace(token[:equal])
			value := strings.Trim(token[equal+1:], "'\"")
			if name != "" && codexPathWithinRoots(value, tempRoots) {
				assignedRoots[name] = true
			}
		}
	}

	for _, segment := range segments {
		lower := strings.ToLower(segment)
		at := strings.Index(lower, "rm -r")
		if at < 0 {
			continue
		}
		rest := strings.TrimSpace(segment[at+len("rm -r"):])
		if strings.HasPrefix(rest, "f") {
			rest = strings.TrimSpace(rest[1:])
		}
		arguments := strings.Fields(rest)
		if len(arguments) == 0 {
			return false
		}
		for _, argument := range arguments {
			argument = strings.Trim(argument, "'\"")
			if argument == "f" || argument == "-f" || argument == "--" {
				continue
			}
			switch {
			case strings.HasPrefix(argument, "${") && strings.HasSuffix(argument, "}"):
				if !assignedRoots[argument[2:len(argument)-1]] {
					return false
				}
			case strings.HasPrefix(argument, "$"):
				if !assignedRoots[strings.TrimPrefix(argument, "$")] {
					return false
				}
			case codexPathWithinRoots(argument, tempRoots):
			default:
				return false
			}
		}
	}
	return true
}
