//go:build linux

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// A runner that re-executes into a self-update keeps its pid, so the jobs it hosts — its own
// children — are still its children in the image that comes next. That stop, and only that one,
// leaves them running: the old image hands each job on, and the new one adopts it from the record
// written when it was spawned, hosts it, and reports how it ended. Every other runner stop ends them,
// as it always has.
//
// "The next image" is played in this process: a new pool and a new supervisor over the same
// ORBIT_HOME, once the old supervisor has returned. As far as a job can tell that is the exec itself —
// the same parent, its record on disk, the old supervisor gone. The old image's goroutines are still
// here, which is why they must never reap a job they handed on.

// superviseImage runs a session's supervisor as one image of the runner runs it: pool is that image's,
// and stopping it cancels the runner's context with cause — errRunnerSelfUpdate for the stop runLoop
// makes to re-execute, context.Canceled for a signal's.
func superviseImage(t *testing.T, job *ClaimedSession, pool *sessionPool, api *runnerStopControlPlane, cause error) *runnerStopSupervisor {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(api.serve))
	t.Cleanup(server.Close)
	sessionCtx, cancelSession := context.WithCancel(context.Background())
	runnerCtx, stopRunner := context.WithCancelCause(context.Background())
	live, added := pool.register(job, cancelSession, false)
	if !added {
		t.Fatal("the session was not registered")
	}
	s := &runnerStopSupervisor{job: job, stop: func() { stopRunner(cause) }, end: cancelSession, done: make(chan struct{})}
	execDir := t.TempDir()
	go func() {
		defer close(s.done)
		runInteractiveSession(NewTransport(server.URL, "runner-token"), job, sessionCtx, runnerCtx,
			execDir, nil, pool, live)
		pool.finish(live)
	}()
	t.Cleanup(func() {
		s.stop()
		api.releaseLeases()
		select {
		case <-s.done:
		case <-time.After(4 * time.Minute):
			t.Error("the supervisor never returned after the runner stopped")
		}
		cancelSession()
	})
	return s
}

// processState is the state letter /proc gives pid — "Z" for a zombie — or "" for no such process.
func processState(pid int) string {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return ""
	}
	stat := string(data)
	fields := strings.Fields(stat[strings.LastIndexByte(stat, ')')+1:])
	if len(fields) == 0 {
		return ""
	}
	return fields[0]
}

// requireRunning holds that pid is a running process. A zombie answers signal 0 as well, so it is
// ruled out first.
func requireRunning(t *testing.T, pid int, what string) {
	t.Helper()
	if state := processState(pid); state == "" || state == "Z" {
		t.Fatalf("%s (pid %d) is not running: /proc state %q", what, pid, state)
	}
	if !processAlive(pid) {
		t.Fatalf("%s (pid %d) does not answer signal 0", what, pid)
	}
}

// jobRecordPath is where the runner files a job's record: runDir(session)/bg-jobs/<jobId>.json.
func jobRecordPath(sessionID, jobID string) string {
	return filepath.Join(runDir(sessionID), "bg-jobs", jobID+".json")
}

func requireNoRecord(t *testing.T, sessionID, jobID, why string) {
	t.Helper()
	if _, err := os.Stat(jobRecordPath(sessionID, jobID)); !os.IsNotExist(err) {
		t.Errorf("the record of %s is still there (stat err = %v): %s", jobID, err, why)
	}
}

func listJobs(t *testing.T, sessionID string) map[string]bgJobStatus {
	t.Helper()
	var listed struct {
		Jobs []bgJobStatus `json:"jobs"`
	}
	if raw := bgCall(t, sessionID, "list", nil); json.Unmarshal(raw, &listed) != nil {
		t.Fatalf("bg_list result was not a job list: %s", raw)
	}
	jobs := map[string]bgJobStatus{}
	for _, job := range listed.Jobs {
		jobs[job.JobID] = job
	}
	return jobs
}

// recordedChild is a process this test starts as the runner starts a job — its own process group —
// with a record filed for it, as an image that handed the job on leaves one.
type recordedChild struct {
	jobID string
	pid   int
}

func startRecordedChild(t *testing.T, sessionID, jobID string, version interface{}, dir string) recordedChild {
	t.Helper()
	cmd := exec.Command("sleep", "300")
	cmd.Dir = dir
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = cmd.Wait()
	})
	writeJobRecord(t, sessionID, jobID, version, cmd.Process.Pid)
	return recordedChild{jobID: jobID, pid: cmd.Process.Pid}
}

func writeJobRecord(t *testing.T, sessionID, jobID string, version interface{}, pid int) {
	t.Helper()
	data, err := json.Marshal(map[string]interface{}{
		"version": version, "sessionId": sessionID, "jobId": jobID, "pid": pid, "kind": bgKindJob,
		"command": "sleep 300", "outputPath": filepath.Join(runDir(sessionID), jobID+".output"),
		"startedAt": time.Now().UTC().Format(time.RFC3339Nano),
	})
	if err != nil {
		t.Fatal(err)
	}
	path := jobRecordPath(sessionID, jobID)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

// requireOneEndAsPrinted holds that exactly one end was reported for job across the images' control
// planes, failed, with the exit code the job printed it was exiting with.
func requireOneEndAsPrinted(t *testing.T, job bgJobStatus, printed string, apis ...*runnerStopControlPlane) {
	t.Helper()
	var ended []map[string]interface{}
	for _, api := range apis {
		ended = append(ended, api.terminalReports(job.JobID)...)
	}
	if len(ended) != 1 {
		t.Errorf("terminal reports of %s across both images = %v, want exactly one", job.JobID, ended)
		return
	}
	said := regexp.MustCompile(regexp.QuoteMeta(printed) + ` (\d+)`).FindStringSubmatch(asString(ended[0]["output"]))
	if said == nil {
		t.Errorf("the end of %s carries no exit status the job printed: %v", job.JobID, ended[0])
		return
	}
	status, _ := strconv.Atoi(said[1])
	if got, ok := ended[0]["exitCode"].(float64); !ok || int(got) != status {
		t.Errorf("the end of %s reports exit code %v, and the job exited with %d", job.JobID, ended[0]["exitCode"], status)
	}
	if got := asString(ended[0]["status"]); got != bgStatusFailed {
		t.Errorf("the end of %s reports status %q, want failed", job.JobID, got)
	}
}

// The re-exec, end to end in one process. The old image's drain kills the service and hands on the
// jobs and the watch: running, not reported, on record. One job exits while no image hosts it, and
// stays unreaped. The next image adopts all of them before its supervisor starts and hosts them —
// bg_list and bg_output find them, bg_kill ends the watch — and each job's end is reported exactly
// once, with the exit status the job itself printed: the one that exited in between as soon as the
// supervisor takes it over, the other when it exits.
func TestSelfUpdateHandsJobsOnAndTheNextImageReportsHowTheyEnd(t *testing.T) {
	job := runnerStopJob(t, "sess-selfupdate-handoff")
	release := filepath.Join(os.Getenv("ORBIT_HOME"), "release")
	releaseEarly := filepath.Join(os.Getenv("ORBIT_HOME"), "release-early")
	oldAPI := newRunnerStopControlPlane()
	old := superviseImage(t, job, newSessionPool(4), oldAPI, errRunnerSelfUpdate)

	build := old.mustRun(t, fmt.Sprintf(`echo building; while [ ! -e %s ]; do sleep 0.1; done; `+
		`sh -c 'exit 7'; status=$?; echo "build exit status $status"; exit $status`, release), bgKindJob)
	early := old.mustRun(t, fmt.Sprintf(`while [ ! -e %s ]; do sleep 0.1; done; `+
		`sh -c 'exit 5'; status=$?; echo "early exit status $status"; exit $status`, releaseEarly), bgKindJob)
	ci := old.mustRun(t, "exec sleep 300", bgKindWatch)
	devServer := old.mustRun(t, "exec sleep 300", bgKindService)
	awaitCondition(t, 15*time.Second, "the launches were never delivered", func() bool {
		return oldAPI.delivered(isJobLaunch(build.JobID)) && oldAPI.delivered(isJobLaunch(early.JobID)) &&
			oldAPI.delivered(isJobLaunch(ci.JobID)) && oldAPI.delivered(isJobLaunch(devServer.JobID))
	})

	old.stop()
	old.awaitReturn(t, 2*time.Minute)

	// A service goes with the runner's stop, whatever the stop is for.
	assertEndedByRunnerStop(t, oldAPI, devServer)
	for _, handed := range []bgJobStatus{build, early, ci} {
		if got := oldAPI.terminalReports(handed.JobID); len(got) != 0 {
			t.Errorf("%s %s was reported ended by the image that re-executed: %v", handed.Kind, handed.JobID, got)
		}
		if _, err := os.Stat(jobRecordPath(job.SessionID, handed.JobID)); err != nil {
			t.Errorf("%s %s has no record for the next image to adopt it by: %v", handed.Kind, handed.JobID, err)
		}
	}
	requireRunning(t, build.PID, "the job after the self-update drain")
	requireRunning(t, early.PID, "the second job after the self-update drain")
	requireRunning(t, ci.PID, "the watch after the self-update drain")

	// Between the images: a job that exits now is left for the next image to reap and read.
	if err := os.WriteFile(releaseEarly, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	awaitCondition(t, 15*time.Second, "the job that exited between the images is not waiting to be reaped", func() bool {
		return processState(early.PID) == "Z"
	})

	// The next image: a pool of its own, the records adopted before anything else, then the supervisor.
	newAPI := newRunnerStopControlPlane()
	newPool := newSessionPool(4)
	newPool.adoptRecordedJobs()
	if !newPool.ids()[job.SessionID] {
		t.Error("before the supervisor starts, the adopted jobs do not hold the session's checkout from the sweep")
	}
	superviseImage(t, job, newPool, newAPI, errRunnerSelfUpdate)
	awaitCondition(t, 15*time.Second, "the next image never announced the jobs it adopted, or never reported the one that had ended", func() bool {
		return newAPI.delivered(isJobLaunch(build.JobID)) && newAPI.delivered(isJobLaunch(ci.JobID)) &&
			len(newAPI.terminalReports(early.JobID)) > 0
	})
	listed := listJobs(t, job.SessionID)
	for _, adopted := range []bgJobStatus{build, ci} {
		if got, ok := listed[adopted.JobID]; !ok || got.Status != bgStatusRunning || got.PID != adopted.PID {
			t.Errorf("bg_list in the next image has %s as %+v (listed: %t), want it running as pid %d",
				adopted.JobID, got, ok, adopted.PID)
		}
	}
	var output bgJobOutput
	if raw := bgCall(t, job.SessionID, "output", map[string]interface{}{"jobId": build.JobID}); json.Unmarshal(raw, &output) != nil ||
		!strings.Contains(output.Output, "building") {
		t.Errorf("bg_output of the adopted job = %q, want what it wrote before the re-exec", output.Output)
	}

	bgCall(t, job.SessionID, "kill", map[string]interface{}{"jobId": ci.JobID})
	if err := os.WriteFile(release, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	awaitCondition(t, 30*time.Second, "the adopted job and watch ended and their ends never reached the control plane", func() bool {
		return len(newAPI.terminalReports(build.JobID)) > 0 && len(newAPI.terminalReports(ci.JobID)) > 0
	})
	time.Sleep(time.Second) // four flush intervals, for a second report to show up in

	requireOneEndAsPrinted(t, build, "build exit status", oldAPI, newAPI)
	requireOneEndAsPrinted(t, early, "early exit status", oldAPI, newAPI)
	watchEnded := append(oldAPI.terminalReports(ci.JobID), newAPI.terminalReports(ci.JobID)...)
	if len(watchEnded) != 1 || asString(watchEnded[0]["status"]) != bgStatusKilled || asString(watchEnded[0]["reason"]) != "requested" {
		t.Errorf("terminal reports of the watch killed by bg_kill = %v, want exactly one, killed on request", watchEnded)
	}
	// Reaped by the next image before it reported, so no zombie is what answers signal 0 here.
	for _, adopted := range []bgJobStatus{build, early, ci} {
		if processAlive(adopted.PID) {
			t.Errorf("%s %s (pid %d) is still there after its end was reported: /proc state %q",
				adopted.Kind, adopted.JobID, adopted.PID, processState(adopted.PID))
		}
		requireNoRecord(t, job.SessionID, adopted.JobID, "it has ended")
	}
}

// The same session, the same jobs, and a stop that is not a re-exec: a signal. Nothing is handed on —
// the job and the watch are killed and each reported once as the runner's stop, and no record is left
// for an image that is not coming.
func TestARunnerStopThatIsNotASelfUpdateStillEndsItsJobs(t *testing.T) {
	job := runnerStopJob(t, "sess-signal-stop-jobs")
	api := newRunnerStopControlPlane()
	sup := superviseImage(t, job, newSessionPool(4), api, context.Canceled)

	build := sup.mustRun(t, "exec sleep 300", bgKindJob)
	ci := sup.mustRun(t, "exec sleep 300", bgKindWatch)
	awaitCondition(t, 15*time.Second, "the launches were never delivered", func() bool {
		return api.delivered(isJobLaunch(build.JobID)) && api.delivered(isJobLaunch(ci.JobID))
	})

	sup.stop()
	sup.awaitReturn(t, 2*time.Minute)

	assertEndedByRunnerStop(t, api, build)
	assertEndedByRunnerStop(t, api, ci)
	requireNoRecord(t, job.SessionID, build.JobID, "the runner's stop ended the job")
	requireNoRecord(t, job.SessionID, ci.JobID, "the runner's stop ended the watch")
}

// A record is adopted only in the one format this runner reads. One of another version, or one that is
// not a record at all, names a process this runner cannot vouch for: it is not adopted, nothing is
// reported for it — the control plane already takes a job last reported by a runner process that has
// gone as one with no end report — the process is left alone, and the record is discarded. The paired
// positive is a record this runner does read, in the same session.
func TestARecordOfAVersionThisRunnerCannotReadIsNoEndReport(t *testing.T) {
	job := runnerStopJob(t, "sess-record-versions")
	dir := t.TempDir()
	known := startRecordedChild(t, job.SessionID, "bgj_0000000000a1", 1, dir)
	unknown := startRecordedChild(t, job.SessionID, "bgj_0000000000b2", 2, dir)
	garbled := jobRecordPath(job.SessionID, "bgj_0000000000c3")
	if err := os.WriteFile(garbled, []byte(`{"version": "one", "pid": `), 0o600); err != nil {
		t.Fatal(err)
	}

	pool := newSessionPool(4)
	pool.adoptRecordedJobs()
	api := newRunnerStopControlPlane()
	superviseImage(t, job, pool, api, context.Canceled)

	awaitCondition(t, 15*time.Second, "the job whose record this runner reads was never adopted", func() bool {
		return api.delivered(isJobLaunch(known.jobID))
	})
	listed := listJobs(t, job.SessionID)
	if _, ok := listed[known.jobID]; !ok {
		t.Errorf("bg_list = %v, want the adopted job", listed)
	}
	if _, ok := listed[unknown.jobID]; ok {
		t.Errorf("bg_list = %v: a job filed in a record version this runner does not read was adopted", listed)
	}
	time.Sleep(time.Second) // four flush intervals
	if api.delivered(func(e RunEvent) bool { return asString(e.Payload["toolUseId"]) == unknown.jobID }) {
		t.Error("an event was reported for the job of a record this runner cannot read")
	}
	requireNoRecord(t, job.SessionID, unknown.jobID, "a record of another version is discarded")
	if _, err := os.Stat(garbled); !os.IsNotExist(err) {
		t.Errorf("the garbled record is still there (stat err = %v)", err)
	}
	requireRunning(t, unknown.pid, "the process of the record this runner cannot read")
}

// Until a job is adopted the pool does not hold its checkout, and the worktree sweep takes the checkout
// for one nobody is using — deleting it under the running job. The adoption holds it before the sweep
// can run; a record naming a process this runner does not parent holds nothing.
func TestTheWorktreeSweepSparesTheCheckoutOfAJobAdoptedFromItsRecord(t *testing.T) {
	f := newGCFixture(t)
	held := f.checkout(t, "sess-adopted")
	stranger := f.checkout(t, "sess-stranger")
	child := startRecordedChild(t, "sess-adopted", "bgj_00000000d4d4", 1, held)
	// The test process's own parent: alive, and nobody's to signal from here.
	writeJobRecord(t, "sess-stranger", "bgj_00000000e5e5", 1, os.Getppid())

	pool := newSessionPool(1)
	pool.adoptRecordedJobs()
	gcWorktrees(f.transport, pool.ids(), diskUnderTheFloor())

	requireCheckoutOnDisk(t, held, "a job adopted from its record is still running in it")
	requireRunning(t, child.pid, "the adopted job")
	requireCheckoutReclaimed(t, stranger, "a record naming a process this runner does not parent holds nothing")
}

// Asked of the source, as TestGcWorktreesIsTheOnlyDeleterAndTheRunLoopKeepsCallingIt asks: nothing
// fails when the adoption moves behind the reclaim or the first sweep, a checkout is simply deleted
// under a running job once in a while.
func TestTheRunLoopAdoptsRecordedJobsBeforeAnythingElse(t *testing.T) {
	src, err := os.ReadFile("runloop.go")
	if err != nil {
		t.Fatalf("read runloop.go: %v", err)
	}
	body := string(src)
	body = body[strings.Index(body, "func runLoop("):]
	adopt := strings.Index(body, "pool.adoptRecordedJobs()")
	if adopt < 0 {
		t.Fatal("runLoop does not adopt the jobs an image before it handed on")
	}
	for _, later := range []string{"\tgo ", "reclaimMissingSessions(", "gcWorktrees(", "startSession("} {
		if at := strings.Index(body, later); at >= 0 && at < adopt {
			t.Errorf("runLoop reaches %q before it adopts recorded jobs", strings.TrimSpace(later))
		}
	}
}
