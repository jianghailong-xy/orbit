package main

import (
	"sort"
	"strings"
	"testing"
)

// Tools that deliberately have no CLI command. permission_prompt is the runtime's live approval
// bridge — Claude calls it mid-turn over MCP and nobody types it — so it is the one tool the
// parity check below must not demand.
var cliParityExemptTools = map[string]string{
	"permission_prompt": "runtime approval bridge, called by the engine mid-turn",
}

// Params whose CLI spelling is not the mechanical --kebab-case of the MCP name.
var cliParityParamAlias = map[string]string{
	"dependsOnTaskId":  "--depends-on",
	"dependsOnTaskIds": "--depends-on",
	// Singular at a terminal, like --depends-on above: one flag carries one label and repeats,
	// which is also what makes a label containing a comma expressible.
	"labels": "--label",
	// One array of {op, taskId, dependsOnTaskId} over MCP; at a terminal the same batch is typed
	// as repeated --add A:B / --remove C:D, because nobody hand-writes JSON into a flag.
	"ops": "--add",
}

// The CLI and the MCP server are two doors onto the same API, and `orbit capabilities` is what an
// agent reads to find the CLI one. So every tool must have a command, and every parameter must be
// named in that command's documented arguments — this is exactly what drifted when session_create
// grew `provider` and `permissionMode` and the hand-written argument list kept quiet about them.
func TestCLICapabilitiesCoverEveryMCPToolAndParameter(t *testing.T) {
	specs := map[string]cliCapabilitySpec{}
	for _, list := range [][]cliCapabilitySpec{baseCLICapabilities, providerCLICapabilities, projectCLICapabilities, notifyCLICapabilities, sessionCLICapabilities, agentCLICapabilities} {
		for _, spec := range list {
			specs[spec.Tool] = spec
		}
	}

	for _, descriptor := range toolDescriptors(true, true) {
		name, _ := descriptor["name"].(string)
		if _, exempt := cliParityExemptTools[name]; exempt {
			if _, present := specs[name]; present {
				t.Errorf("%s is documented as CLI-exempt but has a command", name)
			}
			continue
		}
		spec, ok := specs[name]
		if !ok {
			t.Errorf("MCP tool %q has no CLI command; add one or record why it is exempt", name)
			continue
		}
		documented := strings.Join(spec.Arguments, " ")
		schema, _ := descriptor["inputSchema"].(map[string]interface{})
		props, _ := schema["properties"].(map[string]interface{})
		for _, param := range sortedParamNames(props) {
			if !cliDocumentsParam(documented, param) {
				t.Errorf("%s does not document MCP parameter %q: %v", name, param, spec.Arguments)
			}
		}
	}
}

// A parameter counts as documented when the arguments name its flag (--kebab-case), its
// positional form ([kebab-case]), or the alias the CLI deliberately uses instead.
func cliDocumentsParam(documented, param string) bool {
	kebab := kebabCase(param)
	if strings.Contains(documented, "--"+kebab) || strings.Contains(documented, "["+kebab+"]") {
		return true
	}
	alias, ok := cliParityParamAlias[param]
	return ok && strings.Contains(documented, alias)
}

func kebabCase(s string) string {
	var b strings.Builder
	for i, r := range s {
		if r >= 'A' && r <= 'Z' {
			if i > 0 {
				b.WriteByte('-')
			}
			b.WriteRune(r + ('a' - 'A'))
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

func sortedParamNames(m map[string]interface{}) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
