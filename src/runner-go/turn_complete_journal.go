package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// A session's turn completions, kept on disk until the control plane has answered them (task 34mwBTpOPo3S9LM2SXs10,
// from the C1a rollback drill of 2026-10-27). There a runner stopped with its link gateway down and the control plane
// refusing HTTPS: its turn's completion went nowhere, while the turn's events, its turn_end among them, stayed in the
// link spool. The next process stored them, but the control plane still had the turn in flight, so it handed the turn
// to that process with a resume continuation, and the engine answered it a second time. Over HTTPS the same follows from
// any completion lost with its runner.
//
// So the supervisor's completeTurn writes each completion to the session's spool directory,
// ~/.orbit/link-spool/<session>/turn-complete-<turn>.json, mode 0600 as the spool's segments, before the event flush
// that precedes it: a flush that fails sends no completion, and that is the case above. The file goes once this process
// is done with the completion: the control plane answered it or refused it, or the supervisor did not send it after
// all. It stays only when the runner stops before the control plane answered, or is killed. The session's next
// supervisor sends what it finds after the session's spool is stored and before its first inbox fetch, under its own
// lease: at its start the runner's next process takes over every open session it is assigned (reclaimMissingSessions).
// turnComplete's acknowledgement is a compare-and-set on the turn (not ANSWERED, delivered), so a completion the control
// plane took already, whose answer was lost, changes nothing, and a turn still in flight is answered and never handed to
// an engine again. A turn whose completion was never written is handed back with its resume continuation, as before:
// the runner killed before its engine finished the turn, or between the turn_end being stored and the write, the time
// completeTurn takes to read the worktree's diff. Delivery stays at least once.
//
// This holds with the link mode off as on, so it changes what a runner whose link mode is off does. That is an
// exception to the project's rule that a task leaves the runner as it was with the switch off (instruction 11), which
// the project's coordinator approved on 2026-10-27: the task asks for both modes, and all it does is send again the
// runner's own completion, which turnComplete takes idempotently.
//
// A completion the control plane refuses for the session (409, 403, 404: the session is not this process's, or no
// longer has the turn) is dropped and said. One of a session that is not handed back to this runner is never sent: it
// stays until the spool's 72-hour cleanup, which says what it removes (link_events_spool.go).

const (
	turnCompletionPrefix = "turn-complete-"
	turnCompletionSuffix = ".json"
)

// turnCompletions is one session's kept completions. Nil keeps nothing: a transport that is not the daemon's.
type turnCompletions struct {
	session string
	dir     string
	log     func(...any)
}

// newTurnCompletions is the kept completions of a session on t, nil when t keeps none: only the daemon's transport has
// the sessions' event streams, and with them the spool the completions go beside.
func newTurnCompletions(t *Transport, sessionID string) *turnCompletions {
	streams := t.eventStreams()
	if streams == nil {
		return nil
	}
	return &turnCompletions{session: sessionID, dir: filepath.Join(streams.spool.dir, spoolNamePart(decodeSessionID(sessionID))),
		log: streams.log}
}

// turnCompletionFile is a kept completion as its file holds it. usageUnknown is the request's own (UsageUnknown), which
// its JSON leaves out: it decides whether the completion carries a cost.
type turnCompletionFile struct {
	KeptAt       time.Time       `json:"keptAt"`
	UsageUnknown bool            `json:"usageUnknown,omitempty"`
	Request      json.RawMessage `json:"request"`
}

func (j *turnCompletions) path(turnID string) string {
	return filepath.Join(j.dir, turnCompletionPrefix+spoolNamePart(turnID)+turnCompletionSuffix)
}

// keep writes req, as it goes on the wire, in place of any completion of its turn kept before. A write the disk refuses
// is said and changes nothing else: the completion goes as it always has.
func (j *turnCompletions) keep(req TurnCompleteRequest) {
	if j == nil || req.TurnID == "" {
		return
	}
	req.LeaseOwner = "" // the process that sends it says whose it is
	wire, err := json.Marshal(req)
	if err == nil {
		var data []byte
		data, err = json.Marshal(turnCompletionFile{KeptAt: time.Now().UTC(), UsageUnknown: req.UsageUnknown, Request: wire})
		if err == nil {
			err = j.write(j.path(req.TurnID), data)
		}
	}
	if err != nil {
		j.log(fmt.Sprintf("runner link: the completion of turn %s of session %s could not be kept for the runner's next process: %v",
			req.TurnID, j.session, err))
	}
}

// write puts data at path whole: a process killed while it writes leaves the file as it was, or none.
func (j *turnCompletions) write(path string, data []byte) error {
	tmp := path + ".tmp"
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		// The spool removes the directory once it holds nothing more of its own, so it is made again when it went
		// between the two.
		if err = os.MkdirAll(j.dir, 0o700); err != nil {
			return err
		}
		if err = os.WriteFile(tmp, data, 0o600); err == nil {
			break
		}
	}
	if err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// drop lets the completion of a turn go.
func (j *turnCompletions) drop(turnID string) {
	if j == nil {
		return
	}
	_ = os.Remove(j.path(turnID))
}

// settle lets the completion of a turn go once this process is done with it: answered, refused, or not sent after all.
// unanswered, when it is not nil, is why the control plane never answered it before the runner stopped
// (completionUnansweredAtStop): it is kept then, for the runner's next process.
func (j *turnCompletions) settle(turnID string, unanswered error) {
	if j == nil {
		return
	}
	if unanswered != nil {
		j.log(fmt.Sprintf("runner link: the completion of turn %s of session %s is kept for the runner's next process: %v",
			turnID, j.session, unanswered))
		return
	}
	j.drop(turnID)
}

// completionUnansweredAtStop is err when it left a completion unanswered because the runner stopped (stopping), and
// nil when the completion is done with: answered (err nil), refused for the session (the session is not this
// process's any more), or not sent for a reason of the session's own, which the next process would not change either:
// its events given up (errLinkEventsAbandoned), or a CURRENT_WORK acknowledgement the control plane refused (fenced).
func completionUnansweredAtStop(err error, stopping, fenced bool) error {
	if err == nil || !stopping || fenced || isLeaseOwnershipError(err) || errors.Is(err, errLinkEventsAbandoned) {
		return nil
	}
	return err
}

// pending is every completion kept, oldest first. A file that does not read back is said and removed: there is
// nothing in it to send.
func (j *turnCompletions) pending() []TurnCompleteRequest {
	if j == nil {
		return nil
	}
	entries, err := os.ReadDir(j.dir)
	if err != nil {
		return nil
	}
	type kept struct {
		at  time.Time
		req TurnCompleteRequest
	}
	var out []kept
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, turnCompletionPrefix) {
			continue
		}
		path := filepath.Join(j.dir, name)
		if strings.HasSuffix(name, turnCompletionSuffix+".tmp") {
			_ = os.Remove(path) // a write cut short: the completion it was for was never kept
			continue
		}
		if !strings.HasSuffix(name, turnCompletionSuffix) {
			continue
		}
		req, at, err := readTurnCompletion(path)
		if err != nil {
			j.log(fmt.Sprintf("runner link: the kept completion %s of session %s does not read back and is removed: %v", name, j.session, err))
			_ = os.Remove(path)
			continue
		}
		out = append(out, kept{at: at, req: req})
	}
	sort.SliceStable(out, func(a, b int) bool { return out[a].at.Before(out[b].at) })
	reqs := make([]TurnCompleteRequest, len(out))
	for i, k := range out {
		reqs[i] = k.req
	}
	return reqs
}

func readTurnCompletion(path string) (TurnCompleteRequest, time.Time, error) {
	var req TurnCompleteRequest
	data, err := os.ReadFile(path)
	if err != nil {
		return req, time.Time{}, err
	}
	var f turnCompletionFile
	if err := json.Unmarshal(data, &f); err != nil {
		return req, time.Time{}, err
	}
	if err := json.Unmarshal(f.Request, &req); err != nil {
		return req, time.Time{}, err
	}
	if req.TurnID == "" {
		return req, time.Time{}, errors.New("it names no turn")
	}
	req.UsageUnknown = f.UsageUnknown
	return req, f.KeptAt, nil
}

// linkSpoolDirCompletions is the turns of the completions kept in a session's spool directory, for its cleanup.
func linkSpoolDirCompletions(dir string, files []os.DirEntry) []string {
	var turns []string
	for _, f := range files {
		name := f.Name()
		if !strings.HasPrefix(name, turnCompletionPrefix) || !strings.HasSuffix(name, turnCompletionSuffix) {
			continue
		}
		if req, _, err := readTurnCompletion(filepath.Join(dir, name)); err == nil {
			turns = append(turns, req.TurnID)
		} else {
			turns = append(turns, strings.TrimSuffix(strings.TrimPrefix(name, turnCompletionPrefix), turnCompletionSuffix))
		}
	}
	return turns
}
