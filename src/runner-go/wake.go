package main

import "context"

// runWakeLoop waits for the control plane's wake and beats the moment it comes.
//
// Work the heartbeat carries, a sign-in the user just started from the web or the code they pasted into it, otherwise
// waited for the next 30s tick: up to half a minute before the URL appeared, and as long again after the paste. The wake
// carries nothing itself; it only moves that tick forward, so a missed one costs exactly the old wait.
func runWakeLoop(ctx context.Context, wait func(context.Context) (bool, error), beat func()) {
	for ctx.Err() == nil {
		if woke, err := wait(ctx); err == nil && woke {
			beat()
		}
	}
}
