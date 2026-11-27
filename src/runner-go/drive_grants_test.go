package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

// The engine grants of the drive (docs/drive-technical-design.md §7): every launch names the
// parent /run/orbit-drive and both spellings of the drive in every write mode, Plan mode only reads it, and a runner
// with no drive mounted is launched exactly as before.

func driveRootsForTest() []string { return []string{driveParentPath, driveHomePath, driveMountPath} }

func addDirs(args []string) []string {
	var dirs []string
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--add-dir" {
			dirs = append(dirs, args[i+1])
		}
	}
	return dirs
}

func TestClaudeLaunchGrantsTheDriveInEveryMode(t *testing.T) {
	for _, mode := range []string{"default", "acceptEdits", "auto", "bypassPermissions", "plan"} {
		t.Run(mode, func(t *testing.T) {
			fakeDriveMount(t, true)
			job := claudeSpawnJob(t)
			job.Agent.PermissionMode = mode
			args := claudeCommandArgs(job, t.TempDir(), true)
			dirs := addDirs(args)
			for _, root := range driveRootsForTest() {
				found := false
				for _, d := range dirs {
					found = found || d == root
				}
				if !found {
					t.Fatalf("--add-dir %s missing from %v", root, args)
				}
			}
			// Plan mode is passed through; the runner's prompt refuses a write in the drive (plan_drive_test.go).
			if !containsArgs(args, []string{"--permission-mode", mode}) {
				t.Fatalf("permission mode %s not passed: %v", mode, args)
			}
		})
	}
	t.Run("no drive mounted", func(t *testing.T) {
		fakeDriveMount(t, false)
		for _, d := range addDirs(claudeCommandArgs(claudeSpawnJob(t), t.TempDir(), true)) {
			if strings.Contains(d, "orbit-drive") || strings.Contains(d, "orbit-documents") || strings.Contains(d, "orbit-files") || d == driveParentPath || d == driveHomePath {
				t.Fatalf("a runner without the drive was granted %s", d)
			}
		}
	})
}

func TestCodexGrantsTheDriveWritableInAutoAndReadsItInPlan(t *testing.T) {
	fakeDriveMount(t, true)
	t.Setenv("ORBIT_HOME", t.TempDir())
	roots := codexRuntimeWorkspaceRoots("auto", nil, "/repo", "/tmp/uploads")
	policy := codexSandboxPolicy("auto", nil, "/repo", "/tmp/uploads")
	writable, _ := policy["writableRoots"].([]string)
	// The sandbox gets the drive's own path only: the parent is unwritable to the agent and the link is a symlink,
	// and either one makes Codex's bwrap refuse every command (row 56).
	if !containsString(roots, driveMountPath) || !containsString(writable, driveMountPath) {
		t.Fatalf("auto: %s missing from workspace roots %v / writable roots %v", driveMountPath, roots, writable)
	}
	for _, root := range []string{driveParentPath, driveHomePath} {
		if containsString(roots, root) || containsString(writable, root) {
			t.Fatalf("auto: %s must not be a sandbox root: %v / %v", root, roots, writable)
		}
	}
	// The classifier treats the drive as a workspace root, never as a temp one.
	auto := codexAutoApprovalContextFor("/repo", "/tmp/uploads")
	for _, root := range driveRootsForTest() {
		if !containsString(auto.workspaceRoots, root) || containsString(auto.tempRoots, root) {
			t.Fatalf("approval context for %s: %+v", root, auto)
		}
	}
	// Plan and Default grant no writable root of their own: Plan refuses every write at the approval, and the
	// read-only subagent's sandbox reads everything.
	for _, mode := range []string{"plan", "default", codexReadonlySubagentMode} {
		if got := codexRuntimeWorkspaceRoots(mode, nil, "/repo", "/tmp/uploads"); !reflect.DeepEqual(got, []string{"/repo", "/tmp/uploads"}) {
			t.Fatalf("%s: workspace roots = %v", mode, got)
		}
		if p := codexSandboxPolicy(mode, nil, "/repo", "/tmp/uploads"); p["writableRoots"] != nil {
			t.Fatalf("%s: sandbox names writable roots: %v", mode, p)
		}
	}

	job := &ClaimedSession{SessionID: "s", Agent: AgentExecConfig{}}
	args := codexExecCommandArgs(job, "/repo", "/tmp/uploads", nil, "")
	if dirs := addDirs(args); !reflect.DeepEqual(dirs, []string{"/tmp/uploads", driveMountPath}) {
		t.Fatalf("codex exec --add-dir = %v", dirs)
	}

	fakeDriveMount(t, false)
	if roots := codexRuntimeWorkspaceRoots("auto", nil, "/repo", "/tmp/uploads"); containsString(roots, driveMountPath) {
		t.Fatalf("no drive mounted, yet %v", roots)
	}
	if dirs := addDirs(codexExecCommandArgs(job, "/repo", "/tmp/uploads", nil, "")); !reflect.DeepEqual(dirs, []string{"/tmp/uploads"}) {
		t.Fatalf("no drive mounted, yet codex exec --add-dir = %v", dirs)
	}
}

func TestCursorSandboxBindsTheDriveParentNeverTheMount(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("bwrap binds are Linux")
	}
	fakeDriveMount(t, true)
	t.Setenv("ORBIT_HOME", t.TempDir())
	if err := os.MkdirAll(runnerCacheRoot(), 0o700); err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "bwrap"), []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	sandbox, reason := detectCursorSandbox(context.Background(), nil, t.TempDir())
	if sandbox == nil {
		t.Fatal(reason)
	}
	parent, _ := filepath.EvalSymlinks(driveParentPath)
	mount, _ := filepath.EvalSymlinks(driveMountPath)
	if !containsString(sandbox.roots, parent) {
		t.Fatalf("the parent %s is not a bound root: %v", parent, sandbox.roots)
	}
	if containsString(sandbox.roots, mount) {
		t.Fatalf("the mount %s itself is bound, which keeps a dead mount after a remount: %v", mount, sandbox.roots)
	}
}

func TestOpenCodeAllowsTheDriveAsAnExternalDirectory(t *testing.T) {
	fakeDriveMount(t, true)
	for _, mode := range []string{"default", "acceptEdits", "plan"} {
		permission := map[string]interface{}{}
		applyOpenCodePermissions(permission, AgentExecConfig{PermissionMode: mode}, nil)
		external, _ := permission["external_directory"].(map[string]interface{})
		for _, root := range driveRootsForTest() {
			if external[root+"/**"] != "allow" {
				t.Fatalf("%s: external_directory %v does not allow %s", mode, external, root)
			}
		}
		if mode == "plan" {
			for _, name := range []string{"edit", "write", "patch"} {
				if permission[name] != "deny" {
					t.Fatalf("plan: %s = %v, so the drive could be written", name, permission[name])
				}
			}
		}
	}
	fakeDriveMount(t, false)
	permission := map[string]interface{}{}
	applyOpenCodePermissions(permission, AgentExecConfig{PermissionMode: "default"}, nil)
	if _, ok := permission["external_directory"]; ok {
		t.Fatalf("no drive mounted, yet %v", permission)
	}
}

func TestAntigravityAndDshTreatTheDriveAsAWorkspaceRoot(t *testing.T) {
	fakeDriveMount(t, true)
	w := newAgyPolicyWorld(t)
	policy := w.policy("acceptEdits")
	policy.Drive = driveGrantRoots()
	file := filepath.Join(driveMountPath, "Proj", "a.md")
	decide := func(mode, tool string, args map[string]interface{}) string {
		policy.Mode = mode
		in := &agyHookInput{}
		in.ToolCall.Name, in.ToolCall.Args = tool, args
		return decideAntigravityToolCall(policy, in).decision
	}
	if got := decide("acceptEdits", "write_to_file", map[string]interface{}{"TargetFile": file, "CodeContent": "x"}); got != "allow" {
		t.Fatalf("accept edits write in the drive = %s", got)
	}
	if got := decide("default", "write_to_file", map[string]interface{}{"TargetFile": file, "CodeContent": "x"}); got != "ask" {
		t.Fatalf("default write in the drive = %s, want the same ask as the checkout", got)
	}
	if got := decide("plan", "write_to_file", map[string]interface{}{"TargetFile": file, "CodeContent": "x"}); got == "allow" {
		t.Fatal("plan mode may write the drive")
	}
	if got := decide("plan", "view_file", map[string]interface{}{"AbsolutePath": file}); got != "allow" {
		t.Fatalf("plan read in the drive = %s", got)
	}

	// The DeepSeek Harness sandbox gets the roots beside the uploads folder.
	t.Setenv("ORBIT_HOME", t.TempDir())
	job := &ClaimedSession{SessionID: "dsh-drive"}
	overlay := dshSessionAgentOverlay(job)
	if !reflect.DeepEqual(overlay.Drive, driveRootsForTest()) {
		t.Fatalf("dsh overlay drive = %v", overlay.Drive)
	}
	// And a routine edit of a drive file is not a card in Auto, as an uploads edit is not.
	ask := dshPermissionAsk{Name: "write", Input: map[string]interface{}{"file_path": file, "sandbox_permissions": "x"}}
	if !dshAutoUploadsEdit(ask, "/work", "") {
		t.Fatal("auto asks about an edit in the drive")
	}
	fakeDriveMount(t, false)
	if dshAutoUploadsEdit(ask, "/work", "") {
		t.Fatal("a runner without the drive allowed an edit there")
	}
}

func TestBackgroundJobsMayRunInTheDrive(t *testing.T) {
	fakeDriveMount(t, true)
	svc := &bgJobService{execDir: t.TempDir(), extraDirs: append([]string{"/tmp/up"}, driveGrantRoots()...)}
	if got, err := svc.resolveDir(driveMountPath); err != nil || got != driveMountPath {
		t.Fatalf("resolveDir(drive) = %q, %v", got, err)
	}
}

// §8.1: a runner with a handle holding bytes no commit has taken is not idle, so it is not put to sleep with them.
func TestUnflushedDriveWritesHoldTheSleepGate(t *testing.T) {
	fakeDriveMount(t, true)
	writeStatus := func(handles int, updated time.Time) {
		data, _ := json.Marshal(map[string]interface{}{"connected": true, "uncommittedHandles": handles, "updatedAt": updated})
		writeTestFile(t, driveStatusPath, string(data))
	}
	writeStatus(2, time.Now())
	if got := driveUncommittedHandles(); got != 2 {
		t.Fatalf("driveUncommittedHandles = %d, want 2", got)
	}
	sleeper := newManagedSleep()
	counts := ManagedWorkload{DriveWrites: driveUncommittedHandles()}
	if counts.idle() {
		t.Fatal("a runner with unflushed drive writes reports idle")
	}
	request := &ManagedSleepRequest{RequestedAt: "2026-11-22T08:00:00.000Z"}
	if stop, beat := sleeper.answer(request, counts.idle()); stop || beat {
		t.Fatalf("accepted a sleep with drive writes pending: stop %v beat %v", stop, beat)
	}
	if got := sleeper.report(counts); got.SleepReady != "" || got.IdleSeconds != 0 || got.DriveWrites != 2 {
		t.Fatalf("report = %+v, want busy, carrying the count", got)
	}

	// Flushed: idle again, and the acceptance goes out.
	writeStatus(0, time.Now())
	counts = ManagedWorkload{DriveWrites: driveUncommittedHandles()}
	if !counts.idle() {
		t.Fatal("a flushed drive still holds sleep")
	}
	if _, beat := sleeper.answer(request, counts.idle()); !beat {
		t.Fatal("an idle runner did not accept")
	}

	// A daemon that stopped writing status.json cannot flush anything any more: nothing held for it.
	writeStatus(3, time.Now().Add(-10*time.Minute))
	if got := driveUncommittedHandles(); got != 0 {
		t.Fatalf("a stale status.json still holds sleep: %d", got)
	}
	// No drive mounted: status.json means nothing.
	writeStatus(3, time.Now())
	fakeDriveMount(t, false)
	if got := driveUncommittedHandles(); got != 0 {
		t.Fatalf("no drive mounted, yet %d", got)
	}
}

// §8.2: a drive write from a superseded instance is refused by the control plane, once: it is not a transient failure
// to retry, it says why, and the instance is told it is revoked.
func TestSupersededInstanceDriveWriteIsRefused(t *testing.T) {
	fakeDriveMount(t, true)
	t.Setenv(envManagedRunnerGeneration, "1")
	t.Setenv(envManagedRunnerPodUID, "0a1b2c3d-0000-4000-8000-123456789abc")
	managedInstanceOnce.Do(func() {})
	old := managedInstanceCached
	managedInstanceCached = &managedInstance{Generation: "1", PodUID: "0a1b2c3d-0000-4000-8000-123456789abc"}
	t.Cleanup(func() { managedInstanceCached = old })

	commits := 0
	srv := newDriveTestServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(managedRunnerGenerationHeader) != "1" {
			t.Errorf("the write did not carry the instance: %v", r.Header)
		}
		commits++
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"code":"MANAGED_RUNNER_INSTANCE_SUPERSEDED","message":"this runner instance was replaced by a later one"}`))
	})
	tr := newCallerTransport(srv.URL, "runner-secret", runnerCallerMCP)
	_, err := commitDriveFile(context.Background(), tr, "commit-1", map[string]interface{}{"path": "/a.md"})
	if err == nil {
		t.Fatal("a superseded instance's drive write was accepted")
	}
	if commits != 1 {
		t.Fatalf("the refusal was retried: %d attempts", commits)
	}
	if got := driveToolError("drive_put", err); !strings.Contains(got.Error(), "replaced") {
		t.Fatalf("the refusal does not say why: %v", got)
	}
	if !isManagedInstanceRevoked(err) {
		t.Fatalf("the instance is not told it is revoked: %v", err)
	}
}

// §12.2: Claude Default mode treats the drive as a workspace root exactly as it treats the uploads folder: both are
// --add-dir working directories, and nothing else is added to the launch (no allow rule, no skipped permissions), so an
// edit there asks as an edit in the checkout does and leaving the workspace asks nothing.
func TestClaudeDefaultModeTreatsTheDriveAsAWorkspaceRoot(t *testing.T) {
	fakeDriveMount(t, true)
	job := claudeSpawnJob(t)
	job.Agent.PermissionMode = "default"
	scratch := t.TempDir()
	with := claudeCommandArgs(job, scratch, true)
	fakeDriveMount(t, false)
	without := claudeCommandArgs(job, scratch, true)

	if !containsArgs(with, []string{"--permission-mode", "default"}) || containsArgs(with, []string{"--dangerously-skip-permissions"}) {
		t.Fatalf("default mode launch = %v", with)
	}
	uploads := uploadsDir(job.SessionID)
	if !containsString(addDirs(with), uploads) {
		t.Fatalf("uploads folder is not a working directory: %v", with)
	}
	extra := addDirs(with)[len(addDirs(without)):]
	if len(extra) != 3 {
		t.Fatalf("the drive added %v, want the parent and both spellings", extra)
	}
	// The drive changes nothing but those working directories and the guidance text about it.
	var stripped, plain []string
	for i := 0; i < len(with); i++ {
		if with[i] == "--add-dir" && containsString(extra, with[i+1]) {
			i++
			continue
		}
		stripped = append(stripped, with[i])
		if with[i] == "--append-system-prompt" {
			i++
		}
	}
	for i := 0; i < len(without); i++ {
		plain = append(plain, without[i])
		if without[i] == "--append-system-prompt" {
			i++
		}
	}
	if !reflect.DeepEqual(stripped, plain) {
		t.Fatalf("the drive changed more than its working directories:\nwith    %.600v\nwithout %.600v", stripped, plain)
	}
}
