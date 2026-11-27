package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"strings"
	"sync"
)

// kimiInstructionsOpen is how the block kimiPromptText writes ahead of a prompt begins.
const kimiInstructionsOpen = "<orbit-agent-instructions>\n"

// kimiInstructionLedger says whether a Kimi conversation still holds Orbit's instructions, so that the next prompt
// carries them only when it does not (kimiProfile.Carrier, carrierFirstPrompt): on the conversation's first prompt,
// and again after a context reset. It reads the main agent's wire, which Kimi keeps for the whole conversation and
// resumes from: a turn.prompt whose input carries the instructions block puts them in the history, and a compaction
// Kimi applies (context.apply_compaction) replaces the history with a summary that does not hold them. A resumed
// conversation is read from its wire's start, so it is judged by its own history; a wire that cannot be read, or one a
// Kimi without these records writes, never reads as holding them, and every prompt carries them as before.
type kimiInstructionLedger struct {
	mu   sync.Mutex
	home string
	id   string
	wire string
	off  int64
	held bool
}

func newKimiInstructionLedger(home, id string) *kimiInstructionLedger {
	return &kimiInstructionLedger{home: home, id: id}
}

// due reports whether the next prompt has to carry the instructions. A nil ledger always says yes.
func (l *kimiInstructionLedger) due() bool {
	if l == nil || kimiProfile.Carrier == carrierEveryPrompt {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.wire == "" {
		// A new conversation's wire appears with its first prompt.
		if l.wire, _ = kimiTurnWire(l.home, l.id); l.wire == "" {
			return true
		}
	}
	f, err := os.Open(l.wire)
	if err != nil {
		return true
	}
	defer f.Close()
	if info, err := f.Stat(); err != nil || info.Size() < l.off {
		// A wire shorter than what was read is not the one that was read: read it again from its start.
		l.off, l.held = 0, false
	}
	data, err := io.ReadAll(io.NewSectionReader(f, l.off, 1<<62))
	if err != nil {
		return !l.held
	}
	// A line still being written is read once it is whole.
	end := bytes.LastIndexByte(data, '\n')
	if end < 0 {
		return !l.held
	}
	l.off += int64(end + 1)
	for _, line := range bytes.Split(data[:end], []byte{'\n'}) {
		prompt := bytes.Contains(line, []byte(`"turn.prompt"`))
		if !prompt && !bytes.Contains(line, []byte(`"context.apply_compaction"`)) {
			continue
		}
		var rec struct {
			Type    string `json:"type"`
			AgentID string `json:"agentId"`
			Input   []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"input"`
		}
		if json.Unmarshal(line, &rec) != nil || rec.AgentID != "main" {
			continue
		}
		switch rec.Type {
		case "context.apply_compaction":
			l.held = false
		case "turn.prompt":
			for _, part := range rec.Input {
				if part.Type == "text" && strings.Contains(part.Text, kimiInstructionsOpen) {
					l.held = true
				}
			}
		}
	}
	return !l.held
}
