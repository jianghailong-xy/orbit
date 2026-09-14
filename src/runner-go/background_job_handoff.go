package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// A runner that re-executes into a self-update does not end the jobs it hosts. The exec keeps the
// pid, so a job nobody reaped is still this process's child when the new image starts; the old image
// hands each job on (handOffJobs) and the new one adopts it from the record written when it was
// spawned (adoptRecordedJobs). Between the two, and for as long as no supervisor hosts it, the job is
// kept by the session pool. Only a re-exec hands a job on: a signal, a drain that runs out of time and
// a re-exec that fails all end the jobs, as a runner stop always has.

// errRunnerSelfUpdate is the cause runLoop stops with when it stops to re-execute into a newer release.
var errRunnerSelfUpdate = errors.New("the runner is re-executing into a self-update")

// bgHandedOnReportTimeout bounds one report of a handed-on job ended after its supervisor returned
// (endHandedOffJob). The runner is on its way out by then, and a service manager's stop timeout is
// running.
const bgHandedOnReportTimeout = 10 * time.Second

// recordJobs lets this tailer's jobs outlive the runner image: each job it starts is recorded under
// sessionID, a self-update hands them to pool instead of ending them, and report is how the end of one
// reaches the control plane after the supervisor has returned. Called once, before any job can start.
func (b *bgTailer) recordJobs(sessionID string, pool *sessionPool, report func(payload map[string]interface{}) error) {
	b.sessionID = sessionID
	b.pool = pool
	b.reportStopped = report
}

// recordJob writes the record a job needs to be handed on. A job without one is not handed on: the
// runner's stop ends it as it always did, since the next image could not tell it from a stranger.
func (b *bgTailer) recordJob(job *bgJob) bool {
	if b.pool == nil {
		return false
	}
	if err := writeBgJobRecord(job.recordLocked(b.sessionID)); err != nil {
		logln("could not record background job", job.id+"; it will not outlive a self-update:", err)
		return false
	}
	return true
}

// recordLocked is the job's record as it stands. Caller holds b.mu, or is the only one to know the job.
func (j *bgJob) recordLocked(sessionID string) bgJobRecord {
	return bgJobRecord{
		Version:      bgJobRecordVersion,
		SessionID:    sessionID,
		JobID:        j.id,
		PID:          j.pid,
		Kind:         j.kind,
		Command:      j.command,
		Description:  j.description,
		OutputPath:   j.outputPath,
		StartedAt:    j.startedAt,
		WakeOnExit:   j.wakeOnExit,
		WakeOnOutput: j.wakeOnOutput,
		WokenThrough: j.wokenThrough,
		OutputWakes:  j.outputWakes,
	}
}

// runnerSelfUpdatingLocked reports whether the runner is stopping to re-execute into a self-update,
// with a pool to hand this tailer's jobs to. Caller holds b.mu.
func (b *bgTailer) runnerSelfUpdatingLocked() bool {
	return b.pool != nil && b.runnerStoppingLocked() && errors.Is(context.Cause(b.shutdown), errRunnerSelfUpdate)
}

// handOffJobs is the drain of a runner stopping to re-execute into a self-update. A service is killed
// and reported as the runner's stop, like any runner stop kills one: it is cheap to restart. A job or
// a watch is neither killed nor reported. It stops being this tailer's — its tail ends, its hold on the
// checkout goes, its record is brought up to date — and the pool keeps it, unreaped, for the image the
// runner re-executes into. If that image never comes, the pool ends it after all (endHostlessJobs).
//
// Reports whether it drained: not when the runner is stopping for anything else, or the session is
// ending anyway, which the ordinary drain is for.
func (b *bgTailer) handOffJobs() bool {
	b.mu.Lock()
	if !b.runnerSelfUpdatingLocked() || b.ctx.Err() != nil {
		b.mu.Unlock()
		return false
	}
	var killing, handing []*bgJob
	for id, job := range b.jobs {
		// One being reaped, or being killed, is ending here already.
		if job.status != bgStatusRunning || job.reaping || job.killReason != "" {
			continue
		}
		if job.kind == bgKindService || !job.recorded {
			job.killReason = bgRunnerShutdownReason
			killing = append(killing, job)
			continue
		}
		job.handedOff = true
		job.formerHost = b
		delete(b.jobs, id)
		handing = append(handing, job)
	}
	b.mu.Unlock()

	for _, job := range killing {
		job.cancel()
	}
	for _, job := range handing {
		b.stop(job.id)
		b.mu.Lock()
		rec := job.recordLocked(b.sessionID)
		b.mu.Unlock()
		if err := writeBgJobRecord(rec); err != nil {
			// The record written at spawn still names the job; only its output wakes may repeat.
			logln("could not bring the record of background job", job.id, "up to date:", err)
		}
		b.pool.keepHostlessJob(b.sessionID, job)
		// Its waiter waits on outside this tailer, and will not reap the job here (claimReap).
		job.releaseWaiter(&b.wg)
		logln(fmt.Sprintf("background %s %s of session %s handed on to the runner's next image", job.kind, job.id, b.sessionID))
	}
	for _, job := range killing {
		select {
		case <-job.done:
		case <-time.After(bgKillTeardownGrace):
		}
	}
	return true
}

// claimReap is a waiter's step between its job's exit and reaping it. A job still hosted here is
// marked as ending here, so nothing hands it on any more. One already handed on is left unreaped for
// its next host, and noted as exited, so that ending it here after all reports it as it ended.
func (b *bgTailer) claimReap(job *bgJob) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if job.handedOff {
		job.exited = true
		return false
	}
	job.reaping = true
	return true
}

// killable reports whether killing the job is still this tailer's to do: not once it has been handed
// on, and not once its exited process is being reaped.
func (b *bgTailer) killable(job *bgJob) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return !job.handedOff && !job.reaping
}

// releaseWaiter gives back the waiter's slot in its tailer's WaitGroup, once: when the waiter returns,
// or when the job is handed on while the waiter still waits.
func (j *bgJob) releaseWaiter(wg *sync.WaitGroup) { j.waiterSlot.Do(wg.Done) }

// adoptJobs makes this tailer the host of jobs the runner adopted from their records after
// re-executing (adoptRecordedJobs), as it is of the jobs it starts: bg_list, bg_output and bg_kill find
// them, the session's end drains them, and their end is reported and wakes the session if they asked.
// One still running is announced again — the control plane last heard of it from the image before, and
// would take it for a job whose runner went away with no end report — and waited on. One that exited
// while no supervisor hosted it is reported as it ended.
func (b *bgTailer) adoptJobs(jobs []*bgJob) {
	for _, job := range jobs {
		jobCtx, cancel := context.WithCancel(b.ctx)
		job.cancel = cancel
		b.mu.Lock()
		b.jobs[job.id] = job
		b.mu.Unlock()
		if job.adoptedExit != nil {
			b.finishJob(job, *job.adoptedExit)
			continue
		}
		// Ended by the context it is hosted under, as a job this tailer starts is.
		context.AfterFunc(jobCtx, func() {
			if b.killable(job) {
				job.kill()
			}
		})
		b.emit(evBackgroundTask, job.runningPayload())
		b.startTail(job.id, job.id, job.outputPath, false)
		if job.wakeOnOutput {
			b.startOutputWakes(job)
		}
		b.mu.Lock()
		b.wg.Add(1)
		b.mu.Unlock()
		go func() {
			defer job.releaseWaiter(&b.wg)
			awaitChildExit(job.pid)
			if b.claimReap(job) {
				b.finishJob(job, job.reap())
			}
		}()
	}
}

// endHandedOffJob ends a job this tailer handed on to a next image that never came: the re-exec failed,
// or the runner stopped for something else after all. It is what any runner stop does to a job it
// hosts, done later — killed, and reported as the runner's stop — unless the job had exited already,
// and is reported as it ended. The report goes through the session's event stream although its
// supervisor has returned (recordJobs).
func (b *bgTailer) endHandedOffJob(job *bgJob, reason string) {
	b.mu.Lock()
	exited := job.exited
	if !exited {
		job.killReason = reason
	}
	b.mu.Unlock()
	if !exited {
		job.kill()
	}
	exit := job.reap()

	b.mu.Lock()
	status := job.endLocked(exit)
	reason = job.killReason
	b.mu.Unlock()
	if b.markTerminal(job.id) {
		if err := b.reportStopped(job.endPayload(status, exit, reason)); err != nil {
			logln("could not report the end of background job", job.id+":", err)
		}
		b.alertIfNobodyIsWatching(job, status, exit)
		if wake, ok := b.wakeFor(job, reason); ok {
			b.deliverWake(wake)
		}
	}
	removeBgJobRecord(b.sessionID, job.id)
	close(job.done)
}

// keepHostlessJob keeps a runner-hosted job that no supervisor hosts: handed on by one whose runner is
// re-executing into a self-update, or adopted from its record before any supervisor started.
func (p *sessionPool) keepHostlessJob(sessionID string, job *bgJob) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.hostless == nil {
		p.hostless = map[string][]*bgJob{}
	}
	p.hostless[sessionID] = append(p.hostless[sessionID], job)
}

// takeHostlessJobs gives the session's supervisor the jobs this image adopted for it. A job handed on
// within this image stays: its next host is the image the runner re-executes into.
func (p *sessionPool) takeHostlessJobs(sessionID string) []*bgJob {
	p.mu.Lock()
	defer p.mu.Unlock()
	var taken, kept []*bgJob
	for _, job := range p.hostless[sessionID] {
		if job.formerHost == nil {
			taken = append(taken, job)
		} else {
			kept = append(kept, job)
		}
	}
	if len(kept) == 0 {
		delete(p.hostless, sessionID)
	} else {
		p.hostless[sessionID] = kept
	}
	return taken
}

// hasAdoptedJobs reports whether jobs adopted for this session wait for its supervisor, which then
// starts hosting them at once rather than at the session's next claim.
func (p *sessionPool) hasAdoptedJobs(sessionID string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, job := range p.hostless[sessionID] {
		if job.formerHost == nil {
			return true
		}
	}
	return false
}

// endHostlessJobs ends every job the pool keeps, because the image it was kept for is not coming: the
// runner stopped for something other than a re-exec, or the re-exec failed. reason is what a job
// killed now is reported as.
func (p *sessionPool) endHostlessJobs(reason string) {
	p.mu.Lock()
	hostless := p.hostless
	p.hostless = nil
	p.mu.Unlock()
	p.endJobs(hostless, reason)
}

// endUnclaimedHostlessJobs ends the adopted jobs of sessions this runner does not supervise, once a
// reclaim has said which it does: a session that ended while the runner re-executed ends its jobs, as
// the end of a session always does.
func (p *sessionPool) endUnclaimedHostlessJobs() {
	p.mu.Lock()
	unclaimed := map[string][]*bgJob{}
	for sessionID, jobs := range p.hostless {
		if p.sessions[sessionID] == nil {
			unclaimed[sessionID] = jobs
			delete(p.hostless, sessionID)
		}
	}
	p.mu.Unlock()
	p.endJobs(unclaimed, bgSessionCancelledReason)
}

func (p *sessionPool) endJobs(jobs map[string][]*bgJob, reason string) {
	var wg sync.WaitGroup
	for sessionID, sessionJobs := range jobs {
		for _, job := range sessionJobs {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if job.formerHost != nil {
					job.formerHost.endHandedOffJob(job, reason)
					return
				}
				p.endAdoptedJob(sessionID, job, reason)
			}()
		}
	}
	wg.Wait()
}

// endAdoptedJob ends a job adopted from its record that no supervisor ever hosted. Nothing can carry its
// end to the control plane — only a supervisor has the session's event stream — so it is logged, and the
// control plane goes on reading the job as one whose runner went away with no end report.
func (p *sessionPool) endAdoptedJob(sessionID string, job *bgJob, reason string) {
	exit := 0
	if job.adoptedExit != nil {
		exit = *job.adoptedExit
	} else {
		job.kill()
		exit = job.reap()
		p.releaseWorktreeBackgroundJob(sessionID, job.id)
	}
	removeBgJobRecord(sessionID, job.id)
	logln(fmt.Sprintf("background %s %s of session %s ended with no supervisor to report it (%s, exit %d)",
		job.kind, job.id, sessionID, reason, exit))
}
