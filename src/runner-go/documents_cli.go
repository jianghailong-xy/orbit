package main

import (
	"fmt"
	"io"
	"os"
	"strings"
)

const documentsHelp = `orbit documents — work with the owner's Documents

Usage:
  orbit documents put <local-path> <path> [--json]
  orbit documents get <path> [--json]
  orbit documents ls [path] [--cursor CURSOR] [--json]
  orbit documents mv <from> <to> [--json]
  orbit documents rm <path> [--json]

Use orbit documents <command> --help for details. orbit drive is the same command under its old name.
`

var documentsCLIHelp = map[string]string{
	"put": "Copy a file from this session's checkout or uploads directory to the drive. Overwriting keeps the previous version. " +
		"The file is sent in 8 MiB chunks and has no size limit: file_upload's 25 MiB cap does not apply here.",
	"get": "Download a drive file into this session's uploads directory and return its local path.",
	"ls":  "List one page of a drive folder. With no path, list the root.",
	"mv":  "Move or rename a drive entry. This overwrites an existing file at the destination.",
	"rm":  "Move a drive entry to the owner's Trash. The owner can restore it from the Documents page. Agents cannot see Trash.",
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
	fs := newCLIFlagSet(strings.Join(spec.Argv, " "))
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	var cursor *string
	if spec.Tool == "documents_list" {
		cursor = fs.String("cursor", "", "nextCursor from the previous page")
	}
	positionals, err := parseInterspersed(fs, args)
	if err != nil {
		return err
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
