package main

import (
	"path/filepath"
	"strings"
)

// codexAutoApprovalContext describes the roots that Auto may use without asking. Codex's
// workspace-write sandbox remains the final boundary; this context only decides whether an
// approval request is safe enough to answer automatically.
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

func codexRuntimeWorkspaceRoots(permissionMode string, job *ClaimedSession, execDir, upDir string) []string {
	roots := []string{execDir, upDir}
	if permissionMode == "auto" && job != nil && job.WT != nil && job.WT.RepoDir != "" {
		// A linked worktree stores its index and worktree metadata in the shared repository's
		// .git directory. Grant that metadata directory alone so local git commands do not
		// become "outside workspace" approvals; the repository's source files remain outside.
		roots = append(roots, filepath.Join(job.WT.RepoDir, ".git"))
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
	if !codexPathWithinRoots(cwd, autoContext.workspaceRoots) {
		return false, false
	}
	command := strings.TrimSpace(firstString(params, "command"))
	if command == "" || codexAutoCommandNeedsApproval(command, autoContext.tempRoots) {
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

func codexShellWord(command, word string) bool {
	for start := 0; ; {
		at := strings.Index(command[start:], word)
		if at < 0 {
			return false
		}
		at += start
		end := at + len(word)
		beforeWord := at == 0 || !codexShellWordChar(command[at-1])
		afterWord := end == len(command) || !codexShellWordChar(command[end])
		if beforeWord && afterWord {
			return true
		}
		start = end
	}
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
