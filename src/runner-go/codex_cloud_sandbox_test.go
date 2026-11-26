//go:build linux || darwin

package main

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// The line Codex logs on every start in a Pod with no system bwrap.
const codexBubblewrapMissingLine = "2026-11-22T14:31:13.780609Z ERROR codex_app_server: Codex could not find bubblewrap on PATH. " +
	"Install bubblewrap with your OS package manager. Codex will use the bundled bubblewrap in the meantime."

// codexSandboxEvents keeps every event a Codex launch emitted.
type codexSandboxEvents struct {
	mu     sync.Mutex
	events []map[string]interface{}
}

func (r *codexSandboxEvents) emit(kind string, payload map[string]interface{}) {
	if kind != evSystem {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, payload)
}

func (r *codexSandboxEvents) snapshot() []map[string]interface{} {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]map[string]interface{}(nil), r.events...)
}

// waitStderr waits for the forwarded bubblewrap line and returns its event.
func (r *codexSandboxEvents) waitStderr(t *testing.T) map[string]interface{} {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		for _, e := range r.snapshot() {
			if s, _ := e["stderr"].(string); strings.Contains(s, "could not find bubblewrap") {
				return e
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("codex's bubblewrap line was never forwarded")
	return nil
}

func (r *codexSandboxEvents) notices() []map[string]interface{} {
	var out []map[string]interface{}
	for _, e := range r.snapshot() {
		if e["noticeKind"] == codexCloudSandboxNoticeKind {
			out = append(out, e)
		}
	}
	return out
}

// cloudSandboxCase launches Codex Auto against a fake codex whose `sandbox linux` probe exits with
// probeExit, on a runner that is managed or not, and drives one turn/start far enough to emit.
type cloudSandboxCase struct {
	job    *ClaimedSession
	events *codexSandboxEvents
	probes func() int
}

func launchCodexAuto(t *testing.T, managed bool, probeExit string) cloudSandboxCase {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	resetCodexCloudSandboxCache(t)
	prevManaged := codexCloudSandboxManaged
	codexCloudSandboxManaged = func() bool { return managed }
	t.Cleanup(func() { codexCloudSandboxManaged = prevManaged })

	bin := t.TempDir()
	probeLog := filepath.Join(t.TempDir(), "probes")
	writeFakeBin(t, bin, providerCodex, `if [ "$1" = sandbox ]; then
  echo probe >> '`+probeLog+`'
  [ `+probeExit+` = 0 ] || echo 'bwrap: No permissions to create a new namespace, likely because the kernel does not allow non-privileged user namespaces.' >&2
  exit `+probeExit+`
fi
echo '`+codexBubblewrapMissingLine+`' >&2
/bin/sleep 2`)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	job := &ClaimedSession{
		SessionID: "019fcbf3-0fa8-7f83-9302-46b25389cb16",
		Agent:     AgentExecConfig{PermissionMode: "auto"},
	}
	dir := t.TempDir()
	events := &codexSandboxEvents{}
	app, err := startCodexAppServer(context.Background(), job, dir, dir, envWithAgent(job.Agent.Env), events.emit, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(app.close)
	events.waitStderr(t)
	// The fake never answers turn/start; what matters is what the runner sent and emitted before it.
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	_, _ = app.startTurn(ctx, "thread-1", job, dir, dir, "turn-1", "work", nil)
	return cloudSandboxCase{job: job, events: events, probes: func() int {
		b, _ := os.ReadFile(probeLog)
		return strings.Count(string(b), "probe")
	}}
}

func resetCodexCloudSandboxCache(t *testing.T) {
	t.Helper()
	reset := func() {
		codexCloudSandboxCache.mu.Lock()
		codexCloudSandboxCache.done, codexCloudSandboxCache.unavailable = false, false
		codexCloudSandboxCache.mu.Unlock()
	}
	reset()
	t.Cleanup(reset)
}

// On an Orbit Cloud runner whose Codex sandbox cannot start, Auto runs with the sandbox off and says so:
// thread/start and turn/start ask for danger-full-access, the approval policy and reviewer stay Auto's,
// the bubblewrap line carries the Cloud diagnostic rather than "install bubblewrap", and the server gets
// one report whose permission semantics mark the sandbox off, with nothing for the transcript to draw.
func TestCodexAutoOnCloudWithAFailedSandboxProbeRunsWithTheSandboxOff(t *testing.T) {
	c := launchCodexAuto(t, true, "1")
	if !c.job.codexCloudSandboxUnavailable {
		t.Fatal("a failed probe on a managed runner did not mark the sandbox unavailable")
	}

	thread := codexThreadParams(c.job, "/repo", "/up")
	if thread["sandbox"] != "danger-full-access" {
		t.Errorf("thread/start sandbox = %v, want danger-full-access", thread["sandbox"])
	}
	if thread["approvalPolicy"] != "on-request" || thread["approvalsReviewer"] != "auto_review" {
		t.Errorf("thread/start approval = %v / %v, want Auto's on-request / auto_review", thread["approvalPolicy"], thread["approvalsReviewer"])
	}
	turn := codexTurnParams("thread-1", c.job, "/repo", "/up", "turn-1", "work", nil, codexTurnContextOptions{})
	if got := turn["sandboxPolicy"]; !reflect.DeepEqual(got, map[string]interface{}{"type": "dangerFullAccess"}) {
		t.Errorf("turn/start sandboxPolicy = %#v, want dangerFullAccess", got)
	}
	if turn["approvalPolicy"] != "on-request" || turn["approvalsReviewer"] != "auto_review" {
		t.Errorf("turn/start approval = %v / %v, want Auto's on-request / auto_review", turn["approvalPolicy"], turn["approvalsReviewer"])
	}

	stderr := c.events.waitStderr(t)
	diagnostic, _ := stderr["diagnostic"].(map[string]interface{})
	if diagnostic["code"] != codexCloudSandboxCode {
		t.Errorf("bubblewrap line diagnostic = %#v, want code %s, not bubblewrap_missing", diagnostic, codexCloudSandboxCode)
	}

	notices := c.events.notices()
	if len(notices) != 1 {
		t.Fatalf("got %d sandbox notices, want 1: %#v", len(notices), c.events.snapshot())
	}
	notice := notices[0]
	if notice["sandboxUnavailable"] != true {
		t.Errorf("report = %#v, want sandboxUnavailable", notice)
	}
	if _, ok := notice["notice"]; ok {
		t.Errorf("report carries transcript text %q, want none", notice["notice"])
	}
	if _, ok := notice["diagnostic"]; ok {
		t.Errorf("report carries a diagnostic %#v, want none", notice["diagnostic"])
	}
	semantics, _ := notice["permissionSemantics"].(map[string]interface{})
	if semantics["sandbox"] != "off" || semantics["honored"] != false || semantics["mode"] != "auto" || semantics["unapproved"] != "allow" {
		t.Errorf("permissionSemantics = %#v, want Auto with the sandbox off and not honored", semantics)
	}

	// The probe ran once and its answer is kept for the next launch.
	if !codexCloudSandboxUnavailable() || c.probes() != 1 {
		t.Errorf("probes = %d, want one cached probe", c.probes())
	}
}

// A managed runner whose sandbox works keeps today's Auto: workspace-write, no notice, and the
// bubblewrap line keeps its own diagnostic.
func TestCodexAutoOnCloudWithAPassingSandboxProbeKeepsWorkspaceWrite(t *testing.T) {
	c := launchCodexAuto(t, true, "0")
	assertCodexAutoUnchanged(t, c)
	if c.probes() != 1 {
		t.Errorf("probes = %d, want 1", c.probes())
	}
}

// A self-registered runner never probes, and a host lacking bubblewrap keeps the existing advice.
func TestCodexAutoOnASelfRegisteredHostIsUnchanged(t *testing.T) {
	c := launchCodexAuto(t, false, "1")
	assertCodexAutoUnchanged(t, c)
	if c.probes() != 0 {
		t.Errorf("a self-registered runner probed Codex's sandbox %d times", c.probes())
	}
}

func assertCodexAutoUnchanged(t *testing.T, c cloudSandboxCase) {
	t.Helper()
	if c.job.codexCloudSandboxUnavailable {
		t.Fatal("the sandbox was marked unavailable")
	}
	if got := codexThreadParams(c.job, "/repo", "/up")["sandbox"]; got != "workspace-write" {
		t.Errorf("thread/start sandbox = %v, want workspace-write", got)
	}
	turn := codexTurnParams("thread-1", c.job, "/repo", "/up", "turn-1", "work", nil, codexTurnContextOptions{})
	if policy, _ := turn["sandboxPolicy"].(map[string]interface{}); policy["type"] != "workspaceWrite" {
		t.Errorf("turn/start sandboxPolicy = %#v, want workspaceWrite", turn["sandboxPolicy"])
	}
	want, _ := codexStderrDiagnostic(codexBubblewrapMissingLine)
	if got := c.events.waitStderr(t)["diagnostic"]; !reflect.DeepEqual(got, want) || want["code"] != "bubblewrap_missing" {
		t.Errorf("bubblewrap line diagnostic = %#v, want the existing bubblewrap_missing", got)
	}
	if n := len(c.events.notices()); n != 0 {
		t.Errorf("got %d sandbox notices, want none", n)
	}
}

// The sandbox stays as it is for every mode but Auto, even where the probe failed.
func TestCodexCloudSandboxOffOnlyChangesAuto(t *testing.T) {
	job := &ClaimedSession{codexCloudSandboxUnavailable: true}
	for _, mode := range []string{"default", "acceptEdits", "plan", "dontAsk", "bypassPermissions", codexReadonlySubagentMode} {
		if got, want := codexThreadSandboxMode(job, mode), codexSandboxMode(mode); got != want {
			t.Errorf("%s: sandbox %q, want %q", mode, got, want)
		}
		if got, want := codexSandboxPolicy(mode, job, "/repo", "/up"), codexSandboxPolicy(mode, nil, "/repo", "/up"); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: sandboxPolicy %#v, want %#v", mode, got, want)
		}
	}
}

// sandboxReports is every event of the launch that reports the sandbox unavailable to the server
// (`sandboxUnavailable: true`, read by apiserver codex-sandbox-report.ts).
func (r *codexSandboxEvents) sandboxReports() []map[string]interface{} {
	var out []map[string]interface{}
	for _, e := range r.snapshot() {
		if e["sandboxUnavailable"] == true {
			out = append(out, e)
		}
	}
	return out
}

// The runner reports the probe's outcome for the session: once when the probe fails, so the server's
// permission semantics say the sandbox is off, and never when it passes or on a self-registered runner.
func TestCodexCloudSandboxProbeOutcomeIsReportedToTheServer(t *testing.T) {
	failed := launchCodexAuto(t, true, "1")
	if n := len(failed.events.sandboxReports()); n != 1 {
		t.Fatalf("a failed probe sent %d sandbox-unavailable reports, want 1: %#v", n, failed.events.snapshot())
	}
	for _, c := range []struct {
		name      string
		managed   bool
		probeExit string
	}{{"passing probe", true, "0"}, {"self-registered runner", false, "1"}} {
		got := launchCodexAuto(t, c.managed, c.probeExit)
		got.events.waitStderr(t)
		if n := len(got.events.sandboxReports()); n != 0 {
			t.Errorf("%s sent %d sandbox-unavailable reports, want none", c.name, n)
		}
	}
}
