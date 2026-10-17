package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func workflowFixture(t *testing.T) (configDir, dir, receipt string) {
	t.Helper()
	configDir = t.TempDir()
	dir = filepath.Join(configDir, "projects", "project", "session", "subagents", "workflows", "wf_test")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeWorkflowFile(t, filepath.Join(configDir, "projects", "project", "session.jsonl"), "")
	return configDir, dir, "Workflow launched in background. Task ID: w1\nTranscript dir: " + dir
}

func writeWorkflowFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestWorkflowTranscriptRelaysActualCallsAndJournalResult(t *testing.T) {
	_, dir, _ := workflowFixture(t)
	emit, got := collect()
	bg := newBgTailer(context.Background(), emit, nil)
	defer bg.stopAll()
	w := bg.workflowTranscript("toolu_wf")
	w.dir = dir
	journal := `{"type":"started","agentId":"a1","label":"reader","phase":"Understand"}` + "\n"
	writeWorkflowFile(t, filepath.Join(dir, "journal.jsonl"), journal)
	transcript := `{"type":"user","message":{"content":"private harness prompt"}}` + "\n" +
		`{"type":"attachment","rendered":"runtime metadata"}` + "\n" +
		`{"type":"assistant","message":{"content":[{"type":"text","text":"Inspecting the server."},{"type":"tool_use","id":"call1","name":"Bash","input":{"command":"ls src"}}]}}` + "\n"
	path := filepath.Join(dir, "agent-a1.jsonl")
	writeWorkflowFile(t, path, transcript)
	w.scan()
	key := "toolu_wf:workflow-agent:a1"
	if len(*got) != 3 || (*got)[0].typ != evToolUse || (*got)[0].payload["id"] != key ||
		(*got)[0].payload["parentToolUseId"] != "toolu_wf" || (*got)[1].payload["parentToolUseId"] != key ||
		(*got)[2].payload["parentToolUseId"] != key || (*got)[2].payload["id"] != "call1" {
		t.Fatalf("missing nested launch, text or actual call: %#v", *got)
	}
	transcript += `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call1","content":"apiserver\nweb"}]}}` + "\n"
	writeWorkflowFile(t, path, transcript)
	writeWorkflowFile(t, filepath.Join(dir, "journal.jsonl"), journal+`{"type":"result","agentId":"a1","result":{"summary":"Found both clients"}}`+"\n")
	w.scan()
	w.scan()
	if len(*got) != 5 || (*got)[3].payload["toolUseId"] != "call1" || (*got)[3].payload["content"] != "apiserver\nweb" ||
		(*got)[4].payload["toolUseId"] != key || (*got)[4].payload["content"] != `{"summary":"Found both clients"}` {
		t.Fatalf("lost/repeated result: %#v", *got)
	}
	// The journal and message log have separate writers. A result must not stop us from
	// collecting a final message that flushes to disk after its journal entry.
	transcript += `{"type":"assistant","message":{"content":[{"type":"text","text":"Final details."}]}}` + "\n"
	writeWorkflowFile(t, path, transcript)
	bg.finishWorkflowTranscript("toolu_wf", "completed")
	if len(*got) != 6 || (*got)[5].payload["text"] != "Final details." {
		t.Fatalf("completion lost a buffered message or duplicated the result: %#v", *got)
	}
}

func TestWorkflowProgressLinksByAgentIDAndRetainsLinkAtCompletion(t *testing.T) {
	emit, got := collect()
	bg := newBgTailer(context.Background(), emit, nil)
	defer bg.stopAll()
	frame := workflowProgressFrame()
	entries := frame["workflow_progress"].([]interface{})
	entries[2].(map[string]interface{})["agentId"] = "agent-one"
	entries[3].(map[string]interface{})["agentId"] = "agent-two"
	// Identical display labels must still address two different transcripts.
	entries[3].(map[string]interface{})["label"] = entries[2].(map[string]interface{})["label"]
	handleMessage(frame, emit, bg)
	p := (*got)[len(*got)-1].payload
	rows := p["agents"].([]interface{})
	for i, id := range []string{"agent-one", "agent-two"} {
		if rows[i].(map[string]interface{})["transcriptKey"] != "toolu_wf:workflow-agent:"+id {
			t.Fatalf("missing stable transcript identity: %v", rows)
		}
	}
	handleMessage(frame, emit, bg)
	if len(*got) != 4 {
		t.Fatalf("progress repeated synthetic launches: %v", *got)
	}
	bgTaskFromNotification(taskNotif("wf", "toolu_wf", "failed"), emit, bg)
	final := (*got)[len(*got)-1]
	if final.typ != evBackgroundTask || final.payload["progress"] == nil {
		t.Fatalf("missing durable progress: %v", final)
	}
	for _, e := range (*got)[4:6] {
		if e.typ != evToolResult || e.payload["isError"] != true {
			t.Fatalf("failed workflow left agent running: %v", e)
		}
	}
}

func TestWorkflowReceiptStaysWithinCurrentSession(t *testing.T) {
	configDir, dir, receipt := workflowFixture(t)
	if got := workflowReceiptDir(receipt, "session", configDir); got != dir {
		t.Fatalf("valid receipt rejected: %q", got)
	}
	for _, text := range []string{
		"Quoted: " + receipt,
		strings.ReplaceAll(receipt, dir, t.TempDir()),
		strings.ReplaceAll(receipt, dir, filepath.Dir(dir)+"/wf_other/../wf_test"),
	} {
		if got := workflowReceiptDir(text, "session", configDir); got != "" {
			t.Fatalf("accepted unrelated path %q", got)
		}
	}
	if got := workflowReceiptDir(receipt, "another-session", configDir); got != "" {
		t.Fatalf("accepted other session: %q", got)
	}
	outside := t.TempDir()
	link := filepath.Join(filepath.Dir(dir), "wf_link")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	if got := workflowReceiptDir(strings.ReplaceAll(receipt, dir, link), "session", configDir); got != "" {
		t.Fatalf("followed directory escape: %q", got)
	}
}

func TestWorkflowScanIsIncrementalBoundedAndCancellable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.jsonl")
	first := `{"value":1}` + "\n"
	partial := `{"value":2}`
	writeWorkflowFile(t, path, first+strings.Repeat("x", transcriptRelevantLineCap+10)+"\n"+partial)
	var values []int
	visit := func(row map[string]interface{}) { values = append(values, toInt(row["value"])) }
	offset := scanWorkflowJSONL(context.Background(), path, 0, visit)
	if len(values) != 1 {
		t.Fatalf("read partial or oversized record: %v", values)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.WriteString("\n")
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	offset = scanWorkflowJSONL(context.Background(), path, offset, visit)
	scanWorkflowJSONL(context.Background(), path, offset, visit)
	if len(values) != 2 || values[1] != 2 {
		t.Fatalf("incremental read lost/repeated records: %v", values)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if off := scanWorkflowJSONL(ctx, path, 0, visit); off != 0 || len(values) != 2 {
		t.Fatal("cancelled reader emitted")
	}
	link := filepath.Join(t.TempDir(), "agent-link.jsonl")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	scanWorkflowJSONL(context.Background(), link, 0, visit)
	if len(values) != 2 {
		t.Fatal("followed transcript symlink")
	}
}

func TestWorkflowWatcherStopsAndClosesAgents(t *testing.T) {
	configDir, dir, receipt := workflowFixture(t)
	writeWorkflowFile(t, filepath.Join(dir, "journal.jsonl"), `{"type":"started","agentId":"a1","label":"reader"}`+"\n")
	events := make(chan string, 10)
	bg := newBgTailer(context.Background(), func(kind string, _ map[string]interface{}) { events <- kind }, nil)
	bg.claudeSessionUUID, bg.claudeConfigDir = "session", configDir
	bg.onToolResult("toolu_wf", receipt)
	bg.onToolResult("toolu_wf", receipt)
	select {
	case kind := <-events:
		if kind != evToolUse {
			t.Fatalf("first event = %s", kind)
		}
	case <-time.After(time.Second):
		t.Fatal("watcher did not discover journal agent")
	}
	bg.stopAll()
	select {
	case kind := <-events:
		if kind != evToolResult {
			t.Fatalf("stop event = %s", kind)
		}
	default:
		t.Fatal("stopping left agent running")
	}
	bg.onToolResult("toolu_wf", receipt)
	if len(events) != 0 {
		t.Fatal("stopped watcher emitted again")
	}
}
