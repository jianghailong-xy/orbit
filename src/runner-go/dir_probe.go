package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The directory probe relay (docs/first-workspace-contract.md §2): "what is at this path on this machine?", asked
// while a machine's first workspace is given a folder, before any workspace exists to name in agentDirs. Only this
// machine can answer, so the question rides a heartbeat and the answer goes back by a POST of its own, as the Claude
// history relay's does (claude_history.go).
const dirProbeCapabilityV1 = "dir-probe/v1"

// startDirProbe answers a heartbeat's dirProbeRequest off the heartbeat's goroutine: a stat on a slow mount and the
// git calls can take seconds, and the beat it arrived on must not wait for them. Handed over once, never
// redelivered, so there is no in-flight guard to keep: a person who retypes the path asks again.
func startDirProbe(cmd *DirProbeCommand, ops *countedOps, report func(RunnerDirProbeResult) error) {
	if cmd == nil || cmd.Path == "" {
		return
	}
	ops.Add(1)
	go func(path string) {
		defer ops.Done()
		if err := report(RunnerDirProbeResult{Path: path, Result: probeDir(path, agentDirProbeTimeout)}); err != nil {
			logln("dir-probe-result POST failed:", err)
		}
	}(cmd.Path)
}

// probeDir is what is at path on this machine: `~` expanded and made absolute, as a session's working directory
// would be. Nothing being there is an answer — exists false, and no error — while error is kept for a look that
// could not be taken, so that "not there" and "could not tell" never read as the same thing.
//
// It answers by the deadline whatever the disk does. A stat on a mount that has gone away blocks where no context
// reaches, and a look still counted among the heartbeat's operations would hold off this runner's updates and a
// managed instance's sleep for as long as it hangs; a late look is left to finish on its own.
func probeDir(path string, timeout time.Duration) DirProbe {
	out := DirProbe{Path: path}
	expanded := expandTilde(path)
	if expanded == "~" || strings.HasPrefix(expanded, "~/") {
		out.Error = "this machine's user has no home directory to expand ~ against"
		return out
	}
	abs, err := filepath.Abs(expanded)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	out.Path = abs
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	looked, look := make(chan DirProbe, 1), lookAtDirProbe
	go func(out DirProbe) { looked <- look(ctx, out) }(out)
	select {
	case probe := <-looked:
		if ctx.Err() == nil {
			return probe
		}
	case <-ctx.Done():
	}
	out.Error = fmt.Sprintf("looking at it took longer than %s", timeout)
	return out
}

// lookAtDirProbe fills in what is at out.Path. A variable so a test can stand in a look that hangs.
var lookAtDirProbe = func(ctx context.Context, out DirProbe) DirProbe {
	look := lookAtDir(ctx, out.Path)
	if look.statErr != nil {
		if !errors.Is(look.statErr, fs.ErrNotExist) {
			out.Error = look.statErr.Error()
		}
		return out
	}
	out.Exists, out.IsDir, out.IsGit, out.FreeBytes = true, look.info.IsDir(), look.isGit, look.free
	if out.IsGit {
		// The branch HEAD names, in a repository with no commit yet too, and as its full name, which `rev-parse
		// --abbrev-ref` would shorten to heads/<name> beside a tag of that name. A detached HEAD names none.
		if ref, err := gitCtx(ctx, out.Path, "symbolic-ref", "-q", "HEAD"); err == nil {
			if branch, ok := strings.CutPrefix(ref, "refs/heads/"); ok && branch != "" {
				out.Branch = &branch
			}
		}
	}
	// The home directory however it is spelled: through a symlink, or in another case on a filesystem that ignores it.
	if home := userHome(); home != "" {
		if homeInfo, err := os.Stat(home); err == nil {
			out.IsHome = os.SameFile(look.info, homeInfo)
		}
	}
	return out
}
