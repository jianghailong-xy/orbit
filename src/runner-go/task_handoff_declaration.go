package main

import (
	"fmt"
	"strings"
)

// What `handoff` on its own is missing. Refused HERE, before the round trip, for the same reason
// `--project` and `--no-project` together are: this is not an authority question the server owns,
// it is two halves of one sentence with one of them missing. A crossing is a request to move work
// between two goals, and a request that names one end is not a question anybody — user, policy or
// coordinator — could answer.
//
// The server says the same thing on the create doors (`a declared crossing has to say where it is
// going`) and says nothing at all on the edit door, where the declaration is not read yet. So a
// caller that got this wrong would learn it on one door and not the other, and on the quiet door
// would watch a declared crossing be refused as if it had never declared anything.
const taskHandoffNeedsATargetProjectError = "a declared crossing has to name where it is going: send `handoff` together with the projectId it crosses into (--project-id on `orbit task create`, --project on `orbit task update`). A handoff on its own declares a crossing with no destination, and nobody can answer that"

// requireHandoffNamesItsDestination refuses a declaration that names no target project.
//
// `handoff: null` is not a declaration — presence is, and a null is how a caller spells "no
// handoff" in a language with no absent — so it passes through to the server as given rather than
// being read as a crossing this client then refuses.
func requireHandoffNamesItsDestination(item map[string]interface{}) error {
	if declared, present := item["handoff"]; !present || declared == nil {
		return nil
	}
	target, present := item["projectId"]
	if !present || target == nil {
		return fmt.Errorf("%s", taskHandoffNeedsATargetProjectError)
	}
	// A blank id is an unset shell variable or a typo, which is the same missing destination one
	// step later — and on the edit door it is refused for exactly that reason already.
	if id, ok := target.(string); ok && strings.TrimSpace(id) == "" {
		return fmt.Errorf("%s", taskHandoffNeedsATargetProjectError)
	}
	return nil
}
