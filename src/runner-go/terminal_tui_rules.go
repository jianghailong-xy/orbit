package main

import (
	"regexp"
	"strings"
)

// What the terminal's [a] Always allow remembers from a Bash line: a port of `bashCommandRules` in
// @orbit/shared (src/shared/src/bashRules.ts), which the web, OrbitKit and Android cards use too.
// TestTUIBashRulePrefixes walks the same bash-rules.fixture.json they do, so a rule change starts
// there and lands at every end or none. Best-effort, not a full shell parser.

var (
	bashAssignment     = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)
	bashProgramWord    = regexp.MustCompile(`^[A-Za-z./_-][\w./-]*$`)
	bashSubcommandWord = regexp.MustCompile(`^[A-Za-z][\w-]*$`)
	bashWrapperOption  = regexp.MustCompile(`^-[A-Za-z]*c[A-Za-z]*$`)
)

func bashWordSet(words ...string) map[string]bool {
	set := make(map[string]bool, len(words))
	for _, w := range words {
		set[w] = true
	}
	return set
}

var (
	bashShellWrappers = bashWordSet("bash", "/bin/bash", "/usr/bin/bash", "sh", "/bin/sh", "/usr/bin/sh",
		"zsh", "/bin/zsh", "/usr/bin/zsh")
	bashCommandKeywords = bashWordSet("if", "then", "elif", "else", "while", "until", "do", "time", "coproc")
	// Words that lead a command without being its program: what follows them is judged instead.
	bashLeadingKeywords = bashWordSet("if", "then", "elif", "else", "while", "until", "do", "time", "coproc",
		"fi", "done", "esac", "!", "{", "}")
	// Words that open a construct whose next word is a name or a pattern, not a program to run.
	bashConstructHeaders = bashWordSet("for", "select", "case", "function")
	// Programs whose second word picks what they do (`git status`); any other program's second word
	// is an argument (`ls OrbitKitTests`), and a rule naming it would cover only that one call.
	bashSubcommandPrograms = bashWordSet(
		"git", "gh", "npm", "pnpm", "yarn", "bun", "npx", "deno", "node-gyp",
		"docker", "podman", "kubectl", "helm", "terraform", "gcloud", "aws", "az",
		"go", "cargo", "rustup", "swift", "xcrun", "dotnet", "mvn", "gradle", "gradlew", "flutter", "adb",
		"pip", "pip3", "uv", "poetry", "conda", "brew", "apt", "apt-get",
		"systemctl", "launchctl", "defaults", "make", "orbit")
	// Programs that change files or the environment, or run whatever they are given: allowed once,
	// never remembered. A standing grant can let a command out of the session sandbox.
	bashNeverRemembered = bashWordSet(
		"cp", "mv", "rm", "rmdir", "ln", "chmod", "chown", "chgrp", "tee", "dd", "touch", "truncate",
		"mkdir", "install", "rsync", "unlink", "shred",
		"export", "env", "set", "unset", "declare", "typeset", "readonly", "local", "alias", "source", ".",
		"eval", "exec", "sudo", "doas", "xargs", "nohup", "timeout", "nice", "command", "builtin")
)

// bashRulePrefixes is the prefix of each distinct sub-command worth remembering, each stored as
// `<prefix>:*`: `cd x && npm test -- login` → ["cd", "npm test"]. A line that runs a shell wrapper
// (`bash -c …`) has none: a rule for it would allow anything.
func bashRulePrefixes(command string) []string {
	if strings.TrimSpace(command) == "" {
		return nil
	}
	segments, heads := bashRuleHeads(command)
	for _, segment := range segments {
		if bashShellWrapperCommand(segment) {
			return nil
		}
	}
	seen := map[string]bool{}
	var out []string
	for _, head := range heads {
		if p := bashRememberedPrefix(head); p != "" && !seen[p] && !bashCommandKeywords[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	return out
}

// bashShellWrapperCommand says whether one sub-command runs a shell with `-c`/`-lc`-style code.
func bashShellWrapperCommand(segment string) bool {
	words := strings.Fields(segment)
	i := 0
	for i < len(words) && bashAssignment.MatchString(words[i]) {
		i++
	}
	if i >= len(words) || !bashShellWrappers[words[i]] {
		return false
	}
	return i+1 < len(words) && (words[i+1] == "--command" || bashWrapperOption.MatchString(words[i+1]))
}

// bashRememberedPrefix is what one sub-command, read with its substitutions replaced by `$_`, may
// stand for, or "" for nothing: leading keywords skipped, a second word only for a sub-command
// program, nothing for a program that changes files or the environment.
func bashRememberedPrefix(head string) string {
	words := strings.Fields(head)
	i := 0
	for i < len(words) && (bashLeadingKeywords[words[i]] || bashAssignment.MatchString(words[i])) {
		i++
	}
	if i >= len(words) || bashConstructHeaders[words[i]] || !bashProgramWord.MatchString(words[i]) {
		return ""
	}
	program := words[i]
	name := program[strings.LastIndex(program, "/")+1:]
	if bashNeverRemembered[name] {
		return ""
	}
	if !bashSubcommandPrograms[name] {
		return program
	}
	if i+1 < len(words) && bashSubcommandWord.MatchString(words[i+1]) {
		return program + " " + words[i+1]
	}
	return ""
}

type bashHeredoc struct {
	delimiter string
	stripTabs bool
	quoted    bool
}

// bashRuleHeads splits a line into its sub-commands at unquoted ; && || | and newlines, dropping
// comments and heredoc bodies, and keeps each command substitution whole. `heads` is each segment
// with its substitutions replaced by `$_`, which is what a rule is taken from.
func bashRuleHeads(command string) (segments, heads []string) {
	cmd := []rune(command)
	var cur, head []rune
	// The quote that is open: ' and " as themselves, $ for ANSI-C $'…', which closes on '.
	var quote rune
	atWordStart := true
	var heredocs []bashHeredoc
	inArithmetic := false
	add := func(rs ...rune) {
		cur = append(cur, rs...)
		head = append(head, rs...)
	}
	endSegment := func() {
		segments = append(segments, string(cur))
		heads = append(heads, string(head))
		cur, head = nil, nil
		atWordStart = true
		inArithmetic = false
	}
	for i := 0; i < len(cmd); i++ {
		c := cmd[i]
		if quote == '\'' {
			add(c)
			if c == '\'' {
				quote = 0
			}
			continue
		}
		if quote != '$' {
			if body := bashSubstitutionBody(cmd, i); body >= 0 {
				// A command substitution runs a second command to build this one: one piece of
				// this sub-command, never split at what it holds, and no rule is taken from it.
				end := bashEndOfSubstitution(cmd, body, c == '`')
				cur = append(cur, cmd[i:end]...)
				head = append(head, '$', '_')
				i = end - 1
				atWordStart = false
				continue
			}
		}
		if quote != 0 {
			if c == '\\' && i+1 < len(cmd) {
				add(c, cmd[i+1])
				i++
				continue
			}
			add(c)
			if c == quote || (quote == '$' && c == '\'') {
				quote = 0
			}
			continue
		}
		if c == '\\' {
			add(c)
			if i+1 < len(cmd) {
				i++
				add(cmd[i])
				// A line continuation is as if neither character were there, so the word state stays.
				if cmd[i] != '\n' {
					atWordStart = false
				}
			}
			continue
		}
		if c == '"' || c == '\'' {
			quote = c
			add(c)
			atWordStart = false
			continue
		}
		if c == '$' && i+1 < len(cmd) && cmd[i+1] == '\'' {
			quote = '$'
			add(c, '\'')
			i++
			atWordStart = false
			continue
		}
		if c == '#' && atWordStart {
			end := len(cmd)
			if nl := bashIndexRune(cmd, '\n', i); nl >= 0 {
				end = nl
			}
			i = end - 1
			continue
		}
		if c == '<' && i+1 < len(cmd) && cmd[i+1] == '<' && !inArithmetic {
			if i+2 < len(cmd) && cmd[i+2] == '<' {
				// A here-string: its text is the word after it, on this line.
				add('<', '<', '<')
				i += 2
				atWordStart = true
				continue
			}
			if heredoc, end, ok := bashReadHeredoc(cmd, i); ok {
				heredocs = append(heredocs, heredoc)
				add(cmd[i:end]...)
				i = end - 1
				continue
			}
		}
		if c == ';' || c == '\n' {
			endSegment()
			if c == '\n' && len(heredocs) > 0 {
				i = bashEndOfHeredocBodies(cmd, i+1, heredocs) - 1
				heredocs = nil
			}
			continue
		}
		if (c == '&' || c == '|') && i+1 < len(cmd) && cmd[i+1] == c {
			endSegment()
			i++
			continue
		}
		if c == '|' {
			endSegment()
			continue
		}
		// Between `$((` and `))` a `<<` is a shift.
		if c == '(' && i >= 2 && cmd[i-1] == '(' && cmd[i-2] == '$' {
			inArithmetic = true
		}
		if c == ')' && i >= 1 && cmd[i-1] == ')' {
			inArithmetic = false
		}
		add(c)
		atWordStart = strings.ContainsRune(" \t&()<>", c)
	}
	endSegment()
	return segments, heads
}

func bashIndexRune(cmd []rune, r rune, from int) int {
	for i := from; i < len(cmd); i++ {
		if cmd[i] == r {
			return i
		}
	}
	return -1
}

// bashSubstitutionBody is where a command substitution opening at i has its body, or -1. `$((` is arithmetic.
func bashSubstitutionBody(cmd []rune, i int) int {
	if cmd[i] == '`' {
		return i + 1
	}
	if cmd[i] == '$' && i+1 < len(cmd) && cmd[i+1] == '(' && (i+2 >= len(cmd) || cmd[i+2] != '(') {
		return i + 2
	}
	return -1
}

// bashEndOfSubstitution is just past the `)` or backtick that closes the substitution whose body
// starts at start, or the end of the line when nothing does. Quotes and nested substitutions inside
// are read so they do not end it early.
func bashEndOfSubstitution(cmd []rune, start int, backtick bool) int {
	depth := 1
	i := start
	for i < len(cmd) {
		c := cmd[i]
		switch {
		case c == '\\':
			i += 2
		case backtick:
			if c == '`' {
				return i + 1
			}
			i++
		case c == '\'':
			if close := bashIndexRune(cmd, '\'', i+1); close >= 0 {
				i = close + 1
			} else {
				i = len(cmd)
			}
		case c == '"':
			i++
			for i < len(cmd) && cmd[i] != '"' {
				if cmd[i] == '\\' {
					i += 2
				} else if body := bashSubstitutionBody(cmd, i); body >= 0 {
					i = bashEndOfSubstitution(cmd, body, cmd[i] == '`')
				} else {
					i++
				}
			}
			i++
		case c == '`':
			i = bashEndOfSubstitution(cmd, i+1, true)
		case c == '(':
			depth++
			i++
		case c == ')':
			depth--
			if depth == 0 {
				return i + 1
			}
			i++
		default:
			i++
		}
	}
	return len(cmd)
}

// bashReadHeredoc is the heredoc whose `<<` or `<<-` is at start and the index just past its word,
// or false when no word follows. A form this does not read exactly gets a delimiter no real line
// equals, so the rest of the line counts as body: too much body only means remembering less.
func bashReadHeredoc(cmd []rune, start int) (bashHeredoc, int, bool) {
	var h bashHeredoc
	i := start + 2
	if i < len(cmd) && cmd[i] == '-' {
		h.stripTabs = true
		i++
	}
	for i < len(cmd) && (cmd[i] == ' ' || cmd[i] == '\t') {
		i++
	}
	wordStart := i
	var delimiter []rune
	for i < len(cmd) && !strings.ContainsRune(" \t&()<>;|\n", cmd[i]) {
		c := cmd[i]
		i++
		switch c {
		case '\'', '"':
			end := bashIndexRune(cmd, c, i)
			if end < 0 {
				end = len(cmd)
			}
			delimiter = append(delimiter, cmd[i:end]...)
			i = end + 1
			h.quoted = true
		case '\\':
			if i < len(cmd) {
				delimiter = append(delimiter, cmd[i])
			}
			i++
			h.quoted = true
		default:
			delimiter = append(delimiter, c)
		}
	}
	if i == wordStart {
		return h, 0, false
	}
	h.delimiter = string(delimiter)
	return h, min(i, len(cmd)), true
}

// bashEndOfHeredocBodies is just past the last of these heredocs' terminators, reading from the
// line at start, or the end of the line when one never comes. A backslash-newline in an unquoted
// body leaves where it ends unclear, so the rest counts as body.
func bashEndOfHeredocBodies(cmd []rune, start int, heredocs []bashHeredoc) int {
	i := start
	for _, h := range heredocs {
		terminates := func(text string) bool {
			if h.stripTabs {
				text = strings.TrimLeft(text, "\t")
			}
			return text == h.delimiter
		}
		for {
			if i >= len(cmd) {
				return len(cmd)
			}
			lineStart := i
			for i < len(cmd) && cmd[i] != '\n' {
				if !h.quoted && cmd[i] == '\\' {
					i += 2
				} else {
					i++
				}
			}
			line := string(cmd[lineStart:min(i, len(cmd))])
			i++
			if terminates(line) {
				break
			}
			if terminates(strings.ReplaceAll(line, "\\\n", "")) {
				return len(cmd)
			}
		}
	}
	return i
}
