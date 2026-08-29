package main

// What a real `claude` does with the setconfig control frames Orbit sends it.
//
// claude_setconfig_session_test.go drives the same frames through the whole session loop,
// but against fakeClaude — a fixture that answers the way the CLI was once observed to
// answer. That pins the runner's half of the feature (apply in place, degrade to a
// re-spawn, settle the turn either way) and nothing at all about the engine, and
// fake_claude_contract_test.go only holds the fixture to its own script, which is a
// statement about the fixture. So the day the CLI renames a subtype, changes the shape of
// a control response, or reworks the refusal it hands back, every one of those tests stays
// green while the feature is dead in production — and the runner updates its engines on
// its own schedule, so nothing else would notice either.
//
// This file therefore asks the installed CLI directly, and asserts only on what it said.
// Everything in between is the production path rather than a re-implementation of it: the
// frames come from setConfigFrames, go out through claudeRuntime's writer as
// controlRequestFrame builds them, and the answers come back through parseControlResponse
// into resolveControl exactly as session.go's stdout reader routes them.
//
// Two things make it cheap enough to keep in the default suite:
//
//   - None of these frames starts a turn. `set_model` and `set_permission_mode` are
//     answered by the CLI itself, so no request reaches the API and no tokens are spent.
//   - The control channel is serviced before authentication matters. A config dir with no
//     credentials in it answers all of these (verified against 2.1.241 on an empty HOME),
//     which is why nothing here borrows the machine's login and why "signed out" is not a
//     skip condition — a skip for it would be dead code hiding a real regression. If a
//     future CLI does gate control behind a login, these fail loudly with its own stderr.
//
// The one reason to skip is a CLI that is not installed, and the skip says so out loud.

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	// realClaudeContractTimeout bounds the wait for one control answer, and for the frame
	// that follows it. Production gives the same request claudeSetConfigTimeout (30s);
	// this is deliberately looser, because a cold CLI on a loaded machine taking longer is
	// not the contract breaking, and a test that reds for it teaches people to re-run it.
	// Every probe logs what the answer actually took, so drift toward the production
	// deadline is visible without being a flake.
	realClaudeContractTimeout = 90 * time.Second

	// The two model ids the set_model probes move between: the process is spawned on one
	// and asked for the other, because a set_model naming the model already loaded is
	// accepted without the echo this pins (2.1.241). Haiku is the spawn model so that a
	// probe that somehow did run a turn would be the cheapest one available.
	realClaudeSpawnModel  = "claude-haiku-4-5-20251001"
	realClaudeTargetModel = "claude-sonnet-5"
)

// A permission mode Orbit sets on a live session. Two things have to be true, and only the
// first of them is what the control channel returns: the CLI accepts the request, and the
// mode is actually in force afterwards — which it reports by volunteering a status frame
// naming it. A success not followed by one would be a change that was acknowledged and not
// made.
func TestRealClaudeAcceptsASetPermissionMode(t *testing.T) {
	agent := realClaudeContractAgent()
	p := startRealClaudeProbe(t, agent)

	frames, refused := p.setConfig(`{"permissionMode":"plan"}`, agent)
	if refused != nil {
		t.Fatalf("%s refused a permission mode Orbit sets in production: %v%s", p.exe, refused, p.engineOutput())
	}
	if len(frames) != 1 || frames[0].subtype != ctrlSetPermissionMode {
		t.Fatalf("the payload resolved to %d frame(s), want exactly one %s", len(frames), ctrlSetPermissionMode)
	}
	status := p.awaitFrame(`a system/status frame naming the new permissionMode`, func(m map[string]interface{}) bool {
		return m["type"] == "system" && m["subtype"] == "status"
	})
	if got := status["permissionMode"]; got != "plan" {
		t.Errorf("%s reports permissionMode %v after accepting the change, want %q: %v", p.exe, got, "plan", status)
	}
}

// The refusal the whole fallback is built on.
//
// A mode the installed CLI does not know is not a hypothetical: Orbit's list of modes and
// the engine's are two independently released things, so the first session to be handed a
// mode this CLI has not learned yet gets exactly this answer — and the runner's response
// to it is to throw the process away and re-spawn. Both halves are asserted, because a
// refusal whose text goes missing degrades the same way while telling the user nothing.
func TestRealClaudeRefusesAnUnknownPermissionMode(t *testing.T) {
	agent := realClaudeContractAgent()
	p := startRealClaudeProbe(t, agent)

	_, refused := p.setConfig(`{"permissionMode":"orbitOnlyMode"}`, agent)
	if refused == nil {
		t.Fatalf("%s accepted %q as a permission mode; the refusal the re-spawn fallback triggers on no longer happens%s",
			p.exe, "orbitOnlyMode", p.engineOutput())
	}
	// The engine's own sentence, not merely the fact of a refusal. The runner has nothing
	// else to tell a person why their setting is costing them a restart.
	const rule = "Cannot set permission mode: must be one of"
	if !strings.Contains(refused.Error(), rule) {
		t.Errorf("%s refused with %q, want it to carry %q", p.exe, refused, rule)
	}
	for _, mode := range []string{"acceptEdits", "default", "plan"} {
		if !strings.Contains(refused.Error(), mode) {
			t.Errorf("the refusal does not name %q among the modes it accepts: %q", mode, refused)
		}
	}
	// And what the transcript shows carries it through. This notice is the runner's entire
	// account of the degradation (session.go emits it as `setconfig-degraded`), so this is
	// the assertion that fails if the engine's words stop reaching the person waiting on
	// the change.
	notice := setConfigDegradedNotice(refused)
	if !strings.Contains(notice, rule) {
		t.Errorf("the transcript notice drops the engine's reason: %q", notice)
	}
	if !strings.Contains(notice, `permission mode "orbitOnlyMode"`) {
		t.Errorf("the transcript notice does not say what was being changed: %q", notice)
	}
}

// A model switch on a live session, which the CLI both answers and writes into the
// conversation.
//
// That second frame is the only record a transcript gets of a model change, and its shape
// is not the one Orbit's own user frames have: `content` is a bare string where userFrame
// always sends an array of content blocks. Anything reading user frames back has to keep
// coping with both, so the string-ness is asserted rather than assumed.
func TestRealClaudeAcceptsASetModel(t *testing.T) {
	agent := realClaudeContractAgent()
	p := startRealClaudeProbe(t, agent)

	frames, refused := p.setConfig(`{"model":"`+realClaudeTargetModel+`"}`, agent)
	if refused != nil {
		t.Fatalf("%s refused a model switch to %s: %v%s", p.exe, realClaudeTargetModel, refused, p.engineOutput())
	}
	if len(frames) != 1 || frames[0].subtype != ctrlSetModel {
		t.Fatalf("the payload resolved to %d frame(s), want exactly one %s", len(frames), ctrlSetModel)
	}
	echo := p.awaitFrame("a user frame echoing the model switch", func(m map[string]interface{}) bool {
		if m["type"] != frameUser {
			return false
		}
		msg, _ := m["message"].(map[string]interface{})
		return msg != nil && strings.Contains(fmt.Sprint(msg["content"]), "Set model to")
	})
	msg, _ := echo["message"].(map[string]interface{})
	content, isString := msg["content"].(string)
	if !isString {
		t.Fatalf("the model-switch echo carries content of type %T, want a bare string: %v", msg["content"], echo)
	}
	plain := "<local-command-stdout>Set model to " + realClaudeTargetModel + "</local-command-stdout>"
	inlineCode := "<local-command-stdout>Set model to `" + realClaudeTargetModel + "`</local-command-stdout>"
	if content != plain && content != inlineCode {
		t.Errorf("the model-switch echo says\n\t%q\nwant exactly one of\n\t%q\n\t%q", content, plain, inlineCode)
	}
}

// system_prompt is set_model's optional second argument, and Orbit never uses it.
//
// controlRequestFrame leaves an unused optional field out of the frame entirely rather
// than sending it empty, on the reasoning that an omitted key and a null one are different
// statements. Against the real CLI the difference is sharper than that: the key
// present-but-empty is refused outright, so a frame builder that "helpfully" filled it in
// would turn every model switch in production into a re-spawn. Both sides are checked
// here, because the omission only means anything if the engine is the one enforcing it.
func TestRealClaudeTakesASetModelWithNoSystemPrompt(t *testing.T) {
	agent := realClaudeContractAgent()
	p := startRealClaudeProbe(t, agent)

	frames, refused := p.setConfig(`{"model":"`+realClaudeTargetModel+`"}`, agent)
	if refused != nil {
		t.Fatalf("%s refused the set_model Orbit sends: %v%s", p.exe, refused, p.engineOutput())
	}
	// The bytes that just went down this pipe: absent, not empty and not null.
	if frame := controlRequestFrame("req-probe", frames[0].subtype, frames[0].payload); strings.Contains(frame, "system_prompt") {
		t.Fatalf("the frame Orbit sent carries a system_prompt nobody set: %s", frame)
	}
	err := p.request(ctrlSetModel, map[string]interface{}{"model": realClaudeSpawnModel, "system_prompt": ""})
	if err == nil {
		t.Fatalf("%s accepted an empty system_prompt; omitting the key and sending it empty are no longer different requests%s",
			p.exe, p.engineOutput())
	}
	if !strings.Contains(err.Error(), "system_prompt") {
		t.Errorf("%s refused the empty system_prompt with %q, want it to name the field", p.exe, err)
	}
}

// The probe builds its own argv instead of calling claudeCommandArgs, and this is what
// keeps that from drifting into testing a protocol nobody speaks.
//
// A real session's argv names an --mcp-config whose `orbit` server is this executable,
// which under `go test` is the test binary — claude would start the suite again as an MCP
// server. None of that is reachable from a control frame, so the probe leaves it out. What
// it may not leave out are the flags that decide the dialect, and every one of those has
// to still be a flag a session is really spawned with.
//
// Runs with or without a CLI installed: it reads argv, not an engine.
func TestRealClaudeProbeSpawnsWithProductionsTransportFlags(t *testing.T) {
	t.Setenv("ORBIT_HOME", t.TempDir())
	// Both shapes of agent: with an effort and without, because the flag that carries it is
	// conditional on both sides and a probe measuring effort has to spawn the way a session
	// with one really does.
	for _, effort := range []string{"", "low"} {
		agent := realClaudeContractAgent()
		agent.Effort = effort
		job := &ClaimedSession{
			SessionID:   "real-claude-setconfig-contract",
			SessionUUID: "11111111-2222-3333-4444-555555555555",
			Agent:       agent,
		}
		production := claudeCommandArgs(job, t.TempDir(), true)
		probe := realClaudeTransportArgs(job)
		if effort != "" && !containsArgs(probe, []string{"--effort", effort}) {
			t.Errorf("the probe drops --effort for an agent that has one: %v", probe)
		}
		for i := 0; i < len(probe); {
			group := probe[i : i+1]
			if strings.HasPrefix(probe[i], "-") && i+1 < len(probe) && !strings.HasPrefix(probe[i+1], "-") {
				group = probe[i : i+2]
			}
			if !containsArgs(production, group) {
				t.Errorf("the probe spawns with %v, which a real session no longer passes: %v", group, production)
			}
			i += len(group)
		}
	}
}

// realClaudeContractAgent is the agent config the probes spawn on: enough to name a model
// and a starting permission mode, and nothing that would give the process work to do.
func realClaudeContractAgent() AgentExecConfig {
	return AgentExecConfig{
		Provider:       providerClaude,
		Model:          realClaudeSpawnModel,
		PermissionMode: "default",
	}
}

// realClaudeTransportArgs is claudeCommandArgs' transport half — the flags that decide
// what dialect the process speaks and which conversation it is — without the MCP config,
// the agent instructions or the extra working dirs, none of which a control frame reaches.
// TestRealClaudeProbeSpawnsWithProductionsTransportFlags holds it to the real thing.
//
// --effort is here on the same terms production passes it: only when the agent has one, so
// an empty effort means the flag is absent and the model decides. The request-body probe
// depends on that being the real spelling, since what it measures is a frame changing what
// this flag set.
func realClaudeTransportArgs(job *ClaimedSession) []string {
	args := []string{
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--include-partial-messages",
		"--replay-user-messages",
		"--verbose",
		"--model", job.Agent.Model,
		"--permission-mode", job.Agent.PermissionMode,
		"--session-id", job.SessionUUID,
	}
	if job.Agent.Effort != "" {
		args = append(args, "--effort", job.Agent.Effort)
	}
	return args
}

// realClaudeProbe is one live `claude`, driven through the production control path.
type realClaudeProbe struct {
	t   *testing.T
	exe string
	rt  *claudeRuntime

	// frames holds the stdout lines that are NOT control_responses; the responses go where
	// production sends them, into rt.resolveControl. Nothing reads this until an assertion
	// asks for a frame, so it is buffered well past anything a turn-less process emits — a
	// full channel would stall the same goroutine that delivers the control answers.
	frames chan map[string]interface{}
	// seen is every frame already taken off the channel. Kept because the CLI chooses its
	// own order: a set_model's user echo lands before that request's answer, a
	// set_permission_mode's status frame after it.
	seen []map[string]interface{}

	mu     sync.Mutex
	stderr strings.Builder
}

// startRealClaudeProbe spawns one CLI for this test, or skips the test with the reason it
// could not.
func startRealClaudeProbe(t *testing.T, agent AgentExecConfig) *realClaudeProbe {
	t.Helper()
	exe := requireRealClaude(t)

	// Nothing a probe does may touch this machine's own Claude Code state. Both dirs are
	// redirected: CLAUDE_CONFIG_DIR is where the CLI keeps credentials, settings and the
	// session files it writes, and HOME is where it looks when that is unset. They are left
	// EMPTY rather than seeded from the real ones — no credential is borrowed because none
	// is needed — so a probe can neither read the user's login nor leave a session in their
	// history, and both dirs go away with the test.
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())

	ctx, cancel := context.WithCancel(context.Background())
	job := &ClaimedSession{
		SessionID:   "real-claude-setconfig-contract",
		SessionUUID: newContractSessionUUID(t),
		Provider:    providerClaude,
		Agent:       agent,
	}
	proc, err := spawnClaude(ctx, job, t.TempDir(), realClaudeTransportArgs(job))
	if err != nil {
		cancel()
		t.Fatalf("spawning %s: %v", exe, err)
	}
	p := &realClaudeProbe{
		t:      t,
		exe:    exe,
		rt:     newClaudeRuntime(proc),
		frames: make(chan map[string]interface{}, 256),
	}
	go p.readStdout(proc.stdout)
	go p.readStderr(proc.stderr)
	t.Cleanup(func() { p.stop(cancel) })
	return p
}

// requireRealClaude resolves the binary a session would really be spawned with, or skips.
//
// Skipping is the only thing that works on a machine with no engine installed, but a
// silent skip is a green run that verified nothing — so the reason names what was looked
// for and everywhere it was looked for, and a run that does find one logs the version it
// is holding to this contract.
func requireRealClaude(t *testing.T) string {
	t.Helper()
	// Off the PATH the runner *service* runs with rather than the shell's: the official
	// installer drops claude in ~/.local/bin, which a bare `go test` environment need not
	// have (service.go). Read before HOME is redirected — those dirs hang off the real one.
	home := userHome()
	enginePath := runnerEnginePath(home, os.Getenv("PATH"))
	exe, ok := lookPathIn(providerClaude, enginePath)
	if !ok {
		t.Skipf("no %q binary in %v or anywhere on PATH, so the setconfig control frames are NOT verified against a real engine on this machine (searched %s)",
			providerClaude, engineInstallerDirs(home), enginePath)
	}
	// spawnClaude resolves "claude" off the process PATH, so hand it the one that found this.
	t.Setenv("PATH", enginePath)
	t.Logf("driving %s (%s)", exe, engineVersion(exe))
	return exe
}

// setConfig runs one control-plane setconfig payload through the same steps session.go
// runs it through: the frames it resolves to, each sent as a control_request, each waited
// on for the CLI's own answer, and the first refusal wrapped the way the degraded path
// wraps it. The wrapping is not decoration — it is what puts the engine's words in front
// of a person, so the test has to assert on the same string production builds.
func (p *realClaudeProbe) setConfig(content string, agent AgentExecConfig) ([]setConfigFrame, error) {
	p.t.Helper()
	frames, err := setConfigFrames(content, agent)
	if err != nil {
		p.t.Fatalf("setConfigFrames(%s): %v", content, err)
	}
	if len(frames) == 0 {
		p.t.Fatalf("setConfigFrames(%s) asks the engine for nothing, so this probe would be asserting on silence", content)
	}
	var refused error
	for _, f := range frames {
		if err := p.request(f.subtype, f.payload); err != nil {
			refused = fmt.Errorf("%s: %w", f.what, err)
			break
		}
	}
	return frames, refused
}

// request sends one control_request and returns the CLI's answer: nil for a success, and
// for a refusal the engine's own message, carried out by resolveControl.
func (p *realClaudeProbe) request(subtype string, payload map[string]interface{}) error {
	p.t.Helper()
	started := time.Now()
	w, err := p.rt.requestControlWith(subtype, payload)
	if err != nil {
		return err
	}
	err = p.rt.awaitControl(context.Background(), w, realClaudeContractTimeout)
	p.t.Logf("%s answered %s in %s: %v", p.exe, subtype, time.Since(started).Round(time.Millisecond), err)
	return err
}

// awaitFrame returns the first frame the CLI emitted — already arrived, or still to come —
// that matches, and fails with everything it did emit when none does.
func (p *realClaudeProbe) awaitFrame(what string, match func(map[string]interface{}) bool) map[string]interface{} {
	p.t.Helper()
	for _, m := range p.seen {
		if match(m) {
			return m
		}
	}
	deadline := time.After(realClaudeContractTimeout)
	for {
		select {
		case m, ok := <-p.frames:
			if !ok {
				p.t.Fatalf("%s stopped before emitting %s; it emitted %s%s", p.exe, what, p.frameTypes(), p.engineOutput())
			}
			p.seen = append(p.seen, m)
			if match(m) {
				return m
			}
		case <-deadline:
			p.t.Fatalf("%s emitted no %s within %s; it emitted %s%s", p.exe, what, realClaudeContractTimeout, p.frameTypes(), p.engineOutput())
			return nil
		}
	}
}

// readStdout is session.go's reader loop narrowed to what a contract probe needs: a
// control_response is routed to the request waiting for it exactly as production routes
// it, and everything else is parked for the assertions.
func (p *realClaudeProbe) readStdout(stdout io.Reader) {
	defer close(p.frames)
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 1024*1024), 16*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var msg map[string]interface{}
		if json.Unmarshal([]byte(line), &msg) != nil {
			continue
		}
		if resp, ok := parseControlResponse(msg); ok {
			p.rt.resolveControl(resp)
			continue
		}
		p.frames <- msg
	}
	// Past EOF nothing can be answered any more. Production says the same thing at the same
	// point; without it a probe whose CLI died would sit out the full deadline for a reply
	// that is not coming.
	p.rt.failPendingControl(errRuntimeGone)
}

// readStderr keeps the pipe drained — a CLI blocked on a stderr nobody is reading answers
// nothing — and keeps what it said for the failure messages.
func (p *realClaudeProbe) readStderr(stderr io.Reader) {
	sc := bufio.NewScanner(stderr)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		p.mu.Lock()
		p.stderr.WriteString(sc.Text())
		p.stderr.WriteString("\n")
		p.mu.Unlock()
	}
}

// engineOutput is what the CLI said for itself, printed only when an assertion fails: a
// refusal it explains on stderr and nowhere else is the difference between a readable
// failure and "want success, got error".
func (p *realClaudeProbe) engineOutput() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stderr.Len() == 0 {
		return ""
	}
	return "\n" + p.exe + " stderr:\n" + p.stderr.String()
}

// frameTypes names the frames that did arrive, so a probe waiting for one that never comes
// says what it got instead.
func (p *realClaudeProbe) frameTypes() string {
	if len(p.seen) == 0 {
		return "nothing"
	}
	out := make([]string, 0, len(p.seen))
	for _, m := range p.seen {
		kind, _ := m["type"].(string)
		if sub, ok := m["subtype"].(string); ok {
			kind += "/" + sub
		}
		out = append(out, kind)
	}
	return strings.Join(out, ", ")
}

// stop reclaims exactly the process this probe started.
//
// rt.wait() closes its stdin, which is what a `claude -p` exits on, and reaps that pid's
// tree; cancel() is the backstop for one that does not take the hint, and reaches the
// process group this spawn was made the leader of and nothing else. Nothing here matches
// on a name: this machine runs other real claude sessions, and a pattern kill would take
// them with it.
func (p *realClaudeProbe) stop(cancel context.CancelFunc) {
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- p.rt.wait() }()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		cancel()
		<-done
	}
}

// newContractSessionUUID mints a session id per probe. `claude` keys its own transcript
// file by it, so probes sharing one would resume each other's conversation.
func newContractSessionUUID(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("minting a session uuid: %v", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}
