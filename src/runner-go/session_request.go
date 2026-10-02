package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"strings"
)

// Session requests (docs/session-request-reply-contract.md §3): a session_send or project_send that
// asks for a reply, and session_reply, the recipient's answer. The send returns at once with a
// requestId and a replyBy; the outcome — the answer, or why there is none — comes back to the asking
// session later as a turn of its own, so nothing here waits or polls.

// The deadline's bounds and default, the ones a watch's TTL has (WATCH_LIMITS on the server).
const (
	sessionReplyMinSeconds     = watchMinTTLSeconds
	sessionReplyMaxSeconds     = watchMaxTTLSeconds
	sessionReplyDefaultSeconds = 86400
)

// sessionRequestSchemaProps are the three request parameters session_send and project_send share.
func sessionRequestSchemaProps() map[string]interface{} {
	return map[string]interface{}{
		"expectReply": map[string]interface{}{
			"type": "boolean",
			"description": "Ask the recipient for a reply. The call still returns at once, with `requestId` and " +
				"`replyBy`; end your turn and the outcome comes back to you as a new turn — the answer " +
				"(REPLIED), or why there is none: NO_REPLY (it went idle without answering; you get its last " +
				"words instead), RECIPIENT_ENDED, EXPIRED (past replyBy) or UNDELIVERED (it never saw the " +
				"message). Exactly one of them, exactly once. Do not poll for it.",
		},
		"replyOptions": map[string]interface{}{
			"type": "array",
			"description": "Only with expectReply: 2 to 4 answers to choose from, each { label, description? } — " +
				"the recipient answers with the index of one (and may add a message). Leave it out for a " +
				"question only prose can answer.",
			"minItems": 2,
			"maxItems": 4,
			"items": map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"label":       map[string]interface{}{"type": "string"},
					"description": map[string]interface{}{"type": "string"},
				},
				"required": []string{"label"},
			},
		},
		"replyWithinSeconds": map[string]interface{}{
			"type": "integer",
			"description": fmt.Sprintf("Only with expectReply: how long the recipient has before the request "+
				"EXPIRES, in seconds (%d–%d, default %d — a day).",
				sessionReplyMinSeconds, sessionReplyMaxSeconds, sessionReplyDefaultSeconds),
			"minimum": sessionReplyMinSeconds,
			"maximum": sessionReplyMaxSeconds,
		},
	}
}

// withSessionRequestProps adds the request parameters to a send tool's own properties.
func withSessionRequestProps(props map[string]interface{}) map[string]interface{} {
	for key, value := range sessionRequestSchemaProps() {
		props[key] = value
	}
	return props
}

// copySessionRequestArgs carries the request parameters from a tool call into the body. expectReply
// is sent only when true — omitted, the body is byte-for-byte the plain send every installed server
// knows — and the other two travel exactly as given, for the server to judge.
func copySessionRequestArgs(body, args map[string]interface{}) {
	if getBool(args, "expectReply") {
		body["expectReply"] = true
	}
	for _, key := range []string{"replyOptions", "replyWithinSeconds"} {
		if value, ok := args[key]; ok && value != nil {
			body[key] = value
		}
	}
}

// sessionReplyDescriptor is the recipient's tool: the answer to a request it was sent.
func sessionReplyDescriptor(obj func(map[string]interface{}, ...string) map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{
		"name": "session_reply",
		"description": "Answer a request another Orbit session sent you — a message whose " +
			"<orbit-session-message> block carries request-id and asks for a reply. Give `option` (the index " +
			"of the answer you choose) when it offered options, `message`, or both; without options, " +
			"`message` is required. If you cannot do what was asked, say so here: an answer is better than " +
			"none. The asker gets it as a turn of its own. Only the session the request was sent to can " +
			"answer it, and only once — a request that already has an outcome is refused with " +
			"REQUEST_CLOSED (send an ordinary session_send to add something after that).",
		"inputSchema": obj(map[string]interface{}{
			"requestId": map[string]interface{}{"type": "string", "description": "The request-id from the message's <orbit-session-message> block."},
			"message":   map[string]interface{}{"type": "string", "description": "Your answer, in words."},
			"option":    map[string]interface{}{"type": "integer", "minimum": 0, "maximum": 3, "description": "The index of the option you choose, when the request offered options."},
		}, "requestId"),
	}
}

// sessionReplyBody is what session_reply sends: message and option, each only when given.
func sessionReplyBody(message string, messageSet bool, option *int) map[string]interface{} {
	body := map[string]interface{}{}
	if messageSet {
		body["message"] = message
	}
	if option != nil {
		body["option"] = *option
	}
	return body
}

// sessionRequestFlags are the CLI spelling of the request parameters, for `orbit session send` and
// `orbit project send`.
type sessionRequestFlags struct {
	fs          *flag.FlagSet
	expectReply *bool
	options     *string
	within      *int
}

func addSessionRequestFlags(fs *flag.FlagSet) *sessionRequestFlags {
	return &sessionRequestFlags{
		fs:          fs,
		expectReply: fs.Bool("expect-reply", false, "ask the recipient for a reply"),
		options:     fs.String("reply-options", "", "with --expect-reply: a JSON array of 2-4 {label, description} answers to choose from"),
		within:      fs.Int("reply-within-seconds", 0, "with --expect-reply: seconds until the request expires"),
	}
}

// apply writes the flags that were given into the body, refusing the two that mean something only
// with --expect-reply when it is absent — the server would refuse them too, and saying so here
// names the flag.
func (f *sessionRequestFlags) apply(body map[string]interface{}) error {
	optionsSet := flagWasSet(f.fs, "reply-options")
	withinSet := flagWasSet(f.fs, "reply-within-seconds")
	if !*f.expectReply {
		if optionsSet || withinSet {
			return fmt.Errorf("--reply-options and --reply-within-seconds need --expect-reply")
		}
		return nil
	}
	body["expectReply"] = true
	if optionsSet {
		options, err := parseReplyOptions(*f.options)
		if err != nil {
			return err
		}
		body["replyOptions"] = options
	}
	if withinSet {
		if *f.within < sessionReplyMinSeconds || *f.within > sessionReplyMaxSeconds {
			return fmt.Errorf("--reply-within-seconds must be %d to %d", sessionReplyMinSeconds, sessionReplyMaxSeconds)
		}
		body["replyWithinSeconds"] = *f.within
	}
	return nil
}

// parseReplyOptions reads --reply-options: 2 to 4 objects with a label and an optional description.
func parseReplyOptions(raw string) ([]map[string]interface{}, error) {
	var options []map[string]interface{}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&options); err != nil {
		return nil, fmt.Errorf(`--reply-options must be a JSON array like [{"label":"merge now"},{"label":"wait","description":"until review"}]: %w`, err)
	}
	if len(options) < 2 || len(options) > 4 {
		return nil, fmt.Errorf("--reply-options must hold 2 to 4 options, got %d", len(options))
	}
	for i, option := range options {
		label, _ := option["label"].(string)
		if strings.TrimSpace(label) == "" {
			return nil, fmt.Errorf("--reply-options[%d] needs a label", i)
		}
		for key := range option {
			if key != "label" && key != "description" {
				return nil, fmt.Errorf("--reply-options[%d] has unknown field %q: only label and description", i, key)
			}
		}
	}
	return options, nil
}

// cliSessionReply is `orbit session reply REQUEST_ID`: the CLI spelling of session_reply.
func cliSessionReply(args []string, in io.Reader, out io.Writer, ctx cliOrchestrationContext) error {
	id, rest := peelLeadingID(args)
	fs := newCLIFlagSet("orbit session reply")
	message := fs.String("message", "", "your answer, in words")
	messageFile := fs.String("message-file", "", "read the answer from stdin (-)")
	option := fs.Int("option", -1, "the index of the option you choose")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(rest); err != nil {
		return err
	}
	id, err := resolveRequestCLIId(id, fs.Args())
	if err != nil {
		return err
	}
	messageText, messageSet, err := readCLIText(in, *message, flagWasSet(fs, "message"), *messageFile, flagWasSet(fs, "message-file"), "message")
	if err != nil {
		return err
	}
	var chosen *int
	if flagWasSet(fs, "option") {
		if *option < 0 || *option > 3 {
			return fmt.Errorf("--option must be the index of an option (0-3)")
		}
		chosen = option
	}
	if (!messageSet || strings.TrimSpace(messageText) == "") && chosen == nil {
		return fmt.Errorf("--message, --message-file - or --option is required")
	}
	t, err := cliSessionTransport(ctx)
	if err != nil {
		return err
	}
	raw, err := t.sendSessionReply(ctx.sessionID, ctx.token, id, sessionReplyBody(messageText, messageSet, chosen))
	if err != nil {
		return fmt.Errorf("reply to session request: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

func resolveRequestCLIId(leading string, trailing []string) (string, error) {
	if leading != "" && len(trailing) > 0 {
		return "", fmt.Errorf("unexpected arguments: %s", strings.Join(trailing, " "))
	}
	if leading == "" {
		if len(trailing) > 1 {
			return "", fmt.Errorf("expected one request id, got: %s", strings.Join(trailing, " "))
		}
		if len(trailing) == 1 {
			leading = trailing[0]
		}
	}
	if leading == "" {
		return "", fmt.Errorf("request id is required — the request-id of the <orbit-session-message> block")
	}
	if err := validatePathSegmentID(leading); err != nil {
		return "", fmt.Errorf("request %w", err)
	}
	return leading, nil
}
