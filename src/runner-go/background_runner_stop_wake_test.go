//go:build linux || darwin

package main

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// A job that asked to be woken on its exit, and exits on its own as the runner begins to stop, still
// wakes its session. On 2026-11-16 at 09:51Z a GPU's thermal power-off stopped workstation-gpu's
// runner 40 ms after such a job exited: its end was reported, but its wake was not. The drain the
// runner's stop runs waited only for jobs still marked running, and this one had been marked ended
// a moment before its wake was sent. So the drain returned, the gate closed, and sendWake dropped the
// wake without a word. The session heard of the job only from the next message its owner sent
// ("Ended while you were away").

// wakeRecorder is the control plane's wake door: it keeps every wake the runner sends and serves
// everything else as api does.
type wakeRecorder struct {
	mu    sync.Mutex
	wakes []bgWake
}

func (w *wakeRecorder) handler(api *runnerStopControlPlane) http.HandlerFunc {
	return func(rw http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/background-wake") {
			api.serve(rw, r)
			return
		}
		var wake bgWake
		_ = json.NewDecoder(r.Body).Decode(&wake)
		w.mu.Lock()
		w.wakes = append(w.wakes, wake)
		w.mu.Unlock()
		_, _ = rw.Write([]byte(`{"outcome":"ENQUEUED","turnId":"t"}`))
	}
}

func (w *wakeRecorder) count(jobID string) int {
	w.mu.Lock()
	defer w.mu.Unlock()
	n := 0
	for _, wake := range w.wakes {
		if wake.JobID == jobID {
			n++
		}
	}
	return n
}

// runWakeOnExit is bg_run of a job that asks to be woken on its exit, over the session's own socket.
func runWakeOnExit(t *testing.T, s *runnerStopSupervisor, command string) bgJobStatus {
	t.Helper()
	var token string
	awaitCondition(t, 15*time.Second, "the session never served its background job socket", func() bool {
		data, err := os.ReadFile(bgTokenPath(s.job.SessionID))
		token = strings.TrimSpace(string(data))
		return err == nil && token != ""
	})
	raw, err := bgSocketCall(bgSocketPath(s.job.SessionID), token, "run", map[string]interface{}{
		"command": command, "kind": bgKindJob, "description": "runner stop wake", "wakeOnExit": true,
	})
	if err != nil {
		t.Fatalf("bg_run: %v", err)
	}
	var status bgJobStatus
	if err := json.Unmarshal(raw, &status); err != nil {
		t.Fatalf("bg_run result was not a job status: %v (%s)", err, raw)
	}
	return status
}

// wakeAcrossRunnerStop runs one wakeOnExit job in a session with no engine, as the session of
// 2026-11-16 was (its engine recycled under the job). The job exits once exit is called. stop is
// what the case does to make it exit and the runner stop. Once the supervisor has returned, the
// control plane must hold the job's end and exactly one wake for it.
func wakeAcrossRunnerStop(t *testing.T, id string, stop func(sup *runnerStopSupervisor, exit func())) {
	t.Helper()
	job := runnerStopJob(t, id)
	api := newRunnerStopControlPlane()
	rec := &wakeRecorder{}
	sup := superviseUntilRunnerStopOn(t, job, false, api, rec.handler(api))

	trigger := t.TempDir() + "/exit"
	bg := runWakeOnExit(t, sup, "while [ ! -e "+trigger+" ]; do sleep 0.01; done; exit 1")
	awaitCondition(t, 15*time.Second, "the job's launch was never delivered", func() bool {
		return api.delivered(isJobLaunch(bg.JobID))
	})

	stop(sup, func() { _ = os.WriteFile(trigger, nil, 0o644) })
	sup.awaitReturn(t, 2*time.Minute)

	// The job ended on its own, so its end is reported as it ended — not as killed by the stop.
	terminal := api.terminalReports(bg.JobID)
	if len(terminal) != 1 || asString(terminal[0]["status"]) != bgStatusFailed {
		t.Errorf("terminal reports for %s = %v, want one, failed with its own exit code", bg.JobID, terminal)
	}
	if got := rec.count(bg.JobID); got != 1 {
		t.Errorf("wakes sent for %s = %d, want 1: it asked to be woken on its exit and its end was reported",
			bg.JobID, got)
	}
}

// The production moment, held open: the job's end has been reported and its wake not yet sent when
// the runner begins to stop, and the stop's drain gets every chance to finish before the wake is sent.
func TestRunnerStopStillWakesForAJobThatEndedAsItBegan(t *testing.T) {
	ended := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	restore := bgBetweenEndAndWake
	bgBetweenEndAndWake = func() {
		once.Do(func() {
			close(ended)
			<-release
		})
	}
	t.Cleanup(func() { bgBetweenEndAndWake = restore })

	wakeAcrossRunnerStop(t, "sess-stop-wake-held", func(sup *runnerStopSupervisor, exit func()) {
		exit()
		select {
		case <-ended:
		case <-time.After(15 * time.Second):
			t.Fatal("the job never reported its end")
		}
		sup.stop()
		// Long enough for a drain that does not wait for this job to return and close the gate.
		time.Sleep(300 * time.Millisecond)
		close(release)
	})
}

// The same moment at the timings it comes at unaided, on either side of the stop.
func TestRunnerStopWakesForAJobEndingAroundIt(t *testing.T) {
	for _, tc := range []struct {
		name string
		// lead is how long before the runner stops the job exits; negative, how long after.
		lead time.Duration
	}{
		{"200ms before", 200 * time.Millisecond},
		{"30ms before", 30 * time.Millisecond},
		{"together", 0},
		{"300ms after", -300 * time.Millisecond},
	} {
		t.Run(tc.name, func(t *testing.T) {
			id := "sess-stop-wake-" + strings.ReplaceAll(tc.name, " ", "")
			wakeAcrossRunnerStop(t, id, func(sup *runnerStopSupervisor, exit func()) {
				if tc.lead >= 0 {
					exit()
					time.Sleep(tc.lead)
					sup.stop()
					return
				}
				sup.stop()
				time.Sleep(-tc.lead)
				exit()
			})
		})
	}
}
