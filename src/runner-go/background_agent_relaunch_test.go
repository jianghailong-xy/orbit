package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The sequence session ac5fYOgID3kywMbjnz8xX went through (Claude Code 2.1.325), with its own ids:
// a background Agent launch, its async ack naming the agentId, a Claude restart that reports the
// agent "stopped" with no <tool-use-id>, a SendMessage that revives it, and the revived agent's
// "completed" notification carrying the SendMessage call's id instead of the launch's.
const (
	relaunchAgentID  = "ac99e9cc2f9865c6f"
	relaunchLaunchID = "toolu_01E3219KcZphXTzWY9hPoVmr"
	relaunchSendID   = "toolu_018uxDocXvBrR8Veipg6A15o"
	relaunchAck      = "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\n" +
		"agentId: ac99e9cc2f9865c6f (internal ID - do not mention to user. Use SendMessage with to: 'ac99e9cc2f9865c6f', summary: '<5-10 word recap>' to continue this agent.)\n" +
		"The agent is working in the background. You will be notified automatically when it completes."
	relaunchStopped = "<task-notification>\n<task-id>ac99e9cc2f9865c6f</task-id>\n" +
		"<output-file>/tmp/claude-0/x/51334f92/tasks/ac99e9cc2f9865c6f.output</output-file>\n<status>stopped</status>\n" +
		"<summary>Background agent \"Probe\" didn't finish before the previous session ended</summary>\n</task-notification>"
	relaunchCompleted = "<task-notification>\n<task-id>ac99e9cc2f9865c6f</task-id>\n" +
		"<tool-use-id>toolu_018uxDocXvBrR8Veipg6A15o</tool-use-id>\n" +
		"<output-file>/tmp/claude-0/x/51334f92/tasks/ac99e9cc2f9865c6f.output</output-file>\n<status>completed</status>\n" +
		"<summary>Agent \"Probe\" finished</summary>\n</task-notification>"
)

func relaunchMessages() []map[string]interface{} {
	text := func(s string) []interface{} { return []interface{}{map[string]interface{}{"type": "text", "text": s}} }
	toolUse := func(id, name string, input map[string]interface{}) map[string]interface{} {
		return map[string]interface{}{"type": "assistant", "message": map[string]interface{}{"role": "assistant",
			"content": []interface{}{map[string]interface{}{"type": "tool_use", "id": id, "name": name, "input": input}}}}
	}
	toolResult := func(id, content string) map[string]interface{} {
		return map[string]interface{}{"type": "user", "message": map[string]interface{}{"role": "user",
			"content": []interface{}{map[string]interface{}{"type": "tool_result", "tool_use_id": id, "content": text(content)}}}}
	}
	notification := func(s string) map[string]interface{} {
		return map[string]interface{}{"type": "user", "message": map[string]interface{}{"role": "user", "content": s}}
	}
	return []map[string]interface{}{
		toolUse(relaunchLaunchID, "Agent", map[string]interface{}{"description": "Probe", "run_in_background": true}),
		toolResult(relaunchLaunchID, relaunchAck),
		notification(relaunchStopped),
		toolUse(relaunchSendID, "SendMessage", map[string]interface{}{"to": relaunchAgentID, "message": "Resume"}),
		toolResult(relaunchSendID, `{"success":true,"message":"Resuming agent ac99e9c","resumedAgentId":"ac99e9cc2f9865c6f"}`),
		notification(relaunchCompleted),
	}
}

// Through the stdout stream: every terminal background_task names the Agent launch, which is the id
// the control plane holds in runningSubagents, so the launch is cleared.
func TestRelaunchedAgentNotificationsNameTheLaunchStdout(t *testing.T) {
	emit, got := bgCollector()
	bg := newBgTailer(context.Background(), emit, nil)
	defer bg.stopAll()
	for _, msg := range relaunchMessages() {
		handleMessage(msg, emit, bg)
	}
	want := []string{relaunchLaunchID + "|stopped", relaunchLaunchID + "|completed"}
	if len(*got) != len(want) || (*got)[0] != want[0] || (*got)[1] != want[1] {
		t.Fatalf("background_task events = %v, want %v", *got, want)
	}
}

// Through the transcript alone, as a restarted runner's first pass reads it: the map is rebuilt from
// the ack line, so a session already stuck heals. A copy of the same notifications arriving on stdout
// too must not produce a second event for either.
func TestRelaunchedAgentNotificationsNameTheLaunchTranscript(t *testing.T) {
	emit, got := bgCollector()
	bg := newBgTailer(context.Background(), emit, nil)
	defer bg.stopAll()
	var content []byte
	for _, msg := range relaunchMessages() {
		msg["isSidechain"] = false
		line, err := json.Marshal(msg)
		if err != nil {
			t.Fatal(err)
		}
		content = append(append(content, line...), '\n')
	}
	path := filepath.Join(t.TempDir(), "s.jsonl")
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}
	bg.scanTranscript(path, 0)
	want := []string{relaunchLaunchID + "|stopped", relaunchLaunchID + "|completed"}
	if len(*got) != len(want) || (*got)[0] != want[0] || (*got)[1] != want[1] {
		t.Fatalf("background_task events = %v, want %v", *got, want)
	}
	bgTaskFromNotification(relaunchStopped, emit, bg)
	bgTaskFromNotification(relaunchCompleted, emit, bg)
	if len(*got) != len(want) {
		t.Fatalf("a stdout copy re-emitted: %v", *got)
	}
}

// A sub-agent's own nested ack (a launch inside the sub-agent) is not a launch the parent holds.
func TestNestedAgentAckIsNotRecorded(t *testing.T) {
	emit, got := bgCollector()
	bg := newBgTailer(context.Background(), emit, nil)
	defer bg.stopAll()
	handleMessage(map[string]interface{}{"type": "user", "parent_tool_use_id": "toolu_parent",
		"message": map[string]interface{}{"role": "user", "content": []interface{}{map[string]interface{}{
			"type": "tool_result", "tool_use_id": "toolu_nested", "content": relaunchAck}}}}, emit, bg)
	bgTaskFromNotification(relaunchStopped, emit, bg)
	if len(*got) != 1 || (*got)[0] != "|stopped" {
		t.Fatalf("background_task events = %v, want the notification's own (empty) id", *got)
	}
}
