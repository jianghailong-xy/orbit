package main

import (
	"context"
	"errors"
	"net/http"
	"time"
)

// How long the wake loop rests after a poll that failed, so a control plane that is down is not
// hammered; the 30s heartbeat carries on meanwhile.
const wakeRetryDelay = 5 * time.Second

// runWakeLoop parks in the control plane's wake long-poll and beats the moment it answers.
//
// Work the heartbeat carries — a sign-in the user just started from the web, the code they pasted
// into it — otherwise waited for the next 30s tick: up to half a minute before the URL appeared,
// and as long again after the paste. The wake carries nothing itself; it only moves that tick
// forward, so a missed one costs exactly the old wait. A control plane without the route (404)
// never will have it in this process's life, and the loop stops.
func runWakeLoop(ctx context.Context, wait func(context.Context) (bool, error), beat func()) {
	for ctx.Err() == nil {
		woke, err := wait(ctx)
		if err == nil {
			if woke {
				beat()
			}
			continue
		}
		var httpErr *transportHTTPError
		if errors.As(err, &httpErr) && httpErr.statusCode == http.StatusNotFound {
			logln("control plane has no wake long-poll; sign-ins reach this runner on its heartbeat")
			return
		}
		select {
		case <-ctx.Done():
		case <-time.After(wakeRetryDelay):
		}
	}
}
