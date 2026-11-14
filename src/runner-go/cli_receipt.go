package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"strings"
	"sync"
)

// `orbit … --receipt`: the receipt at a terminal (docs/orbit-agent-contract.md §2.4, §6).
//
// Any catalogued command takes --receipt. It runs the command as it always runs and prints, instead
// of the command's own output, the receipt the MCP tool of the same operation answers with
// (tool_receipt.go): the same fields, built by the same code, from the same facts — the requests the
// command made, the card it filed and its answer, the body it sent. stdout is that one JSON document
// and nothing else, a failure's receipt included; stderr still carries the command's notices and, on
// a failure, its message, and the exit status is 0 exactly when the receipt says ok.
//
// `--json` keeps printing what it always printed, the entity document, which is the receipt's
// `entity`: the two flags are one mapping, not two vocabularies.

// cliRecordMu guards cliCurrentRecord: the record of the command --receipt is running, read by the
// transports that command makes (Transport.observe) and by the commands that say what they sent.
var (
	cliRecordMu      sync.Mutex
	cliCurrentRecord *callRecord
)

// cliRecord is the running command's record, or nil when no receipt was asked for — every recording
// method is a no-op on nil.
func cliRecord() *callRecord {
	cliRecordMu.Lock()
	defer cliRecordMu.Unlock()
	return cliCurrentRecord
}

func setCLIRecord(rec *callRecord) (restore func()) {
	cliRecordMu.Lock()
	previous := cliCurrentRecord
	cliCurrentRecord = rec
	cliRecordMu.Unlock()
	return func() {
		cliRecordMu.Lock()
		cliCurrentRecord = previous
		cliRecordMu.Unlock()
	}
}

// takeReceiptFlag removes --receipt from a command line and says whether it was there. Only up to a
// bare "--": what follows it belongs to the command being run, not to this CLI.
func takeReceiptFlag(args []string) ([]string, bool) {
	out := make([]string, 0, len(args))
	asked := false
	for i, arg := range args {
		if arg == "--" {
			out = append(out, args[i:]...)
			break
		}
		switch arg {
		case "--receipt", "--receipt=true", "-receipt":
			asked = true
			continue
		case "--receipt=false":
			continue
		}
		out = append(out, arg)
	}
	return out, asked
}

// cliOperationFor is the catalogued operation a command line runs: the one whose argv is the longest
// prefix of the line's leading words.
func cliOperationFor(args []string) *operation {
	var best *operation
	for _, op := range buildOperationCatalog() {
		if op.CLI == nil || len(op.CLI.Argv) < 2 {
			continue
		}
		words := op.CLI.Argv[1:]
		if len(args) < len(words) {
			continue
		}
		match := true
		for i, word := range words {
			if args[i] != word {
				match = false
				break
			}
		}
		if match && (best == nil || len(words) > len(best.CLI.Argv)-1) {
			best = op
		}
	}
	return best
}

func argsHaveJSONFlag(args []string) bool {
	for _, arg := range args {
		if arg == "--json" || arg == "--json=true" || arg == "-json" {
			return true
		}
	}
	return false
}

func cliTakesJSONFlag(op *operation) bool {
	for _, argument := range op.CLI.Arguments {
		if argument == "--json" || strings.HasPrefix(argument, "--json ") || strings.HasPrefix(argument, "--json[") {
			return true
		}
	}
	return false
}

// runCLIReceipt runs one command line for its receipt.
func runCLIReceipt(args []string, in io.Reader, out, errW io.Writer) error {
	op := cliOperationFor(args)
	if op == nil || !op.answersWithReceipt() {
		return fmt.Errorf("--receipt: %q is not an operation with a receipt; run `orbit capabilities --json` for the ones there are", strings.Join(leadingWords(args), " "))
	}
	if wantsHelp(args) {
		return runOrbitCLI(args, in, out, errW)
	}
	inner := args
	if !argsHaveJSONFlag(args) && cliTakesJSONFlag(op) {
		inner = append(append([]string{}, args...), "--json")
	}
	rec := newCallRecord(op, cliArgumentsForReceipt(op, args))
	rec.defaultTaskID = strings.TrimSpace(os.Getenv("ORBIT_TASK_ID"))
	restore := setCLIRecord(rec)
	var buf bytes.Buffer
	err := runOrbitCLI(inner, in, &buf, errW)
	restore()

	var r toolReceipt
	var invalid *cliInvalidArguments
	switch {
	case errors.As(err, &invalid):
		r = invalidArgumentsReceipt(op, rec.args, invalid.violations)
	case err != nil:
		rec.observeCLIFailure(err)
		r = rec.receipt(err.Error(), true)
	default:
		r = rec.receipt(buf.String(), false)
	}
	blob, marshalErr := json.Marshal(r)
	if marshalErr != nil {
		return marshalErr
	}
	if _, writeErr := fmt.Fprintln(out, string(blob)); writeErr != nil {
		return writeErr
	}
	if err != nil {
		return err
	}
	if !r.OK {
		// A declined card or a hand-off is a refusal even when the command itself returned.
		message := r.Outcome
		if r.Error != nil {
			message = r.Error.Message
		}
		return errors.New(message)
	}
	return nil
}

func leadingWords(args []string) []string {
	var words []string
	for _, arg := range args {
		if strings.HasPrefix(arg, "-") {
			break
		}
		words = append(words, arg)
	}
	return words
}

// observeCLIFailure gives the record the request a failed command ended on when no transport it
// watched reported one: the person's transport answers through its own client, and its refusals still
// arrive wrapped in the error the command returns.
func (rec *callRecord) observeCLIFailure(err error) {
	if rec == nil || rec.lastFailedRequest() != nil {
		return
	}
	var httpErr *transportHTTPError
	if errors.As(err, &httpErr) {
		rec.observe(transportEvent{Kind: transportEventRequest, Method: httpErr.method, Path: httpErr.path, Err: httpErr})
		return
	}
	if isLostAnswer(err) {
		rec.observe(transportEvent{Kind: transportEventRequest, Err: err})
	}
}

// isLostAnswer says whether err is a request that got no answer: a timeout, a refused or dropped
// connection, a body cut off on its way back.
func isLostAnswer(err error) bool {
	if err == nil {
		return false
	}
	var urlErr *url.Error
	var netErr net.Error
	return errors.As(err, &urlErr) || errors.As(err, &netErr) || errors.Is(err, context.DeadlineExceeded) ||
		errors.Is(err, io.ErrUnexpectedEOF) || strings.Contains(err.Error(), "reading response body")
}

// cliArgumentsForReceipt reads a command line's flags as the MCP arguments they stand for, which is
// what the receipt reports from: --idempotency-key is idempotencyKey, --dry-run is dryRun, a leading
// id is the entity the command addresses. A -file flag stands for the field it fills and a --clear-
// or --no- flag for the field it clears.
func cliArgumentsForReceipt(op *operation, args []string) map[string]interface{} {
	out := map[string]interface{}{}
	words := len(op.CLI.Argv) - 1
	rest := args
	if len(rest) >= words {
		rest = rest[words:]
	}
	for i := 0; i < len(rest); i++ {
		arg := rest[i]
		if arg == "--" {
			break
		}
		if !strings.HasPrefix(arg, "-") {
			if key := addressArgumentOf(op); key != "" {
				if _, named := out[key]; !named {
					out[key] = arg
				}
			}
			continue
		}
		name := strings.TrimLeft(arg, "-")
		var value interface{} = true
		if eq := strings.Index(name, "="); eq >= 0 {
			raw := name[eq+1:]
			name = name[:eq]
			switch raw {
			case "true":
				value = true
			case "false":
				value = false
			default:
				value = raw
			}
		} else if i+1 < len(rest) && !strings.HasPrefix(rest[i+1], "-") {
			value = rest[i+1]
			i++
		}
		if name == "json" || name == "help" || name == "h" {
			continue
		}
		switch {
		case strings.HasPrefix(name, "clear-"):
			name, value = strings.TrimPrefix(name, "clear-"), nil
		case strings.HasPrefix(name, "no-"):
			name, value = strings.TrimPrefix(name, "no-"), nil
		case strings.HasSuffix(name, "-file"):
			name = strings.TrimSuffix(name, "-file")
		}
		out[kebabToCamel(name)] = value
	}
	return out
}

// addressArgumentOf is the argument a command's leading id fills: the first address the tool declares.
func addressArgumentOf(op *operation) string {
	props := op.inputProperties()
	for _, key := range receiptAddressArguments {
		if _, declared := props[key]; declared {
			return key
		}
	}
	return ""
}

func kebabToCamel(name string) string {
	parts := strings.Split(name, "-")
	for i := 1; i < len(parts); i++ {
		if parts[i] != "" {
			parts[i] = strings.ToUpper(parts[i][:1]) + parts[i][1:]
		}
	}
	return strings.Join(parts, "")
}

// cliInvalidArguments is a command's JSON payload refused against the MCP tool's schema before anything
// was sent (validateCLIPayload).
type cliInvalidArguments struct {
	tool       string
	violations []argumentViolation
}

func (e *cliInvalidArguments) Error() string {
	sentences := make([]string, len(e.violations))
	for i, v := range e.violations {
		sentences[i] = v.Message
	}
	return e.tool + " was not sent, and nothing was written or asked: " + strings.Join(sentences, "; ")
}

// validateCLIPayload judges the MCP arguments a command line amounts to against the tool's advertised
// schema and exclusive groups — the same judgment `orbit mcp` makes — so a misspelled field in a JSON
// file is refused at the terminal exactly as it is over MCP, before any card or request.
func validateCLIPayload(tool string, args map[string]interface{}) error {
	op := lookupCatalogOperation(tool)
	if op == nil {
		return nil
	}
	if violations := validateToolArguments(op, args); len(violations) > 0 {
		return &cliInvalidArguments{tool: tool, violations: violations}
	}
	return nil
}
