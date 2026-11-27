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

const driveHelp = `orbit drive — work with the owner's Drive

Usage:
  orbit drive put <local-path> <path> [--json]
  orbit drive get <path> [--json]
  orbit drive ls [path] [--cursor CURSOR] [--json]
  orbit drive mv <from> <to> [--json]
  orbit drive rm <path> [--json]
  orbit drive sync <local-dir> <path> [--delete] [--wait] [--json]

Use orbit drive <command> --help for details. orbit documents is the same command under the name it had while Drive
was called Documents.
`

var driveCLIHelp = map[string]string{
	"put": "Copy a file from this session's checkout or uploads directory to the drive. Overwriting keeps the previous version. " +
		"The file is sent in 8 MiB chunks and has no size limit: file_upload's 25 MiB cap does not apply here.",
	"get": "Download a drive file into this session's uploads directory and return its local path.",
	"ls":  "List one page of a drive folder. With no path, list the root.",
	"mv":  "Move or rename a drive entry. This overwrites an existing file at the destination.",
	"rm":  "Move a drive entry to the owner's Trash. The owner can restore it from the Drive page. Agents cannot see Trash.",
	"sync": "Copy a directory of this session's checkout or uploads directory into a Drive folder, once, in the background: " +
		"it answers with a background job id at once, and the job wakes you when it ends, its last output line the summary. " +
		"Files already the same in Drive are skipped, so running it again only sends what changed. One way: nothing " +
		"comes down. --delete moves Drive files the directory no longer has to the owner's Trash. --wait runs it in the " +
		"foreground instead. The owner watches it in the Drive page's upload tray.",
}

var driveCLICapabilities = []cliCapabilitySpec{
	{Tool: "drive_put", Argv: []string{"orbit", "drive", "put"}, Usage: "orbit drive put <local-path> <path> [--json]",
		Arguments: []string{"[local-path] (required)", "[path] (required)", "--json"}, Mutates: true, SessionOnly: true},
	{Tool: "drive_get", Argv: []string{"orbit", "drive", "get"}, Usage: "orbit drive get <path> [--json]",
		Arguments: []string{"[path] (required)", "--json"}, SessionOnly: true},
	{Tool: "drive_list", Argv: []string{"orbit", "drive", "ls"}, Usage: "orbit drive ls [path] [--cursor CURSOR] [--json]",
		Arguments: []string{"[path]", "--cursor <cursor>", "--json"}},
	{Tool: "drive_move", Argv: []string{"orbit", "drive", "mv"}, Usage: "orbit drive mv <from> <to> [--json]",
		Arguments: []string{"[from] (required)", "[to] (required)", "--json"}, Mutates: true},
	{Tool: "drive_delete", Argv: []string{"orbit", "drive", "rm"}, Usage: "orbit drive rm <path> [--json]",
		Arguments: []string{"[path] (required)", "--json"}, Mutates: true},
	{Tool: "drive_sync", Argv: []string{"orbit", "drive", "sync"}, Usage: "orbit drive sync <local-dir> <path> [--delete] [--wait] [--json]",
		Arguments: []string{"[local-path] (required)", "[path] (required)", "--delete", "--wait", "--json"}, Mutates: true, SessionOnly: true},
}

var driveActionHelp = func() map[string]string {
	help := make(map[string]string, len(driveCLICapabilities))
	for _, spec := range driveCLICapabilities {
		action := spec.Argv[2]
		help[action] = fmt.Sprintf("%s\n\n%s\n", spec.Usage, driveCLIHelp[action])
	}
	return help
}()

func cmdDriveCLI(args []string, out io.Writer) error {
	help := false
	if len(args) > 0 && args[0] == "help" {
		args, help = args[1:], true
	}
	if len(args) == 0 || wantsHelp(args[:1]) {
		_, err := fmt.Fprint(out, driveHelp)
		return err
	}
	action := args[0]
	for _, spec := range driveCLICapabilities {
		if action == spec.Argv[2] {
			if help || wantsHelp(args[1:]) {
				_, err := fmt.Fprint(out, driveActionHelp[action])
				return err
			}
			return runDriveCLI(spec, args[1:], out)
		}
	}
	return fmt.Errorf("unknown drive command %q\n\n%s", action, driveHelp)
}

func runDriveCLI(spec cliCapabilitySpec, args []string, out io.Writer) error {
	if !documentsEnabledFromEnv() {
		return errors.New(documentsOffMessage("orbit " + strings.Join(spec.Argv[1:], " ")))
	}
	fs := newCLIFlagSet(strings.Join(spec.Argv, " "))
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	var cursor *string
	if spec.Tool == "drive_list" {
		cursor = fs.String("cursor", "", "nextCursor from the previous page")
	}
	var deleteExtra, wait *bool
	var syncID *string
	if spec.Tool == "drive_sync" {
		deleteExtra = fs.Bool("delete", false, "move Drive files the directory no longer has to Trash")
		wait = fs.Bool("wait", false, "run the sync in the foreground")
		// The record drive_sync opened for this job before starting it; not for people.
		syncID = fs.String("sync-id", "", "the sync record to report into")
	}
	positionals, err := parseInterspersed(fs, args)
	if err != nil {
		return err
	}
	if spec.Tool == "drive_sync" {
		if len(positionals) != 2 {
			return fmt.Errorf("usage: %s", spec.Usage)
		}
		return runDriveSyncCLI(positionals[0], positionals[1], *deleteExtra, *wait, *syncID, *jsonOut, out)
	}
	toolArgs := map[string]interface{}{}
	switch spec.Tool {
	case "drive_put", "drive_move":
		if len(positionals) != 2 {
			return fmt.Errorf("usage: %s", spec.Usage)
		}
		if spec.Tool == "drive_put" {
			toolArgs["localPath"], toolArgs["path"] = positionals[0], positionals[1]
		} else {
			toolArgs["from"], toolArgs["to"] = positionals[0], positionals[1]
		}
	case "drive_list":
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
	raw, err := runDriveTool(t, fileToolContext{sessionID: strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID"))}, spec.Tool, toolArgs)
	if err != nil {
		return err
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}

// runDriveSyncCLI is `orbit drive sync`: without --wait it starts the background job and prints its receipt; with
// it, it syncs here, printing a progress line every few seconds and the summary last. A signal ends it as STOPPED, which
// the owner's tray shows.
func runDriveSyncCLI(localDir, dest string, deleteExtra, wait bool, syncID string, jsonOut bool, out io.Writer) error {
	sessionID := strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID"))
	if !wait {
		t, _ := cliTransport() // without one, the job opens its own record
		raw, err := startDriveSyncJob(t, sessionID, localDir, dest, deleteExtra)
		if err != nil {
			return err
		}
		return writeCLIRawJSON(out, raw, jsonOut)
	}
	source, err := driveSyncSource(sessionID, localDir)
	if err != nil {
		return err
	}
	dest, err = driveSyncDest(dest, deleteExtra)
	if err != nil {
		return err
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	summary, err := runDriveSync(ctx, t, driveSyncOptions{sessionID: sessionID, source: source, dest: dest, deleteExtra: deleteExtra, syncID: strings.TrimSpace(syncID), out: out})
	raw, _ := json.Marshal(summary)
	if writeErr := writeCLIRawJSON(out, raw, true); writeErr != nil {
		return writeErr
	}
	switch {
	case err != nil:
		return fmt.Errorf("drive sync did not finish: %w", err)
	case summary.FailedCount > 0:
		return fmt.Errorf("drive sync: %d file(s) did not upload; the rest are in %s", summary.FailedCount, dest)
	}
	return nil
}
