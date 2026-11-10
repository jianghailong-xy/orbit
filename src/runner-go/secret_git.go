package main

import (
	"bufio"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"sync"
)

// A secret file written into a checkout ships with the commit at the end of the turn (`git add -A`). So after every
// `git add` that a commit, a live diff or a baseline follows, staged content is scanned for every value this runner
// holds; a file holding one is unstaged and named in a warning event (docs/design/owner-request-secrets.md §7.2).

// secretWarnSinks is where each live session hears about a file left out (registerSecretWarnings), by session id.
var secretWarnSinks sync.Map

type secretWarnSink struct{ emit emitFn }

// secretWarned keeps a file from being announced on every live diff: once per session and path per process.
var secretWarned sync.Map

// registerSecretWarnings routes a session's warnings to its emit until the returned func is called.
func registerSecretWarnings(sessionID string, emit emitFn) func() {
	key := decodeSessionID(sessionID)
	sink := &secretWarnSink{emit: emit}
	secretWarnSinks.Store(key, sink)
	return func() { secretWarnSinks.CompareAndDelete(key, sink) }
}

// unstageHeldSecrets unstages every staged file of dir whose content holds a value this runner holds. env is the git
// environment the staging ran under (a temporary index), nil for the checkout's own. sessionID names whom to warn;
// empty for a workspace's own baseline.
func unstageHeldSecrets(dir string, env []string, sessionID string) {
	red := runnerSecrets().scrubber()
	if red == nil {
		return
	}
	hits := stagedFilesHoldingSecrets(dir, env, red)
	if len(hits) == 0 {
		return
	}
	var err error
	if _, headErr := gitEnv(dir, env, "rev-parse", "--verify", "--quiet", "HEAD"); headErr == nil {
		_, err = gitEnv(dir, env, append([]string{"reset", "--quiet", "--"}, hits...)...)
	} else {
		_, err = gitEnv(dir, env, append([]string{"rm", "--cached", "--quiet", "--"}, hits...)...)
	}
	for _, path := range hits {
		secretUnstagedWarning(sessionID, path, err)
	}
}

// stagedFilesHoldingSecrets is the staged paths, changed against HEAD (all of them before there is a HEAD), whose
// staged content holds a value.
func stagedFilesHoldingSecrets(dir string, env []string, red *integrationOutputRedactor) []string {
	args := []string{"diff", "--cached", "--name-only", "-z", "--no-renames", "--diff-filter=ACMRT", "HEAD"}
	if _, err := gitEnv(dir, env, "rev-parse", "--verify", "--quiet", "HEAD"); err != nil {
		args = []string{"ls-files", "--cached", "-z"}
	}
	out, err := gitEnv(dir, env, args...)
	if err != nil || out == "" {
		return nil
	}
	var names []string
	for _, name := range strings.Split(out, "\x00") {
		// A name with a newline in it cannot be asked for in a batch; it is read on its own.
		if name != "" {
			names = append(names, name)
		}
	}
	var hits []string
	var batch []string
	for _, name := range names {
		if strings.ContainsAny(name, "\n\r") {
			if content, err := gitEnv(dir, env, "cat-file", "blob", ":"+name); err == nil && red.holds([]byte(content)) {
				hits = append(hits, name)
			}
			continue
		}
		batch = append(batch, name)
	}
	return append(hits, stagedBlobsHolding(dir, env, batch, red)...)
}

// stagedBlobsHolding reads the staged blob of each name through one `git cat-file --batch`.
func stagedBlobsHolding(dir string, env []string, names []string, red *integrationOutputRedactor) []string {
	if len(names) == 0 {
		return nil
	}
	cmd := exec.Command("git", "-C", dir, "cat-file", "--batch")
	cmd.Env = env
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil
	}
	if err := cmd.Start(); err != nil {
		return nil
	}
	go func() {
		defer stdin.Close()
		for _, name := range names {
			if _, err := io.WriteString(stdin, ":"+name+"\n"); err != nil {
				return
			}
		}
	}()
	reader := bufio.NewReader(stdout)
	var hits []string
	for _, name := range names {
		header, err := reader.ReadString('\n')
		if err != nil {
			break
		}
		fields := strings.Fields(header)
		if len(fields) != 3 {
			continue // "<name> missing": a submodule or a path git could not resolve
		}
		size, err := strconv.ParseInt(fields[2], 10, 64)
		if err != nil {
			break
		}
		content := make([]byte, size)
		if _, err := io.ReadFull(reader, content); err != nil {
			break
		}
		_, _ = reader.ReadByte() // the newline after the content
		if fields[1] == "blob" && red.holds(content) {
			hits = append(hits, name)
		}
	}
	_, _ = io.Copy(io.Discard, reader)
	_ = cmd.Wait()
	return hits
}

// secretUnstagedWarning tells the session that path was left out of its commit, once per session and path. The value
// and the secret's name are not in it: the path is enough to act on.
func secretUnstagedWarning(sessionID, path string, unstageErr error) {
	key := decodeSessionID(sessionID)
	if unstageErr != nil {
		logln(fmt.Sprintf("secret grants: %s in session %s holds a secret's value and could not be unstaged: %v", path, key, unstageErr))
		return
	}
	if _, seen := secretWarned.LoadOrStore(key+"\x00"+path, true); seen {
		return
	}
	logln(fmt.Sprintf("secret grants: %s in session %s holds a secret's value; it was left out of the commit", path, key))
	if sink, ok := secretWarnSinks.Load(key); ok && key != "" {
		sink.(*secretWarnSink).emit(evSystem, map[string]interface{}{
			"subtype": "secret_unstaged",
			"path":    path,
			// `notice` is what every client already draws as the runner's heads-up (web Transcript NoticeNode).
			"notice": fmt.Sprintf("%s holds the value of a secret the owner delivered to this runner, so Orbit left it out of the commit. Keep secrets out of the checkout; use orbit secret exec or the secret's own file instead.", path),
		})
	}
}
