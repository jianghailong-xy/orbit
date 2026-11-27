package main

// The owner's stop of one bg_run job from the app (POST /sessions/:id/background/jobs/:jobId/stop).
// The control plane records it on the session and lists it on every heartbeat answer to this runner
// (HeartbeatResponse.StopBackgroundJobs) for as long as the job is still running there, so a lost
// answer costs one beat and nothing else. Each listing is carried out the way bg_kill carries out the
// agent's ask (bgTailer.killJobFor), under its own reason, bgStoppedByOwnerReason: the job ends
// killed, its terminal background_task and its wake say a person stopped it. Repeats are no-ops — a
// job that has ended, or is already being killed, keeps how it ended.

// bgOwnerStopCapabilityV1 declares that this runner carries out stopBackgroundJobs: @orbit/shared's
// BG_OWNER_STOP_V1. The control plane refuses the stop for a runner that does not declare it, and
// lists that runner's jobs as not stoppable.
const bgOwnerStopCapabilityV1 = "bg-owner-stop/v1"

// BgJobStopCommand is one job the owner asked to stop: its session, and the id bg_run returned.
type BgJobStopCommand struct {
	SessionID string `json:"sessionId"`
	JobID     string `json:"jobId"`
}

// stopBackgroundJobsForOwner carries out a heartbeat's stopBackgroundJobs. Each kill runs on its own
// goroutine, because killJobFor waits up to bgKillTeardownGrace for the process to go and the
// heartbeat loop must not wait with it. A session this process hosts no job service for is skipped:
// the next answer lists the stop again, for as long as the job is running.
func stopBackgroundJobsForOwner(stops []BgJobStopCommand) {
	for _, stop := range stops {
		svc, ok := bgSessionServices.Load(decodeSessionID(stop.SessionID))
		if !ok {
			continue
		}
		bg, jobID := svc.(*bgJobService).bg, stop.JobID
		go func() {
			if _, err := bg.killJobFor(jobID, bgKillTeardownGrace, bgStoppedByOwnerReason); err != nil {
				logln("owner stop of background job", jobID+":", err)
			}
		}()
	}
}
