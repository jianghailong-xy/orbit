package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"time"
)

// The capability contract (docs/orbit-agent-contract.md §2.5): what `orbit capabilities --json` says
// about each command besides whether it is offered — why a command cannot run here, as a stable code,
// how a retry is made safe, which argument carries the key, and who has to take part. Every field is
// additive to the document an older consumer reads (catalogue v1.6.0).

// The stable reasons a command cannot run here. A consumer branches on the code; the prose beside it
// (unavailableReason) says the same thing to a person and may change.
const (
	// In a session whose account has Session orchestration off: the session, agent and runner
	// commands, and the project deliveries that spend the grant.
	capabilityOrchestrationDisabled = "ORCHESTRATION_DISABLED"
	// The command acts for the Orbit session it runs in (ORBIT_SESSION_ID), and there is none here.
	capabilityNoSessionContext = "SESSION_CONTEXT_MISSING"
	// The service token in effect is valid but does not carry the scope the command needs.
	capabilityServiceTokenScopeMissing = "SERVICE_TOKEN_SCOPE_MISSING"
	// The credential in effect cannot be read as one (a truncated or foreign service token, an
	// unreadable saved login).
	capabilityTokenInvalid = "TOKEN_INVALID"
	// The service token in effect is past its expiry.
	capabilityTokenExpired = "TOKEN_EXPIRED"
	// This machine has no runner credential, which every command but the account ones sends with.
	capabilityRunnerNotRegistered = "RUNNER_NOT_REGISTERED"
	// The runner credential is there but its storage is not private, so it is not used.
	capabilityRunnerCredentialUnusable = "RUNNER_CREDENTIAL_UNUSABLE"
	// The CLI acts as the person (a personal access token) and the command has no form that does.
	capabilityNotAvailableAsUser = "NOT_AVAILABLE_AS_USER"
	// The command acts as the person, and this process does not.
	capabilityRequiresUserLogin = "REQUIRES_USER_LOGIN"
	// A person's own terminal command, never offered to a running agent.
	capabilityHumanOnly = "HUMAN_ONLY"
	// The session was spawned with watches off.
	capabilityWatchesOff = "WATCHES_OFF"
	// The session was spawned with the wiki off.
	capabilityWikiOff = "WIKI_OFF"
)

// capabilityUnavailableCodes is the closed set, in the order docs/orbit-agent-contract.md lists it.
var capabilityUnavailableCodes = []string{
	capabilityOrchestrationDisabled, capabilityNoSessionContext, capabilityServiceTokenScopeMissing,
	capabilityTokenInvalid, capabilityTokenExpired, capabilityRunnerNotRegistered,
	capabilityRunnerCredentialUnusable, capabilityNotAvailableAsUser, capabilityRequiresUserLogin,
	capabilityHumanOnly, capabilityWatchesOff, capabilityWikiOff,
}

// How a capability involves somebody besides the caller.
const (
	interactionNone            = "none"
	interactionCard            = "confirmation_card"
	interactionOwnerDecision   = "owner_decision"
	interactionHumanOnly       = "human_only"
	idempotencyRepeatReturns   = "returns_first"
	idempotencyRepeatIsRefused = "refused"
)

// cliIdempotencyArg names the argument that makes a repeat of a caller_key operation safe, on each
// surface, and what a repeat with the same value gets.
type cliIdempotencyArg struct {
	MCP string `json:"mcp,omitempty"`
	CLI string `json:"cli,omitempty"`
	// returns_first: the server answers with what the first call wrote. refused: a repeat is refused
	// (the call can land once), so it never writes twice but answers with an error.
	Repeat string `json:"repeat"`
}

// cliRetryPolicy is the error.retry a call's receipt carries when it got no answer (a lost
// connection, a 408 or a 5xx) — the one case where the caller cannot tell whether it landed — with
// and without the idempotency argument. It is computed by the same rule the receipt uses
// (operation.resendIsSafe), so the two cannot disagree. Every other failure's retry follows from its
// status alone (docs/orbit-agent-contract.md §5.2).
type cliRetryPolicy struct {
	OnNoAnswer        string `json:"onNoAnswer"`
	OnNoAnswerWithKey string `json:"onNoAnswerWithKey,omitempty"`
}

// catalogIdempotencyArgOverrides are the caller_key operations whose key is not idempotencyKey or
// clientTurnId: a reply is keyed by the request it answers, which takes one answer.
var catalogIdempotencyArgOverrides = map[string]cliIdempotencyArg{
	"session_reply": {MCP: "requestId", CLI: "REQUEST_ID", Repeat: idempotencyRepeatIsRefused},
}

// idempotencyArg is the argument a caller_key operation is keyed by, nil for every other operation.
func (op *operation) idempotencyArg() *cliIdempotencyArg {
	if op.Idempotency != idempotencyCallerKey {
		return nil
	}
	if arg, ok := catalogIdempotencyArgOverrides[op.Tool]; ok {
		return &arg
	}
	var props map[string]interface{}
	if op.MCP != nil {
		props, _ = op.MCP.InputSchema["properties"].(map[string]interface{})
	}
	for _, key := range []struct{ mcp, cli string }{{"idempotencyKey", "--idempotency-key"}, {"clientTurnId", "--client-turn-id"}} {
		_, inSchema := props[key.mcp]
		inCLI := false
		if op.CLI != nil {
			for _, argument := range op.CLI.Arguments {
				if strings.HasPrefix(argument, key.cli+" ") || argument == key.cli {
					inCLI = true
				}
			}
		}
		if !inSchema && !inCLI {
			continue
		}
		arg := cliIdempotencyArg{Repeat: idempotencyRepeatReturns}
		if inSchema {
			arg.MCP = key.mcp
		}
		if inCLI {
			arg.CLI = key.cli
		}
		return &arg
	}
	return nil
}

// resendIsSafe is whether the identical call may be sent again after it got no answer: a read
// always, a write only when it carried a key whose repeat answers with the first result.
func (op *operation) resendIsSafe(keyed bool) bool {
	if !op.Mutates {
		return true
	}
	arg := op.idempotencyArg()
	return keyed && arg != nil && arg.Repeat == idempotencyRepeatReturns
}

// keyedCall is whether an MCP call's arguments carry the operation's idempotency argument.
func (op *operation) keyedCall(args map[string]interface{}) bool {
	arg := op.idempotencyArg()
	return arg != nil && arg.MCP != "" && strings.TrimSpace(getString(args, arg.MCP)) != ""
}

func (op *operation) retryPolicy() cliRetryPolicy {
	rule := func(safe bool) string {
		if safe {
			return retryResend
		}
		return retryRereadFirst
	}
	policy := cliRetryPolicy{OnNoAnswer: rule(op.resendIsSafe(false))}
	if op.idempotencyArg() != nil {
		policy.OnNoAnswerWithKey = rule(op.resendIsSafe(true))
	}
	return policy
}

func (op *operation) interaction() string {
	if op.CLI != nil && op.CLI.HeadlessOnly {
		return interactionHumanOnly
	}
	switch op.Approval {
	case approvalKindCard:
		return interactionCard
	case approvalKindOwner:
		return interactionOwnerDecision
	default:
		return interactionNone
	}
}

// serviceTokenState reads a service token's claims as decodeServiceTokenClaims does, and when it
// yields none says why: TOKEN_INVALID for a token that is not one, TOKEN_EXPIRED for one past its exp.
// Not verified: only the control plane authorizes, and this only keeps the document from promising
// what the server will refuse.
func serviceTokenState(token string) (*serviceTokenClaims, string, string) {
	if claims := decodeServiceTokenClaims(token); claims != nil {
		return claims, "", ""
	}
	parts := strings.Split(token, ".")
	if len(parts) == 3 {
		if payload, err := base64.RawURLEncoding.DecodeString(parts[1]); err == nil {
			var claims serviceTokenClaims
			if json.Unmarshal(payload, &claims) == nil && claims.Exp > 0 && time.Now().Unix() >= claims.Exp {
				return nil, capabilityTokenExpired, "ORBIT_SERVICE_TOKEN expired at " +
					time.Unix(claims.Exp, 0).UTC().Format(time.RFC3339) + ": mint a new one with `orbit token mint`"
			}
		}
	}
	return nil, capabilityTokenInvalid, "ORBIT_SERVICE_TOKEN is not a service token Orbit issued (it does not decode): " +
		"mint one with `orbit token mint` and pass it whole"
}

// capabilityScope is everything about this process that decides what `orbit capabilities` offers it.
type capabilityScope struct {
	identity      cliIdentity
	sessionID     string
	orchestration bool
	asUser        bool
	service       *serviceTokenClaims
	// Why the service token in effect cannot be used, when it cannot.
	serviceCode, serviceDetail string
	watches, wiki              bool
	// Outside a session, why the runner credential every non-account command sends with cannot be
	// used. Inside one the runner that spawned the session holds it.
	runnerCode, runnerDetail string
}

func newCapabilityScope(identity cliIdentity, sessionID string, orchestration bool) capabilityScope {
	s := capabilityScope{
		identity:      identity,
		sessionID:     sessionID,
		orchestration: orchestration,
		asUser:        identity.Kind == identityUser,
		watches:       watchesEnabledFromEnv(),
		wiki:          wikiEnabledFromEnv(),
	}
	if identity.Kind == identityService {
		s.service, s.serviceCode, s.serviceDetail = serviceTokenState(identity.token)
		if err := configStoragePrivate(); err != nil {
			// No config at all is a machine never registered, whatever its directory's mode.
			if os.IsNotExist(err) || !exists(configPath()) {
				s.runnerCode, s.runnerDetail = capabilityRunnerNotRegistered,
					"no runner credential at "+configPath()+": every command but the account ones sends with this machine's runner credential — run `orbit register`"
			} else {
				s.runnerCode, s.runnerDetail = capabilityRunnerCredentialUnusable,
					"runner credential storage is not private; restart the Orbit runner once to migrate it"
			}
		} else if cfg := loadConfig(); cfg == nil || cfg.RunnerToken == "" {
			s.runnerCode, s.runnerDetail = capabilityRunnerNotRegistered, configPath()+" holds no runner credential: run `orbit register`"
		}
	}
	return s
}

// accountCommand is one of the commands that look after the login itself and send with nothing
// else: they run whoever the CLI acts as.
func accountCommand(argv []string) bool {
	switch strings.Join(argv[1:], " ") {
	case "login", "logout", "whoami":
		return true
	}
	return false
}

// unusable is why a command the document lists cannot run under this process's credentials, ""
// when it can. The prose is capabilityAvailability's where that already answered.
func (s capabilityScope) unusable(spec cliCapabilitySpec) (string, string) {
	available, reason := capabilityAvailability(s.identity, spec.Argv)
	if !available {
		return s.identityCode(spec), reason
	}
	if !accountCommand(spec.Argv) && s.runnerCode != "" {
		return s.runnerCode, s.runnerDetail
	}
	return "", ""
}

// identityCode classes capabilityAvailability's refusal.
func (s capabilityScope) identityCode(spec cliCapabilitySpec) string {
	if strings.Join(spec.Argv[1:], " ") == "api" {
		if s.asUser && s.identity.problemCode != "" {
			return s.identity.problemCode
		}
		return capabilityRequiresUserLogin
	}
	if s.asUser && s.identity.Problem == "" {
		return capabilityNotAvailableAsUser
	}
	if s.identity.problemCode != "" {
		return s.identity.problemCode
	}
	return capabilityTokenInvalid
}

// withheld is why the document does not list a catalogue command for this process at all. Every
// command it leaves out has one (TestEveryWithheldCapabilityHasAStableReason).
func (s capabilityScope) withheld(op *operation) (string, string) {
	spec := op.CLI
	switch {
	case spec.HeadlessOnly && s.sessionID != "":
		reason := catalogMCPExemptions[op.Tool]
		if reason == "" {
			reason = "a person's own terminal command"
		}
		return capabilityHumanOnly, reason + "; a running agent is never offered it"
	case spec.SessionOnly && s.sessionID == "":
		return capabilityNoSessionContext, "it acts for the Orbit session it runs in (ORBIT_SESSION_ID), and this process runs in none"
	case spec.RequiresOrchestration && !s.orchestration:
		if s.sessionID == "" {
			return capabilityNoSessionContext, "it spends the Session orchestration grant of the session it runs in, and this process runs in none"
		}
		return capabilityOrchestrationDisabled, orchestrationOffMsg
	}
	if code, detail := s.orchestrationFamilyWithheld(op); code != "" {
		return code, detail
	}
	switch {
	case (op.CLIFamily == "watch" || op.Tool == "session_await") && !s.watches:
		return capabilityWatchesOff, "this session was spawned with watches off"
	case op.CLIFamily == "wiki" && !s.wiki:
		return capabilityWikiOff, "this session was spawned with the wiki off"
	}
	return "", ""
}

func (s capabilityScope) orchestrationFamilyWithheld(op *operation) (string, string) {
	switch op.CLIFamily {
	case "session", "agent", "runner":
	default:
		return "", ""
	}
	if s.sessionID != "" {
		if !s.orchestration {
			return capabilityOrchestrationDisabled, orchestrationOffMsg
		}
		return "", ""
	}
	if s.asUser {
		if op.CLIFamily == "session" {
			return "", ""
		}
		return capabilityNotAvailableAsUser, userModeUnported
	}
	if op.CLIFamily != "session" {
		return capabilityNoSessionContext, "the " + op.CLIFamily + " commands have no headless form: no service-token scope names them, so they run only inside a live Orbit session with Session orchestration on"
	}
	action := strings.TrimPrefix(op.Tool, "session_")
	scope, grantable := sessionActionScope[action]
	if !grantable {
		return capabilityNoSessionContext, action + " runs only inside a live Orbit session — no service token can grant it"
	}
	if s.serviceCode != "" {
		return s.serviceCode, s.serviceDetail
	}
	if s.service != nil {
		return capabilityServiceTokenScopeMissing, action + " needs the " + scope + " scope; this service token allows only: " +
			headlessActionList(headlessAllowedActions(s.service))
	}
	return capabilityNoSessionContext, "without a session the runner credential allows only: " +
		headlessActionList(headlessAllowedActions(nil)) + "; a service token with the " + scope + " scope (`orbit token mint`) reaches " + action
}
