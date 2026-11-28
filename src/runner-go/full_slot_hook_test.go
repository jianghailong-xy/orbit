package main

import "context"

// installFullSlotReturns stands a control plane behind pool that takes a full runner's returned claims (answer) and its
// claim scope (capacityClaims), as runLoop wires the real one.
func installFullSlotReturns(pool *sessionPool, answer func(sessionID string) (string, bool, error)) {
	pool.returnFullSlot = func(_ context.Context, sessionID string) (string, bool, error) { return answer(sessionID) }
	pool.setCapacityClaims(true)
}
