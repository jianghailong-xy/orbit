package main

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// `orbit wiki import` when the server reads (contracts/wiki.contract.json `import.server`,
// docs/wiki-server-execution-design.md §2.2 and §8, P5).
//
// THE FILES ARE STILL THIS MACHINE'S. When the executor switch gives the account to the server
// (ORBIT_WIKI_EXECUTOR), the command lists the files, reads their frontmatter and registers each as a
// note exactly as it does on its own; what changes is who reads them. It hands the notes — in the order
// it would have read them, each to be read or carrying the ops an earlier run found in it and did not
// propose — to one `import` job of the space, and the server's wiki-worker reads them with the
// deployment's System model, checks what it answers, and proposes it with origin import. The command
// waits for the job and prints its report: the numbers it prints are the report's.
//
// THE MEMORY IS STILL THIS MACHINE'S TOO. The job's report says, note by note, what was read and what
// became of each op, and the run writes that into the same state file a run on this machine writes —
// so a run picks up where the last one stopped whichever path ran it, and the switch can move either
// way between two runs. The job's id is written down before the run waits for it: a run that stops
// waiting (or is killed) leaves the job to the server, and the next run collects it first.
//
// Nothing here needs a model of this machine's: no ANTHROPIC_* variable, no Claude Code.

// How often a run asks after the server's import job while it waits; tests shorten it.
var wikiImportJobPoll = 2 * time.Second

// The notes one job is handed at most (contract `import.server.maxNotes`): the rest wait for the next run.
const wikiImportJobMaxNotes = 1000

// How many failed tries of the job a run waits through: past them the server keeps retrying on its own.
const wikiImportJobAttempts = 3

// wikiImportExecutorAnswer is `GET .../import` (contract `import.server.executor`).
type wikiImportExecutorAnswer struct {
	Executor   string `json:"executor"`
	Model      string `json:"model"`
	ModelState string `json:"modelState"`
}

// wikiImportJobNote is one note handed to the server's job.
type wikiImportJobNote struct {
	NoteID string              `json:"noteId"`
	File   string              `json:"file"`
	Date   string              `json:"date"`
	Ops    []wikiImportJobOpIn `json:"ops,omitempty"`
}

// wikiImportJobOpIn is an op an earlier run found and did not propose, at its index in the file's list.
type wikiImportJobOpIn struct {
	Index int                    `json:"index"`
	Body  map[string]interface{} `json:"body"`
}

// wikiImportJob is `GET .../import-jobs/:jobId` (contract `import.server.read`).
type wikiImportJob struct {
	State    string `json:"state"`
	Error    string `json:"error"`
	Attempts int    `json:"attempts"`
	// The job's own step while it runs: snapshot, reading or proposing.
	Progress struct {
		Step string `json:"step"`
		Read int    `json:"read"`
	} `json:"progress"`
	StartedAt string               `json:"startedAt"`
	Report    *wikiImportJobReport `json:"report"`
	Model     struct {
		Name  string `json:"name"`
		State string `json:"state"`
	} `json:"model"`
}

// wikiImportJobReport is the job's report (contract `import.server.report`).
type wikiImportJobReport struct {
	Model   string `json:"model"`
	Summary struct {
		Entries      int                 `json:"entries"`
		Principles   int                 `json:"principles"`
		Dropped      int                 `json:"dropped"`
		Failed       int                 `json:"failed"`
		Proposed     int                 `json:"proposed"`
		Applied      int                 `json:"applied"`
		Pending      int                 `json:"pending"`
		Verifying    int                 `json:"verifying"`
		Refused      int                 `json:"refused"`
		Deferred     int                 `json:"deferred"`
		Calls        int                 `json:"calls"`
		InputTokens  int                 `json:"inputTokens"`
		OutputTokens int                 `json:"outputTokens"`
		Refusals     []wikiImportRefusal `json:"refusals"`
		Stopped      string              `json:"stopped"`
	} `json:"summary"`
	Notes []struct {
		File       string `json:"file"`
		Status     string `json:"status"`
		Why        string `json:"why"`
		Principles int    `json:"principles"`
		Dropped    int    `json:"dropped"`
		Ops        []struct {
			Index   int                    `json:"index"`
			Body    map[string]interface{} `json:"body"`
			Outcome string                 `json:"outcome"`
			Why     string                 `json:"why"`
			OpID    string                 `json:"opId"`
			EntryID string                 `json:"entryId"`
		} `json:"ops"`
	} `json:"notes"`
}

// wikiImportOnServer asks which path this space's import takes: true only when the server says it reads
// the notes itself. Every other answer — runner, a server that has no such route, one that has no space or
// wiki for this call, a refusal, no answer at all — is the runner's own path, which then meets whatever the
// server has to say exactly as it always has. Nothing is lost by asking wrong: a server that reads for this
// account refuses a registration that does not say so (WIKI_SERVER_EXECUTES) before any model is asked.
func wikiImportOnServer(t *Transport, sessionID, spaceID string) (wikiImportExecutorAnswer, bool) {
	var out wikiImportExecutorAnswer
	path := "/runner/wiki/spaces/" + url.PathEscape(spaceID) + "/import"
	if _, err := t.doWiki(http.MethodGet, path, nil, &out, taskOpTimeout, sessionHeader(sessionID), true); err != nil {
		return out, false
	}
	return out, out.Executor == "server"
}

// runWikiImportOnServer is one run when the server reads: the files registered as a run on this
// machine registers them, the notes handed to the server's job, and its report written into this
// machine's memory.
func runWikiImportOnServer(t *Transport, sessionID string, opts wikiImportOptions, executor wikiImportExecutorAnswer, progress io.Writer) (wikiImportSummary, error) {
	started := time.Now()
	summary := wikiImportSummary{SpaceID: opts.spaceID, From: opts.from, Model: executor.Model, State: opts.statePath, Refusals: []wikiImportRefusal{}}
	sources, err := wikiImportSources(opts.from)
	if err != nil {
		return summary, err
	}
	state, err := loadWikiImportState(opts.statePath, opts.spaceID, opts.from)
	if err != nil {
		return summary, err
	}
	im := &wikiImporter{t: t, sessionID: sessionID, opts: opts, state: state, summary: &summary, progress: progress, texts: map[string]string{}, readBy: "server"}
	runErr := im.onServer(sources)
	state.Calls += summary.Calls
	state.InputTokens += summary.InputTokens
	state.OutputTokens += summary.OutputTokens
	if err := state.save(); err != nil && runErr == nil {
		runErr = fmt.Errorf("orbit wiki import: remembering where this run stopped (%s): %w", state.path, err)
	}
	summary.Files = len(sources)
	for _, source := range sources {
		file := state.Files[source.rel]
		if file == nil || (file.Status != wikiImportDone && file.Status != wikiImportSkipped && file.Status != wikiImportFailed) {
			summary.Remaining++
		}
	}
	summary.Seconds = time.Since(started).Seconds()
	return summary, runErr
}

// onServer collects the job a run before this one left on the server, when there is one — this run is
// then that job's run — and otherwise registers the files and hands the notes to a new job.
func (im *wikiImporter) onServer(sources []wikiImportSource) error {
	if im.state.Job != "" {
		done, err := im.awaitServerJob(im.state.Job, true)
		if err != nil || done {
			return err
		}
	}
	notes, err := im.serverNotes(sources)
	if err != nil {
		return err
	}
	if len(notes) == 0 {
		return nil
	}
	id, err := randomUUID()
	if err != nil {
		return err
	}
	// Written down before anything is asked of the server: a run killed while it waits leaves the job
	// to the server, and the next run collects it instead of reading the same notes again.
	im.state.Job = id
	if err := im.state.save(); err != nil {
		return err
	}
	root, _ := wikiImportGit(wikiImportRepoDir, "rev-parse", "--show-toplevel")
	body := map[string]interface{}{
		"id": id, "maxOps": im.opts.maxOps, "concurrency": im.opts.concurrency, "checkoutRoot": root, "notes": notes,
	}
	path := "/runner/wiki/spaces/" + url.PathEscape(im.opts.spaceID) + "/import-jobs"
	if _, err := im.t.doWiki(http.MethodPost, path, body, nil, taskOpTimeout, sessionHeader(im.sessionID), true); err != nil {
		var httpErr *transportHTTPError
		if errors.As(err, &httpErr) && httpErr.statusCode < http.StatusInternalServerError {
			// Refused: no job was made, and none is left to collect.
			im.state.Job = ""
		}
		return wikiCallError("orbit wiki import", err)
	}
	fmt.Fprintf(im.progress, "Handed %s to the server's import job %s.\n", wikiCount(len(notes), "note", "notes"), id)
	_, err = im.awaitServerJob(id, false)
	return err
}

// serverNotes registers the files that are not yet notes and lists, in order, the notes the job is to
// read and the ones that carry ops an earlier run did not propose.
func (im *wikiImporter) serverNotes(sources []wikiImportSource) ([]wikiImportJobNote, error) {
	var notes []wikiImportJobNote
	for _, source := range sources {
		if len(notes) >= wikiImportJobMaxNotes {
			break
		}
		file, err := im.reconcile(source)
		if err != nil {
			return nil, err
		}
		switch file.Status {
		case wikiImportDone, wikiImportSkipped, wikiImportFailed:
			continue
		case "":
			ok, err := im.register(source)
			if err != nil {
				return nil, err
			}
			if !ok {
				continue
			}
		}
		note := wikiImportJobNote{NoteID: file.NoteID, File: source.rel, Date: source.date}
		if file.Status == wikiImportExtracted {
			for index, op := range file.Ops {
				if op.Outcome == "" {
					note.Ops = append(note.Ops, wikiImportJobOpIn{Index: index, Body: op.Body})
				}
			}
			if len(note.Ops) == 0 {
				continue
			}
		}
		notes = append(notes, note)
	}
	return notes, im.state.save()
}

// awaitServerJob waits for the job and writes its report into this machine's memory. done is false only
// for an earlier run's job the server does not hold (it never reached it): this run then begins afresh.
//
// It stops waiting — the job goes on on the server, and the next run collects it — when the System model
// refuses the deployment's key or is not configured, when the model has not been up, or the job has not
// started, for wikiImportHealthWait, and when the job has failed wikiImportJobAttempts times over.
func (im *wikiImporter) awaitServerJob(id string, earlier bool) (bool, error) {
	path := "/runner/wiki/spaces/" + url.PathEscape(im.opts.spaceID) + "/import-jobs/" + url.PathEscape(id)
	began := time.Now()
	var notUpSince time.Time
	said := ""
	for {
		var job wikiImportJob
		_, err := im.t.doWiki(http.MethodGet, path, nil, &job, taskOpTimeout, sessionHeader(im.sessionID), true)
		var httpErr *transportHTTPError
		if earlier && errors.As(err, &httpErr) && httpErr.statusCode == http.StatusNotFound {
			im.state.Job = ""
			return false, im.state.save()
		}
		if err != nil {
			return true, wikiCallError("orbit wiki import", err)
		}
		switch job.State {
		case "succeeded":
			im.state.Job = ""
			im.applyServerReport(id, job.Report)
			return true, im.state.save()
		case "failed", "cancelled":
			im.state.Job = ""
			return true, fmt.Errorf("orbit wiki import: the server's import job %s %s: %s — the files it was handed stay "+
				"registered, and the next run hands them to a new job", id, job.State, job.Error)
		}
		now := wikiImportJobLine(id, job)
		if now != said {
			fmt.Fprintln(im.progress, now)
			said = now
		}
		left := "the job goes on on the server, and the next run of this command collects what it did"
		switch job.Model.State {
		case "auth_failed":
			return true, fmt.Errorf("the System model refused the deployment's key (401): nothing more is read until the "+
				"deployment fixes it; %s", left)
		case "unconfigured":
			return true, fmt.Errorf("this Orbit server's wiki runs on the server, and it has no System model configured "+
				"(ORBIT_WIKI_MODEL_*): %s", left)
		case "up":
			notUpSince = time.Time{}
		default:
			if notUpSince.IsZero() {
				notUpSince = time.Now()
			} else if time.Since(notUpSince) >= wikiImportHealthWait {
				return true, fmt.Errorf("the System model was not ready within %s (%s): %s", wikiImportHealthWait, job.Model.State, left)
			}
		}
		if job.StartedAt == "" && time.Since(began) >= wikiImportHealthWait {
			return true, fmt.Errorf("the server did not start the import job %s within %s: %s", id, wikiImportHealthWait, left)
		}
		if job.Attempts >= wikiImportJobAttempts {
			return true, fmt.Errorf("the server's import job %s has failed %d times (%s): %s", id, job.Attempts, job.Error, left)
		}
		time.Sleep(wikiImportJobPoll)
	}
}

// wikiImportJobLine is what a waiting run says of the job, once each time it changes.
func wikiImportJobLine(id string, job wikiImportJob) string {
	line := fmt.Sprintf("The server's import job %s is %s", id, job.State)
	if job.State == "running" && job.Progress.Step != "" {
		line += fmt.Sprintf(" (%s, %s read)", job.Progress.Step, wikiCount(job.Progress.Read, "note", "notes"))
	}
	if job.Model.State != "" && job.Model.State != "up" {
		line += fmt.Sprintf("; the System model is %s", job.Model.State)
	}
	if job.Error != "" {
		line += fmt.Sprintf("; its last try said: %s", job.Error)
	}
	return line + "."
}

// applyServerReport writes what the job did into this run's summary — the report's numbers, as they are
// — and into this machine's memory, note by note.
func (im *wikiImporter) applyServerReport(id string, report *wikiImportJobReport) {
	s := im.summary
	s.Job = id
	if report == nil {
		return
	}
	if report.Model != "" {
		s.Model = report.Model
	}
	r := report.Summary
	s.Entries, s.Principles, s.Dropped, s.Failed = r.Entries, r.Principles, r.Dropped, r.Failed
	s.Proposed, s.Applied, s.Pending, s.Verifying, s.Refused, s.Deferred = r.Proposed, r.Applied, r.Pending, r.Verifying, r.Refused, r.Deferred
	s.Calls, s.InputTokens, s.OutputTokens = r.Calls, r.InputTokens, r.OutputTokens
	s.Refusals = append(s.Refusals, r.Refusals...)
	s.Stopped = r.Stopped
	for _, note := range report.Notes {
		file := im.state.Files[note.File]
		if file == nil {
			continue
		}
		switch note.Status {
		case "read":
			file.Ops = make([]wikiImportOp, 0, len(note.Ops))
			for _, op := range note.Ops {
				file.Ops = append(file.Ops, wikiImportOp{Body: op.Body, Outcome: op.Outcome, Why: op.Why, OpID: op.OpID, EntryID: op.EntryID})
			}
			file.Principles, file.Dropped = note.Principles, note.Dropped
			file.Status = wikiImportExtracted
			if len(file.Ops) == 0 {
				file.Status = wikiImportDone
			}
			fmt.Fprintf(im.progress, "%s: %s\n", note.File, describeWikiImportFile(file))
		case "failed":
			file.Status, file.Why = wikiImportFailed, note.Why
			fmt.Fprintf(im.progress, "%s: nothing read — %s\n", note.File, note.Why)
		case "carried":
			for _, op := range note.Ops {
				if op.Index < 0 || op.Index >= len(file.Ops) {
					continue
				}
				kept := &file.Ops[op.Index]
				kept.Outcome, kept.Why, kept.OpID, kept.EntryID = op.Outcome, op.Why, op.OpID, op.EntryID
			}
		}
	}
	im.settle()
}
