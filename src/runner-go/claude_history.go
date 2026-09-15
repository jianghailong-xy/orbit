package main

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Reporting "what Claude Code conversations are already in this directory?" is the runner's job
// because it is the only one who can answer: ~/.claude/projects is on this disk and the control
// plane never sees it. It is scoped to ONE directory per request, deliberately. A census of every
// project directory on a working machine measured 1,993 slugs holding 1.84 GB of transcripts —
// unreadable on a heartbeat, and it would report the paths of projects nobody asked about.
const (
	// How far back a scan looks. Claude Code rolls transcripts away on its own `cleanupPeriodDays`
	// schedule (measured: the oldest file on a busy machine sits almost exactly 30 days back, with
	// no cliff before it), so "all your history" is a promise nobody can keep. The window is
	// reported with the answer and the offer states it, rather than implying the rest still exists.
	claudeHistoryWindow = 30 * 24 * time.Hour
	// The most transcripts one answer carries, mirroring @orbit/shared CLAUDE_HISTORY_MAX_TRANSCRIPTS.
	claudeHistoryMaxTranscripts = 200
	// Ceiling on how much transcript text one scan reads to count messages. Reading is what makes
	// the count real rather than guessed, but a directory is not allowed to make a heartbeat's
	// background work unbounded: past this the remaining files are still listed and counted as
	// conversations, they just contribute no messages.
	claudeHistoryMaxReadBytes = 256 << 20
)

// scanClaudeHistory reports the local Claude Code transcripts recorded for workDir.
//
// An empty result is an ordinary answer, not a failure: a directory nobody has run claude in has
// no project directory at all, and the form simply offers nothing. `error` is reserved for a scan
// that could not look — no home directory, an unreadable projects directory — so that "nothing is
// there" and "I could not tell" never render as the same sentence.
func scanClaudeHistory(workDir string) RunnerClaudeHistoryResult {
	out := RunnerClaudeHistoryResult{
		WorkDir:     workDir,
		WindowDays:  int(claudeHistoryWindow / (24 * time.Hour)),
		Transcripts: []ClaudeHistoryTranscript{},
	}
	dir, err := claudeProjectDir(workDir)
	if err != nil {
		out.Error = err.Error()
		return out
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		// A directory that was never created is the "no history here" answer, which is the common
		// case and not an error. Anything else (permissions, a broken mount) is worth saying.
		if !os.IsNotExist(err) {
			out.Error = err.Error()
		}
		return out
	}
	type candidate struct {
		id       string
		path     string
		modified time.Time
		size     int64
	}
	cutoff := time.Now().Add(-claudeHistoryWindow)
	var found []candidate
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		id := strings.TrimSuffix(e.Name(), ".jsonl")
		// Only files named as a Claude session id are transcripts an import could be keyed on;
		// whatever else lives here belongs to Claude Code, not to us.
		if !claudeSessionUUID.MatchString(id) {
			continue
		}
		info, err := e.Info()
		if err != nil || info.ModTime().Before(cutoff) {
			continue
		}
		found = append(found, candidate{id: id, path: filepath.Join(dir, e.Name()), modified: info.ModTime(), size: info.Size()})
	}
	// Newest first: the first entry is the conversation the user is in the middle of, which is the
	// one the offer names. Rolling cleanup works on the same clock, so this is also the order the
	// machine would discard them in, backwards.
	sort.Slice(found, func(i, j int) bool { return found[i].modified.After(found[j].modified) })

	if len(found) > claudeHistoryMaxTranscripts {
		// `conversations` still counts every file in the window, so a directory holding more than
		// one answer carries shows the two numbers disagreeing rather than offering "all of them"
		// and quietly importing the newest 200.
		out.Conversations = len(found)
		found = found[:claudeHistoryMaxTranscripts]
	}
	var read int64
	for _, c := range found {
		out.Bytes += c.size
		title, messages := "", 0
		if read < claudeHistoryMaxReadBytes {
			title, messages = readTranscriptSummary(c.path)
			read += c.size
		}
		// A transcript holding only bookkeeping (`last-prompt`, `ai-title`) is not a conversation:
		// `--resume` refuses it with "No conversation found", and the import door refuses it too.
		// Offering it here would promise something both of them would then decline.
		if messages == 0 {
			continue
		}
		out.Events += messages
		out.Transcripts = append(out.Transcripts, ClaudeHistoryTranscript{
			ClaudeSessionID: c.id,
			Title:           title,
			LastActiveAt:    c.modified.UTC().Format(time.RFC3339),
			Messages:        messages,
		})
	}
	if out.Conversations < len(out.Transcripts) {
		out.Conversations = len(out.Transcripts)
	}
	return out
}

// claudeProjectDir is where Claude Code keeps the transcripts recorded while running in cwd —
// the same directory `--resume` reads, so the escaping must match claudeTranscriptPath's exactly.
func claudeProjectDir(cwd string) (string, error) {
	abs, err := filepath.Abs(expandTilde(cwd))
	if err != nil {
		return "", err
	}
	// Reuse the one place the slug rule is written, rather than spelling it a second time: a
	// directory computed differently from the one --resume reads would report history that the
	// import then cannot find.
	path, err := claudeTranscriptPath(abs, "x")
	if err != nil {
		return "", err
	}
	return filepath.Dir(path), nil
}

// readTranscriptSummary streams one transcript for the two things the offer states about it: the
// title Claude gave the conversation (its last `ai-title` record — the same one the import reads,
// so the session lands in Orbit under the name the user knows it by) and how many messages it
// holds. Whole-file: the count is the answer's substance, and a prefix would undercount exactly
// the long conversations the user most wants to keep.
func readTranscriptSummary(path string) (string, int) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, transcriptReadBuffer)
	title, messages := "", 0
	for {
		line, err := r.ReadString('\n')
		if strings.TrimSpace(line) != "" {
			var rec struct {
				Type    string `json:"type"`
				AiTitle string `json:"aiTitle"`
			}
			if json.Unmarshal([]byte(line), &rec) == nil {
				switch rec.Type {
				case "user", "assistant":
					messages++
				case "ai-title":
					if rec.AiTitle != "" {
						title = rec.AiTitle
					}
				}
			}
		}
		if err != nil {
			return title, messages
		}
	}
}
