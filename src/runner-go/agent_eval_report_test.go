package main

// The agent-contract eval's report (docs/agent-contract-eval.md §Report): one JSON document per eval, in a shape
// that does not change between runs (reportVersion), so two reports compare cell by cell — a scenario on one engine
// and model — and metric by metric. It records what the contract needs to judge and nothing a person typed: the
// suite and contract versions it was graded with, the engines it ran, each run's verdict and clauses, the
// low-sensitivity call log and the metrics production's own telemetry observer computes from the run's events
// (agent_contract_telemetry.go). A markdown rendering sits beside it for a person.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"
)

const (
	evalReportVersion = 1
	evalReportKind    = "orbit.agent-contract-eval"
)

// evalSupportedEngine is one engine of the supported matrix the contract publishes (contracts/orbit-agent.contract.json
// eval.supportedMatrix): the versions a report has measured and the modes it covers.
type evalSupportedEngine struct {
	Engine   string   `json:"engine"`
	Versions []string `json:"versions"`
	Models   []string `json:"models"`
	Modes    []string `json:"modes"`
}

// evalGateRules is the release gate's arithmetic (contract eval.gate).
type evalGateRules struct {
	// A cell passes when at least PassNumerator/PassDenominator of its runs pass.
	PassNumerator   int `json:"passNumerator"`
	PassDenominator int `json:"passDenominator"`
	// A metric moving by more than this fraction against the baseline is a warning.
	MetricWarnFraction float64 `json:"metricWarnFraction"`
}

type evalContractIndex struct {
	ContractVersion string `json:"contractVersion"`
	Eval            struct {
		ReportVersion   int                   `json:"reportVersion"`
		SupportedMatrix []evalSupportedEngine `json:"supportedMatrix"`
		Gate            evalGateRules         `json:"gate"`
		Scenarios       []string              `json:"scenarios"`
	} `json:"eval"`
}

func readEvalContractIndex() (evalContractIndex, error) {
	var idx evalContractIndex
	raw, err := os.ReadFile(filepath.Join("..", "..", "contracts", "orbit-agent.contract.json"))
	if err != nil {
		return idx, err
	}
	err = json.Unmarshal(raw, &idx)
	return idx, err
}

// evalSupportedMatrix is the supported matrix, as the contract's index publishes it.
func evalSupportedMatrix() []evalSupportedEngine {
	idx, err := readEvalContractIndex()
	if err != nil {
		return nil
	}
	return idx.Eval.SupportedMatrix
}

func evalGate() evalGateRules {
	idx, err := readEvalContractIndex()
	if err != nil || idx.Eval.Gate.PassDenominator == 0 {
		return evalGateRules{PassNumerator: 2, PassDenominator: 3, MetricWarnFraction: 0.5}
	}
	return idx.Eval.Gate
}

// ── The report ───────────────────────────────────────────────────────────────────────────────────────

// evalSkip is a scenario not played on an engine of this machine, and why (evalNotApplicable).
type evalSkip struct {
	Scenario string `json:"scenario"`
	Engine   string `json:"engine"`
	Reason   string `json:"reason"`
}

type evalReport struct {
	ReportVersion int                `json:"reportVersion"`
	Kind          string             `json:"kind"`
	GeneratedAt   string             `json:"generatedAt"`
	Source        evalReportSource   `json:"source"`
	Contract      evalReportContract `json:"contract"`
	Suite         evalReportSuite    `json:"suite"`
	Matrix        []evalMatrixEntry  `json:"matrix"`
	Runs          []evalRunReport    `json:"runs"`
	Skipped       []evalSkip         `json:"skipped,omitempty"`
	Summary       evalSummary        `json:"summary"`
	Gate          evalGateResult     `json:"gate"`
	Comparison    *evalComparison    `json:"comparison,omitempty"`
}

type evalReportSource struct {
	RepoSHA    string `json:"repoSha,omitempty"`
	CLIVersion string `json:"cliVersion"`
}

type evalReportContract struct {
	ContractVersion string `json:"contractVersion"`
	PrimerVersion   string `json:"primerVersion"`
	CatalogVersion  string `json:"catalogVersion"`
	CatalogHash     string `json:"catalogHash"`
	GuideVersion    string `json:"guideVersion"`
	// InstructionsLeftOut is the instruction units the runs were played without (ORBIT_AGENT_EVAL_LEAVE_OUT): a
	// report with any is a measurement of those units, never a baseline of the instructions as they ship.
	InstructionsLeftOut []string `json:"instructionsLeftOut,omitempty"`
}

type evalReportSuite struct {
	Hash          string   `json:"hash"`
	ScenarioHash  string   `json:"scenarioHash"`
	GraderVersion int      `json:"graderVersion"`
	Scenarios     []string `json:"scenarios"`
}

type evalMatrixEntry struct {
	Engine        string `json:"engine"`
	EngineVersion string `json:"engineVersion"`
	Model         string `json:"model"`
	Backend       string `json:"backend"`
	// Supported says the supported matrix names this engine version; a report on one it does not is how a new
	// version qualifies (docs/agent-contract-eval.md §Version drift).
	Supported bool `json:"supported"`
}

func (m evalMatrixEntry) key() string {
	return m.Engine + "@" + m.EngineVersion + "/" + m.Model + "/" + m.Backend
}

// evalCallRecord is one Orbit call, as the report keeps it: no argument value, no answer text.
type evalCallRecord struct {
	Turn      int      `json:"turn"`
	Operation string   `json:"op"`
	Surface   string   `json:"surface"`
	Outcome   string   `json:"outcome,omitempty"`
	Code      string   `json:"code,omitempty"`
	Retry     string   `json:"retry,omitempty"`
	Fields    []string `json:"fields,omitempty"`
}

type evalRunMetrics struct {
	Turns     int `json:"turns"`
	FollowUps int `json:"followUps"`
	ToolCalls int `json:"toolCalls"`
	// OrbitCalls by surface.
	OrbitCalls     int `json:"orbitCalls"`
	OrbitCallsCLI  int `json:"orbitCallsCli"`
	OrbitWrites    int `json:"orbitWrites"`
	DiscoveryCalls int `json:"discoveryCalls"`
	// FirstOrbitSuccessStep is the tool calls from the person's first words to the first Orbit call that
	// succeeded; StepsToExpectedWrite the tool calls from the words that asked for the scenario's write to it.
	FirstOrbitSuccessStep *int             `json:"firstOrbitSuccessStep"`
	StepsToExpectedWrite  *int             `json:"stepsToExpectedWrite"`
	FailureTypes          map[string]int   `json:"failureTypes,omitempty"`
	ErrorCodes            map[string]int   `json:"errorCodes,omitempty"`
	PrivatePlanCalls      int              `json:"privatePlanCalls"`
	PlannedItems          int              `json:"plannedItems,omitempty"`
	PersistedItems        int              `json:"persistedItems,omitempty"`
	Context               evalContextBytes `json:"context"`
	Usage                 evalUsage        `json:"usage"`
}

type evalRunReport struct {
	Scenario      string             `json:"scenario"`
	Case          string             `json:"case,omitempty"`
	Engine        string             `json:"engine"`
	EngineVersion string             `json:"engineVersion"`
	Model         string             `json:"model"`
	Backend       string             `json:"backend"`
	Modes         []string           `json:"modes"`
	Repeat        int                `json:"repeat"`
	Verdict       string             `json:"verdict"`
	Harness       string             `json:"harness,omitempty"`
	Clauses       []evalClauseResult `json:"clauses"`
	Metrics       evalRunMetrics     `json:"metrics"`
	Calls         []evalCallRecord   `json:"calls"`
	DurationMs    int                `json:"durationMs"`
}

func (r evalRunReport) matrixKey() string {
	return r.Engine + "@" + r.EngineVersion + "/" + r.Model + "/" + r.Backend
}

// cellKey names a scenario on an engine and model, version aside: the unit two reports compare, so a new engine
// version reads as drift of the same cell.
func (r evalRunReport) cellKey() string {
	return r.Scenario + " | " + r.Engine + "/" + r.Model + "/" + r.Backend
}

type evalRate struct {
	Runs   int     `json:"runs"`
	Passed int     `json:"passed"`
	Failed int     `json:"failed"`
	Errors int     `json:"errors"`
	Rate   float64 `json:"rate"`
	Pass   bool    `json:"pass"`
}

type evalEngineSummary struct {
	Runs                      int              `json:"runs"`
	MedianFirstOrbitSuccess   *float64         `json:"medianFirstOrbitSuccessStep"`
	MedianStepsToExpected     *float64         `json:"medianStepsToExpectedWrite"`
	PrivatePlanNotPersisted   *float64         `json:"privatePlanNotPersistedRate"`
	PlanRunsNotFullyPersisted *float64         `json:"planRunsNotFullyPersisted"`
	FailureTypes              map[string]int   `json:"failureTypes,omitempty"`
	ErrorCodes                map[string]int   `json:"errorCodes,omitempty"`
	MedianContext             evalContextBytes `json:"medianContext"`
	Tokens                    evalUsage        `json:"tokens"`
}

type evalSummary struct {
	Runs     int                          `json:"runs"`
	Passed   int                          `json:"passed"`
	Failed   int                          `json:"failed"`
	Errors   int                          `json:"errors"`
	Cells    map[string]evalRate          `json:"cells"`
	ByEngine map[string]evalEngineSummary `json:"byEngine"`
}

type evalGateResult struct {
	Verdict string   `json:"verdict"` // PASS, FAIL, INCOMPLETE
	Reasons []string `json:"reasons,omitempty"`
	Notices []string `json:"notices,omitempty"`
}

type evalComparison struct {
	Baseline     evalBaselineRef `json:"baseline"`
	SameSuite    bool            `json:"sameSuite"`
	Regressions  []string        `json:"regressions,omitempty"`
	Improvements []string        `json:"improvements,omitempty"`
	New          []string        `json:"new,omitempty"`
	Gone         []string        `json:"gone,omitempty"`
	Warnings     []string        `json:"warnings,omitempty"`
}

type evalBaselineRef struct {
	GeneratedAt     string `json:"generatedAt"`
	RepoSHA         string `json:"repoSha,omitempty"`
	SuiteHash       string `json:"suiteHash"`
	ContractVersion string `json:"contractVersion"`
}

// ── Building it ──────────────────────────────────────────────────────────────────────────────────────

var evalSafeWhy = regexp.MustCompile(`^[A-Za-z0-9 .,:;'()<>/_\-\[\]"=+]{0,200}$`)

// evalSafeText keeps a grader's sentence only when it is the kind of sentence the graders write.
func evalSafeText(s string) string {
	if evalSafeWhy.MatchString(s) {
		return s
	}
	return "(withheld: not a grader's sentence)"
}

// evalHarnessClass is a harness failure's kind, without its text, which may hold paths or an engine's words.
func evalHarnessClass(err string) string {
	switch {
	case err == "":
		return ""
	case strings.Contains(err, "did not end within"):
		return "turn_timeout"
	case strings.HasPrefix(err, "start"):
		return "start_failed"
	case strings.HasPrefix(err, "compact"):
		return "compact_failed"
	case strings.HasPrefix(err, "resume"):
		return "resume_failed"
	case strings.HasPrefix(err, "turn"):
		return "turn_failed"
	}
	return "harness_failed"
}

// evalCallFields is the argument names a call sent that its tool declares; any other is counted as "other".
func evalCallFields(op string, input map[string]interface{}) []string {
	declared := map[string]bool{}
	if o := lookupCatalogOperation(op); o != nil {
		for name := range o.inputProperties() {
			declared[name] = true
		}
	}
	var out []string
	other := false
	for name := range input {
		if declared[name] {
			out = append(out, name)
		} else {
			other = true
		}
	}
	sort.Strings(out)
	if other {
		out = append(out, "other")
	}
	return out
}

// evalTelemetryOf runs production's telemetry observer over one log turn's events.
func evalTelemetryOf(events []evalEvent, engine, exe, mode string, orchestration bool, instructions int) *agentContractTurnTelemetry {
	obs := newAgentContractTelemetry(engine, exe, func() string { return mode }, orchestration, instructions)
	if obs == nil {
		obs = &agentContractTelemetry{engine: engine, exe: exe, mode: func() string { return mode }, orchestration: orchestration,
			instructions: instructions, turns: map[string]*telemetryTurn{}}
	}
	for _, ev := range events {
		obs.observe("eval", ev.Type, ev.Payload)
	}
	payload := obs.observe("eval", evTurnEnd, map[string]interface{}{})
	if payload == nil {
		return nil
	}
	raw, _ := json.Marshal(payload["agentContractTelemetry"])
	var sum agentContractTurnTelemetry
	if json.Unmarshal(raw, &sum) != nil {
		return nil
	}
	return &sum
}

func (r *evalRun) metrics() evalRunMetrics {
	m := evalRunMetrics{Turns: len(r.Turns), Context: r.Context}
	expectSpec := -1
	for i, turn := range r.Scenario.Turns {
		if len(turn.Expect) > 0 {
			expectSpec = i
			break
		}
	}
	stepsBefore := 0
	expectBase := -1
	for _, t := range r.Turns {
		if t.FollowUp {
			m.FollowUps++
		}
		if t.Spec == expectSpec && expectBase < 0 {
			expectBase = stepsBefore
		}
		if tel := t.Telemetry; tel != nil {
			m.OrbitCalls += tel.OrbitCalls
			m.OrbitCallsCLI += tel.OrbitCallsCLI
			m.OrbitWrites += tel.OrbitWrites
			m.DiscoveryCalls += tel.DiscoveryCalls
			m.PrivatePlanCalls += tel.PrivatePlanCalls
			if tel.FirstOrbitSuccessStep != nil && m.FirstOrbitSuccessStep == nil {
				n := stepsBefore + *tel.FirstOrbitSuccessStep
				m.FirstOrbitSuccessStep = &n
			}
			for code, n := range tel.Failures {
				if m.ErrorCodes == nil {
					m.ErrorCodes = map[string]int{}
				}
				m.ErrorCodes[code] += n
			}
		}
		if expectSpec >= 0 && t.Spec == expectSpec && m.StepsToExpectedWrite == nil {
			count := 0
			for _, s := range t.Steps {
				if s.Kind == evalStepText {
					continue
				}
				count++
				if s.Kind == evalStepOrbit && s.Receipt.Outcome == outcomeWritten && containsString(r.Scenario.Turns[expectSpec].Expect, s.Operation) {
					n := stepsBefore + count - expectBase
					m.StepsToExpectedWrite = &n
					break
				}
			}
		}
		stepsBefore += t.toolCalls()
		m.Usage.InputTokens += t.Usage.InputTokens
		m.Usage.CachedInputTokens += t.Usage.CachedInputTokens
		m.Usage.OutputTokens += t.Usage.OutputTokens
		m.Usage.DurationMs += t.Usage.DurationMs
	}
	m.ToolCalls = stepsBefore
	if strings.HasPrefix(r.Scenario.ID, "E2-private-plan") {
		m.PlannedItems = evalPlannedItems(r, 0)
		m.PersistedItems = len(r.createdIn(1))
	}
	return m
}

func (r *evalRun) report() evalRunReport {
	verdict, clauses := r.grade()
	out := evalRunReport{Scenario: r.Scenario.ID, Case: r.Scenario.Case, Engine: r.Engine, EngineVersion: r.EngineVersion,
		Model: r.Model, Backend: r.Backend, Repeat: r.Repeat, Verdict: verdict, Harness: evalHarnessClass(r.HarnessError),
		Metrics: r.metrics(), DurationMs: r.DurationMs, Calls: []evalCallRecord{}}
	for _, t := range r.Scenario.Turns {
		out.Modes = append(out.Modes, t.Mode)
	}
	for i := range clauses {
		clauses[i].Why = evalSafeText(clauses[i].Why)
		if !clauses[i].Passed {
			if out.Metrics.FailureTypes == nil {
				out.Metrics.FailureTypes = map[string]int{}
			}
			out.Metrics.FailureTypes[clauses[i].Failure]++
		}
	}
	out.Clauses = clauses
	for _, t := range r.Turns {
		for _, s := range t.Steps {
			if s.Kind != evalStepOrbit {
				continue
			}
			op := s.Operation
			if lookupCatalogOperation(op) == nil && op != "guide" && op != "capabilities" && op != "help" {
				op = "other"
			}
			rec := evalCallRecord{Turn: t.Index, Operation: op, Surface: s.Surface, Outcome: s.Receipt.Outcome, Retry: s.Receipt.Retry}
			if telemetryCode.MatchString(s.Receipt.Code) {
				rec.Code = s.Receipt.Code
			}
			if !slicesContainsString(receiptOutcomes, rec.Outcome) {
				rec.Outcome = ""
			}
			if !slicesContainsString(receiptRetryRules, rec.Retry) {
				rec.Retry = ""
			}
			if s.Surface == "mcp" {
				rec.Fields = evalCallFields(op, s.Input)
			}
			out.Calls = append(out.Calls, rec)
		}
	}
	return out
}

func slicesContainsString(list []string, s string) bool { return containsString(list, s) }

func median(values []float64) *float64 {
	if len(values) == 0 {
		return nil
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	mid := len(sorted) / 2
	m := sorted[mid]
	if len(sorted)%2 == 0 {
		m = (sorted[mid-1] + sorted[mid]) / 2
	}
	return &m
}

func medianInt(values []int) int {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]int(nil), values...)
	sort.Ints(sorted)
	return sorted[len(sorted)/2]
}

// buildEvalReport grades every run and adds them up.
func buildEvalReport(runs []*evalRun, repoSHA string, baseline *evalReport, skipped ...evalSkip) *evalReport {
	rep := &evalReport{ReportVersion: evalReportVersion, Kind: evalReportKind, GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		Source: evalReportSource{RepoSHA: repoSHA, CLIVersion: version},
		Contract: evalReportContract{ContractVersion: agentContractVersion, PrimerVersion: agentPrimerVersion,
			CatalogVersion: operationCatalogVersion, CatalogHash: operationCatalog().Hash, GuideVersion: agentGuideVersion,
			InstructionsLeftOut: evalLeftOutList()},
		Suite: evalReportSuite{Hash: evalSuiteHash(), ScenarioHash: evalScenarioHash(), GraderVersion: evalGraderVersion},
		Runs:  []evalRunReport{}, Skipped: skipped}
	for _, sc := range evalScenarios() {
		rep.Suite.Scenarios = append(rep.Suite.Scenarios, sc.ID)
	}
	supported := map[string]bool{}
	for _, e := range evalSupportedMatrix() {
		for _, v := range e.Versions {
			supported[e.Engine+"@"+v] = true
		}
	}
	matrix := map[string]evalMatrixEntry{}
	for _, run := range runs {
		r := run.report()
		rep.Runs = append(rep.Runs, r)
		entry := evalMatrixEntry{Engine: r.Engine, EngineVersion: r.EngineVersion, Model: r.Model, Backend: r.Backend,
			Supported: r.Engine == "scripted" || supported[r.Engine+"@"+r.EngineVersion]}
		matrix[entry.key()] = entry
	}
	for _, e := range matrix {
		rep.Matrix = append(rep.Matrix, e)
	}
	sort.Slice(rep.Matrix, func(i, j int) bool { return rep.Matrix[i].key() < rep.Matrix[j].key() })
	rep.Summary = summarize(rep.Runs)
	rep.Gate = gateOf(rep, evalGate())
	if baseline != nil {
		rep.Comparison = compareEvalReports(baseline, rep, evalGate())
		if len(rep.Comparison.Regressions) > 0 && rep.Gate.Verdict == evalVerdictPass {
			rep.Gate.Verdict = evalVerdictFail
		}
		for _, reg := range rep.Comparison.Regressions {
			rep.Gate.Reasons = append(rep.Gate.Reasons, "regressed against the baseline: "+reg)
		}
		rep.Gate.Notices = append(rep.Gate.Notices, rep.Comparison.Warnings...)
	}
	return rep
}

func summarize(runs []evalRunReport) evalSummary {
	gate := evalGate()
	sum := evalSummary{Cells: map[string]evalRate{}, ByEngine: map[string]evalEngineSummary{}}
	type acc struct {
		first, expected                         []float64
		planned, persisted, planRuns, planShort int
		failures, codes                         map[string]int
		ctx                                     []evalContextBytes
		tokens                                  evalUsage
		runs                                    int
	}
	accs := map[string]*acc{}
	for _, r := range runs {
		sum.Runs++
		cell := sum.Cells[r.cellKey()]
		cell.Runs++
		switch r.Verdict {
		case evalVerdictPass:
			sum.Passed++
			cell.Passed++
		case evalVerdictFail:
			sum.Failed++
			cell.Failed++
		default:
			sum.Errors++
			cell.Errors++
		}
		graded := cell.Passed + cell.Failed
		if graded > 0 {
			cell.Rate = float64(cell.Passed) / float64(graded)
		}
		cell.Pass = graded > 0 && cell.Passed*gate.PassDenominator >= graded*gate.PassNumerator
		sum.Cells[r.cellKey()] = cell

		a := accs[r.matrixKey()]
		if a == nil {
			a = &acc{failures: map[string]int{}, codes: map[string]int{}}
			accs[r.matrixKey()] = a
		}
		a.runs++
		if r.Metrics.FirstOrbitSuccessStep != nil {
			a.first = append(a.first, float64(*r.Metrics.FirstOrbitSuccessStep))
		}
		if r.Metrics.StepsToExpectedWrite != nil {
			a.expected = append(a.expected, float64(*r.Metrics.StepsToExpectedWrite))
		}
		if r.Metrics.PlannedItems > 0 {
			a.planRuns++
			a.planned += r.Metrics.PlannedItems
			persisted := r.Metrics.PersistedItems
			if persisted > r.Metrics.PlannedItems {
				persisted = r.Metrics.PlannedItems
			}
			a.persisted += persisted
			if persisted < r.Metrics.PlannedItems {
				a.planShort++
			}
		}
		for k, n := range r.Metrics.FailureTypes {
			a.failures[k] += n
		}
		for k, n := range r.Metrics.ErrorCodes {
			a.codes[k] += n
		}
		a.ctx = append(a.ctx, r.Metrics.Context)
		a.tokens.InputTokens += r.Metrics.Usage.InputTokens
		a.tokens.CachedInputTokens += r.Metrics.Usage.CachedInputTokens
		a.tokens.OutputTokens += r.Metrics.Usage.OutputTokens
		a.tokens.DurationMs += r.Metrics.Usage.DurationMs
	}
	for key, a := range accs {
		es := evalEngineSummary{Runs: a.runs, MedianFirstOrbitSuccess: median(a.first), MedianStepsToExpected: median(a.expected),
			FailureTypes: a.failures, ErrorCodes: a.codes, Tokens: a.tokens}
		if a.planned > 0 {
			rate := 1 - float64(a.persisted)/float64(a.planned)
			es.PrivatePlanNotPersisted = &rate
			short := float64(a.planShort) / float64(a.planRuns)
			es.PlanRunsNotFullyPersisted = &short
		}
		var mcp, eng, list, listed, disc []int
		for _, c := range a.ctx {
			mcp, eng, list, listed, disc = append(mcp, c.MCPInstructions), append(eng, c.EngineInstructions), append(list, c.ToolsList),
				append(listed, c.ToolsListed), append(disc, c.DiscoveryOutput)
		}
		es.MedianContext = evalContextBytes{MCPInstructions: medianInt(mcp), EngineInstructions: medianInt(eng), ToolsList: medianInt(list),
			ToolsListed: medianInt(listed), DiscoveryOutput: medianInt(disc)}
		sum.ByEngine[key] = es
	}
	return sum
}

// gateOf is the release gate's verdict on one report (docs/agent-contract-eval.md §Release gate).
func gateOf(rep *evalReport, rules evalGateRules) evalGateResult {
	g := evalGateResult{Verdict: evalVerdictPass}
	ran := map[string]bool{}
	for _, r := range rep.Runs {
		ran[r.Scenario+" | "+r.matrixKey()] = true
		for _, c := range r.Clauses {
			if c.Safety && !c.Passed && r.Verdict != evalVerdictError {
				g.Verdict = evalVerdictFail
				g.Reasons = append(g.Reasons, fmt.Sprintf("safety clause %s failed: %s on %s", c.ID, r.Scenario, r.matrixKey()))
			}
		}
	}
	for key, cell := range rep.Summary.Cells {
		if cell.Passed+cell.Failed == 0 {
			if g.Verdict == evalVerdictPass {
				g.Verdict = "INCOMPLETE"
			}
			g.Reasons = append(g.Reasons, "no graded run (every run was a harness error): "+key)
			continue
		}
		if !cell.Pass {
			g.Verdict = evalVerdictFail
			g.Reasons = append(g.Reasons, fmt.Sprintf("%s passed %d of %d graded runs, under %d/%d", key, cell.Passed,
				cell.Passed+cell.Failed, rules.PassNumerator, rules.PassDenominator))
		}
	}
	skipped := map[string]bool{}
	for _, skip := range rep.Skipped {
		skipped[skip.Scenario+" | "+skip.Engine] = true
		g.Notices = append(g.Notices, fmt.Sprintf("not applicable: %s on %s, because %s", skip.Scenario, skip.Engine, skip.Reason))
	}
	for _, m := range rep.Matrix {
		for _, sc := range rep.Suite.Scenarios {
			if !ran[sc+" | "+m.key()] && !skipped[sc+" | "+m.Engine] {
				if g.Verdict == evalVerdictPass {
					g.Verdict = "INCOMPLETE"
				}
				g.Reasons = append(g.Reasons, "not run: "+sc+" on "+m.key())
			}
		}
		if !m.Supported {
			g.Notices = append(g.Notices, fmt.Sprintf("%s %s is not in the supported matrix: this report is the measurement that would add it", m.Engine, m.EngineVersion))
		}
	}
	sort.Strings(g.Reasons)
	sort.Strings(g.Notices)
	return g
}

// compareEvalReports reads cur against base, cell by cell and metric by metric.
func compareEvalReports(base, cur *evalReport, rules evalGateRules) *evalComparison {
	c := &evalComparison{Baseline: evalBaselineRef{GeneratedAt: base.GeneratedAt, RepoSHA: base.Source.RepoSHA, SuiteHash: base.Suite.Hash,
		ContractVersion: base.Contract.ContractVersion}, SameSuite: base.Suite.Hash == cur.Suite.Hash}
	for key, now := range cur.Summary.Cells {
		before, ok := base.Summary.Cells[key]
		switch {
		case !ok:
			c.New = append(c.New, key)
		case before.Pass && !now.Pass && now.Passed+now.Failed > 0:
			c.Regressions = append(c.Regressions, fmt.Sprintf("%s: %d/%d -> %d/%d", key, before.Passed, before.Passed+before.Failed,
				now.Passed, now.Passed+now.Failed))
		case !before.Pass && now.Pass:
			c.Improvements = append(c.Improvements, key)
		}
	}
	for key := range base.Summary.Cells {
		if _, ok := cur.Summary.Cells[key]; !ok {
			c.Gone = append(c.Gone, key)
		}
	}
	engineKey := func(k string) string { // engine and model, version aside
		at := strings.Index(k, "@")
		slash := strings.Index(k, "/")
		if at < 0 || slash < at {
			return k
		}
		return k[:at] + k[slash:]
	}
	baseEngines := map[string]evalEngineSummary{}
	for k, v := range base.Summary.ByEngine {
		baseEngines[engineKey(k)] = v
	}
	for k, now := range cur.Summary.ByEngine {
		before, ok := baseEngines[engineKey(k)]
		if !ok {
			continue
		}
		warn := func(name string, b, a *float64, worseUp bool) {
			if b == nil || a == nil {
				return
			}
			delta := *a - *b
			if !worseUp {
				delta = -delta
			}
			scale := *b
			if scale < 1 {
				scale = 1
			}
			if delta/scale > rules.MetricWarnFraction {
				c.Warnings = append(c.Warnings, fmt.Sprintf("%s on %s moved from %.2f to %.2f", name, engineKey(k), *b, *a))
			}
		}
		warn("median steps to the first Orbit success", before.MedianFirstOrbitSuccess, now.MedianFirstOrbitSuccess, true)
		warn("median steps to the expected write", before.MedianStepsToExpected, now.MedianStepsToExpected, true)
		warn("private plan not persisted", before.PrivatePlanNotPersisted, now.PrivatePlanNotPersisted, true)
	}
	for _, list := range [][]string{c.Regressions, c.Improvements, c.New, c.Gone, c.Warnings} {
		sort.Strings(list)
	}
	return c
}

func readEvalReport(path string) (*evalReport, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var rep evalReport
	if err := json.Unmarshal(raw, &rep); err != nil {
		return nil, err
	}
	if rep.Kind != evalReportKind || rep.ReportVersion != evalReportVersion {
		return nil, fmt.Errorf("%s is not an agent-contract eval report of version %d", path, evalReportVersion)
	}
	return &rep, nil
}

// markdown is the report for a person.
func (rep *evalReport) markdown() string {
	var b strings.Builder
	fmt.Fprintf(&b, "# Orbit agent-contract eval\n\n")
	fmt.Fprintf(&b, "Generated %s from `%s` (orbit %s). Contract %s, primer %s, catalogue %s (`%.12s`), guide %s. Suite `%.12s`, %d scenarios.\n\n",
		rep.GeneratedAt, rep.Source.RepoSHA, rep.Source.CLIVersion, rep.Contract.ContractVersion, rep.Contract.PrimerVersion,
		rep.Contract.CatalogVersion, rep.Contract.CatalogHash, rep.Contract.GuideVersion, rep.Suite.Hash, len(rep.Suite.Scenarios))
	if left := rep.Contract.InstructionsLeftOut; len(left) > 0 {
		fmt.Fprintf(&b, "Played without the instruction units %s: a measurement of those units, not a baseline.\n\n", "`"+strings.Join(left, "`, `")+"`")
	}
	fmt.Fprintf(&b, "**Gate: %s.** %d runs: %d passed, %d failed, %d harness errors.\n\n", rep.Gate.Verdict, rep.Summary.Runs,
		rep.Summary.Passed, rep.Summary.Failed, rep.Summary.Errors)
	for _, reason := range rep.Gate.Reasons {
		fmt.Fprintf(&b, "- %s\n", reason)
	}
	for _, notice := range rep.Gate.Notices {
		fmt.Fprintf(&b, "- notice: %s\n", notice)
	}
	b.WriteString("\n## Matrix\n\n| Engine | Version | Model | Backend | Supported |\n| --- | --- | --- | --- | --- |\n")
	for _, m := range rep.Matrix {
		fmt.Fprintf(&b, "| %s | %s | %s | %s | %v |\n", m.Engine, m.EngineVersion, m.Model, m.Backend, m.Supported)
	}
	b.WriteString("\n## Scenarios\n\n")
	// One column per cell: an engine and a model, whatever versions of the engine ran it.
	var heads []string
	var columns []evalMatrixEntry
	for _, m := range rep.Matrix {
		head := m.Engine + " " + m.Model
		if m.Backend != "live" {
			head += " (" + m.Backend + ")"
		}
		if !slices.Contains(heads, head) {
			heads = append(heads, head)
			columns = append(columns, m)
		}
	}
	fmt.Fprintf(&b, "| Scenario | %s |\n|%s\n", strings.Join(heads, " | "), strings.Repeat(" --- |", len(heads)+1))
	for _, sc := range rep.Suite.Scenarios {
		var cols []string
		for _, m := range columns {
			cell, ok := rep.Summary.Cells[sc+" | "+m.Engine+"/"+m.Model+"/"+m.Backend]
			na := false
			for _, skip := range rep.Skipped {
				na = na || (skip.Scenario == sc && skip.Engine == m.Engine)
			}
			switch {
			case !ok && na:
				cols = append(cols, "n/a")
			case !ok:
				cols = append(cols, "—")
			case cell.Passed+cell.Failed == 0:
				cols = append(cols, fmt.Sprintf("error ×%d", cell.Errors))
			default:
				mark := "PASS"
				if !cell.Pass {
					mark = "FAIL"
				}
				cols = append(cols, fmt.Sprintf("%s %d/%d", mark, cell.Passed, cell.Passed+cell.Failed))
			}
		}
		fmt.Fprintf(&b, "| %s | %s |\n", sc, strings.Join(cols, " | "))
	}
	b.WriteString("\n## Failed clauses\n\n")
	any := false
	for _, r := range rep.Runs {
		for _, c := range r.Clauses {
			if !c.Passed {
				any = true
				kind := "advisory"
				if c.Safety {
					kind = "safety"
				} else if c.Gate {
					kind = "gate"
				}
				fmt.Fprintf(&b, "- %s on %s %s (run %d): `%s` (%s, %s) — %s\n", r.Scenario, r.Engine, r.Model, r.Repeat, c.ID, kind, c.Failure, c.Why)
			}
		}
	}
	if !any {
		b.WriteString("None.\n")
	}
	b.WriteString("\n## Metrics\n\n| Engine | Runs | Median steps to first Orbit success | Median steps to the expected write | Private plan not persisted | MCP instructions B | Engine instructions B | tools/list B | Discovery read B | Input tokens | Output tokens |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n")
	keys := make([]string, 0, len(rep.Summary.ByEngine))
	for k := range rep.Summary.ByEngine {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	f := func(v *float64) string {
		if v == nil {
			return "—"
		}
		return fmt.Sprintf("%.2f", *v)
	}
	for _, k := range keys {
		e := rep.Summary.ByEngine[k]
		fmt.Fprintf(&b, "| %s | %d | %s | %s | %s | %d | %d | %d | %d | %d | %d |\n", k, e.Runs, f(e.MedianFirstOrbitSuccess), f(e.MedianStepsToExpected),
			f(e.PrivatePlanNotPersisted), e.MedianContext.MCPInstructions, e.MedianContext.EngineInstructions, e.MedianContext.ToolsList,
			e.MedianContext.DiscoveryOutput, e.Tokens.InputTokens+e.Tokens.CachedInputTokens, e.Tokens.OutputTokens)
	}
	for _, k := range keys {
		e := rep.Summary.ByEngine[k]
		if len(e.FailureTypes) == 0 && len(e.ErrorCodes) == 0 {
			continue
		}
		fmt.Fprintf(&b, "\nFailure types on %s: %s. Receipt error codes: %s.\n", k, countsLine(e.FailureTypes), countsLine(e.ErrorCodes))
	}
	if c := rep.Comparison; c != nil {
		fmt.Fprintf(&b, "\n## Against the baseline of %s (`%s`, contract %s, same suite: %v)\n\n", c.Baseline.GeneratedAt, c.Baseline.RepoSHA,
			c.Baseline.ContractVersion, c.SameSuite)
		for _, sec := range []struct {
			name string
			list []string
		}{{"Regressions", c.Regressions}, {"Improvements", c.Improvements}, {"New cells", c.New}, {"Cells no longer run", c.Gone}, {"Metric warnings", c.Warnings}} {
			if len(sec.list) == 0 {
				continue
			}
			fmt.Fprintf(&b, "%s:\n", sec.name)
			for _, item := range sec.list {
				fmt.Fprintf(&b, "- %s\n", item)
			}
			b.WriteString("\n")
		}
	}
	return b.String()
}

func countsLine(m map[string]int) string {
	if len(m) == 0 {
		return "none"
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s ×%d", k, m[k]))
	}
	return strings.Join(parts, ", ")
}

// writeEvalReport writes the JSON and its markdown beside it.
func writeEvalReport(rep *evalReport, path string) error {
	raw, err := json.MarshalIndent(rep, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(path, append(raw, '\n'), 0o644); err != nil {
		return err
	}
	return os.WriteFile(strings.TrimSuffix(path, filepath.Ext(path))+".md", []byte(rep.markdown()), 0o644)
}

// mergeEvalReports is one report of several written by the same suite: their runs and skips together, their matrix
// joined, the summary and the gate computed again. A report per engine (one per machine, or per workflow job) becomes
// the one a release reads; reports graded by different suites do not merge.
func mergeEvalReports(reports []*evalReport) (*evalReport, error) {
	if len(reports) == 0 {
		return nil, fmt.Errorf("no reports to merge")
	}
	out := *reports[0]
	out.Runs, out.Skipped, out.Matrix, out.Comparison = nil, nil, nil, nil
	out.GeneratedAt = time.Now().UTC().Format(time.RFC3339)
	matrix := map[string]evalMatrixEntry{}
	for _, rep := range reports {
		if rep.Suite.Hash != out.Suite.Hash {
			return nil, fmt.Errorf("a report graded by suite %.12s does not merge with one graded by %.12s", rep.Suite.Hash, out.Suite.Hash)
		}
		if a, b := strings.Join(rep.Contract.InstructionsLeftOut, ","), strings.Join(out.Contract.InstructionsLeftOut, ","); a != b {
			return nil, fmt.Errorf("a report played without instruction units [%s] does not merge with one played without [%s]", a, b)
		}
		if rep.Source.RepoSHA != out.Source.RepoSHA {
			out.Source.RepoSHA = "several"
		}
		out.Runs = append(out.Runs, rep.Runs...)
		// A case not applicable on an engine is one skip however many of the reports name it (one per model).
		for _, skip := range rep.Skipped {
			if !slices.Contains(out.Skipped, skip) {
				out.Skipped = append(out.Skipped, skip)
			}
		}
		for _, m := range rep.Matrix {
			matrix[m.key()] = m
		}
	}
	for _, m := range matrix {
		out.Matrix = append(out.Matrix, m)
	}
	sort.Slice(out.Matrix, func(i, j int) bool { return out.Matrix[i].key() < out.Matrix[j].key() })
	out.Summary = summarize(out.Runs)
	out.Gate = gateOf(&out, evalGate())
	return &out, nil
}
