package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
)

const documentsHelp = `orbit documents — work with the owner's Documents

Usage:
  orbit documents put <local-path> <path> [--json]
  orbit documents get <path> [--json]
  orbit documents ls [path] [--cursor CURSOR] [--json]
  orbit documents mv <from> <to> [--json]
  orbit documents rm <path> [--json]
  orbit documents sync <local-dir> <path> [--delete] [--wait] [--json]

Use orbit documents <command> --help for details. orbit drive is the same command under its old name.
`

var documentsCLIHelp = map[string]string{
	"put": "Copy a file from this session's checkout or uploads directory to the drive. Overwriting keeps the previous version. " +
		"The file is sent in 8 MiB chunks and has no size limit: file_upload's 25 MiB cap does not apply here.",
	"get": "Download a drive file into this session's uploads directory and return its local path.",
	"ls":  "List one page of a drive folder. With no path, list the root.",
	"mv":  "Move or rename a drive entry. This overwrites an existing file at the destination.",
	"rm":  "Move a drive entry to the owner's Trash. The owner can restore it from the Documents page. Agents cannot see Trash.",
	"sync": "Copy a directory of this session's checkout or uploads directory into a Documents folder, once, in the background: " +
		"it answers with a background job id at once, and the job wakes you when it ends, its last output line the summary. " +
		"Files already the same in Documents are skipped, so running it again only sends what changed. One way: nothing " +
		"comes down. --delete moves Documents files the directory no longer has to the owner's Trash. --wait runs it in the " +
		"foreground instead. The owner watches it in the Documents page's upload tray.",
}

var documentsCLICapabilities = []cliCapabilitySpec{
	{Tool: "documents_put", Argv: []string{"orbit", "documents", "put"}, Usage: "orbit documents put <local-path> <path> [--json]",
		Arguments: []string{"[local-path] (required)", "[path] (required)", "--json"}, Mutates: true, SessionOnly: true},
	{Tool: "documents_get", Argv: []string{"orbit", "documents", "get"}, Usage: "orbit documents get <path> [--json]",
		Arguments: []string{"[path] (required)", "--json"}, SessionOnly: true},
	{Tool: "documents_list", Argv: []string{"orbit", "documents", "ls"}, Usage: "orbit documents ls [path] [--cursor CURSOR] [--json]",
		Arguments: []string{"[path]", "--cursor <cursor>", "--json"}},
	{Tool: "documents_move", Argv: []string{"orbit", "documents", "mv"}, Usage: "orbit documents mv <from> <to> [--json]",
		Arguments: []string{"[from] (required)", "[to] (required)", "--json"}, Mutates: true},
	{Tool: "documents_delete", Argv: []string{"orbit", "documents", "rm"}, Usage: "orbit documents rm <path> [--json]",
		Arguments: []string{"[path] (required)", "--json"}, Mutates: true},
	{Tool: "documents_sync", Argv: []string{"orbit", "documents", "sync"}, Usage: "orbit documents sync <local-dir> <path> [--delete] [--wait] [--json]",
		Arguments: []string{"[local-path] (required)", "[path] (required)", "--delete", "--wait", "--json"}, Mutates: true, SessionOnly: true},
}

var documentsActionHelp = func() map[string]string {
	help := make(map[string]string, len(documentsCLICapabilities))
	for _, spec := range documentsCLICapabilities {
		action := spec.Argv[2]
		help[action] = fmt.Sprintf("%s\n\n%s\n", spec.Usage, documentsCLIHelp[action])
	}
	return help
}()

func cmdDocumentsCLI(args []string, out io.Writer) error {
	help := false
	if len(args) > 0 && args[0] == "help" {
		args, help = args[1:], true
	}
	if len(args) == 0 || wantsHelp(args[:1]) {
		_, err := fmt.Fprint(out, documentsHelp)
		return err
	}
	action := args[0]
	for _, spec := range documentsCLICapabilities {
		if action == spec.Argv[2] {
			if help || wantsHelp(args[1:]) {
				_, err := fmt.Fprint(out, documentsActionHelp[action])
				return err
			}
			return runDocumentsCLI(spec, args[1:], out)
		}
	}
	return fmt.Errorf("unknown documents command %q\n\n%s", action, documentsHelp)
}

func runDocumentsCLI(spec cliCapabilitySpec, args []string, out io.Writer) error {
	if !documentsEnabledFromEnv() {
		return errors.New(documentsOffMessage("orbit " + strings.Join(spec.Argv[1:], " ")))
	}
	fs := newCLIFlagSet(strings.Join(spec.Argv, " "))
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	var cursor *string
	if spec.Tool == "documents_list" {
		cursor = fs.String("cursor", "", "nextCursor from the previous page")
	}
	var deleteExtra, wait *bool
	if spec.Tool == "documents_sync" {
		deleteExtra = fs.Bool("delete", false, "move Documents files the directory no longer has to Trash")
		wait = fs.Bool("wait", false, "run the sync in the foreground")
	}
	positionals, err := parseInterspersed(fs, args)
	if err != nil {
		return err
	}
	if spec.Tool == "documents_sync" {
		if len(positionals) != 2 {
			return fmt.Errorf("usage: %s", spec.Usage)
		}
		return runDocumentsSyncCLI(positionals[0], positionals[1], *deleteExtra, *wait, *jsonOut, out)
	}
	toolArgs := map[string]interface{}{}
	switch spec.Tool {
	case "documents_put", "documents_move":
		if len(positionals) != 2 {
			return fmt.Errorf("usage: %s", spec.Usage)
		}
		if spec.Tool == "documents_put" {
			toolArgs["localPath"], toolArgs["path"] = positionals[0], positionals[1]
		} else {
			toolArgs["from"], toolArgs["to"] = positionals[0], positionals[1]
		}
	case "documents_list":
		if len(positionals) > 1 {
			return fmt.Errorf("usage: %s", spec.Usage)
		}
		if len(positionals) == 1 {
			toolArgs["path"] = positionals[0]
		}
		toolArgs["cursor"] = *cursor
	default:
		if len(positionals) != 1 {
			return fmt.Errorf("usage: %s", spec.Usage)
		}
		toolArgs["path"] = positionals[0]
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := runDocumentsTool(t, fileToolContext{sessionID: strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID"))}, spec.Tool, toolArgs)
	if err != nil {
		return err
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// runDocumentsSyncCLI is `orbit documents sync`: without --wait it starts the background job and prints its receipt; with
// it, it syncs here, printing a progress line every few seconds and the summary last. A signal ends it as STOPPED, which
// the owner's tray shows.
func runDocumentsSyncCLI(localDir, dest string, deleteExtra, wait, jsonOut bool, out io.Writer) error {
	sessionID := strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID"))
	if !wait {
		raw, err := startDocumentsSyncJob(sessionID, localDir, dest, deleteExtra)
		if err != nil {
			return err
		}
		return writeCLIRawJSON(out, raw, jsonOut)
	}
	source, err := documentsSyncSource(sessionID, localDir)
	if err != nil {
		return err
	}
	dest, err = documentsSyncDest(dest, deleteExtra)
	if err != nil {
		return err
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	summary, err := runDocumentsSync(ctx, t, documentsSyncOptions{sessionID: sessionID, source: source, dest: dest, deleteExtra: deleteExtra, out: out})
	raw, _ := json.Marshal(summary)
	if writeErr := writeCLIRawJSON(out, raw, true); writeErr != nil {
		return writeErr
	}
	switch {
	case err != nil:
		return fmt.Errorf("documents sync did not finish: %w", err)
	case summary.FailedCount > 0:
		return fmt.Errorf("documents sync: %d file(s) did not upload; the rest are in %s", summary.FailedCount, dest)
	}
	return nil
}
