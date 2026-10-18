package main

import (
	"fmt"
	"time"
)

// What a stopping runner waits for once its claim loop is over, how long, and in what order (runLoop).
//
// Two kinds of work outlive the claim loop. The session supervisors drain their turns, as they always
// have. And the heartbeat has started work of its own that holds no session: a landing's merge check
// above all, which can run for an hour, then repository operations, merges, commits, uploads, an engine
// install. Until 2026-10-17 the heartbeat stopped as soon as the sessions had drained, and the runner
// then waited for that work with no limit. In the managed-runner lab (task T03) a landing's check was
// running when the Pod was stopped: the runner went silent at once and the kubelet killed it 240 s
// later. The job then stayed RUNNING under the dead process's claim until its lease expired, and the
// next Pod ran it again 10 min 26 s after its last report. A session torn down at the drain deadline
// would have fared worse: the control plane's reaper fails a RUNNING session whose runner is silent for
// 90 s, where the next process would otherwise have reclaimed it.
//
// So the heartbeat now beats until both kinds of work are over, the second kind gets a budget, and what
// is left of it when the budget runs out is stopped and handed back — a landing stops its checks,
// removes its scratch worktree and gives its claim back to be run again at once (integrate.go,
// handBackIntegrationJob).
//
// THE BUDGETS. Everything stays inside the supervisor envelope the sessions already had,
// shutdownSupervisorTimeout (170 s), which is below both deadlines a stop is held to:
//   - systemd's TimeoutStopSec of a self-managed runner, 180 s (service.go, host_setup.go);
//   - a managed runner Pod's termination grace, 240 s (MANAGED_POD_TERMINATION_GRACE_SECONDS in
//     src/apiserver/src/managed-runners/managed-runner-resources.ts).
//
// Heartbeat work gets what an in-flight turn gets, shutdownDrainTimeout (100 s), to finish on its own.
// That leaves 70 s of the envelope for what is stopped then: ending a check's process tree (5 s at
// most), removing its worktree, and the hand-back request (15 s per attempt, tried again while time
// remains). The last beat is waited for at most shutdownLastBeatWait (5 s), so the runner is gone 175 s
// after the stop at the very latest: 5 s inside systemd's limit, 65 s inside the Pod's. An idle runner
// is gone as soon as it has drained, as before.
const (
	shutdownOperationsTimeout = shutdownDrainTimeout
	shutdownLastBeatWait      = 5 * time.Second
	shutdownPollInterval      = 200 * time.Millisecond
)

// shutdownSequence is the stop, in order, with each piece the run loop owns passed in.
type shutdownSequence struct {
	// sessions is how many session supervisors are still attached.
	sessions func() int
	// operations is how much heartbeat-delivered work is still running: the heartbeat's operations
	// and an engine install.
	operations func() int
	// stopResets ends the Codex rate-limit reset steps once the sessions have drained, where the stop
	// always ended them: the control plane hands a draining process no claim, so a step waiting for
	// one would only hold the stop.
	stopResets func()
	// interrupt stops the operations still running when their budget runs out. Called once at most.
	interrupt func()
	// stopHeartbeat sends the last beat and stops the heartbeat. Called once, after both waits: until
	// then the control plane keeps hearing from this process, and a session it is still RUNNING here
	// is not failed for silence.
	stopHeartbeat func()
	poll          time.Duration
}

// shutdownLeft is what was still running when the stop gave up waiting.
type shutdownLeft struct {
	sessions, operations int
}

// run waits for the sessions, then the operations, each until deadline at the latest, interrupting the
// operations at operationsDeadline even while the sessions are still draining.
func (s shutdownSequence) run(operationsDeadline, deadline time.Time) shutdownLeft {
	var left shutdownLeft
	interrupted := false
	interruptWhenDue := func(now time.Time) {
		if interrupted || now.Before(operationsDeadline) {
			return
		}
		if n := s.operations(); n > 0 {
			interrupted = true
			logln(fmt.Sprintf("%d heartbeat operation(s) still running %s into the stop; stopping them, and a landing hands its claim back",
				n, shutdownOperationsTimeout))
			s.interrupt()
		}
	}
	for {
		n := s.sessions()
		if n == 0 {
			break
		}
		now := time.Now()
		if now.After(deadline) {
			logln(fmt.Sprintf("drain deadline reached; %d session supervisor(s) still attached, exiting", n))
			left.sessions = n
			break
		}
		interruptWhenDue(now)
		time.Sleep(s.poll)
	}
	s.stopResets()
	for {
		n := s.operations()
		if n == 0 {
			break
		}
		now := time.Now()
		if now.After(deadline) {
			logln(fmt.Sprintf("drain deadline reached; %d heartbeat operation(s) still running, exiting without them", n))
			left.operations = n
			break
		}
		interruptWhenDue(now)
		time.Sleep(s.poll)
	}
	s.stopHeartbeat()
	return left
}

// beatUntilStopped is the heartbeat goroutine's loop: a beat on every tick and on every request until
// stop closes, then one last beat. The control plane's reaper fails a session still RUNNING here once
// this runner has been silent for 90 s; beating once more as the stop ends starts that clock at this
// process's exit rather than at its last tick, up to 30 s earlier — time the next process has to come
// back and reclaim the session.
func beatUntilStopped(stop <-chan struct{}, ticks <-chan time.Time, now <-chan struct{}, beat func()) {
	runHeartbeatTicks(stop, ticks, now, beat)
	beat()
}

// handBackUnstartedIntegrationJobs hands back the landings a heartbeat answer claimed for this process
// after its stop began (§2.2 J-T11): the answer was asked for before the stop, so the control plane
// handed them over, and nothing here will start them. Held RUNNING, each would wait out its lease
// before anything ran it. A landing this process is already running is left to its own end, and one
// claimed for another process is not this one's to give back. Each hand-back is counted with the
// heartbeat's operations, so the stop waits for it as for any of them.
func handBackUnstartedIntegrationJobs(jobs []IntegrationJobCommand, leaseOwner string, running func(jobID string) bool,
	ops *countedOps, handBack func(IntegrationJobCommand)) {
	for _, job := range jobs {
		if job.LeaseOwner != "" && leaseOwner != "" && job.LeaseOwner != leaseOwner {
			continue
		}
		if running(job.JobID) {
			continue
		}
		ops.Add(1)
		go func(job IntegrationJobCommand) {
			defer ops.Done()
			handBack(job)
		}(job)
	}
}
