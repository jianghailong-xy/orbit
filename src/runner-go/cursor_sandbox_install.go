package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"time"
)

const cursorSandboxInstallTimeout = 2 * time.Minute

// Only the installation outcome is process-wide; availability and writable roots
// must be probed again for each session.
type cursorSandboxInstaller struct {
	mu   sync.Mutex
	done chan struct{}
	err  error
}

var runnerCursorSandboxInstaller = &cursorSandboxInstaller{}

func (i *cursorSandboxInstaller) ensure(ctx context.Context, job *ClaimedSession, workspace string,
	detect func(context.Context, *ClaimedSession, string) (*cursorSandbox, string), install func(context.Context) error) (*cursorSandbox, string) {
	sandbox, reason := detect(ctx, job, workspace)
	if sandbox != nil || runtime.GOOS != "linux" {
		return sandbox, reason
	}
	if _, err := exec.LookPath("bwrap"); err == nil {
		return nil, reason
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.done == nil {
		i.done = make(chan struct{})
		go func() {
			// Installation belongs to the runner, not the first session's lifetime.
			installCtx, cancel := context.WithTimeout(context.Background(), cursorSandboxInstallTimeout)
			defer cancel()
			logln("cursor-sandbox: installing bubblewrap on this runner")
			err := install(installCtx)
			i.mu.Lock()
			defer i.mu.Unlock()
			i.err = err
			if err != nil {
				logln("cursor-sandbox: bubblewrap install failed:", err)
			} else {
				logln("cursor-sandbox: bubblewrap installer finished")
			}
			close(i.done)
		}()
	}
	select {
	case <-i.done:
		if i.err != nil {
			reason += "; bubblewrap install failed: " + i.err.Error()
		}
	default:
		reason += "; bubblewrap installation has been started and is in progress"
	}

	return sandbox, reason
}

func installCursorBubblewrap(ctx context.Context) error {
	for _, manager := range []string{"apt-get", "dnf", "yum", "apk", "pacman"} {
		binary, err := exec.LookPath(manager)
		if err != nil {
			continue
		}
		args := []string{"install", "-y", "bubblewrap"}
		switch manager {
		case "apk":
			args = []string{"add", "--no-cache", "bubblewrap"}
		case "pacman":
			args = []string{"-S", "--noconfirm", "--needed", "bubblewrap"}
		}
		if os.Geteuid() != 0 {
			args = append([]string{"-n", binary}, args...)
			binary = "sudo"
		}
		cmd := exec.CommandContext(ctx, binary, args...)
		cmd.Env = append(os.Environ(), "DEBIAN_FRONTEND=noninteractive")
		configureEngineCommandTree(cmd)
		output, err := cmd.CombinedOutput()
		if err != nil {
			return fmt.Errorf("%s: %w: %s", manager, err, lastLine(string(output)))
		}
		return nil
	}
	return fmt.Errorf("no supported package manager (apt-get, dnf, yum, apk, pacman) is available")
}

func (b *cursorPermissionBridge) prepareSandbox(ctx context.Context, job *ClaimedSession, installer *cursorSandboxInstaller,
	detect func(context.Context, *ClaimedSession, string) (*cursorSandbox, string), install func(context.Context) error) {
	if b.policy().Answer != cursorAnswerReview {
		return
	}
	b.sandbox, b.sandboxReason = installer.ensure(ctx, job, b.workspace, detect, install)
	b.sandboxInForce = b.sandbox != nil
}
