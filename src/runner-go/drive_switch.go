package main

import (
	"errors"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
)

// The Drive switch, as a session sees it. The apiserver's ORBIT_DRIVE_ENABLED decides whether the
// server offers the Drive and says so on every claim and reclaim (`documentsDisabled`). The runner
// writes that into the engine's environment as ORBIT_DOCUMENTS=off|on, and `orbit mcp` and `orbit drive` read it
// from there. A server that predates the switch never sends the field, which means on.
const envDocuments = "ORBIT_DOCUMENTS"

// documentsDisabledCode is the code the drive routes answer 404 with while the server has Drive off.
const documentsDisabledCode = "DOCUMENTS_DISABLED"

// documentsEnv renders the ORBIT_DOCUMENTS value the runner injects at spawn.
func documentsEnv(disabled bool) string {
	if disabled {
		return "off"
	}
	return "on"
}

// documentsEnabledFromEnv reads ORBIT_DOCUMENTS. Only an explicit off turns Drive off, so a runner that
// predates the flag injects nothing and its sessions keep what they had.
func documentsEnabledFromEnv() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(envDocuments))) {
	case "off", "0", "false", "no":
		return false
	default:
		return true
	}
}

// documentsOffProcess is what the last claim or reclaim said, for the runner's own text that has no job in
// reach (the agent's standing instructions). The switch is the server's, so every session of one runner is told
// the same; each spawn still carries it in its own environment.
var documentsOffProcess atomic.Bool

func noteDocumentsDisabled(disabled bool) { documentsOffProcess.Store(disabled) }

// documentsDisabledByServer reports a control plane that has Drive switched off.
func documentsDisabledByServer(err error) bool {
	var httpErr *transportHTTPError
	return errors.As(err, &httpErr) && httpErr.statusCode == http.StatusNotFound && httpErr.code() == documentsDisabledCode
}

// documentsOffMessage is what a drive tool or command answers while Drive is off.
func documentsOffMessage(what string) string {
	return what + ": Drive is not enabled on this Orbit server (ORBIT_DRIVE_ENABLED), so there is no " +
		"Orbit Files drive. Nothing was read or written; carry on without it, or tell the user"
}

// driveToolNames is the set callDriveTool answers for.
var driveToolNames = map[string]bool{
	"drive_put": true, "drive_get": true, "drive_list": true, "drive_move": true, "drive_delete": true,
	"drive_sync": true,
}

// withoutDriveTools is tools without the drive tools: what `orbit mcp` lists while Drive is off.
func withoutDriveTools(tools []map[string]interface{}) []map[string]interface{} {
	kept := make([]map[string]interface{}, 0, len(tools))
	for _, tool := range tools {
		if name, _ := tool["name"].(string); driveToolNames[name] {
			continue
		}
		kept = append(kept, tool)
	}
	return kept
}
