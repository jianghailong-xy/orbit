package main

import (
	"errors"
	"strings"
	"testing"
)

// Reasoning effort over the control channel: the bytes it turns into, and the one thing
// this frame cannot do that the other two can — answer for itself.
//
// apply_flag_settings replies `{"subtype":"success"}` to anything: an unknown settings key,
// a level that is not a level, an empty settings object, a CLI too old to have the feature.
// Nothing is echoed back and no init field reports the effort in force. So there is no
// assertion available here that says "the engine acted on it" — that claim is only
// checkable against the API requests the engine goes on to make, which is what
// claude_effort_requestbody_test.go does against a real CLI. What is checkable HERE is that
// Orbit sends the exact frame that was measured, and refuses to send it where it would be
// answered `success` and ignored.

// The wire shape, to the byte. Nothing reads this back, so the frame is the whole contract:
// a key that drifts (effort / effort_level / maxEffortLevel were each measured to be
// accepted and ignored) is a config change that is answered, logged as applied, and never
// made.
func TestEffortFrameBytes(t *testing.T) {
	running := AgentExecConfig{Model: "claude-opus-5", PermissionMode: "default", Effort: "low"}
	for _, tc := range []struct {
		name    string
		content string
		want    string
	}{
		{
			name:    "a level is passed through as the string it is",
			content: `{"effort":"xhigh"}`,
			want:    `{"request":{"settings":{"effortLevel":"xhigh"},"subtype":"apply_flag_settings"},"request_id":"req-3-1","type":"control_request"}` + "\n",
		},
		{
			// The one value with a shape of its own. Orbit's empty effort means "let the
			// model decide", which at spawn is expressed by leaving --effort off; on the
			// control channel it is null. An empty string would be a level the CLI does not
			// have, and an omitted key would leave the level alone — both answered `success`,
			// both silently wrong.
			name:    "cleared effort is null, not an empty string and not an absent key",
			content: `{"effort":""}`,
			want:    `{"request":{"settings":{"effortLevel":null},"subtype":"apply_flag_settings"},"request_id":"req-3-1","type":"control_request"}` + "\n",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			frames, err := setConfigFrames(tc.content, running)
			if err != nil {
				t.Fatalf("setConfigFrames(%s): %v", tc.content, err)
			}
			if len(frames) != 1 || frames[0].subtype != ctrlApplyFlagSettings {
				t.Fatalf("the payload resolved to %d frame(s) %v, want one %s", len(frames), subtypesOf(frames), ctrlApplyFlagSettings)
			}
			if got := controlRequestFrame("req-3-1", frames[0].subtype, frames[0].payload); got != tc.want {
				t.Errorf("frame =\n\t%q\nwant\n\t%q", got, tc.want)
			}
		})
	}
}

// Effort is the one field of the three whose committed value is NOT what the running
// process was built with: a session that never set one inherits its workspace's at claim
// time. So the control plane states it only when the PATCH moved it, and an unstated effort
// has to stay unstated all the way down — a runner that read "absent" as "" would answer a
// model change by clearing a workspace default nobody touched.
func TestSetConfigFramesLeaveAnUnstatedEffortAlone(t *testing.T) {
	running := AgentExecConfig{Model: "claude-opus-5", PermissionMode: "default", Effort: "high"}
	for _, content := range []string{
		`{"model":"claude-sonnet-5","permissionMode":"default"}`,
		// null reads the same as absent, and means the same thing: an older control plane
		// spelling "I am not talking about effort".
		`{"model":"claude-sonnet-5","permissionMode":"default","effort":null}`,
	} {
		frames, err := setConfigFrames(content, running)
		if err != nil {
			t.Fatalf("setConfigFrames(%s): %v", content, err)
		}
		if got := subtypesOf(frames); !equalStrings(got, []string{ctrlSetModel}) {
			t.Errorf("%s resolved to %v, want only a %s", content, got, ctrlSetModel)
		}
	}
	// And restating the effort this process is already running is not news either.
	frames, err := setConfigFrames(`{"effort":"high"}`, running)
	if err != nil {
		t.Fatalf("setConfigFrames: %v", err)
	}
	if len(frames) != 0 {
		t.Errorf("restating the running effort asked the engine for %v", subtypesOf(frames))
	}
}

// The value has to land on the claim as well as on the engine. The claim is what the NEXT
// process is built from — the degraded re-spawn below, a crash resume, a provider switch —
// so a runner that told the engine and not the claim would hand the effort back the moment
// anything rebuilt the process.
func TestEffortFrameCarriesTheValueOntoTheClaim(t *testing.T) {
	agent := AgentExecConfig{Model: "claude-opus-5", PermissionMode: "default", Effort: "low"}
	frames, err := setConfigFrames(`{"effort":"xhigh"}`, agent)
	if err != nil {
		t.Fatalf("setConfigFrames: %v", err)
	}
	for _, f := range frames {
		f.apply(&agent)
	}
	if agent.Effort != "xhigh" {
		t.Fatalf("the claim ended up on effort %q, want %q", agent.Effort, "xhigh")
	}
	// Clearing has to reach it too: "" is what makes the next spawn leave --effort off.
	cleared, err := setConfigFrames(`{"effort":""}`, agent)
	if err != nil {
		t.Fatalf("setConfigFrames: %v", err)
	}
	if len(cleared) != 1 {
		t.Fatalf("clearing the effort resolved to %d frame(s), want 1", len(cleared))
	}
	cleared[0].apply(&agent)
	if agent.Effort != "" {
		t.Fatalf("the claim ended up on effort %q after a clear, want it empty", agent.Effort)
	}
}

// The degradation, decided before a byte is sent.
//
// This is the whole reason claudeEffortFloor exists: the engine's answer cannot be used, so
// a CLI that would ignore the frame has to be recognised from what it announced about
// itself. Both directions are asserted — a gate that refused everything would satisfy the
// old-version half on its own, and one that allowed everything would satisfy the new-version
// half.
func TestEffortFrameIsWithheldFromAnEngineThatCannotApplyIt(t *testing.T) {
	frames, err := setConfigFrames(`{"effort":"xhigh"}`, AgentExecConfig{Effort: "low"})
	if err != nil || len(frames) != 1 {
		t.Fatalf("setConfigFrames = %v, %v; want one frame", subtypesOf(frames), err)
	}
	effort := frames[0]
	for _, version := range []string{claudeEffortFloor, "2.1.241", "2.2.0", "3.0.0", "2.1.235-rc.1"} {
		if err := effort.unsupportedBy(version); err != nil {
			t.Errorf("an effort change was withheld from %s: %v", version, err)
		}
	}
	for _, version := range []string{"2.1.234", "2.1.9", "2.0.999", "1.9.9"} {
		if err := effort.unsupportedBy(version); err == nil {
			t.Errorf("an effort change was sent to %s, which is older than the %s it was measured on", version, claudeEffortFloor)
		} else if !strings.Contains(err.Error(), version) || !strings.Contains(err.Error(), claudeEffortFloor) {
			t.Errorf("the refusal for %s says %q; a person has to be told which engine and against what", version, err)
		}
	}
	// A process that has not announced a version yet has said nothing, and nothing is not
	// consent: a frame sent on the hope that it lands is the silent failure this gate exists
	// to prevent. It degrades to the re-spawn, which applies the effort either way.
	unknown := effort.unsupportedBy("")
	if unknown == nil {
		t.Fatal("an effort change was sent to an engine that has not said what it is")
	}
	if !errors.Is(unknown, errEngineCannotApply) {
		t.Errorf("the withheld frame reports %v, which the session loop cannot tell from a refusal", unknown)
	}
	// It reads like a refusal all the way out to the transcript, because that is what it is
	// handled as — the person is told the engine is restarting, and why.
	if notice := setConfigDegradedNotice(unknown); !strings.Contains(notice, "Restarting the engine") {
		t.Errorf("the transcript notice for a withheld frame says %q", notice)
	}
	// The other two frames answer for themselves, so they are never version-gated: gating
	// them would turn every model switch on an unversioned process into a re-spawn.
	told, err := setConfigFrames(`{"model":"claude-sonnet-5","permissionMode":"plan"}`, AgentExecConfig{})
	if err != nil {
		t.Fatalf("setConfigFrames: %v", err)
	}
	for _, f := range told {
		if err := f.unsupportedBy(""); err != nil {
			t.Errorf("%s was withheld from an engine that has not announced a version: %v", f.subtype, err)
		}
	}
}

// Versions are compared as numbers, which is the only way 2.1.241 comes out newer than
// 2.1.9. A string compare gets that backwards, and getting it backwards means silently
// withholding the frame from every engine in the fleet.
func TestClaudeVersionAtLeast(t *testing.T) {
	for _, tc := range []struct {
		version, floor string
		want           bool
	}{
		{"2.1.241", "2.1.235", true},
		{"2.1.235", "2.1.235", true},
		{"2.1.234", "2.1.235", false},
		{"2.1.9", "2.1.235", false},
		{"2.2.0", "2.1.235", true},
		{"3.0.0", "2.1.235", true},
		{"2.0.999", "2.1.235", false},
		{"2.1.235-rc.1", "2.1.235", true},
		{"2.1", "2.1.235", false},
		{"2.2", "2.1.235", true},
		// Unreadable is not "at least" anything: the caller degrades, which is the safe
		// direction for a frame whose effect cannot be checked.
		{"", "2.1.235", false},
		{"unknown", "2.1.235", false},
	} {
		if got := claudeVersionAtLeast(tc.version, tc.floor); got != tc.want {
			t.Errorf("claudeVersionAtLeast(%q, %q) = %v, want %v", tc.version, tc.floor, got, tc.want)
		}
	}
}

// The runtime learns the version from the process itself, and forgets it with the process.
//
// Both halves matter. A version read off `claude --version` on PATH would answer for the
// binary the NEXT spawn uses — engines self-update underneath live sessions — and a version
// that outlived its runtime would let a new, older process inherit the last one's claim.
func TestRuntimeRemembersTheVersionItsProcessAnnounced(t *testing.T) {
	rt := newPipeRuntime(t)
	if got := rt.announcedVersion(); got != "" {
		t.Fatalf("a process that has said nothing announces %q", got)
	}
	rt.noteAnnouncedVersion("2.1.241")
	if got := rt.announcedVersion(); got != "2.1.241" {
		t.Fatalf("announcedVersion = %q after an init handshake, want %q", got, "2.1.241")
	}
	// An init frame with no version in it says nothing, and must not erase what was said.
	rt.noteAnnouncedVersion("")
	if got := rt.announcedVersion(); got != "2.1.241" {
		t.Fatalf("a versionless init handshake left announcedVersion at %q", got)
	}
	if got := newPipeRuntime(t).announcedVersion(); got != "" {
		t.Fatalf("a second process inherited the version %q from the first", got)
	}
}

// subtypesOf names the frames a payload resolved to, for the failure messages.
func subtypesOf(frames []setConfigFrame) []string {
	var out []string
	for _, f := range frames {
		out = append(out, f.subtype)
	}
	return out
}
