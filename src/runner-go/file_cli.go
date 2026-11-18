package main

import (
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
)

// `orbit file upload|fetch|list`: the CLI half of the file tools (file_tools.go), for shell composition and for an
// engine with no MCP. Upload, fetch and pin act for the session they run in, so they have no form at a terminal outside
// one and are listed only inside one. Listing names what it lists, so it runs anywhere the runner credential does.

const fileHelp = `orbit file — keep files in Orbit instead of in the repository

Usage:
  orbit file upload <path> [--task-id ID] [--label TEXT] [--as test-report] [--pin] [--json]
  orbit file fetch <id> [--json]
  orbit file list [--task-id ID | --session-id ID | --evidence-id ID] [--json]
  orbit file pin <id> [--unpin] [--json]

Screenshots and reports go here rather than into a commit. Every file has an id, a sha256 and an
orbit-attachment: link to put in a reply. upload, fetch and pin act for the session they run in
(ORBIT_SESSION_ID): a file stays with the session that uploads it, and arrives in that session's
uploads directory, outside the checkout.
Run 'orbit file <command> --help' for options.
`

var fileActionHelp = map[string]string{
	"upload": `orbit file upload — keep a file or a folder in Orbit

Usage:
  orbit file upload <path> [--task-id ID] [--label TEXT] [--as test-report] [--pin] [--json]

Options:
  [path]                   The file or directory, absolute or relative to here. Required. Its real
                           location, links resolved, has to be inside this session's checkout or its
                           uploads directory, as with a file a reply links; anywhere else is refused,
                           so copy a file there first
  --task-id ID             The task this session is running; leaving it out means the same. A file
                           stays with the session that uploads it and counts as that session's task,
                           so any other task's id is refused: to give a file to another task as an
                           input, use task_create's attachmentIds; a folder goes file by file
  --label TEXT             What this is, in a few words (up to ` + strconv.Itoa(fileLabelMaxChars) + ` characters). On a directory
                           it is the bundle's
  --as test-report         Read one Playwright JSON or JUnit XML report and keep a summary with the
                           file, answered as "testReport": total, passed, failed, skipped, duration,
                           and failed and skipped test names. It stays after the file expires, and
                           evidence citing the file shows it. Anything else, a directory included,
                           is kept as a plain file and "note" says so
  --pin                    Keep it past the date it would expire on, as orbit file pin does
  --json

A file expires 14 days after upload unless evidence cites it; once a version citing it is sent back
or replaced, 30 days after that. Its name, size, sha256 and test summary stay; only the bytes go.

The answer has the id, sha256, sizeBytes and an orbit-attachment: link to put in a reply. A directory
becomes one folder bundle with a manifest of its relative paths, and each file is listed with its
own id. Symbolic links are not followed; they, empty files and anything else that cannot be kept are
listed under "skipped". One file may be 25 MiB and a folder ` + strconv.Itoa(fileBundleMaxFiles) + ` files; a folder over either is
refused whole.
`,
	"fetch": `orbit file fetch — download one of this session's files, or one evidence it judges cites

Usage:
  orbit file fetch <id> [--json]

Options:
  [id]                     The file's or the bundle's id, as upload or list gave it. Required
  --json

Saves the file in this session's uploads directory, outside the checkout, and answers its absolute
path as "path". The bytes are checked against the sha256 Orbit holds. Given a folder bundle's id, it
saves the manifest and lists the bundle's files with their ids, so that you fetch only the ones you
need.
`,
	"list": `orbit file list — what files one task, session or evidence version has

Usage:
  orbit file list [--task-id ID | --session-id ID | --evidence-id ID] [--json]

Options:
  --task-id ID             This task's files: its inputs, and what the sessions that ran it kept
                           with file_upload
  --session-id ID          This session's files
  --evidence-id ID         This evidence version's files
  --json

Newest first, each with its id, sha256, sizeBytes and orbit-attachment: link. With none of the three
it lists the session it runs in. A folder is one row of kind "bundle": fetch it for the files
inside. This says what exists; fetch reads this session's own files and those cited by evidence it
judges.
`,
	"pin": `orbit file pin — keep a file past the date it would expire on

Usage:
  orbit file pin <id> [--unpin] [--json]

Options:
  [id]                     The file's or the bundle's id, as upload or list gave it. Required
  --unpin                  Take the pin away. If its date has passed, the file expires at the next
                           cleanup, within the hour
  --json

One of this session's own files, or one cited by evidence it judges. A bundle's id covers the files
in it. Pinning an expired file brings it back while its bytes are still kept, and says so if they
have gone.
`,
}

func cmdFileCLI(args []string, out io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		_, err := fmt.Fprint(out, fileHelp)
		return err
	}
	if args[0] == "help" {
		if len(args) == 1 {
			_, err := fmt.Fprint(out, fileHelp)
			return err
		}
		h, ok := fileActionHelp[args[1]]
		if !ok {
			return fmt.Errorf("unknown command %q", args[1])
		}
		_, err := fmt.Fprint(out, h)
		return err
	}
	action := args[0]
	h, known := fileActionHelp[action]
	if !known {
		return fmt.Errorf("unknown command %q\n\n%s", action, fileHelp)
	}
	if wantsHelp(args[1:]) {
		_, err := fmt.Fprint(out, h)
		return err
	}
	fs := newCLIFlagSet("orbit file " + action)
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	var taskID, label, as, sessionID, evidenceID *string
	var pin, unpin *bool
	switch action {
	case "upload":
		taskID = fs.String("task-id", "", "this session's own task")
		label = fs.String("label", "", "what this is")
		as = fs.String("as", "", "test-report: keep a summary of this report")
		pin = fs.Bool("pin", false, "keep it past the date it would expire on")
	case "pin":
		unpin = fs.Bool("unpin", false, "take the pin away")
	case "list":
		taskID = fs.String("task-id", "", "this task's files")
		sessionID = fs.String("session-id", "", "this session's files")
		evidenceID = fs.String("evidence-id", "", "this evidence version's files")
	}
	positionals, err := parseInterspersed(fs, args[1:])
	if err != nil {
		return err
	}
	toolArgs := map[string]interface{}{}
	var tool string
	switch action {
	case "upload":
		if len(positionals) != 1 {
			return fmt.Errorf("orbit file upload takes one path: %s", fileActionHelp["upload"])
		}
		tool = "file_upload"
		toolArgs["path"], toolArgs["taskId"], toolArgs["label"], toolArgs["as"], toolArgs["pin"] = positionals[0], *taskID, *label, *as, *pin
	case "pin":
		if len(positionals) != 1 {
			return fmt.Errorf("orbit file pin takes one id: %s", fileActionHelp["pin"])
		}
		tool = "file_pin"
		toolArgs["id"], toolArgs["unpin"] = positionals[0], *unpin
	case "fetch":
		if len(positionals) != 1 {
			return fmt.Errorf("orbit file fetch takes one id: %s", fileActionHelp["fetch"])
		}
		tool = "file_fetch"
		toolArgs["id"] = positionals[0]
	case "list":
		if len(positionals) != 0 {
			return fmt.Errorf("unexpected arguments: %s", strings.Join(positionals, " "))
		}
		tool = "file_list"
		toolArgs["taskId"], toolArgs["sessionId"], toolArgs["evidenceId"] = *taskID, *sessionID, *evidenceID
	default:
		panic("unreachable file command")
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := runFileTool(t, fileToolContext{sessionID: strings.TrimSpace(os.Getenv("ORBIT_SESSION_ID"))}, tool, toolArgs)
	if err != nil {
		return err
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}
