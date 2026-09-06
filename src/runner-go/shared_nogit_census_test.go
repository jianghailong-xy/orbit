package main

import (
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// The census of §0's degradations: every place worktree.go answers a failure with a directory to
// share instead of a refusal, and the standing proof that the new-style path reaches none of them.
//
// Two halves, because either alone is weak. The STRUCTURAL half enumerates the exits out of the
// source and walks the call graph, so an exit added tomorrow cannot hide from it — but it only
// knows what the code says. The BEHAVIOURAL half drives each exit for real, with the Legacy job as
// a positive control on the same fixture: "the new path refuses here" means nothing unless the
// fixture is one that genuinely reaches the degradation, and the Legacy assertion is what proves
// it does. Together they say: these are all of them, they are all still live, and none is on the
// new path.

// sharedExit is one place a degradation is written, identified by what it is guarded by rather
// than by a line number — a guard that changes is exactly when somebody should re-classify it.
type sharedExit struct {
	fn, constant, guard string
}

// theSixExits is the inventory. Five write shared-nogit and one writes shared; all six are inside
// the Legacy body of setupWorktree, which is what makes "the new-style path reaches none of them"
// a statement about reachability rather than about intent.
//
// Adding a seventh fails this test by construction. That is the point: a new degradation is a
// decision about SR33, and it should not be possible to make it by accident.
var theSixExits = []sharedExit{
	{"setupWorktree", "isoShared", "job.Branch == \"\""},
	{"setupWorktree", "isoSharedNoGit", "!job.AutoInitGit"},
	{"setupWorktree", "isoSharedNoGit", "err := initGitRepo(baseDir); err != nil"},
	{"setupWorktree", "isoSharedNoGit", "err != nil || repoRoot == \"\""},
	{"setupWorktree", "isoSharedNoGit", "err != nil || base == \"\""},
	{"setupWorktree", "isoSharedNoGit", "err != nil"},
}

func TestNewStylePathCannotReachAnySharedNoGitExit(t *testing.T) {
	fset := token.NewFileSet()
	pkg := map[string]*ast.File{}
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		pkg[name] = f
	}
	if len(pkg) < 10 {
		t.Fatalf("only %d source files parsed; the census would be reading almost nothing", len(pkg))
	}

	render := func(n ast.Node) string {
		if n == nil {
			return ""
		}
		var b strings.Builder
		if err := printer.Fprint(&b, fset, n); err != nil {
			return "<unprintable>"
		}
		return strings.Join(strings.Fields(b.String()), " ")
	}

	// Every write to IsolationStatus in the package, with the function it lives in, the constant it
	// writes, and the innermost `if` guarding it.
	type write struct {
		exit sharedExit
		pos  string
	}
	var writes []write
	for _, f := range pkg {
		ast.Inspect(f, func(n ast.Node) bool {
			fn, ok := n.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				return true
			}
			var guards []*ast.IfStmt
			ast.Inspect(fn.Body, func(m ast.Node) bool {
				if ifs, ok := m.(*ast.IfStmt); ok {
					guards = append(guards, ifs)
				}
				assign, ok := m.(*ast.AssignStmt)
				if !ok || len(assign.Lhs) != 1 || len(assign.Rhs) != 1 {
					return true
				}
				sel, ok := assign.Lhs[0].(*ast.SelectorExpr)
				if !ok || sel.Sel.Name != "IsolationStatus" {
					return true
				}
				// The innermost enclosing `if` is the last one whose extent covers this write.
				guard := ""
				for _, ifs := range guards {
					if ifs.Pos() <= assign.Pos() && assign.End() <= ifs.End() {
						guard = render(ifs.Cond)
						if ifs.Init != nil {
							guard = render(ifs.Init) + "; " + guard
						}
					}
				}
				writes = append(writes, write{
					exit: sharedExit{fn.Name.Name, render(assign.Rhs[0]), guard},
					pos:  fset.Position(assign.Pos()).String(),
				})
				return true
			})
			return true
		})
	}

	// Half one: the inventory is complete and current.
	var found, want []string
	for _, w := range writes {
		if w.exit.constant != "isoShared" && w.exit.constant != "isoSharedNoGit" {
			continue
		}
		found = append(found, w.exit.fn+" "+w.exit.constant+" ["+w.exit.guard+"] at "+w.pos)
	}
	for _, e := range theSixExits {
		want = append(want, e.fn+" "+e.constant+" ["+e.guard+"]")
	}
	sort.Strings(found)
	sort.Strings(want)
	stripPos := func(s []string) []string {
		out := make([]string, len(s))
		for i, v := range s {
			out[i] = v[:strings.LastIndex(v, " at ")]
		}
		sort.Strings(out)
		return out
	}
	if got := stripPos(found); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("the degradation exits in this package are no longer the ones this census "+
			"classified. Add the new one to theSixExits AND give it a case below, or explain why it "+
			"cannot be reached from the new-style path.\n found:\n  %s\n declared:\n  %s",
			strings.Join(found, "\n  "), strings.Join(want, "\n  "))
	}

	// Half two: none of the functions holding one is reachable from the new-style entry point, and
	// every IsolationStatus write that IS reachable from it writes isoWorktree.
	callees := map[string]map[string]bool{}
	for _, f := range pkg {
		ast.Inspect(f, func(n ast.Node) bool {
			fn, ok := n.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				return true
			}
			if callees[fn.Name.Name] == nil {
				callees[fn.Name.Name] = map[string]bool{}
			}
			ast.Inspect(fn.Body, func(m ast.Node) bool {
				call, ok := m.(*ast.CallExpr)
				if !ok {
					return true
				}
				// Method calls are recorded by selector name too: over-approximating what the new
				// path can reach can only make this test stricter.
				switch fun := call.Fun.(type) {
				case *ast.Ident:
					callees[fn.Name.Name][fun.Name] = true
				case *ast.SelectorExpr:
					callees[fn.Name.Name][fun.Sel.Name] = true
				}
				return true
			})
			return true
		})
	}
	if _, ok := callees["setupSourceWorktree"]; !ok {
		t.Fatal("setupSourceWorktree is gone; the new-style path is not where this test thinks it is")
	}
	reachable := map[string]bool{}
	queue := []string{"setupSourceWorktree"}
	for len(queue) > 0 {
		fn := queue[0]
		queue = queue[1:]
		if reachable[fn] {
			continue
		}
		reachable[fn] = true
		for callee := range callees[fn] {
			if !reachable[callee] {
				queue = append(queue, callee)
			}
		}
	}
	if !reachable["fetchBaseObject"] || !reachable["repoIdentityRefusal"] {
		t.Fatal("the call graph does not even reach the gate's own helpers; it is not being built")
	}
	for _, w := range writes {
		if !reachable[w.exit.fn] {
			continue
		}
		if w.exit.constant != "isoWorktree" {
			t.Errorf("the new-style path can reach %s at %s, which writes %s — SR33 has no "+
				"degradation in it", w.exit.fn, w.pos, w.exit.constant)
		}
	}
	if reachable["setupWorktree"] {
		t.Error("setupSourceWorktree can re-enter setupWorktree; every exit above is then reachable")
	}
}

// The behavioural half: each declared exit, driven for real. The Legacy job is the positive control
// — it must actually land on the degradation, or the new-style assertion beside it is being made
// about a fixture that reaches nothing.
func TestEveryDegradationExitRefusesOnTheNewStylePath(t *testing.T) {
	for _, tc := range []struct {
		name       string
		wantLegacy string
		wantCode   string
		autoInit   bool
		noBranch   bool
		arrange    func(t *testing.T) string // returns the baseDir
	}{
		{
			name: "workDir is not a git repo", wantLegacy: isoSharedNoGit,
			wantCode: sourceRefusalWorktreeRequired,
			arrange:  func(t *testing.T) string { return filepath.Join(t.TempDir(), "not-a-repo") },
		},
		{
			name: "auto git init fails", wantLegacy: isoSharedNoGit, autoInit: true,
			wantCode: sourceRefusalWorktreeRequired,
			arrange: func(t *testing.T) string {
				// A path that exists as a FILE: `git init` cannot make a repo of it, which is the
				// branch Legacy answers by sharing the dir it just failed to initialise.
				p := filepath.Join(t.TempDir(), "a-file")
				if err := os.WriteFile(p, []byte("not a directory\n"), 0o644); err != nil {
					t.Fatal(err)
				}
				return p
			},
		},
		{
			name: "the repo has no HEAD to fork from", wantLegacy: isoSharedNoGit,
			wantCode: sourceRefusalShaUnavailable,
			arrange: func(t *testing.T) string {
				// An initialised repo with no commits, and an origin so the identity check has
				// something to agree with: what it has NOT got is the commit this run is pinned to.
				repo := t.TempDir()
				mustGit(t, repo, "init", "-b", "main")
				bare := t.TempDir()
				mustGit(t, bare, "init", "--bare", "-b", "main")
				mustGit(t, repo, "remote", "add", "origin", bare)
				return repo
			},
		},
		{
			name: "`git worktree add` fails", wantLegacy: isoSharedNoGit,
			wantCode: sourceRefusalWorktreeRequired,
			arrange: func(t *testing.T) string {
				repo := initRepo(t)
				addOriginBare(t, repo)
				return repo
			},
		},
		{
			name: "the session was given no branch", wantLegacy: isoShared, noBranch: true,
			wantCode: sourceRefusalWorktreeRequired,
			arrange: func(t *testing.T) string {
				repo := initRepo(t)
				addOriginBare(t, repo)
				return repo
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// The positive control. Same fixture, Legacy session: it must reach the degradation,
			// or the refusal asserted afterwards is being made about a path nothing travels.
			t.Run("legacy still degrades", func(t *testing.T) {
				t.Setenv("ORBIT_HOME", t.TempDir())
				baseDir := tc.arrange(t)
				job := &ClaimedSession{SessionID: "s-legacy", Branch: "orbit/legacy", AutoInitGit: tc.autoInit}
				if tc.noBranch {
					job.Branch = ""
				}
				occupyWorktreePath(t, tc.name, job.SessionID)
				execDir := setupWorktree(job, baseDir)
				if job.IsolationStatus != tc.wantLegacy {
					t.Fatalf("IsolationStatus = %q, want %q — this fixture no longer reaches the "+
						"exit it was built to reach, so the refusal case below proves nothing",
						job.IsolationStatus, tc.wantLegacy)
				}
				if execDir != baseDir {
					t.Errorf("exec dir = %q, want the shared workDir %q", execDir, baseDir)
				}
				if job.SourceRefusal != nil {
					t.Errorf("a Legacy session was refused (%s); SR45 says it behaves as before",
						job.SourceRefusal.Code)
				}
			})

			t.Run("new-style refuses instead", func(t *testing.T) {
				t.Setenv("ORBIT_HOME", t.TempDir())
				baseDir := tc.arrange(t)
				pinned := strings.Repeat("d", 40)
				if head, err := git(baseDir, "rev-parse", "HEAD"); err == nil && fullSha.MatchString(head) {
					pinned = head
				}
				job := pinnedJob(t, "s-strict", baseDir, pinned)
				job.AutoInitGit = tc.autoInit
				if tc.noBranch {
					job.Branch = ""
				}
				occupyWorktreePath(t, tc.name, job.SessionID)
				execDir := setupWorktree(job, baseDir)

				if execDir != "" {
					t.Errorf("exec dir = %q; a refused run has nowhere to run", execDir)
				}
				assertRefused(t, job, tc.wantCode)
				// SR33 spelled out: not a shared dir, not a `git init`, not a checkout.
				if _, err := os.Stat(filepath.Join(baseDir, ".git")); err == nil && tc.autoInit {
					t.Error("the new-style path git-initialised the workDir")
				}
			})
		})
	}
}

// occupyWorktreePath puts something in the way of the checkout, for the one case whose exit is
// `git worktree add` failing. Every other case fails earlier and is unaffected.
func occupyWorktreePath(t *testing.T, caseName, sessionID string) {
	t.Helper()
	if !strings.Contains(caseName, "worktree add") {
		return
	}
	occupied := filepath.Join(worktreesDir(), sessionID)
	if err := os.MkdirAll(occupied, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(occupied, "in-the-way.txt"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}
