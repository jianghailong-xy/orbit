package main

import "encoding/json"

// approvalDeclinedCode names the outcome a declined confirmation card produces, on either surface.
const approvalDeclinedCode = "APPROVAL_DECLINED"

// declinedCardRefusal is the ONE refusal document a declined confirmation card produces, whichever
// surface asked for it (docs/orbit-agent-contract.md §6.1, gap G4).
//
// Before this, a decline was a non-error MCP result whose text began "the human rejected this …"
// and, on the CLI, an error built from a different sentence. Both were refusals, and the two shapes
// meant a reader had to know which door had been knocked on to classify the answer. The document is
// the same on both now: the MCP tool returns it as its result text, the CLI returns it as the
// command's error (so it lands on stderr and the exit code is non-zero). The transport stays
// different — a tool result is not a process — but the outcome, its code, the card it answered and
// the person who answered it are one document.
//
// `subject` is the noun the person declined — "this task", "this batch", "this DAG change" — so the
// message still reads like the answer they gave.
//
// An owner who pressed "Chat about this" refused nothing (isOwnerChat): what comes back is their
// message, ownerChatReply, exactly as every other Orbit ask hands it over, and no refusal document.
func declinedCardRefusal(tool, subject string, dec *ApprovalDecisionResponse) string {
	if isOwnerChat(dec) {
		return ownerChatReply(dec.Message)
	}
	document := struct {
		Refused   bool   `json:"refused"`
		Code      string `json:"code"`
		Tool      string `json:"tool"`
		Message   string `json:"message"`
		DecidedBy string `json:"decidedBy,omitempty"`
	}{
		Refused:   true,
		Code:      approvalDeclinedCode,
		Tool:      tool,
		Message:   "the human rejected " + subject + ": " + declinedReason(dec),
		DecidedBy: dec.DecidedByID,
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		// A string field cannot fail to marshal; the fallback is the sentence alone rather than a
		// refusal nobody can read.
		return "the human rejected " + subject + ": " + declinedReason(dec)
	}
	return string(encoded)
}
