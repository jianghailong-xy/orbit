package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"time"
)

// Codex's command sandbox on Orbit Cloud.
//
// An Orbit Cloud runner Pod runs under seccomp RuntimeDefault with no capabilities, so
// unshare(CLONE_NEWUSER) is refused and Codex's bundled bwrap cannot build its sandbox: every
// command Auto sends under workspace-write fails before it runs, and Codex 0.170 has no working
// fallback (legacy Landlock panics). The model then leaves the sandbox anyway, through an escalation
// Codex's own reviewer allows or through bg_run. So on a managed runner whose sandbox probe fails,
// Auto runs with the sandbox off (danger-full-access) and the session's permission semantics say so.
// The Cloud runner's own container is the boundary there, so the transcript gets no warning about it
// (owner, 2026-11-26). The approval policy and reviewer stay as Auto has them. A self-registered runner never probes and keeps today's behaviour.

const (
	codexCloudSandboxNoticeKind = "codex-sandbox-unavailable"
	codexCloudSandboxCode       = "sandbox_unavailable_cloud"
	codexCloudSandboxNote       = "Codex's own sandbox cannot start on Orbit Cloud, so it is off: your Cloud runner's container isolates its commands instead."
	codexCloudSandboxProbeLimit = 30 * time.Second
)

// Seams for tests: whether this runner is an Orbit Cloud (managed) runner, and the probe itself.
// The probe answers whether Codex's sandbox could run a command (ok), and whether that answer is one
// to keep (conclusive): a codex that could not be started at all says nothing about the sandbox.
var (
	codexCloudSandboxManaged = func() bool { return currentManagedInstance() != nil && runtime.GOOS == "linux" }
	codexCloudSandboxProbe   = runCodexSandboxProbe
)

var codexCloudSandboxCache struct {
	mu          sync.Mutex
	done        bool
	unavailable bool
}

// codexCloudSandboxUnavailable reports whether Codex's sandbox cannot run on this managed runner. It
// probes once, on the first Codex launch, and keeps a conclusive answer for the life of the process.
func codexCloudSandboxUnavailable() bool {
	if !codexCloudSandboxManaged() {
		return false
	}
	c := &codexCloudSandboxCache
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.done {
		return c.unavailable
	}
	ok, conclusive := codexCloudSandboxProbe()
	if !conclusive {
		return false
	}
	c.done, c.unavailable = true, !ok
	if c.unavailable {
		logln("codex: sandbox probe failed on this Orbit Cloud runner; Codex Auto runs with the sandbox off")
	}
	return c.unavailable
}

// runCodexSandboxProbe runs `true` under Codex's own Linux sandbox, in the workspace-write mode Auto uses.
func runCodexSandboxProbe() (ok, conclusive bool) {
	ctx, cancel := context.WithTimeout(context.Background(), codexCloudSandboxProbeLimit)
	defer cancel()
	cmd := exec.CommandContext(ctx, "codex", "sandbox", "linux", "--full-auto", "--", "true")
	cmd.Dir = os.TempDir()
	err := cmd.Run()
	if err == nil {
		return true, true
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && ctx.Err() == nil {
		return false, true
	}
	return false, false
}

// codexCloudSandboxOff is whether this claim's Codex runs Auto with the sandbox off.
func codexCloudSandboxOff(job *ClaimedSession, permissionMode string) bool {
	return job != nil && job.codexCloudSandboxUnavailable && permissionMode == "auto"
}

// codexCloudSandboxDiagnostic is the transcript diagnostic for the sandbox being off on Orbit Cloud.
func codexCloudSandboxDiagnostic() map[string]interface{} {
	return map[string]interface{}{
		"component":   "sandbox",
		"phase":       "startup",
		"severity":    "WARN",
		"impact":      "degraded",
		"recoverable": false,
		"code":        codexCloudSandboxCode,
	}
}

// codexCloudSandboxPermissionSemantics is what Auto means on this session, in the shape of the session
// payload's permissionSemantics (shared/permissionSemantics.ts), with the sandbox marked off.
func codexCloudSandboxPermissionSemantics() map[string]interface{} {
	return map[string]interface{}{
		"mode":            "auto",
		"unapproved":      "allow",
		"approvalSupport": "partial",
		"honored":         false,
		"sandbox":         "off",
		"note":            codexCloudSandboxNote,
		"shortNote":       "Codex sandbox off, the Cloud runner's container isolates commands",
	}
}

// codexCloudSandboxNoticePayload is the runner's report of the probe's outcome to the server:
// `sandboxUnavailable` marks the session so its server-derived permission semantics say the sandbox is
// off (apiserver codex-sandbox-report.ts). It carries no `notice` or `diagnostic`, so the transcript
// draws nothing for it. A runner whose probe passed sends no such event, which leaves the session as it is.
func codexCloudSandboxNoticePayload() map[string]interface{} {
	return map[string]interface{}{
		"sandboxUnavailable":  true,
		"noticeKind":          codexCloudSandboxNoticeKind,
		"provider":            providerCodex,
		"permissionSemantics": codexCloudSandboxPermissionSemantics(),
	}
}

// codexStderrDiagnosticFor is codexStderrDiagnostic for this claim. With the sandbox off on Orbit
// Cloud, Codex's "could not find bubblewrap" line is not advice to install bubblewrap (there is no
// root in the Pod, and a system bwrap hits the same seccomp wall), so it carries the truthful
// diagnostic instead.
func codexStderrDiagnosticFor(job *ClaimedSession, line string) (map[string]interface{}, bool) {
	diagnostic, ok := codexStderrDiagnostic(line)
	if ok && diagnostic["code"] == "bubblewrap_missing" && job != nil && job.codexCloudSandboxUnavailable {
		return codexCloudSandboxDiagnostic(), true
	}
	return diagnostic, ok
}
