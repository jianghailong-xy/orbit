package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// The drive is read-only in Plan mode (docs/drive-product-design.md D9, D16; technical design §7.2).
// Claude Code's Plan does not keep a write there from running: it asks its permission prompt about every Write, Edit
// and Bash call, and an Allow on that card wrote the drive. Kimi's Plan asks about every shell call the same way. So
// where the runner answers an engine's permission request, a Plan-mode call that would write under the drive is
// refused on the spot with planDriveRefusal, and no card is filed. Reads, and every call about any other path, take
// the path they took before.

const planDriveRefusal = "The Drive is read-only in Plan mode: nothing was written to ~/Drive. Do not retry " +
	"it or make the same write another way. Put the change in your plan; it can be made once the owner approves the " +
	"plan or switches this session out of Plan mode."

// planDriveFileTools are the tools that write the file their input names.
var planDriveFileTools = map[string]bool{"Write": true, "Edit": true, "MultiEdit": true, "NotebookEdit": true}

// planDriveShellTools are the tools that run a shell command.
var planDriveShellTools = map[string]bool{"Bash": true, "Terminal": true}

// planDriveWrite reports whether a tool call would write under the Files drive: a file tool whose path is there, or a
// shell command that names a path there and is not one of the read-only commands planDriveReadOnlyCommand knows.
func planDriveWrite(toolName string, input map[string]interface{}) bool {
	switch {
	case planDriveFileTools[toolName]:
		path := firstString(input, "file_path", "notebook_path", "path", "filePath")
		return path != "" && pathUnderDrive(path)
	case planDriveShellTools[toolName]:
		command := firstString(input, "command", "cmd")
		return planDriveCommandNamesDrive(command) && !planDriveReadOnlyCommand(command)
	}
	return false
}

// driveRootSpellings are the drive's roots as written and as their links resolve: the parent, ~/Drive and the mount.
func driveRootSpellings() []string {
	var roots []string
	for _, root := range []string{driveParentPath, driveHomePath, driveMountPath} {
		roots = appendUnique(roots, filepath.Clean(root), realPath(root))
	}
	return roots
}

// pathUnderDrive reports whether a path, by any spelling — ~ or $HOME, relative to this process's directory, or
// through a link — is one of the drive's roots or below one.
func pathUnderDrive(path string) bool {
	path = expandShellHome(strings.TrimSpace(path))
	if path == "" {
		return false
	}
	path = absPath(path)
	roots := driveRootSpellings()
	return pathInsideAny(path, roots...) || pathInsideAny(resolveExistingPrefix(path), roots...)
}

// expandShellHome replaces a leading ~, $HOME or ${HOME} with this process's home directory.
func expandShellHome(path string) string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return path
	}
	for _, prefix := range []string{"${HOME}", "$HOME", "~"} {
		if rest, ok := strings.CutPrefix(path, prefix); ok && (rest == "" || strings.HasPrefix(rest, "/")) {
			return home + rest
		}
	}
	return path
}

// resolveExistingPrefix resolves the links of the longest part of an absolute path that exists, and keeps the rest:
// a file about to be created under a link to the drive is under the drive.
func resolveExistingPrefix(path string) string {
	rest := ""
	for dir := path; ; dir = filepath.Dir(dir) {
		if real, err := filepath.EvalSymlinks(dir); err == nil {
			return filepath.Join(real, rest)
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return path
		}
		rest = filepath.Join(filepath.Base(dir), rest)
	}
}

// planDriveWordSplit splits a command into the words that may be paths: at blanks, quotes and shell operators.
var planDriveWordSplit = regexp.MustCompile("[\\s'\"`;&|<>()=]+")

// planDriveCommandNamesDrive reports whether any word of a shell command is a path under the drive.
func planDriveCommandNamesDrive(command string) bool {
	for _, word := range planDriveWordSplit.Split(command, -1) {
		if word != "" && !strings.HasPrefix(word, "-") && pathUnderDrive(word) {
			return true
		}
	}
	return false
}

// planDriveReadOnlyCommands are the commands that only read the files they name. A command not in this list, or one
// of them with an option that writes (planDriveWritingOptions), counts as a write.
var planDriveReadOnlyCommands = map[string]bool{
	"ls": true, "cat": true, "head": true, "tail": true, "wc": true, "stat": true, "file": true, "find": true,
	"grep": true, "egrep": true, "fgrep": true, "rg": true, "du": true, "df": true, "tree": true, "sha256sum": true,
	"sha1sum": true, "md5sum": true, "cksum": true, "diff": true, "cmp": true, "realpath": true, "readlink": true,
	"basename": true, "dirname": true, "test": true, "[": true, "echo": true, "printf": true, "pwd": true, "cd": true,
	"true": true, "sort": true, "uniq": true, "cut": true, "tr": true, "jq": true, "less": true, "more": true,
	"xxd": true, "od": true, "hexdump": true, "nl": true, "column": true,
}

// planDriveWritingOptions are the options that make a read-only command write.
var planDriveWritingOptions = map[string][]string{
	"find": {"-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"},
	"sort": {"-o", "--output"},
}

// planDriveDescriptorRedirect is a redirection to another descriptor, which writes no file.
var planDriveDescriptorRedirect = regexp.MustCompile(`[0-9]*>&[0-9-]+`)

// planDriveFileRedirect is a redirection into a file, with the file it names.
var planDriveFileRedirect = regexp.MustCompile(`&?[0-9]*>>?\|?\s*(?:"([^"]*)"|'([^']*)'|([^\s;&|<>()]+))`)

// planDriveReadOnlyCommand reports whether a shell command writes nothing under the drive: no command substitution, no
// redirection into a file there, and every command of every pipeline and list a read-only one.
func planDriveReadOnlyCommand(command string) bool {
	if strings.Contains(command, "$(") || strings.Contains(command, "`") {
		return false
	}
	command = planDriveDescriptorRedirect.ReplaceAllString(command, " ")
	for _, match := range planDriveFileRedirect.FindAllStringSubmatch(command, -1) {
		if target := match[1] + match[2] + match[3]; target == "" || pathUnderDrive(target) {
			return false
		}
	}
	command = planDriveFileRedirect.ReplaceAllString(command, " ")
	if strings.Contains(command, ">") {
		return false
	}
	segments := strings.FieldsFunc(command, func(r rune) bool {
		return r == ';' || r == '&' || r == '|' || r == '\n'
	})
	for _, segment := range segments {
		words := strings.Fields(segment)
		for len(words) > 0 && codexShellEnvAssignment(words[0]) {
			words = words[1:]
		}
		if len(words) == 0 {
			continue
		}
		name := filepath.Base(strings.Trim(words[0], `'"`))
		if !planDriveReadOnlyCommands[name] {
			return false
		}
		for _, word := range words[1:] {
			for _, option := range planDriveWritingOptions[name] {
				if word == option || strings.HasPrefix(word, option+"=") || (option == "-o" && strings.HasPrefix(word, "-o")) {
					return false
				}
			}
		}
	}
	return true
}
