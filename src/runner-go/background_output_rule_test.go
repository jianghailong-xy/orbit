//go:build linux || darwin

package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Which file a background shell's live output is read from. A launch is known by the engine's own frames and read from the
// engine's own file. Each case goes through the real handleMessage, so what these frames say is all that decides it. Every
// file is a fixture in a temporary home.

const (
	outputRuleSession      = "aaaaaaaa-bbbb-4ccc-8ddd-000000000001"
	outputRuleOtherSession = "aaaaaaaa-bbbb-4ccc-8ddd-000000000002"
	outputRuleShell        = "bqpmn2xk7"
	outputRuleSecret       = "the-runner-credential"
)

// outputRuleHost is a machine with a credential, a checkout, and the temporary directory the engine keeps its output in.
type outputRuleHost struct {
	orbit, checkout, config string
	// temp is the engine's <temp>/claude-<uid>; slug the directory below it named for the working directory.
	temp, slug string
}

func newOutputRuleHost(t *testing.T) outputRuleHost {
	t.Helper()
	base := realPath(t.TempDir())
	home := filepath.Join(base, "home")
	h := outputRuleHost{
		orbit:    filepath.Join(home, ".orbit"),
		checkout: mkdirForTest(t, filepath.Join(home, ".orbit", "worktrees", outputRuleSession)),
		temp:     filepath.Join(base, "tmp", "claude-"+strconv.Itoa(os.Getuid())),
		slug:     "-home--orbit-worktrees-" + outputRuleSession,
	}
	t.Setenv("HOME", home)
	t.Setenv("ORBIT_HOME", h.orbit)
	h.config = writeTestFile(t, filepath.Join(h.orbit, "config.json"), outputRuleSecret)
	mkdirForTest(t, h.tasks())
	return h
}

// tasks is where the engine keeps this session's shells' output.
func (h outputRuleHost) tasks() string {
	return filepath.Join(h.temp, h.slug, outputRuleSession, "tasks")
}

func (h outputRuleHost) output() string { return filepath.Join(h.tasks(), outputRuleShell+".output") }

func engineInitFrame(session string) map[string]interface{} {
	return map[string]interface{}{"type": "system", "subtype": "init", "session_id": session}
}

func engineCallFrame(id, name string, input map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{"type": "assistant", "message": map[string]interface{}{"content": []interface{}{
		map[string]interface{}{"type": "tool_use", "id": id, "name": name, "input": input},
	}}}
}

func engineResultFrame(id, text string) map[string]interface{} {
	return map[string]interface{}{"type": "user", "message": map[string]interface{}{"content": []interface{}{
		map[string]interface{}{"type": "tool_result", "tool_use_id": id, "content": text},
	}}}
}

func launchReceipt(shell, path string) string {
	return "Command running in background with ID: " + shell + ". Output is being written to: " + path +
		". You will be notified when it completes."
}

var engineBackgroundBash = map[string]interface{}{"command": "make", "description": "build", "run_in_background": true}

// outputRuleTailer is a tailer whose holds on the checkout can be read back, with the engine's start already seen.
func outputRuleTailer(t *testing.T, session string) (*bgTailer, *bgAllEvents, *sessionPool) {
	t.Helper()
	p := newSessionPool(1)
	if _, added := p.register(manualWorktreePoolJob(session, "orbit/"+session), func() {}, true); !added {
		t.Fatal("fixture: failed to register the session")
	}
	events := &bgAllEvents{}
	bg := newBgTailer(context.Background(), events.emit, p.worktreeHoldsFor(session))
	handleMessage(engineInitFrame(outputRuleSession), events.emit, bg)
	return bg, events, p
}

// stopWithin stops a tailer and fails if that takes long. A goroutine held in an open would hold this call with it, and it
// is let go at the end so that the test binary can finish.
func stopWithin(t *testing.T, bg *bgTailer, fifos ...string) {
	t.Helper()
	stopped := make(chan struct{})
	go func() {
		bg.stopAll()
		close(stopped)
	}()
	select {
	case <-stopped:
		return
	case <-time.After(5 * time.Second):
		t.Error("a session's stop is still waiting after 5 s")
	}
	for {
		for _, fifo := range fifos {
			if w, err := os.OpenFile(fifo, os.O_WRONLY|syscall.O_NONBLOCK, 0); err == nil {
				w.Close()
			}
		}
		select {
		case <-stopped:
			return
		case <-time.After(100 * time.Millisecond):
		}
	}
}

func assertNothingEmittedOf(t *testing.T, events *bgAllEvents, texts ...string) {
	t.Helper()
	for _, ev := range events.ofKind(evBackgroundOutput) {
		t.Errorf("background_output emitted: %q", asString(ev["content"]))
	}
	for _, ev := range events.ofKind(evBackgroundTask) {
		for _, text := range texts {
			if strings.Contains(fmt.Sprint(ev), text) {
				t.Errorf("background_task holds %q: %v", text, ev)
			}
		}
	}
}

// A result says what it says, and only a call that asked for a background shell makes it a launch.
func TestOnlyACallThatAskedForABackgroundShellStartsATail(t *testing.T) {
	calls := map[string]func(t *testing.T, bg *bgTailer, events *bgAllEvents){
		"no call at all": func(*testing.T, *bgTailer, *bgAllEvents) {},
		"a command in the foreground": func(t *testing.T, bg *bgTailer, events *bgAllEvents) {
			handleMessage(engineCallFrame("toolu_r", "Bash", map[string]interface{}{"command": "cat notes"}), events.emit, bg)
		},
		"a command asked not to": func(t *testing.T, bg *bgTailer, events *bgAllEvents) {
			handleMessage(engineCallFrame("toolu_r", "Bash", map[string]interface{}{"command": "cat notes", "run_in_background": false}), events.emit, bg)
		},
		"another tool": func(t *testing.T, bg *bgTailer, events *bgAllEvents) {
			handleMessage(engineCallFrame("toolu_r", "Read", map[string]interface{}{"file_path": "notes"}), events.emit, bg)
		},
		"a sub-agent, which is no shell": func(t *testing.T, bg *bgTailer, events *bgAllEvents) {
			handleMessage(engineCallFrame("toolu_r", "Agent", map[string]interface{}{"prompt": "go", "run_in_background": true}), events.emit, bg)
		},
		"another call's": func(t *testing.T, bg *bgTailer, events *bgAllEvents) {
			handleMessage(engineCallFrame("toolu_other", "Bash", engineBackgroundBash), events.emit, bg)
		},
	}
	paths := map[string]func(t *testing.T, h outputRuleHost) string{
		"a link out of the checkout": func(t *testing.T, h outputRuleHost) string {
			link := filepath.Join(h.checkout, outputRuleShell+".output")
			linkForTest(t, h.config, link)
			return link
		},
		"another session's job output": func(t *testing.T, h outputRuleHost) string {
			return writeTestFile(t, filepath.Join(h.orbit, "runs", outputRuleOtherSession, outputRuleShell+".output"), outputRuleSecret)
		},
		"a file in the checkout": func(t *testing.T, h outputRuleHost) string {
			return writeTestFile(t, filepath.Join(h.checkout, outputRuleShell+".output"), outputRuleSecret)
		},
		"the engine's own place": func(t *testing.T, h outputRuleHost) string {
			return writeTestFile(t, h.output(), outputRuleSecret)
		},
	}
	for callName, call := range calls {
		for pathName, path := range paths {
			t.Run(callName+"/"+pathName, func(t *testing.T) {
				h := newOutputRuleHost(t)
				bg, events, p := outputRuleTailer(t, "tailrule")
				call(t, bg, events)
				handleMessage(engineResultFrame("toolu_r", launchReceipt(outputRuleShell, path(t, h))), events.emit, bg)
				bg.mu.Lock()
				live := len(bg.live)
				bg.mu.Unlock()
				holders := p.worktreeHolders("tailrule")
				stopWithin(t, bg)
				if live != 0 || len(holders) != 0 {
					t.Errorf("registered %d shells, holding the checkout: %v", live, holders)
				}
				assertNothingEmittedOf(t, events, outputRuleSecret)
			})
		}
	}
}

// A call that did ask for a shell is still only read from the engine's own file. The shell it is owed its hold and its
// report, which carry none of what stands at that path.
func TestABackgroundCallIsReadOnlyFromTheEnginesOwnFile(t *testing.T) {
	foreign := func(t *testing.T, h outputRuleHost, name string) string {
		return writeTestFile(t, filepath.Join(h.orbit, "elsewhere", name), outputRuleSecret)
	}
	for name, path := range map[string]func(t *testing.T, h outputRuleHost) string{
		"a link at its name": func(t *testing.T, h outputRuleHost) string {
			linkForTest(t, h.config, h.output())
			return h.output()
		},
		"a link at its name to another output there": func(t *testing.T, h outputRuleHost) string {
			target := writeTestFile(t, filepath.Join(h.tasks(), "bother.output"), outputRuleSecret)
			linkForTest(t, target, h.output())
			return h.output()
		},
		"a link in place of its directory": func(t *testing.T, h outputRuleHost) string {
			foreign(t, h, outputRuleShell+".output")
			if err := os.Remove(h.tasks()); err != nil {
				t.Fatal(err)
			}
			linkForTest(t, filepath.Join(h.orbit, "elsewhere"), h.tasks())
			return h.output()
		},
		"a link in place of the session's directory": func(t *testing.T, h outputRuleHost) string {
			writeTestFile(t, filepath.Join(h.orbit, "elsewhere", "tasks", outputRuleShell+".output"), outputRuleSecret)
			session := filepath.Dir(h.tasks())
			if err := os.RemoveAll(session); err != nil {
				t.Fatal(err)
			}
			linkForTest(t, filepath.Join(h.orbit, "elsewhere"), session)
			return h.output()
		},
		"a link in place of the temporary directory": func(t *testing.T, h outputRuleHost) string {
			writeTestFile(t, filepath.Join(h.orbit, "elsewhere", h.slug, outputRuleSession, "tasks", outputRuleShell+".output"), outputRuleSecret)
			if err := os.RemoveAll(h.temp); err != nil {
				t.Fatal(err)
			}
			linkForTest(t, filepath.Join(h.orbit, "elsewhere"), h.temp)
			return h.output()
		},
		"another session's file": func(t *testing.T, h outputRuleHost) string {
			return writeTestFile(t, filepath.Join(h.temp, h.slug, outputRuleOtherSession, "tasks", outputRuleShell+".output"), outputRuleSecret)
		},
		"another session's file through a directory name": func(t *testing.T, h outputRuleHost) string {
			writeTestFile(t, filepath.Join(h.temp, "-other", outputRuleOtherSession, "tasks", outputRuleShell+".output"), outputRuleSecret)
			return filepath.Join(h.temp, "-other", outputRuleSession, "..", outputRuleOtherSession, "tasks", outputRuleShell+".output")
		},
		"another account's temporary directory": func(t *testing.T, h outputRuleHost) string {
			return writeTestFile(t, filepath.Join(filepath.Dir(h.temp), "claude-"+strconv.Itoa(os.Getuid()+1), h.slug, outputRuleSession, "tasks", outputRuleShell+".output"), outputRuleSecret)
		},
		"a job's output in Orbit's directory": func(t *testing.T, h outputRuleHost) string {
			return writeTestFile(t, filepath.Join(h.orbit, "runs", outputRuleOtherSession, outputRuleShell+".output"), outputRuleSecret)
		},
		"a file in the checkout": func(t *testing.T, h outputRuleHost) string {
			return writeTestFile(t, filepath.Join(h.checkout, outputRuleShell+".output"), outputRuleSecret)
		},
		"another shell's file": func(t *testing.T, h outputRuleHost) string {
			return writeTestFile(t, filepath.Join(h.tasks(), "bother.output"), outputRuleSecret)
		},
		"a directory of that name": func(t *testing.T, h outputRuleHost) string {
			mkdirForTest(t, h.output())
			return h.output()
		},
	} {
		t.Run(name, func(t *testing.T) {
			h := newOutputRuleHost(t)
			bg, events, p := outputRuleTailer(t, "tailrule")
			handleMessage(engineCallFrame("toolu_bg", "Bash", engineBackgroundBash), events.emit, bg)
			handleMessage(engineResultFrame("toolu_bg", launchReceipt(outputRuleShell, path(t, h))), events.emit, bg)
			if holders := p.worktreeHolders("tailrule"); !holdersInclude(holders, worktreeHeldByBackgroundJob, outputRuleShell) {
				t.Errorf("a shell the engine was asked to run holds nothing: %v", holders)
			}
			bg.killEngineShells()
			if holders := p.worktreeHolders("tailrule"); len(holders) != 0 {
				t.Errorf("still held after the engine stopped: %v", holders)
			}
			stopWithin(t, bg)
			assertNothingEmittedOf(t, events, outputRuleSecret)
			if killed := events.ofKind(evBackgroundTask); len(killed) != 1 || asString(killed[0]["shellId"]) != outputRuleShell {
				t.Errorf("reports = %v, want the shell's own", killed)
			}
		})
	}
}

// What was the right file when the tail began is judged again every time it is read.
func TestATailStopsAtWhatStopsBeingTheEnginesFile(t *testing.T) {
	h := newOutputRuleHost(t)
	writeTestFile(t, h.output(), "[1/4] compiling\n")
	bg, events, _ := outputRuleTailer(t, "tailrule")
	handleMessage(engineCallFrame("toolu_bg", "Bash", engineBackgroundBash), events.emit, bg)
	handleMessage(engineResultFrame("toolu_bg", launchReceipt(outputRuleShell, h.output())), events.emit, bg)
	awaitTailedOutput(t, events, "toolu_bg", "[1/4] compiling")

	if err := os.Remove(h.output()); err != nil {
		t.Fatal(err)
	}
	linkForTest(t, h.config, h.output())
	time.Sleep(bgPollInterval + bgPollInterval/2)
	stopWithin(t, bg)
	for _, ev := range events.ofKind(evBackgroundOutput) {
		if strings.Contains(asString(ev["content"]), outputRuleSecret) {
			t.Errorf("emitted %q", asString(ev["content"]))
		}
	}
}

// A named pipe has no writer to wait for here, and nothing may wait for one: a held read holds the session's stop.
func TestANamedPipeHoldsNeitherATailNorASessionsStop(t *testing.T) {
	mkfifo := func(t *testing.T, path string) string {
		t.Helper()
		mkdirForTest(t, filepath.Dir(path))
		if err := syscall.Mkfifo(path, 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}
	settle := func() { time.Sleep(200 * time.Millisecond) }
	t.Run("at the name of the engine's file", func(t *testing.T) {
		h := newOutputRuleHost(t)
		fifo := mkfifo(t, h.output())
		bg, events, _ := outputRuleTailer(t, "tailrule")
		handleMessage(engineCallFrame("toolu_bg", "Bash", engineBackgroundBash), events.emit, bg)
		handleMessage(engineResultFrame("toolu_bg", launchReceipt(outputRuleShell, fifo)), events.emit, bg)
		settle()
		stopWithin(t, bg, fifo)
		assertNothingEmittedOf(t, events, outputRuleSecret)
	})
	t.Run("in place of a directory on the way", func(t *testing.T) {
		h := newOutputRuleHost(t)
		if err := os.RemoveAll(h.tasks()); err != nil {
			t.Fatal(err)
		}
		fifo := mkfifo(t, h.tasks())
		bg, events, _ := outputRuleTailer(t, "tailrule")
		handleMessage(engineCallFrame("toolu_bg", "Bash", engineBackgroundBash), events.emit, bg)
		handleMessage(engineResultFrame("toolu_bg", launchReceipt(outputRuleShell, h.output())), events.emit, bg)
		settle()
		stopWithin(t, bg, fifo)
	})
	t.Run("named by a result of any other call", func(t *testing.T) {
		h := newOutputRuleHost(t)
		fifo := mkfifo(t, filepath.Join(h.checkout, outputRuleShell+".output"))
		bg, events, _ := outputRuleTailer(t, "tailrule")
		handleMessage(engineResultFrame("toolu_r", launchReceipt(outputRuleShell, fifo)), events.emit, bg)
		settle()
		stopWithin(t, bg, fifo)
		assertNothingEmittedOf(t, events, outputRuleSecret)
	})
	t.Run("at a job's output", func(t *testing.T) {
		h := newOutputRuleHost(t)
		fifo := mkfifo(t, filepath.Join(h.orbit, "runs", outputRuleSession, "bgj_1.output"))
		bg, events, _ := outputRuleTailer(t, "tailrule")
		bg.startTail("bgj_1", "bgj_1", fifo, false)
		settle()
		stopWithin(t, bg, fifo)
		assertNothingEmittedOf(t, events, outputRuleSecret)
	})
	t.Run("at the engine's transcript", func(t *testing.T) {
		h := newOutputRuleHost(t)
		fifo := mkfifo(t, filepath.Join(h.orbit, "claude-accounts", "slot", "projects", "p", outputRuleSession+".jsonl"))
		bg, _, _ := outputRuleTailer(t, "tailrule")
		bg.startTranscriptWatcher(outputRuleSession, filepath.Join(h.orbit, "claude-accounts", "slot"))
		settle()
		stopWithin(t, bg, fifo)
	})
}

// A job's output is the runner's file, and a session can write where it stands. Every read of it reads that file or nothing.
func TestAJobsOutputIsReadOnlyFromTheFileAtItsName(t *testing.T) {
	h := newEvictionHarness(t, "joboutputrule", 1)
	h.startEngine()
	job := h.startJob("sleep 30", bgKindJob)
	secret := writeTestFile(t, filepath.Join(t.TempDir(), "secret"), outputRuleSecret)

	replace := func(with func(path string) error) {
		t.Helper()
		if err := os.Remove(job.OutputPath); err != nil {
			t.Fatal(err)
		}
		if err := with(job.OutputPath); err != nil {
			t.Fatal(err)
		}
	}
	read := func() string {
		t.Helper()
		got := make(chan string, 1)
		go func() {
			out, err := h.bg.jobOutput(job.JobID, 0, 0)
			if err != nil {
				t.Errorf("jobOutput: %v", err)
			}
			got <- out.Output + readCapped(job.OutputPath) + wakeExcerpt(job.OutputPath)
		}()
		select {
		case text := <-got:
			return text
		case <-time.After(5 * time.Second):
			// Let go whatever waits there, and leave nothing there to wait on, so that the harness can stop.
			if w, err := os.OpenFile(job.OutputPath, os.O_WRONLY|syscall.O_NONBLOCK, 0); err == nil {
				w.Close()
			}
			os.Remove(job.OutputPath)
			t.Fatal("a read of the job's output is still waiting after 5 s")
			return ""
		}
	}

	replace(func(path string) error { return os.Symlink(secret, path) })
	if text := read(); text != "" {
		t.Errorf("read through a link: %q", text)
	}
	replace(func(path string) error { return syscall.Mkfifo(path, 0o644) })
	if text := read(); text != "" {
		t.Errorf("read from a named pipe: %q", text)
	}
	replace(func(path string) error { return os.WriteFile(path, []byte("the job's own\n"), 0o644) })
	if text := read(); !strings.Contains(text, "the job's own") {
		t.Errorf("the job's own output: %q", text)
	}
}

// The paired positive, frame by frame as the CLI writes them: its call, then its receipt.
func TestABackgroundShellsOutputReachesTheControlPlaneLive(t *testing.T) {
	for name, frames := range map[string]func(t *testing.T, h outputRuleHost, bg *bgTailer, events *bgAllEvents) string{
		"a call of the agent's": func(t *testing.T, h outputRuleHost, bg *bgTailer, events *bgAllEvents) string {
			handleMessage(engineCallFrame("toolu_bg", "Bash", engineBackgroundBash), events.emit, bg)
			return h.output()
		},
		"a call of a sub-agent's": func(t *testing.T, h outputRuleHost, bg *bgTailer, events *bgAllEvents) string {
			call := engineCallFrame("toolu_bg", "Bash", engineBackgroundBash)
			call["parent_tool_use_id"] = "toolu_agent"
			handleMessage(call, events.emit, bg)
			return h.output()
		},
		"after the engine took a new session id": func(t *testing.T, h outputRuleHost, bg *bgTailer, events *bgAllEvents) string {
			handleMessage(engineInitFrame(outputRuleOtherSession), events.emit, bg)
			handleMessage(engineCallFrame("toolu_bg", "Bash", engineBackgroundBash), events.emit, bg)
			return filepath.Join(h.temp, h.slug, outputRuleOtherSession, "tasks", outputRuleShell+".output")
		},
		"still under the id it started with": func(t *testing.T, h outputRuleHost, bg *bgTailer, events *bgAllEvents) string {
			handleMessage(engineInitFrame(outputRuleOtherSession), events.emit, bg)
			handleMessage(engineCallFrame("toolu_bg", "Bash", engineBackgroundBash), events.emit, bg)
			return h.output()
		},
		"the other shell tool": func(t *testing.T, h outputRuleHost, bg *bgTailer, events *bgAllEvents) string {
			handleMessage(engineCallFrame("toolu_bg", "PowerShell", engineBackgroundBash), events.emit, bg)
			return h.output()
		},
	} {
		t.Run(name, func(t *testing.T) {
			h := newOutputRuleHost(t)
			bg, events, p := outputRuleTailer(t, "tailrule")
			output := frames(t, h, bg, events)
			writeTestFile(t, output, "[1/4] compiling\n")
			handleMessage(engineResultFrame("toolu_bg", launchReceipt(outputRuleShell, output)), events.emit, bg)
			awaitTailedOutput(t, events, "toolu_bg", "[1/4] compiling")

			if err := os.WriteFile(output, []byte("[1/4] compiling\n[2/4] linking\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			awaitLaterOutput(t, events, "toolu_bg", "[2/4] linking")

			if holders := p.worktreeHolders("tailrule"); !holdersInclude(holders, worktreeHeldByBackgroundJob, outputRuleShell) {
				t.Errorf("a shell writing in the checkout holds nothing: %v", holders)
			}
			bg.killEngineShells()
			if holders := p.worktreeHolders("tailrule"); len(holders) != 0 {
				t.Errorf("still held after the engine stopped: %v", holders)
			}
			stopWithin(t, bg)
		})
	}
}

// awaitLaterOutput gives a tail one polling interval and a margin to see what was written after its first read.
func awaitLaterOutput(t *testing.T, events *bgAllEvents, toolUseID, want string) {
	t.Helper()
	deadline := time.Now().Add(2*bgPollInterval + 5*time.Second)
	for time.Now().Before(deadline) {
		for _, ev := range events.ofKind(evBackgroundOutput) {
			if asString(ev["toolUseId"]) == toolUseID && strings.Contains(asString(ev["content"]), want) {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no background_output carrying %q for %s", want, toolUseID)
}
