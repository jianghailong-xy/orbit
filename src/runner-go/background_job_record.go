package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// A runner-hosted job outlives the runner image that started it in exactly one case: a self-update.
// The runner re-executes in place — syscall.Exec keeps the pid, so a job nobody reaped is still this
// process's child — and the new image adopts it. All the new image knows about the job is what the
// old one wrote down when it spawned it: this record. Ownership comes from here and from nowhere
// else. Nothing is inferred from /proc, and a pid this process does not parent is never signalled on
// a record's say-so (background_job_adopt_unix.go).

// bgJobRecordVersion is the record format this image writes and the only one it adopts. A record of
// any other version is a promise about a process this image cannot read, and is taken as a job with
// no end report.
const bgJobRecordVersion = 1

type bgJobRecord struct {
	Version   int    `json:"version"`
	SessionID string `json:"sessionId"`
	JobID     string `json:"jobId"`
	// PID is the job's process, and its process group too: every job leads a group of its own.
	PID          int       `json:"pid"`
	Kind         string    `json:"kind"`
	Command      string    `json:"command"`
	Description  string    `json:"description,omitempty"`
	OutputPath   string    `json:"outputPath"`
	StartedAt    time.Time `json:"startedAt"`
	WakeOnExit   bool      `json:"wakeOnExit,omitempty"`
	WakeOnOutput bool      `json:"wakeOnOutput,omitempty"`
	// Where the session's output wakes had got to when the job was handed on, so the next image
	// neither repeats a wake nor skips output.
	WokenThrough int64 `json:"wokenThrough,omitempty"`
	OutputWakes  int   `json:"outputWakes,omitempty"`
}

func bgJobRecordPath(sessionID, jobID string) string {
	return filepath.Join(runDir(sessionID), "bg-jobs", jobID+".json")
}

// writeBgJobRecord replaces the record atomically, so a runner stopped mid-write leaves the old
// record or the new one, never half of either. The command may carry secrets, hence 0600.
func writeBgJobRecord(rec bgJobRecord) error {
	path := bgJobRecordPath(rec.SessionID, rec.JobID)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func removeBgJobRecord(sessionID, jobID string) {
	if err := os.Remove(bgJobRecordPath(sessionID, jobID)); err != nil && !os.IsNotExist(err) {
		logln("could not remove the record of background job", jobID+":", err)
	}
}

// recordedJob is one record found on disk. problem says why it cannot be adopted — unreadable, a
// version this image does not know, or fields that do not describe the job it is filed as — and is
// empty for one that can be.
type recordedJob struct {
	path    string
	record  bgJobRecord
	problem string
}

// readBgJobRecords reads every job record under runsDir. It never fails as a whole: a record that
// cannot be read is returned with its problem, for the caller to report and discard.
func readBgJobRecords() []recordedJob {
	paths, _ := filepath.Glob(filepath.Join(runsDir(), "*", "bg-jobs", "*.json"))
	var found []recordedJob
	for _, path := range paths {
		found = append(found, readBgJobRecord(path))
	}
	return found
}

func readBgJobRecord(path string) recordedJob {
	found := recordedJob{path: path}
	data, err := os.ReadFile(path)
	if err != nil {
		found.problem = "unreadable: " + err.Error()
		return found
	}
	// The version first, on its own: nothing else in a record of another version means what it
	// means here.
	var header struct {
		Version int `json:"version"`
	}
	if err := json.Unmarshal(data, &header); err != nil {
		found.problem = "not a job record: " + err.Error()
		return found
	}
	if header.Version != bgJobRecordVersion {
		found.problem = fmt.Sprintf("record version %d, and this runner reads version %d", header.Version, bgJobRecordVersion)
		return found
	}
	if err := json.Unmarshal(data, &found.record); err != nil {
		found.problem = "not a job record: " + err.Error()
		return found
	}
	rec := found.record
	sessionDir := filepath.Base(filepath.Dir(filepath.Dir(path)))
	if rec.PID <= 1 || rec.JobID+".json" != filepath.Base(path) || decodeSessionID(rec.SessionID) != sessionDir {
		found.problem = "the record does not describe the job it is filed as"
	}
	return found
}
