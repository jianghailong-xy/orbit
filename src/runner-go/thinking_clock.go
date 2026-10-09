package main

import "time"

// thinkingClock times each stretch of reasoning and writes how long it took onto the durable
// `thinking` event that closes it, as `thinkingMs`.
//
// The duration is knowable only while the stretch streams: `thinking_delta` chunks are broadcast
// and never stored, so a transcript read back later holds the closing event and nothing before it.
// The clients used to time it themselves, which is why a turn watched live said "Thought for 4s"
// and the same turn read again said only "Thought" — every turn but the one on screen lost it.
// Timed here, it is part of the record.
//
// A stretch runs from its first delta until the model moves on to output of another kind (a
// reply's first chunk, a tool call); the durable block claims every stretch since the last one
// was claimed. Most engines close a block straight after its deltas, where that is the same as
// first delta to closing event. Kimi closes one block for the whole turn at its end, after the
// tool calls and the reply, and the pauses are what keep those out of its reasoning time.
//
// The boundaries the clients clear their live drafts on (the web's supersedesLiveDrafts, the
// control plane's supersededPrefixes) clear it too, so a stretch that never got a block of its own
// is not billed to the next one. An engine that streams no deltas (dsh, opencode) gets no
// duration rather than a guessed one.
//
// Not safe for concurrent use: session.go observes events under its buffer lock.
type thinkingClock struct {
	since time.Time     // when the stretch streaming now began; zero when none is
	spent time.Duration // stretches the model has moved on from, not yet claimed by a block
}

// observe notes one event about to be buffered and returns its payload: a copy carrying
// `thinkingMs` when the event is a block closing reasoning this clock timed, else the original.
func (c *thinkingClock) observe(eventType string, payload map[string]interface{}, now time.Time) map[string]interface{} {
	// A sub-agent streams no deltas of its own (only its parent's reach the stream), so nothing
	// it emits claims, pauses or ends the stretch its parent is in.
	if parent, _ := payload["parentToolUseId"].(string); parent != "" {
		return payload
	}
	switch eventType {
	case evThinkingDelta:
		if c.since.IsZero() {
			c.since = now
		}
	case evTextDelta, evToolUse:
		c.pause(now)
	case evThinking:
		c.pause(now)
		ms := c.spent.Milliseconds()
		c.spent = 0
		if ms > 0 {
			stamped := make(map[string]interface{}, len(payload)+1)
			for k, v := range payload {
				stamped[k] = v
			}
			stamped["thinkingMs"] = ms
			return stamped
		}
	case evAssistant, evTurnEnd, evInterrupt, evError:
		c.reset()
	case evUser:
		// A steer is written into the turn that is streaming; it ends nothing.
		if steer, _ := payload["steer"].(bool); !steer {
			c.reset()
		}
	case evSystem:
		// A mid-turn crash skips turn_end and comes back as `resumed`.
		if subtype, _ := payload["subtype"].(string); subtype == "resumed" {
			c.reset()
		}
	}
	return payload
}

func (c *thinkingClock) pause(now time.Time) {
	if !c.since.IsZero() {
		c.spent += now.Sub(c.since)
		c.since = time.Time{}
	}
}

func (c *thinkingClock) reset() {
	c.since = time.Time{}
	c.spent = 0
}
