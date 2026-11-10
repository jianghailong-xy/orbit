package main

import (
	"bufio"
	"fmt"
	"io"
	"os/exec"
	"sort"
	"strings"
)

// What leaves this machine besides events, held to the same scrubber (docs/design/owner-request-secrets.md §7.2): a
// turn's completion and a run's finalize carry text the control plane stores (the result, the error, a shell turn's
// output) and patches it shows and merges from. Text is scrubbed; a file whose patch holds a value is left out of the
// patches, and the session told. A branch whose history holds a value is not merged or pushed.

// scrubTurnComplete is req with every held value scrubbed out of its text and every patch holding one left out. Done
// before the completion is journaled (turn_complete_journal.go) and again as it is sent.
func scrubTurnComplete(req TurnCompleteRequest, sessionID string) TurnCompleteRequest {
	r := runnerSecrets().scrubber()
	if r == nil {
		return req
	}
	req.Result, req.Error, req.Subtype = r.redact(req.Result), r.redact(req.Error), r.redact(req.Subtype)
	if req.ShellOutput != nil {
		out := r.redact(*req.ShellOutput)
		req.ShellOutput = &out
	}
	req.ChangedDiff = withoutSecretPatches(req.ChangedDiff, sessionID)
	return req
}

// scrubRunFinalize is scrubTurnComplete for a run's finalize.
func scrubRunFinalize(req RunFinalizeRequest, sessionID string) RunFinalizeRequest {
	r := runnerSecrets().scrubber()
	if r == nil {
		return req
	}
	req.Result, req.Error, req.Subtype = r.redact(req.Result), r.redact(req.Error), r.redact(req.Subtype)
	req.CaptureError = r.redact(req.CaptureError)
	req.ChangedDiff = withoutSecretPatches(req.ChangedDiff, sessionID)
	return req
}

// withoutSecretPatches leaves out of patches every file whose patch text (or preview) holds a held value, and warns
// the session once per file. The file stays in the changed-file list with its counts.
func withoutSecretPatches(patches []FilePatch, sessionID string) []FilePatch {
	r := runnerSecrets().scrubber()
	if r == nil || len(patches) == 0 {
		return patches
	}
	kept := make([]FilePatch, 0, len(patches))
	for _, patch := range patches {
		if r.holds([]byte(patch.Patch)) || r.holds([]byte(patch.Preview)) {
			secretFileWarning(sessionID, patch.Path, "secret_patch_withheld", fmt.Sprintf(
				"%s holds the value of a secret the owner delivered to this runner, so Orbit left its diff out of what it reports. Remove the value from the file and from the branch's history.", patch.Path))
			continue
		}
		kept = append(kept, patch)
	}
	return kept
}

// secretHistoryPaths is the paths whose added lines, in any commit reachable from tip and from none of exclude, hold a
// held value: what a merge or a push of tip would publish. A ref in exclude that does not resolve is skipped.
func secretHistoryPaths(repo, tip string, exclude ...string) []string {
	r := runnerSecrets().scrubber()
	if r == nil || tip == "" {
		return nil
	}
	args := []string{"-C", repo, "log", "-p", "--no-color", "--no-ext-diff", "--no-renames", "--format=", tip}
	var not []string
	for _, ref := range exclude {
		if ref == "" {
			continue
		}
		if _, err := git(repo, "rev-parse", "--verify", "--quiet", ref+"^{commit}"); err == nil {
			not = append(not, ref)
		}
	}
	if len(not) > 0 {
		args = append(args, append([]string{"--not"}, not...)...)
	}
	cmd := exec.Command("git", args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil
	}
	if err := cmd.Start(); err != nil {
		return nil
	}
	hits := map[string]bool{}
	reader := bufio.NewReaderSize(stdout, 64*1024)
	path := ""
	for {
		line, err := reader.ReadString('\n')
		switch {
		case strings.HasPrefix(line, "diff --git "):
			path = diffGitPath(strings.TrimRight(line, "\n"))
		case strings.HasPrefix(line, "+") && !strings.HasPrefix(line, "+++ "):
			if path != "" && r.holds([]byte(line[1:])) {
				hits[path] = true
			}
		}
		if err != nil {
			break
		}
	}
	_, _ = io.Copy(io.Discard, reader)
	_ = cmd.Wait()
	paths := make([]string, 0, len(hits))
	for p := range hits {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	return paths
}

// diffGitPath is the b/ side of a `diff --git a/x b/x` header.
func diffGitPath(header string) string {
	if i := strings.LastIndex(header, " b/"); i >= 0 {
		return header[i+3:]
	}
	return ""
}

// secretHistoryRefusal is why a merge or push of a branch holding a value was refused, and what to do about it.
func secretHistoryRefusal(paths []string) string {
	return fmt.Sprintf("Refused: the branch's commits add the value of a secret the owner delivered to this runner, in %s. "+
		"Orbit does not merge or push it. Remove the value from those files and from the branch's history "+
		"(rewrite or squash the commits that added it), then try again.", namePaths(paths))
}
