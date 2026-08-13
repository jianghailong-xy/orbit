package main

import (
	"testing"
	"time"
)

func TestContextPingerEmitsFirstReadingThenThrottles(t *testing.T) {
	var got []int
	emit := func(eventType string, payload map[string]interface{}) {
		if eventType != evSystem || payload["subtype"] != "context" {
			t.Fatalf("unexpected event %q %v", eventType, payload)
		}
		got = append(got, payload["contextTokens"].(int))
	}
	var p contextPinger

	p.ping(emit, 0)     // no reading yet — nothing to report
	p.ping(emit, 12000) // first reading goes out at once: the gauge is showing 0%
	p.ping(emit, 13000) // still inside the interval
	p.ping(emit, 14000)

	if len(got) != 1 || got[0] != 12000 {
		t.Fatalf("want one ping of 12000, got %v", got)
	}

	p.at = time.Now().Add(-contextPingInterval)
	p.ping(emit, 12000) // unchanged since the last ping — nothing new to say
	if len(got) != 1 {
		t.Fatalf("unchanged reading pinged again: %v", got)
	}
	p.ping(emit, 20000)
	if len(got) != 2 || got[1] != 20000 {
		t.Fatalf("want a second ping of 20000, got %v", got)
	}
}
