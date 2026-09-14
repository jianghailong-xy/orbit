package main

import (
	"errors"
	"net/http"
	"os"
	"strings"
)

// Watch's rollout flag as a runner-hosted session sees it (docs/watch-rollout.md).
//
// The apiserver decides per account whether Watch is on (its ORBIT_WATCHES) and says so on every claim:
// `watchesDisabled` when it is not. The runner writes that into the engine's environment as ORBIT_WATCHES,
// and everything the engine starts that has to agree about it inherits it: `orbit mcp` leaves the watch
// tools out of its list and lets session_create(wait) wait inline the way it did before watches, the
// `orbit` CLI leaves the watch commands out of its capabilities, and `orbit hook bg-guard` lets a poll of
// Orbit's own work through. A spawn reads the flag once, so an engine started before the flag changed
// keeps what it was started with until it is spawned again.

const envWatches = "ORBIT_WATCHES"

// watchesDisabledCode is the code the control plane refuses a watch write with while Watch is not on for
// the account. It comes with a 404, the status a control plane without Watch answers too, which is why a
// released runner that knows nothing of the flag already waits inline on it.
const watchesDisabledCode = "WATCHES_DISABLED"

// watchesEnv renders the ORBIT_WATCHES value the runner injects at spawn.
func watchesEnv(disabled bool) string {
	if disabled {
		return "off"
	}
	return "on"
}

// watchesEnabledFromEnv reads ORBIT_WATCHES. Only an explicit off turns Watch off: a runner that predates
// the flag injects nothing, and its sessions keep what that runner always did.
func watchesEnabledFromEnv() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(envWatches))) {
	case "off", "0", "false", "no":
		return false
	default:
		return true
	}
}

// watchesOn reports whether this claimed session is spawned with Watch.
func (s *ClaimedSession) watchesOn() bool {
	return s == nil || !s.WatchesDisabled
}

// watchesDisabledByServer reports a control plane that has Watch switched off for this account.
func watchesDisabledByServer(err error) bool {
	var httpErr *transportHTTPError
	return errors.As(err, &httpErr) && httpErr.statusCode == http.StatusNotFound && httpErr.code() == watchesDisabledCode
}

// watchesOffMessage is what a watch tool or command answers in a session spawned with Watch off.
func watchesOffMessage(what string) string {
	return what + ": Watch is switched off for this session on this Orbit server (ORBIT_WATCHES=off), so nothing " +
		"on the server can hold a wait. Look at the tasks or sessions again in a later turn, or tell the user what " +
		"you are waiting for."
}

// withoutWatchTools is tools without the watch tools: what `orbit mcp` lists in a session spawned with Watch off.
func withoutWatchTools(tools []map[string]interface{}) []map[string]interface{} {
	kept := make([]map[string]interface{}, 0, len(tools))
	for _, tool := range tools {
		if name, _ := tool["name"].(string); watchToolNames[name] {
			continue
		}
		kept = append(kept, tool)
	}
	return kept
}
