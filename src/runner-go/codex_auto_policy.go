package main

import (
	"path/filepath"
	"strings"
)

// codexAutoApprovalContext describes the roots that Auto may use without asking. The context is
// only a request-level classifier; it never expands the execution scope on its own.
type codexAutoApprovalContext struct {
	workspaceRoots []string
	tempRoots      []string
}

func codexAutoApprovalContextFor(execDir, upDir string) codexAutoApprovalContext {
	return codexAutoApprovalContext{
		workspaceRoots: []string{execDir, upDir},
		tempRoots:      []string{upDir},
	}
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
	if !codexPathWithinRoots(cwd, autoContext.workspaceRoots) {
		return false, false
	}
	command := strings.TrimSpace(firstString(params, "command"))
	if command == "" ||
		codexAutoCommandTargetsOutsideRoots(command, cwd, autoContext.workspaceRoots) ||
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
		"curl", "wget", "ssh", "scp", "socat", "sudo", "doas", "printenv",
		"chmod", "chown", "mkfs", "shutdown", "reboot", "poweroff", "launchctl", "systemctl",
	} {
		if codexShellWord(lower, word) {
			return true
		}
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

// codexAutoCommandTargetsOutsideRoots recognizes Git's explicit path selectors. Checking only
// the request cwd is insufficient for commands such as `git -C /other/checkout status`: Git reads
// the checkout named by -C, not the process cwd. Unknown or variable selectors fail closed because
// Auto must be able to prove the target is inside the session's workspace before skipping a card.
func codexAutoCommandTargetsOutsideRoots(command, cwd string, roots []string) bool {
	if len(roots) == 0 {
		return true
	}
	lower := strings.ToLower(command)
	for search := 0; search < len(lower); {
		relative := strings.Index(lower[search:], "git")
		if relative < 0 {
			break
		}
		at := search + relative
		if !codexShellWordAt(lower, at, len("git")) {
			search = at + len("git")
			continue
		}
		suffixStart := at + len("git")
		// A quoted executable (`"git" -C ...`) leaves the closing quote just
		// after the word. Skip it before tokenizing the options.
		if suffixStart < len(command) && (command[suffixStart] == '\'' || command[suffixStart] == '"') {
			suffixStart++
		}
		tokens := codexShellWordsUntilOperator(command[suffixStart:])
		gitDir := cwd
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
			resolved, ok := codexResolvePathFrom(path, gitDir)
			if !ok || !codexPathWithinRoots(resolved, roots) {
				return true
			}
			if codexGitPathChangesDirectory(token) {
				gitDir = resolved
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
	return token == "-C" || (strings.HasPrefix(token, "-C") && len(token) > len("-C"))
}

func codexPathWithinRootsFrom(path, cwd string, roots []string) bool {
	resolved, ok := codexResolvePathFrom(path, cwd)
	return ok && codexPathWithinRoots(resolved, roots)
}

func codexResolvePathFrom(path, cwd string) (string, bool) {
	path = strings.TrimSpace(path)
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
func codexShellWordsUntilOperator(command string) []string {
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
		case ' ', '\t', '\r', '\n':
			flush()
		case ';', '&', '|':
			flush()
			return words
		default:
			current.WriteByte(c)
		}
	}
	flush()
	return words
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
