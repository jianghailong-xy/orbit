package main

import (
	"fmt"
	"io"
)

// `orbit provider` — the CLI half of the MCP provider_list tool. `--provider` on a session or a
// task takes a built-in engine slug or one the owner configured, and a configured provider's slug
// is derived from its label rather than typed by anyone, so the only way to learn one used to be
// to guess and read the refusal back. This is that list.
//
// Plain runner auth, no orchestration gate: `orbit task create --provider` is available to every
// agent, so the discovery of what to pass has to be too.

const providerHelp = `orbit provider — list the providers a session or task may run on

Usage:
  orbit provider list [--json]

Run 'orbit provider list --help' for options.
`

var providerActionHelp = map[string]string{
	"list": `orbit provider list — list the provider slugs this owner may dispatch with

Usage:
  orbit provider list [--json]

Reports every slug accepted by --provider on 'orbit session create', 'orbit task create'
and 'orbit task update': the built-in engines (builtin true), plus the providers configured
on the account, each with the runtime it borrows and the models it offers. A slug that is
not on this list is refused with "provider not available".
`,
}

var providerCLICapabilities = []cliCapabilitySpec{
	{Tool: "provider_list", Argv: []string{"orbit", "provider", "list"}, Usage: "orbit provider list [--json]", Arguments: []string{"--json"}},
}

func cmdProviderCLI(args []string, out io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		_, err := fmt.Fprint(out, providerHelp)
		return err
	}
	if args[0] == "help" {
		if len(args) == 1 {
			_, err := fmt.Fprint(out, providerHelp)
			return err
		}
		h, ok := providerActionHelp[args[1]]
		if !ok {
			return fmt.Errorf("unknown command %q", args[1])
		}
		_, err := fmt.Fprint(out, h)
		return err
	}
	action := args[0]
	h, known := providerActionHelp[action]
	if !known {
		return fmt.Errorf("unknown command %q\n\n%s", action, providerHelp)
	}
	if wantsHelp(args[1:]) {
		_, err := fmt.Fprint(out, h)
		return err
	}
	return cliProviderList(args[1:], out)
}

func cliProviderList(args []string, out io.Writer) error {
	fs := newCLIFlagSet("orbit provider list")
	jsonOut := fs.Bool("json", false, "emit compact JSON")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if err := rejectTrailing(fs); err != nil {
		return err
	}
	t, err := cliTransport()
	if err != nil {
		return err
	}
	raw, err := t.listProviders()
	if err != nil {
		return fmt.Errorf("list providers: %w", err)
	}
	return writeCLIRawJSON(out, raw, *jsonOut)
}
