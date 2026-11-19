package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// The help center's Ask (docs/mocks/help-center board 02, decisions on board 03; apiserver help/help-ask.ts): a
// question answered by an ordinary session that starts read-only. The control plane marks the claim with HelpAsk
// (migration 0850's `session.help_ask`) and hands it only to a runner that declares helpAskCapabilityV1. This runner
// then, instead of a workspace's folder:
//
//   - starts it in a scratch folder of its own (helpAskDir) holding the article library, fetched from the control
//     plane's GET /api/help as a signed-out reader would read it, one Markdown file per article and an INDEX.md;
//   - starts Claude Code with Read, Grep and Glob as its only built-in tools, in Don't Ask with no setting source
//     (they read inside that folder and are refused everywhere else), with Orbit's MCP server alone (--strict-mcp-config)
//     and that server serving the four help reads alone (ORBIT_HELP_ASK, mcp_help_ask.go): no file edits, no shell,
//     no Orbit write tools;
//   - appends the Ask's system prompt (helpAskSystemPrompt): answer from the articles and the account state only, cite
//     articles as [n] with a source list, say it does not know otherwise, and offer changes only as orbit:/ links.
//
// The control plane's runner doors refuse an Ask's tools everything but the four reads (help-ask-reads.ts), so what is
// enforced here is also enforced there.

// helpAskCapabilityV1 declares that this runner starts an Ask read-only. @orbit/shared's HELP_ASK_V1 is the same string.
const helpAskCapabilityV1 = "help-ask/v1"

// envHelpAsk tells `orbit mcp` it serves an Ask: the four help reads and nothing else.
const envHelpAsk = "ORBIT_HELP_ASK"

// HelpAskPage is the page a question was asked from, as the chip named it.
type HelpAskPage struct {
	Route  string   `json:"route"`
	Label  string   `json:"label"`
	Errors []string `json:"errors"`
}

// HelpAskMarker is `session.help_ask`: an Ask, and the page it was asked from (nil when the chip was taken off).
type HelpAskMarker struct {
	Page *HelpAskPage `json:"page"`
}

// helpAskBuiltinTools are the only built-in tools an Ask's Claude Code has: it reads the articles, and nothing more.
var helpAskBuiltinTools = []string{"Read", "Grep", "Glob"}

// helpAskReads are the account reads an Ask may make, one tool each (mcp_help_ask.go) and one runner door each
// (GET /runner/help-ask/<read>). @orbit/shared's HELP_ASK_READS.
var helpAskReads = []string{"machines", "sessions", "tasks", "quota"}

// helpAskToolName is the MCP tool for one read.
func helpAskToolName(read string) string { return "help_" + read }

// helpAskRootDir holds every Ask's scratch folder, a sibling of the worktrees, outside any repository.
func helpAskRootDir() string { return filepath.Join(machineHome(), "help-ask") }

// helpAskDir is one Ask's scratch folder.
func helpAskDir(sessionID string) string {
	return filepath.Join(helpAskRootDir(), decodeSessionID(sessionID))
}

// helpIndexArticle is one article of GET /api/help, as much of it as an Ask files.
type helpIndexArticle struct {
	Slug     string `json:"slug"`
	Title    string `json:"title"`
	Summary  string `json:"summary"`
	Category string `json:"category"`
}

type helpIndexAnswer struct {
	Categories []struct {
		Slug  string `json:"slug"`
		Title string `json:"title"`
	} `json:"categories"`
	Articles []helpIndexArticle `json:"articles"`
}

type helpArticleAnswer struct {
	helpIndexArticle
	Body string `json:"body"`
}

// helpFetch reads one public help door of the control plane. Sent with no credential: the help doors are open to
// anyone, and judge a credential they are sent as a login (a runner token is not one), so an Ask reads the library
// a signed-out reader reads — the administrators' category is not in it.
func helpFetch(ctx context.Context, baseURL, path string, out interface{}) error {
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, strings.TrimRight(baseURL, "/")+"/api"+path, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("GET %s: %d %s", path, resp.StatusCode, strings.TrimSpace(string(b)))
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(out)
}

// helpArticlePath is the app path an article opens at, as an orbit:/ link names it.
func helpArticlePath(a helpIndexArticle) string { return "/help/" + a.Category + "/" + a.Slug }

// fillHelpLibrary writes the library into dir: articles/<category>/<slug>.md each with its title, summary and link
// on top, and INDEX.md listing them all. It replaces what an earlier start wrote only once the whole library has
// been read, so a control plane that does not answer leaves the last library in place.
func fillHelpLibrary(ctx context.Context, baseURL, dir string) (int, error) {
	var index helpIndexAnswer
	if err := helpFetch(ctx, baseURL, "/help", &index); err != nil {
		return 0, err
	}
	sort.SliceStable(index.Articles, func(i, j int) bool {
		if index.Articles[i].Category != index.Articles[j].Category {
			return categoryRank(index, index.Articles[i].Category) < categoryRank(index, index.Articles[j].Category)
		}
		return index.Articles[i].Slug < index.Articles[j].Slug
	})
	staging := filepath.Join(dir, ".articles-new")
	_ = os.RemoveAll(staging)
	var listing strings.Builder
	listing.WriteString("# Orbit help articles\n\nEvery article, by category. Cite one by its link: orbit:/help/<category>/<slug>.\n")
	lastCategory := ""
	for _, meta := range index.Articles {
		if !safeHelpSlug(meta.Category) || !safeHelpSlug(meta.Slug) {
			continue
		}
		var article helpArticleAnswer
		if err := helpFetch(ctx, baseURL, "/help/articles/"+url.PathEscape(meta.Slug), &article); err != nil {
			_ = os.RemoveAll(staging)
			return 0, err
		}
		file := filepath.Join(staging, meta.Category, meta.Slug+".md")
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			return 0, err
		}
		content := fmt.Sprintf("# %s\n\nLink: orbit:%s\nSummary: %s\n\n%s\n", meta.Title, helpArticlePath(meta), meta.Summary, article.Body)
		if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
			return 0, err
		}
		if meta.Category != lastCategory {
			fmt.Fprintf(&listing, "\n## %s\n\n", categoryTitle(index, meta.Category))
			lastCategory = meta.Category
		}
		fmt.Fprintf(&listing, "- %s — articles/%s/%s.md — orbit:%s — %s\n", meta.Title, meta.Category, meta.Slug, helpArticlePath(meta), meta.Summary)
	}
	articles := filepath.Join(dir, "articles")
	_ = os.RemoveAll(articles)
	if err := os.MkdirAll(staging, 0o755); err != nil {
		return 0, err
	}
	if err := os.Rename(staging, articles); err != nil {
		return 0, err
	}
	if err := os.WriteFile(filepath.Join(dir, "INDEX.md"), []byte(listing.String()), 0o644); err != nil {
		return 0, err
	}
	return len(index.Articles), nil
}

func categoryRank(index helpIndexAnswer, slug string) int {
	for i, c := range index.Categories {
		if c.Slug == slug {
			return i
		}
	}
	return len(index.Categories)
}

func categoryTitle(index helpIndexAnswer, slug string) string {
	for _, c := range index.Categories {
		if c.Slug == slug {
			return c.Title
		}
	}
	return slug
}

// safeHelpSlug keeps a path component the control plane names to one plain name: no separator, no dot-dot.
func safeHelpSlug(s string) bool {
	if s == "" || len(s) > 120 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-') {
			return false
		}
	}
	return true
}

// prepareHelpAskDir makes an Ask's scratch folder and fills it with the library. A library that cannot be read is
// said in the log and in the folder; the Ask still starts, and its system prompt tells it to say it does not know.
func prepareHelpAskDir(baseURL string, job *ClaimedSession) string {
	dir := helpAskDir(job.SessionID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		logln(fmt.Sprintf("session %s — cannot make the Ask's folder %s: %v", job.SessionID, dir, err))
		return dir
	}
	n, err := fillHelpLibrary(context.Background(), baseURL, dir)
	if err != nil {
		logln(fmt.Sprintf("session %s — the help articles could not be read (%v); the Ask starts with what it has", job.SessionID, err))
		if _, statErr := os.Stat(filepath.Join(dir, "INDEX.md")); statErr != nil {
			_ = os.WriteFile(filepath.Join(dir, "INDEX.md"), []byte("# Orbit help articles\n\nThe articles could not be read from Orbit just now.\n"), 0o644)
		}
	} else {
		logln(fmt.Sprintf("session %s — Ask: %d help articles in %s", job.SessionID, n, dir))
	}
	job.IsolationStatus = isoHelpAsk
	return dir
}

// isoHelpAsk is the isolation an Ask runs with: a scratch folder of articles, no repository.
const isoHelpAsk = "help-ask"

// helpAskSystemPrompt is what an Ask is told, appended to the engine's own system prompt.
func helpAskSystemPrompt(marker *HelpAskMarker) string {
	var b strings.Builder
	b.WriteString(`<orbit_help_ask>
You are Orbit's help assistant. A person using Orbit asked a question from inside the app. You answer it, and you change nothing.

What you can read, and nothing else:
- The help articles in the current folder: INDEX.md lists them all; each is articles/<category>/<slug>.md, with its link (orbit:/help/<category>/<slug>) on top. Use Grep, Glob and Read on them.
- The person's account state, through four read-only tools: help_machines (each machine, online or offline, and its last heartbeat), help_sessions (their sessions and where each stands), help_tasks (their open and failed tasks), help_quota (each machine's engine quota windows).
You cannot see repositories, files on the person's machines, transcripts, or keys, and you have no tool that changes anything.

How to answer:
1. Look first: search the articles for the question, and read the account state the question is about. Then answer.
2. Every claim comes from an article or from the account state. Cite an article by a number in square brackets right after the sentence it supports, like [1]. Number the articles you cite 1, 2, 3 in the order you first cite them. Say what you read in the account state plainly ("build-box last checked in 2 h 4 min ago").
3. If the articles and the account state do not answer it, say you don't know, and say what you looked at. Never guess, and never answer from general knowledge about other products.
4. You never change anything. When the person should change something, offer it as a link they can press, written as a Markdown link to an orbit:/ path, such as [Open build-box](orbit:/settings/machines/<machine id>) or [Paused sessions](orbit:/sessions?view=open). Use paths the articles use, and ids from the account state. Never tell the person you did something.
5. Keep it short: a few sentences, or a short numbered list of steps. Plain English.
6. End with the sources you cited, one per line, after a line that says "Sources:", each as
   [n] [Article title](orbit:/help/<category>/<slug>)
   Leave the list out when you cited none.
</orbit_help_ask>`)
	if marker != nil && marker.Page != nil {
		b.WriteString("\n\n<orbit_help_page>\nThe person asked from this page of Orbit: ")
		b.WriteString(marker.Page.Label)
		b.WriteString(" (")
		b.WriteString(marker.Page.Route)
		b.WriteString(").")
		if len(marker.Page.Errors) > 0 {
			b.WriteString(" It shows these errors:")
			for _, e := range marker.Page.Errors {
				b.WriteString("\n- ")
				b.WriteString(e)
			}
		}
		b.WriteString("\nArticles about this page list its path in their routes; start with those.\n</orbit_help_page>")
	}
	return b.String()
}

// helpAskClaudeArgs is the argv of an Ask's Claude Code: helpAskBuiltinTools and the four reads, nothing else.
func helpAskClaudeArgs(job *ClaimedSession, scratchDir string, firstSpawn bool) []string {
	a := job.Agent
	args := []string{
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--include-partial-messages",
		"--replay-user-messages",
		"--verbose",
		"--model", a.Model,
		// Don't Ask: a tool not allowed below is refused, never asked about.
		"--permission-mode", "dontAsk",
		// The only built-in tools it has: no Edit, Write, NotebookEdit, Bash, WebFetch, WebSearch, Task or Agent.
		"--tools", strings.Join(helpAskBuiltinTools, ","),
		"--strict-mcp-config",
	}
	if a.Effort != "" {
		args = append(args, "--effort", claudeEffortFlag(a.Effort))
	}
	// Only the four reads are allowed by name. The built-ins are not: allowed by name, Read reads any path on the machine
	// (measured on Claude Code 2.1.325), while left to Don't Ask they read inside the Ask's folder and are refused
	// everywhere else. No setting source is loaded either, so no permission the machine's user or a folder's
	// .claude/settings.json grants can widen that; the flag settings below are the only settings it has.
	args = append(args, "--setting-sources", "")
	allowed := []string{}
	for _, read := range helpAskReads {
		allowed = append(allowed, claudeToolName(helpAskToolName(read)))
	}
	args = append(args, "--allowedTools", strings.Join(allowed, ","))
	if orbitExe := orbitCLIExecutable(); orbitExe != "" {
		mcpPath := filepath.Join(scratchDir, "mcp.json")
		b, _ := json.Marshal(map[string]interface{}{"mcpServers": map[string]interface{}{
			"orbit": map[string]interface{}{"command": orbitExe, "args": []string{"mcp"}, "env": map[string]string{envHelpAsk: "1"}},
		}})
		if err := os.WriteFile(mcpPath, b, 0o644); err == nil {
			args = append(args, "--mcp-config", mcpPath)
		}
	}
	args = append(args, "--append-system-prompt", helpAskSystemPrompt(job.HelpAsk))
	if firstSpawn {
		args = append(args, "--session-id", job.SessionUUID)
	} else {
		args = append(args, "--resume", job.SessionUUID)
	}
	// The same session-private settings every session gets — the claude.ai account's connectors, plugins and skills
	// off — without the hooks, which guard tools an Ask does not have.
	if path, err := writeClaudeSettings(scratchDir, "", a.FastMode); err == nil && path != "" {
		args = append(args, "--settings", path)
	}
	return args
}
