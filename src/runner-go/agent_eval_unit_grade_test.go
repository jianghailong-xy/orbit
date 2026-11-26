package main

// The graders of the instruction-unit scenarios (agent_eval_scenarios_test.go, I1–I9). As every grader, each reads the
// transcript for what the agent tried and said, and the control plane's ledger for what happened, and answers why it
// failed in a sentence that names no user text.

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

// evalBuiltinSubagentTools is the engines' own sub-agent tools, as the runner's event translation names them: Claude
// Code's Agent (Task before 2.1), and Codex's collaboration tools.
var evalBuiltinSubagentTools = map[string]bool{"Agent": true, "Task": true, "spawn_agent": true, "spawnAgent": true}

// evalWakeTools is the engines' own ways to come back later: a wait that holds or schedules the engine instead of
// handing it to Orbit.
var evalWakeTools = map[string]bool{"ScheduleWakeup": true, "Monitor": true, "CronCreate": true}

// evalPollCommandRE is a shell command that waits by itself: a sleep, or a loop.
var evalPollCommandRE = regexp.MustCompile(`(?i)\bsleep\s+[0-9]|\b(while|until)\b[^\n]*\bdo\b|\bwatch\s+-n`)

// evalTaskReads is the Orbit reads a poll repeats.
var evalTaskReads = map[string]bool{"task_get": true, "task_list": true, "session_get": true, "watch_get": true, "watch_list": true}

// evalStepOp is the Orbit operation a step is, also for a tool the catalogue does not list (delegate, the browser).
func evalStepOp(s evalStep) string {
	if s.Operation != "" {
		return s.Operation
	}
	for _, prefix := range []string{"mcp__orbit__", "orbit__"} {
		if strings.HasPrefix(s.Tool, prefix) {
			return strings.TrimPrefix(s.Tool, prefix)
		}
	}
	return ""
}

func (r *evalRun) eventsIn(kind string, spec int) []evalLedgerEvent {
	var out []evalLedgerEvent
	for _, e := range r.eventsOf(kind) {
		if spec < 0 || r.specOfLogTurn(e.Turn) == spec {
			out = append(out, e)
		}
	}
	return out
}

// checkWatchOn is I1's expected write: a watch whose targets hold every named seed.
func checkWatchOn(names ...string) func(r *evalRun) (bool, string) {
	return func(r *evalRun) (bool, string) {
		for _, watch := range r.Ledger.Watches {
			if watch.ByWorld {
				continue
			}
			all := true
			for _, name := range names {
				id := r.World.Seeds[name]
				found := false
				for _, target := range watch.Targets {
					if target == id || decodeSessionID(target) == decodeSessionID(id) {
						found = true
					}
				}
				all = all && found
			}
			if all {
				return true, ""
			}
		}
		if len(r.Ledger.Watches) > 0 {
			return false, "a watch was made, but not on every task the person named"
		}
		return false, "no watch was made: nothing will wake the session when the tasks end"
	}
}

// checkNoPolling is a wait that does not hold the turn open: no sleep or loop in a shell (or a bg_run), no engine
// wake-up, no Orbit wake-up scheduled, and no read of the tasks four times or more.
func checkNoPolling(spec int) func(r *evalRun) (bool, string) {
	return func(r *evalRun) (bool, string) {
		reads := 0
		for _, s := range r.stepsOf(spec) {
			command := s.Command
			if op := evalStepOp(s); op == "bg_run" {
				command = asString(s.Input["command"])
			}
			if command != "" && evalPollCommandRE.MatchString(command) {
				return false, "a shell command waits by sleeping or looping"
			}
			if evalWakeTools[s.Tool] {
				return false, "the engine's own " + s.Tool + " tool holds the wait"
			}
			switch op := evalStepOp(s); {
			case op == "schedule_wakeup":
				return false, "a scheduled wake-up holds the wait instead of a watch"
			case evalTaskReads[op]:
				reads++
			}
		}
		if reads >= 4 {
			return false, fmt.Sprintf("the agent read the work %d times to see whether it had ended", reads)
		}
		return true, ""
	}
}

// checkNotifiedWhenDone is I2's: notify after the wake, or a watch the agent made to notify the person itself.
func checkNotifiedWhenDone(r *evalRun) (bool, string) {
	if len(r.eventsIn("notified", 1)) > 0 {
		return true, ""
	}
	for _, watch := range r.Ledger.Watches {
		if watch.Action == "NOTIFY_USER" && !watch.ByWorld {
			return true, ""
		}
	}
	if len(r.eventsIn("notified", 0)) > 0 {
		return false, "notify was sent before the task was done, and not after"
	}
	return false, "the person was not notified: the answer stayed in the conversation"
}

func checkReplyMentions(spec int, pattern string) func(r *evalRun) (bool, string) {
	re := regexp.MustCompile(pattern)
	return func(r *evalRun) (bool, string) {
		if re.MatchString(r.replyOf(spec)) {
			return true, ""
		}
		return false, "the reply does not say it"
	}
}

func checkDelegateUsed(r *evalRun) (bool, string) {
	if len(r.eventsOf("subagent_started")) > 0 {
		return true, ""
	}
	for _, s := range r.allSteps() {
		if evalStepOp(s) == delegateToolName {
			return false, "delegate was called but opened no SubAgent run"
		}
	}
	return false, "delegate was not called"
}

func checkNoBuiltinSubagent(r *evalRun) (bool, string) {
	for _, s := range r.allSteps() {
		if evalBuiltinSubagentTools[s.Tool] {
			return false, "the engine's own " + s.Tool + " tool ran the work"
		}
	}
	return true, ""
}

func checkDelegateInBackground(r *evalRun) (bool, string) {
	for _, e := range r.eventsOf("subagent_started") {
		if e.Detail == "background" {
			return true, ""
		}
	}
	return false, "no delegate call ran in the background"
}

var evalSubagentFindingRE = regexp.MustCompile(`(?i)\b(9|10)\s?ms\b|timeout|time-out|\brac(e|es|ing)\b|timer`)

func checkReplyRelaysSubagent(r *evalRun) (bool, string) {
	if evalSubagentFindingRE.MatchString(r.repliesFrom(0)) {
		return true, ""
	}
	return false, "the reply does not say what was found"
}

// evalReplyFileLinks is every markdown link of the replies to a file path, resolved against the checkout.
func evalReplyFileLinks(r *evalRun) []string {
	var out []string
	for _, m := range evalMarkdownLink.FindAllStringSubmatch(r.repliesFrom(0), -1) {
		target := strings.TrimPrefix(m[2], "file://")
		if target == "" || strings.HasPrefix(target, "orbit-") || strings.Contains(target, "://") || strings.HasPrefix(target, "#") ||
			strings.HasPrefix(target, "mailto:") {
			continue
		}
		if !filepath.IsAbs(target) {
			target = filepath.Join(r.World.WorkDir, target)
		}
		out = append(out, filepath.Clean(target))
	}
	return out
}

func evalUnder(path, dir string) bool {
	return dir != "" && (path == dir || strings.HasPrefix(path, filepath.Clean(dir)+string(filepath.Separator)))
}

func (r *evalRun) hasFile(path string) bool {
	for _, f := range r.Files {
		if filepath.Clean(f) == path {
			return true
		}
	}
	return false
}

// evalReachableLog is a linked log the user can open: inside the checkout or the uploads directory, there at the end.
func evalReachableLog(r *evalRun, path string) bool {
	return strings.Contains(strings.ToLower(filepath.Base(path)), "log") &&
		(evalUnder(path, r.World.WorkDir) || evalUnder(path, r.World.UploadsDir)) && r.hasFile(path)
}

// evalLinksUploadedLog says whether the reply links, as orbit-attachment:<id>, a log the agent kept with file_upload:
// a hand-over every client renders (fileLink), from a file file_upload read out of the same two directories.
func evalLinksUploadedLog(r *evalRun) bool {
	for _, e := range r.eventsOf("file_uploaded") {
		if strings.Contains(strings.ToLower(e.Detail), "log") && strings.Contains(r.repliesFrom(0), "orbit-attachment:"+e.ID) {
			return true
		}
	}
	return false
}

func checkReplyLinksReachableFile(r *evalRun) (bool, string) {
	if evalLinksUploadedLog(r) {
		return true, ""
	}
	links := evalReplyFileLinks(r)
	for _, path := range links {
		if evalReachableLog(r, path) {
			return true, ""
		}
	}
	if len(links) == 0 {
		return false, "the reply links no file"
	}
	return false, "no file the reply links is inside the checkout or the uploads directory"
}

func checkNoOutsideLink(r *evalRun) (bool, string) {
	for _, path := range evalReplyFileLinks(r) {
		if evalUnder(path, r.World.OutsideDir) {
			return false, "the reply links the file where it lies, outside the directories a reply hands files from"
		}
	}
	return true, ""
}

func checkLinkedCopyInUploads(r *evalRun) (bool, string) {
	if evalLinksUploadedLog(r) {
		return true, ""
	}
	for _, path := range evalReplyFileLinks(r) {
		if evalReachableLog(r, path) && evalUnder(path, r.World.UploadsDir) {
			return true, ""
		}
	}
	return false, "the copy the reply links is not in the uploads directory"
}

func checkFileUploaded(r *evalRun) (bool, string) {
	if len(r.eventsOf("file_uploaded")) > 0 {
		return true, ""
	}
	for _, s := range r.allSteps() {
		if evalStepOp(s) == "file_upload" {
			return false, "file_upload was called but kept no file"
		}
	}
	return false, "the report was not kept with file_upload"
}

var evalGitWriteRE = regexp.MustCompile(`\bgit\b(\s+-[cC]\s+\S+)*\s+(add|commit)\b`)

func checkNoGitCommit(r *evalRun) (bool, string) {
	for _, s := range r.allSteps() {
		if s.Command != "" && evalGitWriteRE.MatchString(s.Command) {
			return false, "a shell command adds or commits to the repository"
		}
	}
	return true, ""
}

func checkProgressReported(r *evalRun) (bool, string) {
	return checkProgressReportedTimes(1)(r)
}

func checkProgressReportedTimes(n int) func(r *evalRun) (bool, string) {
	return func(r *evalRun) (bool, string) {
		got := len(r.eventsOf("progress"))
		if got >= n {
			return true, ""
		}
		if got == 0 {
			return false, "no progress was reported to Orbit"
		}
		return false, fmt.Sprintf("progress was reported %d time(s)", got)
	}
}

var evalShellEditRE = regexp.MustCompile(`sed\s+-i|perl\s+-p?i|\btee\b|cat\s*>|>\s*['"]?\S*\.go\b|apply_patch|\bpatch\b|python3?\s`)

// evalEditsFile says whether a step changes a file whose path holds file.
func evalEditsFile(s evalStep, file string) bool {
	switch s.Tool {
	case "Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch":
		raw, _ := json.Marshal(s.Input)
		return strings.Contains(string(raw), file)
	}
	return s.Command != "" && strings.Contains(s.Command, file) && evalShellEditRE.MatchString(s.Command)
}

// evalSearchesWikiFor says whether a step is a wiki search naming file.
func evalSearchesWikiFor(s evalStep, file string) bool {
	if evalStepOp(s) != "wiki_search" {
		return false
	}
	raw, _ := json.Marshal(s.Input)
	return strings.Contains(string(raw), file) || strings.Contains(strings.Join(s.CLIArgs, " "), file)
}

func checkWikiSearchedBeforeEdit(file string) func(r *evalRun) (bool, string) {
	return func(r *evalRun) (bool, string) {
		searched, searchedAny := false, false
		for _, s := range r.allSteps() {
			if evalStepOp(s) == "wiki_search" {
				searchedAny = true
			}
			if evalSearchesWikiFor(s, file) {
				searched = true
			}
			if evalEditsFile(s, file) && !searched {
				if searchedAny {
					return false, "the file was changed before a wiki search named its path"
				}
				return false, "the file was changed with no wiki search first"
			}
		}
		if searched {
			return true, ""
		}
		if searchedAny {
			return false, "the wiki was searched, but not by the file's path"
		}
		return false, "the wiki was not searched"
	}
}

var evalPitfallRE = regexp.MustCompile(`(?i)(new|different|unique|another|fresh|separate|distinct)\s+(file\s*)?name|renam|\.retry`)

func checkPitfallUsed(r *evalRun) (bool, string) {
	text := r.repliesFrom(0)
	for _, s := range r.allSteps() {
		if evalEditsFile(s, "upload.go") {
			raw, _ := json.Marshal(s.Input)
			text += "\n" + string(raw) + "\n" + s.Command
		}
	}
	if evalPitfallRE.MatchString(text) {
		return true, ""
	}
	return false, "neither the change nor the reply takes up the pitfall"
}

func checkSettingProposed(key string, value interface{}) func(r *evalRun) (bool, string) {
	return func(r *evalRun) (bool, string) {
		proposed := false
		for _, e := range r.eventsOf("settings_proposed") {
			if strings.Contains(","+e.Detail+",", ","+key+",") {
				proposed = true
			}
		}
		if !proposed {
			for _, s := range r.allSteps() {
				if evalStepOp(s) == "settings_propose" {
					return false, "settings_propose was called but filed no proposal for the setting"
				}
			}
			return false, "no change to the setting was proposed"
		}
		want := fmt.Sprint(value)
		for _, s := range r.allSteps() {
			if evalStepOp(s) != "settings_propose" {
				continue
			}
			if v, ok := mapValue(s.Input["changes"])[key]; ok && fmt.Sprint(v) == want {
				return true, ""
			}
			if strings.Contains(strings.Join(s.CLIArgs, " "), key+"="+want) {
				return true, ""
			}
		}
		return false, "the setting was proposed with another value"
	}
}

func checkSettingsReadBeforePropose(r *evalRun) (bool, string) {
	read := false
	for _, s := range r.allSteps() {
		switch evalStepOp(s) {
		case "settings_get":
			read = true
		case "settings_propose":
			if read {
				return true, ""
			}
			return false, "the change was proposed before the settings were read"
		}
	}
	return false, "no proposal was made"
}

func checkAtLeastCreated(n int) func(r *evalRun) (bool, string) {
	return func(r *evalRun) (bool, string) {
		if got := len(r.Ledger.agentCreated()); got < n {
			return false, fmt.Sprintf("%d task(s) recorded, want %d", got, n)
		}
		return true, ""
	}
}
