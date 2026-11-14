package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The operation catalogue is the one authority for what an agent may call and what a caller may
// expect. These tests are the force that keeps the two surfaces, the risk metadata and the public
// document from drifting away from it:
//
//   - every advertised tool and capability is a catalog row, and every row is advertised;
//   - each surface's name, description, schema, argv and usage is the catalog's own;
//   - every row states the object, intent, risk, approval, mutation, idempotency, retry,
//     success evidence and returns a caller must be able to rely on;
//   - every advertised argv and helpArgv really executes through the CLI's own router;
//   - the capabilities document carries the catalog version and content hash, and every legacy
//     field it had before the catalogue still reads the same;
//   - docs/operation-catalog.md is the catalogue rendered, not a second description of it.

// catalogFullestCLIContext is the session context with both optional surfaces switched on, i.e.
// the one that advertises the most capabilities.
func catalogFullestCLIContext(t *testing.T) {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	t.Setenv("ORBIT_SESSION_ID", "catalog-test-session")
	t.Setenv("ORBIT_AGENT_ID", "catalog-test-agent")
	t.Setenv("ORBIT_TASK_ID", "")
	t.Setenv(envMCPOrchestration, "true")
	t.Setenv(envOrchestrationToken, "catalog-test-token")
	t.Setenv(envWatches, "on")
	t.Setenv(envWiki, "on")
	t.Setenv("ORBIT_USER_TOKEN", "")
	t.Setenv("ORBIT_SERVICE_TOKEN", "")
}

func catalogHasOperation(t *testing.T, tool string) *operation {
	t.Helper()
	op := catalogOperation(tool)
	if op == nil {
		t.Fatalf("%s is advertised but is not a row of the operation catalogue", tool)
	}
	return op
}

func TestMCPToolListIsProjectedFromCatalog(t *testing.T) {
	built := operationCatalog()
	for _, permissionPrompt := range []bool{false, true} {
		for _, orchestration := range []bool{false, true} {
			got := toolDescriptors(permissionPrompt, orchestration)
			want := make([]*operation, 0, len(built.Ops))
			for _, op := range built.Ops {
				if op.MCP == nil {
					continue
				}
				if op.Gate == gateOrchestration && !orchestration {
					continue
				}
				if op.Gate == gatePermissionPrompt && !permissionPrompt {
					continue
				}
				want = append(want, op)
			}
			if len(got) != len(want) {
				t.Fatalf("tools/list(permissionPrompt=%v, orchestration=%v) has %d tools, the catalogue declares %d",
					permissionPrompt, orchestration, len(got), len(want))
			}
			for i, descriptor := range got {
				op := want[i]
				expected := map[string]interface{}{
					"name":        op.Tool,
					"description": op.MCP.Description,
					"inputSchema": op.MCP.InputSchema,
				}
				for key, value := range op.MCP.Extra {
					expected[key] = value
				}
				// One descriptor is narrowed to this machine at projection time: the catalogue
				// keeps the whole permission-mode contract, the tool list offers what can run here.
				if op.Tool == "session_create" {
					expected = applyPermissionModeOffer(expected)
				}
				if !reflect.DeepEqual(descriptor, expected) {
					t.Errorf("tools/list[%d] for %q is not the catalogue's descriptor (extra keys included)", i, op.Tool)
				}
			}
			// The other direction: a tool the catalogue declares must be in this payload.
			names := map[string]bool{}
			for _, descriptor := range got {
				names[descriptor["name"].(string)] = true
			}
			for _, op := range want {
				if !names[op.Tool] {
					t.Errorf("%s is in the catalogue but not in tools/list", op.Tool)
				}
			}
		}
	}
}

func TestCLICapabilitiesAreProjectedFromCatalog(t *testing.T) {
	catalogFullestCLIContext(t)
	doc := buildCLICapabilities("/opt/orbit")
	if doc.CatalogVersion != operationCatalogVersion {
		t.Errorf("capabilities catalogVersion = %q, want %q", doc.CatalogVersion, operationCatalogVersion)
	}
	if doc.CatalogHash != operationCatalog().Hash {
		t.Errorf("capabilities catalogHash = %q, want the catalogue's own %q", doc.CatalogHash, operationCatalog().Hash)
	}
	seen := map[string]bool{}
	for _, capability := range doc.Capabilities {
		op := catalogHasOperation(t, capability.ID)
		if op.CLI == nil {
			t.Errorf("%s is advertised by the CLI but the catalogue gives it no command", capability.ID)
			continue
		}
		if seen[capability.ID] {
			t.Errorf("%s is advertised twice", capability.ID)
		}
		seen[capability.ID] = true

		wantArgv := append([]string{"/opt/orbit"}, op.CLI.Argv[1:]...)
		if strings.Join(capability.Argv, "\x00") != strings.Join(wantArgv, "\x00") {
			t.Errorf("%s argv = %v, catalogue says %v", capability.ID, capability.Argv, wantArgv)
		}
		wantHelp := append(append([]string{}, capability.Argv...), "--help")
		if strings.Join(capability.HelpArgv, "\x00") != strings.Join(wantHelp, "\x00") {
			t.Errorf("%s helpArgv = %v, want argv + --help", capability.ID, capability.HelpArgv)
		}
		if capability.Usage != op.CLI.Usage {
			t.Errorf("%s usage = %q, catalogue says %q", capability.ID, capability.Usage, op.CLI.Usage)
		}
		if strings.Join(capability.Arguments, "\x00") != strings.Join(runtimeCLIArguments(op), "\x00") {
			t.Errorf("%s arguments are not the catalogue's", capability.ID)
		}
		if capability.Mutates != op.Mutates {
			t.Errorf("%s mutates=%v, catalogue says %v", capability.ID, capability.Mutates, op.Mutates)
		}
		wantDescription := ""
		if op.MCP != nil {
			wantDescription = op.MCP.Description
		}
		if op.CLI.Description != "" {
			wantDescription = op.CLI.Description
		}
		if capability.Description != wantDescription {
			t.Errorf("%s description is not the catalogue's description", capability.ID)
		}
		var wantSchema map[string]interface{}
		if op.MCP != nil {
			wantSchema = op.MCP.InputSchema
			if op.Tool == "session_create" {
				wantSchema = applyPermissionModeOffer(map[string]interface{}{"inputSchema": wantSchema})["inputSchema"].(map[string]interface{})
			}
		} else {
			wantSchema = op.CLI.InputSchema
		}
		if !reflect.DeepEqual(capability.MCPInputSchema, wantSchema) {
			t.Errorf("%s mcpInputSchema is not the catalogue's schema", capability.ID)
		}
		if capability.Object != op.Object || capability.Intent != op.Intent ||
			capability.Risk != op.Risk || capability.Approval != op.Approval ||
			capability.ApprovalKey != op.ApprovalKey || capability.ApprovalDetail != op.ApprovalDetail ||
			capability.Destructive != op.Destructive || capability.Idempotency != op.Idempotency ||
			capability.Retry != op.Retry || capability.SuccessEvidence != op.SuccessEvidence ||
			capability.NextStep != op.NextStep || capability.Returns != op.Returns ||
			capability.Availability != op.availability() {
			t.Errorf("%s metadata on the capability is not the catalogue's metadata", capability.ID)
		}
	}
	// Every command the catalogue declares for this context is advertised. The person's own
	// account commands are HeadlessOnly, so the fullest session context must not carry them.
	for _, op := range operationCatalog().Ops {
		if op.CLI == nil || op.CLIFamily == "account" {
			continue
		}
		if !seen[op.Tool] {
			t.Errorf("%s has a CLI command in the catalogue but the fullest capabilities document does not advertise it", op.Tool)
		}
	}
	for id := range seen {
		if op := catalogOperation(id); op == nil || op.CLI == nil {
			t.Errorf("%s is advertised but is not a CLI command of the catalogue", id)
		}
	}
}

func TestEveryOperationHasCatalogMetadata(t *testing.T) {
	validObjects := map[operationObject]bool{
		objectTask: true, objectTaskList: true, objectProject: true, objectSession: true,
		objectAgent: true, objectRunner: true, objectProvider: true, objectWatch: true,
		objectWiki: true, objectFile: true, objectOwner: true, objectAccount: true,
		objectBackgroundJob: true, objectPermission: true, objectMergeReceipt: true, objectCatalog: true,
	}
	validRisks := map[operationRisk]bool{riskLow: true, riskMedium: true, riskHigh: true}
	validApprovals := map[operationApproval]bool{approvalKindNone: true, approvalKindCard: true, approvalKindOwner: true}
	validIdempotency := map[operationIdempotency]bool{
		idempotencyRead: true, idempotencyCallerKey: true, idempotencyServerKey: true, idempotencyNone: true,
	}
	if len(operationCatalog().Ops) == 0 {
		t.Fatal("the operation catalogue is empty")
	}
	for _, op := range operationCatalog().Ops {
		if op.MCP == nil && op.CLI == nil {
			t.Errorf("%s is declared with neither a tool nor a command", op.Tool)
			continue
		}
		if !validObjects[op.Object] {
			t.Errorf("%s has object %q, which is not one of the catalogue's objects", op.Tool, op.Object)
		}
		if strings.TrimSpace(op.Intent) == "" {
			t.Errorf("%s states no user intent", op.Tool)
		}
		if !validRisks[op.Risk] {
			t.Errorf("%s has risk %q", op.Tool, op.Risk)
		}
		if !validApprovals[op.Approval] {
			t.Errorf("%s has approval %q", op.Tool, op.Approval)
		}
		if !validIdempotency[op.Idempotency] {
			t.Errorf("%s has idempotency %q", op.Tool, op.Idempotency)
		}
		if strings.TrimSpace(op.Retry) == "" {
			t.Errorf("%s states no retry semantics", op.Tool)
		}
		if strings.TrimSpace(op.SuccessEvidence) == "" {
			t.Errorf("%s states no success evidence", op.Tool)
		}
		if strings.TrimSpace(op.Returns) == "" {
			t.Errorf("%s states no output document", op.Tool)
		}
		if !op.Mutates && op.Idempotency != idempotencyRead {
			t.Errorf("%s does not write but its idempotency is %q, not %q", op.Tool, op.Idempotency, idempotencyRead)
		}
		if op.Approval != approvalKindNone && op.Risk != riskHigh {
			t.Errorf("%s needs %q approval but its risk is %q, not %q", op.Tool, op.Approval, op.Risk, riskHigh)
		}
		if op.Approval == approvalKindCard && op.ApprovalKey == "" {
			t.Errorf("%s asks a card but names no approval key", op.Tool)
		}
		if op.Destructive && op.Risk != riskHigh {
			t.Errorf("%s is destructive but its risk is %q, not %q", op.Tool, op.Risk, riskHigh)
		}
		if op.MCP != nil && strings.TrimSpace(op.MCP.Description) == "" {
			t.Errorf("%s declares an MCP tool with no description", op.Tool)
		}
		if op.MCP != nil && op.MCP.InputSchema == nil {
			t.Errorf("%s declares an MCP tool with no input schema", op.Tool)
		}
		if op.CLI != nil && (len(op.CLI.Argv) < 2 || strings.TrimSpace(op.CLI.Usage) == "") {
			t.Errorf("%s declares a CLI command with no argv or usage", op.Tool)
		}
	}
}

func TestEveryDeliberateSurfaceGapIsRecorded(t *testing.T) {
	for _, op := range operationCatalog().Ops {
		switch {
		case op.MCP == nil && strings.TrimSpace(op.MCPExempt) == "":
			t.Errorf("%s has no MCP tool and no declared reason", op.Tool)
		case op.MCP == nil && op.MCPExempt != "" && op.CLI == nil:
			t.Errorf("%s is absent from both surfaces but only declares an MCP exemption", op.Tool)
		case op.MCP != nil && op.CLI == nil && strings.TrimSpace(op.CLIExempt) == "":
			t.Errorf("%s has an MCP tool but no CLI command and no declared reason", op.Tool)
		case op.MCP != nil && op.CLI != nil && (op.CLIExempt != "" || op.MCPExempt != ""):
			t.Errorf("%s declares an exemption for a surface it actually has", op.Tool)
		}
	}
	// The counts the contract's baseline called out: every MCP-only operation is one of the
	// declared exemptions, and the CLI-only set is the person's own commands plus three runner
	// verbs. A new gap has to be declared rather than appearing as silent drift.
	var mcpOnly, cliOnly []string
	for _, op := range operationCatalog().Ops {
		if op.MCP != nil && op.CLI == nil {
			mcpOnly = append(mcpOnly, op.Tool)
		}
		if op.MCP == nil && op.CLI != nil {
			cliOnly = append(cliOnly, op.Tool)
		}
	}
	sort.Strings(mcpOnly)
	sort.Strings(cliOnly)
	for _, tool := range mcpOnly {
		if op := catalogOperation(tool); op == nil || op.CLIExempt == "" {
			t.Errorf("%s is MCP-only without a declared exemption", tool)
		}
	}
	for _, tool := range cliOnly {
		if op := catalogOperation(tool); op == nil || op.MCPExempt == "" {
			t.Errorf("%s is CLI-only without a declared exemption", tool)
		}
	}
}

// TestEveryCardApprovalKeyIsUsedByTheCode keeps the approval metadata honest: a row that says the
// owner is asked on a card names the key the server matches that card by, and the runner code really
// files a card under that key. A renamed or invented key would otherwise sit in the catalogue
// describing an approval nobody is ever asked.
func TestEveryCardApprovalKeyIsUsedByTheCode(t *testing.T) {
	matches, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	var source strings.Builder
	for _, path := range matches {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		source.Write(body)
	}
	seen := map[string]string{}
	for _, op := range operationCatalog().Ops {
		if op.Approval != approvalKindCard {
			continue
		}
		if prior, dup := seen[op.ApprovalKey]; dup {
			t.Errorf("%s and %s ask the owner on the same approval key %q", prior, op.Tool, op.ApprovalKey)
		}
		seen[op.ApprovalKey] = op.Tool
		if !strings.Contains(source.String(), `"`+op.ApprovalKey+`"`) {
			t.Errorf("%s claims a card keyed %q, but no non-test source declares that key", op.Tool, op.ApprovalKey)
		}
	}
}

// TestClaudeConfigurationNamesResolveToCatalogOperations holds the two tool names Claude is
// configured with to the catalogue: the permission bridge it calls mid-turn, and the background-job
// tool its hook matcher guards. Both are spelled through claudeToolName, so a rename in the
// catalogue cannot leave a stale mcp__orbit__ name in the engine's own configuration.
func TestClaudeConfigurationNamesResolveToCatalogOperations(t *testing.T) {
	for _, tool := range []string{"permission_prompt", "bg_run"} {
		op := catalogOperation(tool)
		if op == nil || op.MCP == nil {
			t.Errorf("Claude is configured with %s, which is not an MCP operation of the catalogue", claudeToolName(tool))
			continue
		}
		if got := claudeToolName(tool); got != "mcp__orbit__"+op.Tool {
			t.Errorf("claudeToolName(%q) = %q, but the catalogue names the operation %q", tool, got, op.Tool)
		}
	}
}

func TestCatalogHashMovesWithContentAndIsOrderIndependent(t *testing.T) {
	built := operationCatalog()
	if matched, _ := regexp.MatchString(`^[0-9a-f]{64}$`, built.Hash); !matched {
		t.Fatalf("catalogue hash %q is not a sha256 hex digest", built.Hash)
	}
	// The same rows in another order hash the same.
	shuffled := append([]*operation{}, built.Ops...)
	sort.Slice(shuffled, func(i, j int) bool { return shuffled[i].Tool > shuffled[j].Tool })
	if other := operationCatalogHash(shuffled); other != built.Hash {
		t.Fatalf("hash depends on row order: %s vs %s", other, built.Hash)
	}
	// A changed sentence is a changed catalogue.
	changed := make([]*operation, 0, len(built.Ops))
	for _, op := range built.Ops {
		copied := *op
		if copied.Tool == "task_create" {
			copied.Intent += " (changed)"
		}
		changed = append(changed, &copied)
	}
	if other := operationCatalogHash(changed); other == built.Hash {
		t.Fatal("the hash did not move when an operation's description changed")
	}
}

// TestEveryAdvertisedArgvAndHelpArgvRuns executes the argv `orbit capabilities` hands an agent,
// rather than trusting that the strings resolve. For every capability in every context that
// advertises it:
//
//   - `<argv> --help` goes through the real CLI router and prints that command's leaf help (not
//     the family overview, which is the regression the leafHelpFamilies comment records);
//   - `<argv> --orbit-catalog-probe` reaches the leaf's own flag parser, so the command is really
//     routed and would really accept the flags advertised beside it. The undefined flag is
//     rejected before any network call, so nothing is written and no server is needed.
func TestEveryAdvertisedArgvAndHelpArgvRuns(t *testing.T) {
	type context struct {
		name string
		env  map[string]string
	}
	contexts := []context{
		{"session-orchestration-on", map[string]string{
			envMCPOrchestration: "true", envOrchestrationToken: "catalog-test-token", "ORBIT_SESSION_ID": "catalog-test-session",
		}},
		{"session-orchestration-off", map[string]string{
			envMCPOrchestration: "", envOrchestrationToken: "", "ORBIT_SESSION_ID": "catalog-test-session",
		}},
		{"headless", map[string]string{
			envMCPOrchestration: "", envOrchestrationToken: "", "ORBIT_SESSION_ID": "",
		}},
	}
	overview := map[string]string{
		"task": taskHelp, "task-list": taskListHelp, "project": projectHelp, "session": sessionHelp,
		"provider": providerHelp, "agent": agentHelp, "runner": runnerHelp, "watch": watchHelp,
		"wiki": wikiHelp, "file": fileHelp,
	}
	tested := map[string]bool{}
	for _, tc := range contexts {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("ORBIT_HOME", t.TempDir())
			t.Setenv("ORBIT_AGENT_ID", "")
			t.Setenv("ORBIT_TASK_ID", "")
			t.Setenv("ORBIT_USER_TOKEN", "")
			t.Setenv("ORBIT_SERVICE_TOKEN", "")
			t.Setenv(envWatches, "on")
			t.Setenv(envWiki, "on")
			for key, value := range tc.env {
				t.Setenv(key, value)
			}
			doc := buildCLICapabilities("/opt/orbit")
			if len(doc.Capabilities) == 0 {
				t.Fatal("no capabilities advertised")
			}
			for _, capability := range doc.Capabilities {
				tested[capability.ID] = true
				t.Run(capability.ID, func(t *testing.T) {
					var helpOut, helpErr strings.Builder
					if err := runOrbitCLI(capability.HelpArgv[1:], strings.NewReader(""), &helpOut, &helpErr); err != nil {
						t.Fatalf("%s: %v", strings.Join(capability.HelpArgv, " "), err)
					}
					if strings.TrimSpace(helpOut.String()) == "" {
						t.Fatalf("%s printed no help", strings.Join(capability.HelpArgv, " "))
					}
					if len(capability.Argv) >= 3 {
						if want := overview[capability.Argv[1]]; want != "" && helpOut.String() == want {
							t.Fatalf("%s printed the family overview, not the leaf's own help", strings.Join(capability.HelpArgv, " "))
						}
					}
					probe := append(append([]string{}, capability.Argv[1:]...), "--orbit-catalog-probe")
					var out, errOut strings.Builder
					err := runOrbitCLI(probe, strings.NewReader(""), &out, &errOut)
					if err == nil {
						t.Fatalf("%s accepted an undefined flag without error", strings.Join(probe, " "))
					}
					if !strings.Contains(err.Error(), "flag provided but not defined") {
						t.Fatalf("%s did not reach its own flag parser: %v", strings.Join(probe, " "), err)
					}
				})
			}
		})
	}
	for _, op := range operationCatalog().Ops {
		if op.CLI == nil {
			continue
		}
		if !tested[op.Tool] {
			t.Errorf("%s has a CLI command that no capabilities context advertises, so its argv was never executed", op.Tool)
		}
	}
}

// TestCapabilitiesDocumentStaysBackwardCompatibleAndCarriesCatalogIdentity re-reads the emitted
// document as a consumer would: every field the pre-catalogue document carried is still there
// with the same type, and the two new document fields identify the catalogue that produced it.
func TestCapabilitiesDocumentStaysBackwardCompatibleAndCarriesCatalogIdentity(t *testing.T) {
	catalogFullestCLIContext(t)
	doc := buildCLICapabilities("/opt/orbit")
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{
		"schemaVersion", "capabilityRevision", "serverCapabilityRevision", "serverSchemaRevision",
		"contractDigest", "capabilityCount", "cliVersion", "sourceSha", "registered", "context",
		"identity", "capabilities", "catalogVersion", "catalogHash",
	} {
		if _, ok := decoded[key]; !ok {
			t.Errorf("the capabilities document no longer carries %q", key)
		}
	}
	if got := int(decoded["schemaVersion"].(float64)); got != runnerWriteSchemaRevision {
		t.Errorf("schemaVersion moved to %d; the catalogue fields are additive and must not need a schema bump", got)
	}
	if decoded["catalogVersion"] != operationCatalogVersion {
		t.Errorf("catalogVersion = %v, want %q", decoded["catalogVersion"], operationCatalogVersion)
	}
	if decoded["catalogHash"] != operationCatalog().Hash {
		t.Errorf("catalogHash is not the catalogue's hash")
	}
	capabilities, _ := decoded["capabilities"].([]interface{})
	if len(capabilities) != doc.CapabilityCount || len(capabilities) != len(doc.Capabilities) {
		t.Fatalf("capabilityCount %d, capabilities %d, document %d", doc.CapabilityCount, len(capabilities), len(doc.Capabilities))
	}
	legacy := []string{
		"id", "argv", "helpArgv", "usage", "arguments", "description", "mcpInputSchema",
		"mutates", "available",
	}
	added := []string{
		"object", "intent", "risk", "approval", "destructive", "idempotency", "retry",
		"successEvidence", "returns", "availability",
	}
	for i, entry := range capabilities {
		row, _ := entry.(map[string]interface{})
		for _, key := range legacy {
			if _, ok := row[key]; !ok {
				t.Fatalf("capability %d (%v) no longer carries the legacy field %q", i, row["id"], key)
			}
		}
		for _, key := range added {
			if _, ok := row[key]; !ok {
				t.Fatalf("capability %d (%v) does not carry the catalogue field %q", i, row["id"], key)
			}
		}
	}
}

// TestPublicCatalogDocIsGenerated holds docs/operation-catalog.md to the catalogue: the file is
// the renderer's output, byte for byte. Set ORBIT_UPDATE_CATALOG_DOC=1 to regenerate it after a
// catalogue change.
func TestPublicCatalogDocIsGenerated(t *testing.T) {
	path := filepath.Join("..", "..", "docs", "operation-catalog.md")
	// The document, and the content hash in it, must not depend on whether this runner is root:
	// the catalogue declares the whole contract and the surfaces narrow it, so CI (non-root) and a
	// root runner render the same file.
	restore := runsAsRoot
	t.Cleanup(func() { runsAsRoot = restore })
	runsAsRoot = false
	want := renderOperationCatalogMarkdown()
	runsAsRoot = true
	if asRoot := renderOperationCatalogMarkdown(); asRoot != want {
		t.Fatal("the operation catalogue's public document depends on whether the runner is root")
	}
	if os.Getenv("ORBIT_UPDATE_CATALOG_DOC") == "1" {
		if err := os.WriteFile(path, []byte(want), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (regenerate with ORBIT_UPDATE_CATALOG_DOC=1 go test -run TestPublicCatalogDocIsGenerated .)", err)
	}
	if string(got) != want {
		t.Fatalf("docs/operation-catalog.md is not the catalogue rendered (regenerate with ORBIT_UPDATE_CATALOG_DOC=1 go test -run TestPublicCatalogDocIsGenerated .)")
	}
}

// TestCatalogCoversTheContractBaselineGap pins the two counts docs/orbit-agent-contract.md §8.4
// G8 records: the MCP-only operations are all declared with a reason, and the CLI-only set is the
// seven commands whose surfaces are genuinely different (three runner-local verbs and the person's
// four account commands). A new gap must be argued, not discovered later as drift.
func TestCatalogCoversTheContractBaselineGap(t *testing.T) {
	var mcpOnly, cliOnly []string
	for _, op := range operationCatalog().Ops {
		if op.MCP != nil && op.CLI == nil {
			mcpOnly = append(mcpOnly, op.Tool)
		}
		if op.MCP == nil && op.CLI != nil {
			cliOnly = append(cliOnly, op.Tool)
		}
	}
	wantMCPOnly := []string{
		"ask_owner", "bg_kill", "bg_list", "bg_output", "bg_run", "criterion_check_report",
		"criterion_check_start", "criterion_confirm", "criterion_confirmation_withdraw",
		"integration_abandon", "integration_observe", "integration_retry", "open_item_hand_over",
		"open_item_resolve", "permission_prompt", "request_owner_action", "schedule_wakeup",
		"withdraw_owner_request",
	}
	wantCLIOnly := []string{"api", "login", "logout", "session_import", "whoami", "wiki_import", "wiki_verify"}
	sort.Strings(mcpOnly)
	sort.Strings(cliOnly)
	if strings.Join(mcpOnly, ",") != strings.Join(wantMCPOnly, ",") {
		t.Errorf("MCP-only operations changed:\n got %v\nwant %v", mcpOnly, wantMCPOnly)
	}
	if strings.Join(cliOnly, ",") != strings.Join(wantCLIOnly, ",") {
		t.Errorf("CLI-only operations changed:\n got %v\nwant %v", cliOnly, wantCLIOnly)
	}
	for _, tool := range mcpOnly {
		if op := catalogOperation(tool); op.CLIExempt == "" {
			t.Errorf("%s is MCP-only with no reason recorded", tool)
		}
	}
	for _, tool := range cliOnly {
		if op := catalogOperation(tool); op.MCPExempt == "" {
			t.Errorf("%s is CLI-only with no reason recorded", tool)
		}
	}
}

// TestCatalogOperationIDsAreUnique is the invariant every other test assumes.
func TestCatalogOperationIDsAreUnique(t *testing.T) {
	seen := map[string]bool{}
	for _, op := range operationCatalog().Ops {
		if seen[op.Tool] {
			t.Fatalf("%s is declared twice in the catalogue", op.Tool)
		}
		seen[op.Tool] = true
	}
	if len(seen) < 100 {
		t.Fatalf("the catalogue has only %d operations; the surfaces advertise more than that", len(seen))
	}
	// The count is stated so a removal is as visible as an addition.
	var surfaces int
	for _, op := range operationCatalog().Ops {
		if op.MCP != nil {
			surfaces++
		}
	}
	if surfaces < 100 {
		t.Fatalf("only %d operations have an MCP tool", surfaces)
	}
}
