package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// The engine and model picker the TUI shows before it creates a session (docs/terminal-session-design.md,
// landing step 5). It offers what the app's new-session form offers for this machine: the engines its
// runner reports installed (GET /runners: engines, modelCatalog, runtimeDefaultModels), each on its own
// sign-in, and every configured key that runs on one of them (GET /providers). The choice travels on
// POST /sessions as the app sends it: engine and provider as a pair, and the model.

// tuiEngineOption is one engine-and-credential the picker offers, with the models it can run.
type tuiEngineOption struct {
	Label    string
	Engine   string
	Provider string
	// DefaultModel names what "Default" runs, when the runner or the key says.
	DefaultModel string
	Models       []tuiModelOption
}

type tuiModelOption struct {
	Value string
	Label string
}

// tuiEngineChoice is what the picker answers. An empty Model is the engine's default.
type tuiEngineChoice struct {
	Engine   string
	Provider string
	Model    string
}

// applyTo sets the choice on a POST /sessions body.
func (c tuiEngineChoice) applyTo(body map[string]any) {
	body["engine"] = c.Engine
	body["provider"] = c.Provider
	if c.Model != "" {
		body["model"] = c.Model
	}
}

// engineOptionsFor reads GET /runners and GET /providers into the options for the runner runnerID.
// DeepSeek Harness has no sign-in of its own (its key comes with each dispatch), so it is offered
// only through a key.
func engineOptionsFor(runnersJSON, providersJSON []byte, runnerID string) ([]tuiEngineOption, error) {
	type model struct {
		Value    string `json:"value"`
		Label    string `json:"label"`
		Priority *int   `json:"priority"`
	}
	var runners []struct {
		ID      string `json:"id"`
		Engines []struct {
			Engine            string `json:"engine"`
			Installed         bool   `json:"installed"`
			InstallationError string `json:"installationError"`
			Auth              string `json:"auth"`
		} `json:"engines"`
		ModelCatalog         map[string][]model `json:"modelCatalog"`
		RuntimeDefaultModels map[string]string  `json:"runtimeDefaultModels"`
	}
	if err := json.Unmarshal(runnersJSON, &runners); err != nil {
		var wrapped struct {
			Runners json.RawMessage `json:"runners"`
		}
		if json.Unmarshal(runnersJSON, &wrapped) != nil || json.Unmarshal(wrapped.Runners, &runners) != nil {
			return nil, fmt.Errorf("reading this account's runners: %w", err)
		}
	}
	want := decodeSessionID(runnerID)
	idx := -1
	for i, r := range runners {
		if decodeSessionID(r.ID) == want {
			idx = i
			break
		}
	}
	if idx < 0 {
		return nil, errors.New("this machine's runner is not among this account's runners")
	}
	runner := runners[idx]
	models := func(list []model) []tuiModelOption {
		sorted := append([]model(nil), list...)
		sort.SliceStable(sorted, func(i, j int) bool {
			pi, pj := 1<<30, 1<<30
			if sorted[i].Priority != nil {
				pi = *sorted[i].Priority
			}
			if sorted[j].Priority != nil {
				pj = *sorted[j].Priority
			}
			return pi < pj
		})
		var out []tuiModelOption
		for _, m := range sorted {
			if m.Value == "" {
				continue
			}
			label := m.Label
			if label == "" {
				label = m.Value
			}
			out = append(out, tuiModelOption{Value: m.Value, Label: label})
		}
		return out
	}

	installed := map[string]bool{}
	var options []tuiEngineOption
	for _, e := range runner.Engines {
		if !e.Installed || e.InstallationError != "" {
			continue
		}
		installed[e.Engine] = true
		if e.Engine == providerDsh || e.Auth == "no" {
			continue
		}
		options = append(options, tuiEngineOption{
			Label: engineDisplayName(e.Engine), Engine: e.Engine, Provider: e.Engine,
			DefaultModel: runner.RuntimeDefaultModels[e.Engine], Models: models(runner.ModelCatalog[e.Engine]),
		})
	}

	if len(providersJSON) > 0 {
		var keys []struct {
			Slug         string   `json:"slug"`
			Label        string   `json:"label"`
			Engines      []string `json:"engines"`
			Models       []model  `json:"models"`
			DefaultModel string   `json:"defaultModel"`
		}
		if err := json.Unmarshal(providersJSON, &keys); err != nil {
			return nil, fmt.Errorf("reading this account's keys: %w", err)
		}
		for _, k := range keys {
			label := k.Label
			if label == "" {
				label = k.Slug
			}
			for _, engine := range k.Engines {
				if !installed[engine] {
					continue
				}
				options = append(options, tuiEngineOption{
					Label: engineDisplayName(engine) + " · " + label, Engine: engine, Provider: k.Slug,
					DefaultModel: k.DefaultModel, Models: models(k.Models),
				})
			}
		}
	}
	if len(options) == 0 {
		return nil, errors.New("no engine is ready on this machine: run `orbit doctor` to see what is missing")
	}
	return options, nil
}

// errPickerCancelled is what the picker answers when the person leaves it without choosing.
var errPickerCancelled = errors.New("no engine picked; nothing was created")

// tuiPickerModel is the picker: an engine list, then that engine's models.
type tuiPickerModel struct {
	options  []tuiEngineOption
	stage    int // 0 engines, 1 models
	cursor   int
	engine   int
	choice   *tuiEngineChoice
	canceled bool
}

// modelRows are the model stage's rows: Default first, then the catalog.
func (m *tuiPickerModel) modelRows() []tuiModelOption {
	o := m.options[m.engine]
	def := "Default"
	if o.DefaultModel != "" {
		def += " (" + o.DefaultModel + ")"
	}
	return append([]tuiModelOption{{Value: "", Label: def}}, o.Models...)
}

func (m *tuiPickerModel) rows() int {
	if m.stage == 0 {
		return len(m.options)
	}
	return len(m.modelRows())
}

func (m *tuiPickerModel) Init() tea.Cmd { return nil }

func (m *tuiPickerModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	k, ok := msg.(tea.KeyMsg)
	if !ok {
		return m, nil
	}
	switch k.Type {
	case tea.KeyCtrlC, tea.KeyCtrlD:
		m.canceled = true
		return m, tea.Quit
	case tea.KeyEsc:
		if m.stage == 1 {
			m.stage, m.cursor = 0, m.engine
			return m, nil
		}
		m.canceled = true
		return m, tea.Quit
	case tea.KeyUp:
		if m.cursor > 0 {
			m.cursor--
		}
	case tea.KeyDown:
		if m.cursor < m.rows()-1 {
			m.cursor++
		}
	case tea.KeyRunes:
		// j and k move as the arrows do; keys typed fast arrive as one run.
		for _, r := range k.Runes {
			switch r {
			case 'k':
				m.Update(tea.KeyMsg{Type: tea.KeyUp})
			case 'j':
				m.Update(tea.KeyMsg{Type: tea.KeyDown})
			}
		}
	case tea.KeyEnter:
		if m.stage == 0 {
			m.engine, m.stage, m.cursor = m.cursor, 1, 0
			return m, nil
		}
		o := m.options[m.engine]
		m.choice = &tuiEngineChoice{Engine: o.Engine, Provider: o.Provider, Model: m.modelRows()[m.cursor].Value}
		return m, tea.Quit
	}
	return m, nil
}

func (m *tuiPickerModel) View() string {
	if m.choice != nil || m.canceled {
		return ""
	}
	var b strings.Builder
	title, hint := "Engine for the new session", "↑/↓ choose · enter pick · esc cancel"
	labels := []string{}
	if m.stage == 0 {
		for _, o := range m.options {
			labels = append(labels, o.Label)
		}
	} else {
		title = "Model for " + m.options[m.engine].Label
		hint = "↑/↓ choose · enter pick · esc back"
		for _, r := range m.modelRows() {
			labels = append(labels, r.Label)
		}
	}
	b.WriteString(tuiBlue + "◆ Orbit" + tuiReset + " " + title + "\n")
	for i, l := range labels {
		if i == m.cursor {
			b.WriteString(tuiCyan + "› " + l + tuiReset + "\n")
		} else {
			b.WriteString("  " + l + "\n")
		}
	}
	b.WriteString(tuiGrey + hint + tuiReset)
	return b.String()
}

// pickEngineAndModel reads what this machine can run and asks which engine and model a new session
// runs on.
func pickEngineAndModel(ctx context.Context, client *tuiClient, runnerID string, in io.Reader, out io.Writer) (tuiEngineChoice, error) {
	runnersJSON, err := client.runners(ctx)
	if err != nil {
		return tuiEngineChoice{}, err
	}
	// A key list the server refuses only narrows the choice to the engines' own sign-ins.
	providersJSON, _ := client.providers(ctx)
	options, err := engineOptionsFor(runnersJSON, providersJSON, runnerID)
	if err != nil {
		return tuiEngineChoice{}, err
	}
	m := &tuiPickerModel{options: options}
	final, err := tea.NewProgram(m, tea.WithInput(in), tea.WithOutput(out), tea.WithContext(ctx)).Run()
	if err != nil && !errors.Is(err, tea.ErrInterrupted) {
		return tuiEngineChoice{}, err
	}
	if fm, ok := final.(*tuiPickerModel); ok && fm.choice != nil {
		return *fm.choice, nil
	}
	return tuiEngineChoice{}, errPickerCancelled
}

// createSessionWithPicker creates a session after the picker: body holds the rest of POST /sessions
// (prompt, workspace, runner), and the engine, provider and model picked are added to it.
func createSessionWithPicker(ctx context.Context, client *tuiClient, runnerID string, body map[string]any, in io.Reader, out io.Writer) (string, error) {
	choice, err := pickEngineAndModel(ctx, client, runnerID, in, out)
	if err != nil {
		return "", err
	}
	choice.applyTo(body)
	return client.createSession(ctx, body)
}
