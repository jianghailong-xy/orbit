package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
)

// A coordinator that hands over (docs/coordinator-handoff-v2-design.md §1) is ended like any Complete, but its
// running SubAgent runs and bg_run jobs keep running where they are — in this runner process and the old checkout —
// until they end by themselves. Their end owes a wake, which the server forwards to the successor
// (apiserver runner-api/handoff-wake-forward.ts). Every other end of a session stops them, as it always has.
//
// The runner learns why the session ends from the control plane, in either of the two ways an end reaches it: the
// session's `end` turn says {"keepBackgroundWork":true} (transport.inbox), or the heartbeat that cancels the session
// names it in keepWorkSessionIds (runloop). Whichever comes first marks the session here, and stopAll reads the mark
// when the session's background work would otherwise be stopped.
//
// What is left running is ended by a runner that stops after all: a SubAgent is interrupted (INTERRUPTED, which
// wakes the successor with the reason), a job is killed as the runner's stop. A service is not left running: it
// never ends by itself.

// sessionsKeepingWork is the set of session ids whose end leaves their background work running.
var sessionsKeepingWork sync.Map

func markSessionKeepsWork(sessionID string) {
	if sessionID != "" {
		sessionsKeepingWork.Store(sessionID, true)
	}
}

func sessionKeepsWork(sessionID string) bool {
	_, ok := sessionsKeepingWork.Load(sessionID)
	return ok
}

// clearSessionKeepsWork forgets the mark, as a new run of the session starts: a session completed by a handoff
// and reopened later ends the way its new end says.
func clearSessionKeepsWork(sessionID string) { sessionsKeepingWork.Delete(sessionID) }

// keepBackgroundWorkRequested reads an `end` turn's content (apiserver sessions/running-work.ts,
// KEEP_BACKGROUND_WORK_END_CONTENT). Absent, empty or unparseable all read as no: an end that says nothing stops
// the session's background work, as every end did before.
func keepBackgroundWorkRequested(content string) bool {
	if strings.TrimSpace(content) == "" {
		return false
	}
	var payload struct {
		KeepBackgroundWork bool `json:"keepBackgroundWork"`
	}
	if err := json.Unmarshal([]byte(content), &payload); err != nil {
		return false
	}
	return payload.KeepBackgroundWork
}

// keepJobsPastEnd leaves the tailer's running jobs and watches to end by themselves. Each stops being this
// tailer's — its tail ends, and the drain and the context's cancel no longer reach it — but keeps its hold on the
// checkout, and its waiter ends it when it exits (endKeptJob). A service is left to the drain, which kills it.
func (b *bgTailer) keepJobsPastEnd() {
	b.mu.Lock()
	var kept []*bgJob
	for id, job := range b.jobs {
		if job.status != bgStatusRunning || job.reaping || job.killReason != "" || job.kind == bgKindService {
			continue
		}
		job.handedOff, job.keptPastEnd = true, true
		delete(b.jobs, id)
		// The tail goes; the hold stays until the job ends.
		if s, ok := b.live[id]; ok {
			s.cancel()
			delete(b.live, id)
		}
		kept = append(kept, job)
	}
	shutdown := b.shutdown
	b.mu.Unlock()
	for _, job := range kept {
		// Its waiter goes on waiting, outside this tailer's WaitGroup.
		job.releaseWaiter(&b.wg)
		if shutdown != nil {
			context.AfterFunc(shutdown, func() { b.killKeptJob(job) })
		}
		logln(fmt.Sprintf("background %s %s of session %s left running: its coordinator handed over", job.kind, job.id, b.sessionID))
	}
}

// killKeptJob ends a kept job because the runner is stopping, as a runner's stop ends any job it hosts.
func (b *bgTailer) killKeptJob(job *bgJob) {
	b.mu.Lock()
	if job.exited {
		b.mu.Unlock()
		return
	}
	job.killReason = bgRunnerShutdownReason
	b.mu.Unlock()
	job.kill()
}

// endKeptJob ends a job keepJobsPastEnd left running, once it has exited: reaped, its hold on the checkout
// released, and the wake its end owes sent (the server forwards it to the successor). Its end is not sent as an
// event: the session is no longer open, and the control plane refuses one. A job that was not kept is not ended
// here (a job handed on to the runner's next image is that image's).
func (b *bgTailer) endKeptJob(job *bgJob) {
	b.mu.Lock()
	kept := job.keptPastEnd
	b.mu.Unlock()
	if !kept {
		return
	}
	exit := job.reap()
	b.releaseHold(job.id)
	b.mu.Lock()
	status := job.endLocked(exit)
	reason := job.killReason
	b.mu.Unlock()
	logln(fmt.Sprintf("background %s %s of handed-over session %s ended (%s, exit %d)", job.kind, job.id, b.sessionID, status, exit))
	if b.markTerminal(job.id) {
		if wake, ok := b.wakeFor(job, reason); ok {
			b.deliverWake(wake, false)
		}
	}
	if job.recorded {
		removeBgJobRecord(b.sessionID, job.id)
	}
	close(job.done)
}

// keepSubagentsPastEnd leaves the session's running SubAgents to end by themselves. Each holds the checkout it
// works in until it ends, and its end owes the parent a wake (runSubagent). A remote run is not asked to stop. A
// runner that stops meanwhile interrupts them, as it does any SubAgent it hosts.
func (s *bgJobService) keepSubagentsPastEnd(shutdown context.Context) {
	if s.keptPastEnd.Swap(true) {
		return // a later stopAll of the same end
	}
	s.subagents.mu.Lock()
	var running []*subagentRun
	for _, r := range s.subagents.runs {
		if r.status == subagentStatusRunning {
			running = append(running, r)
		}
	}
	s.subagents.mu.Unlock()
	if len(running) == 0 {
		return
	}
	logln(fmt.Sprintf("%d SubAgent(s) of session %s left running: its coordinator handed over", len(running), s.sessionID))
	for _, r := range running {
		if r.workspace != "" {
			continue // another runner's checkout
		}
		holdID := "subagent:" + r.id
		if s.bg.holds != nil {
			s.bg.holds.holdRunnerJob(holdID, "SubAgent "+r.id)
		}
		go func() {
			<-r.done
			s.bg.releaseHold(holdID)
		}()
	}
	if shutdown != nil {
		stop := context.AfterFunc(shutdown, func() { s.stopSubagents(subagentStopRunnerStopped) })
		go func() {
			for _, r := range running {
				<-r.done
			}
			stop()
		}()
	}
}
