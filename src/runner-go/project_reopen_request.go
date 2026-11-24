package main

import (
	"errors"
	"strings"
)

// project_request_reopen, and its CLI twin `orbit project request-reopen`: any session asks the
// account owner to reopen a DONE or CANCELLED project after a write of its was refused
// PROJECT_REOPEN_REQUIRED (docs/project-reopen-request-design.md §5). The server decides everything
// else (PROJECT_ALREADY_OPEN, REOPEN_REQUEST_DECLINED, the card); the runner checks the shape.

// projectReopenRequestBody is the request, from the tool's arguments. Refused here for a field the
// server would only refuse, so a blank costs no round trip.
func projectReopenRequestBody(args map[string]interface{}) (map[string]interface{}, error) {
	why := strings.TrimSpace(getString(args, "why"))
	if why == "" {
		return nil, errors.New("why is required: the reason the project should be reopened, in the " +
			"agent's own words — the owner reads it on the card")
	}
	planned := strings.TrimSpace(getString(args, "plannedWork"))
	if planned == "" {
		return nil, errors.New("plannedWork is required: what you will do once the project is " +
			"reopened, and how it changes the project's acceptance criteria")
	}
	return map[string]interface{}{"why": why, "plannedWork": planned}, nil
}
