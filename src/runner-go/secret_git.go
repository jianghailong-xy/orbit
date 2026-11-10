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

// unstageHeldSecrets unstages every staged file of dir whose content holds a value this runner holds, or whose blob
// was recorded as holding one while a value was known (secret_taint.go): a file held back while a grant was live is
// held back after it has ended too. env is the git environment the staging ran under (a temporary index), nil for the
// checkout's own. sessionID names whom to warn; empty for a workspace's own baseline. What it unstages for a value it
// holds is recorded, so the next `git add` of the same content, which makes the same blob, is known after the grant.
func unstageHeldSecrets(dir string, env []string, sessionID string) {
	red := runnerSecrets().scrubber()
	recorded := taintObjectIDs(dir)
	if red == nil && len(recorded) == 0 {
		return
	}
	hits := stagedFilesHoldingSecrets(dir, env, red, recorded)
	if len(hits) == 0 {
		return
	}
	paths := make([]string, 0, len(hits))
	for _, hit := range hits {
		paths = append(paths, hit.Path)
	}
	recordTaintObjects(dir, hits)
	var err error
	if _, headErr := gitEnv(dir, env, "rev-parse", "--verify", "--quiet", "HEAD"); headErr == nil {
		_, err = gitEnv(dir, env, append([]string{"reset", "--quiet", "--"}, paths...)...)
	} else {
		_, err = gitEnv(dir, env, append([]string{"rm", "--cached", "--quiet", "--"}, paths...)...)
	}
	for _, path := range paths {
		secretUnstagedWarning(sessionID, path, err)
	}
}

// stagedFilesHoldingSecrets is the staged files, changed against HEAD (all of them before there is a HEAD), whose
// staged blob holds a value red knows (red may be nil) or is one of recorded, with that blob's id.
func stagedFilesHoldingSecrets(dir string, env []string, red *integrationOutputRedactor, recorded map[string]string) []secretTaintObject {
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
		if name != "" {
			names = append(names, name)
		}
	}
	var hits []secretTaintObject
	var batch []string
	for _, name := range names {
		// A name with a newline in it cannot be asked for in a batch; it is read on its own.
		if strings.ContainsAny(name, "\n\r") {
			id, _ := gitEnv(dir, env, "rev-parse", ":"+name)
			content, err := gitEnv(dir, env, "cat-file", "blob", ":"+name)
			if _, tainted := recorded[id]; (id != "" && tainted) || (err == nil && red != nil && red.holds([]byte(content))) {
				hits = append(hits, secretTaintObject{ID: id, Path: name})
			}
			continue
		}
		batch = append(batch, name)
	}
	return append(hits, stagedBlobsHolding(dir, env, batch, red, recorded)...)
}

// stagedBlobsHolding reads the staged blob of each name through one `git cat-file --batch`.
func stagedBlobsHolding(dir string, env []string, names []string, red *integrationOutputRedactor, recorded map[string]string) []secretTaintObject {
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
	var hits []secretTaintObject
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
		_, tainted := recorded[fields[0]]
		if fields[1] == "blob" && (tainted || (red != nil && red.holds(content))) {
			hits = append(hits, secretTaintObject{ID: fields[0], Path: name})
		}
	}
	_, _ = io.Copy(io.Discard, reader)
	_ = cmd.Wait()
	return hits
}

// secretUnstagedWarning tells the session that path was left out of its commit.
func secretUnstagedWarning(sessionID, path string, unstageErr error) {
	if unstageErr != nil {
		logln(fmt.Sprintf("secret grants: %s in session %s holds a secret's value and could not be unstaged: %v", path, decodeSessionID(sessionID), unstageErr))
		return
	}
	secretFileWarning(sessionID, path, "secret_unstaged", fmt.Sprintf("%s holds the value of a secret the owner delivered to this runner, so Orbit left it out of the commit. Keep secrets out of the checkout; use orbit secret exec or the secret's own file instead.", path))
}

// secretFileWarning tells the session, once per session, kind and path, that path was kept back for holding a value.
// The value and the secret's name are not in it: the path is enough to act on.
func secretFileWarning(sessionID, path, subtype, message string) {
	key := decodeSessionID(sessionID)
	if _, seen := secretWarned.LoadOrStore(key+"\x00"+subtype+"\x00"+path, true); seen {
		return
	}
	logln(fmt.Sprintf("secret grants: %s in session %s holds a secret's value (%s)", path, key, subtype))
	if sink, ok := secretWarnSinks.Load(key); ok && key != "" {
		// `notice` is what every client already draws as the runner's heads-up (web Transcript NoticeNode).
		sink.(*secretWarnSink).emit(evSystem, map[string]interface{}{"subtype": subtype, "path": path, "notice": message})
	}
}
