//go:build linux || darwin

package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"unicode/utf8"
)

// What a failed check keeps of the lines that say what failed. `go test ./...` prints nothing for a
// package that passes and everything for one that fails, so a `--- FAIL:` line can be megabytes from
// the end of the output: gone from the 16 KB tail a result carries, and from the end of the log the
// control plane keeps (promotion check 79c952d0, 2026-11-02: 3.26 MB of output, the line dropped).
//
// Every case here names only what the runner had before those lines were kept, and the limits as
// plain numbers, so this file compiles against the old code and shows what the old code did.

const (
	failureLinesHeading = "Failure lines from the whole output:"
	failureLinesMax     = 64
	failureSectionMax   = 8 * 1024
	failureLineMaxRunes = 512
	resultTailMax       = 16 * 1024
	// The most of a tail the coordinator's turn quotes (MAX_CHECK_TAIL_IN_MESSAGE in
	// src/apiserver/src/projects/project-open-item.ts).
	turnTailWindow = 1200
	// More than resultTailMax, so nothing printed before it is left in the ordinary tail.
	floodCommand = "head -c 65536 /dev/zero | tr '\\0' 'x'"
)

// failureSectionOf cuts a tail or a log at the section's heading: what comes before it, the section
// with its heading, and whether there is one at all. The section is the very end of the text, so its
// lines are everything after the heading.
func failureSectionOf(text string) (before, section string, lines []string, found bool) {
	before, after, found := strings.Cut(text, "\n"+failureLinesHeading+"\n")
	if !found {
		return text, "", nil, false
	}
	section = failureLinesHeading + "\n" + after
	return before, section, strings.Split(after, "\n"), true
}

func assertFailureLines(t *testing.T, where, text string, want []string) {
	t.Helper()
	_, _, lines, found := failureSectionOf(text)
	if !found {
		t.Errorf("%s has no %q section; it ends %q", where, failureLinesHeading, lastBytes(text, 200))
		return
	}
	if strings.Join(lines, "\n") != strings.Join(want, "\n") {
		t.Errorf("%s says:\n%s\nwant:\n%s", where, strings.Join(lines, "\n"), strings.Join(want, "\n"))
	}
}

func assertNoFailureSection(t *testing.T, where, text string) {
	t.Helper()
	if strings.Contains(text, failureLinesHeading) {
		t.Errorf("%s carries a failure section it should not: it ends %q", where, lastBytes(text, 200))
	}
}

func lastBytes(text string, n int) string {
	if len(text) <= n {
		return text
	}
	return text[len(text)-n:]
}

// checkThatPrints runs one failing check with no claim behind it: it prints output, then enough that
// none of output is left in the ordinary tail, and fails.
func checkThatPrints(t *testing.T, output string) IntegrationCheckResult {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "printed"), []byte(output), 0o644); err != nil {
		t.Fatalf("write the output: %v", err)
	}
	return runIntegrationCheck(dir, IntegrationCheckSpec{
		Name:           "MERGE_CHECK",
		Command:        "cat printed; " + floodCommand + "; exit 1",
		TimeoutSeconds: 60,
	})
}

// reportedJob runs a job through the report path against a recording control plane, and answers its
// one result and what it uploaded. A job that is not v2 uploads nothing.
func reportedJob(t *testing.T, token string, job IntegrationJobCommand) (IntegrationJobResultRequest, []IntegrationJobOutputRequest) {
	t.Helper()
	t.Setenv("ORBIT_HOME", t.TempDir())
	cp := &progressControlPlane{}
	srv := cp.serve(t)
	runIntegrationJobAndReport(context.Background(), context.Background(), NewTransport(srv.URL, token), job)
	_, _, results, _ := cp.snapshot()
	if len(results) != 1 {
		t.Fatalf("results = %+v, want one", results)
	}
	return results[0], cp.outputSnapshot()
}

// repoWithOneTask is a project line and a task branch with work on it, ready to land.
func repoWithOneTask(t *testing.T) *integrationRepo {
	t.Helper()
	r := newIntegrationRepo(t)
	r.checkoutNew("project/line", "main")
	r.push("project/line")
	r.checkoutNew("task/one", "main")
	r.write("one.txt", "the task's work\n")
	r.commit("task work")
	r.push("task/one")
	r.checkout("main")
	return r
}

// logOf joins one check's chunks in the order they were sent, and holds them to what the control
// plane stores them by: a seq it already has is a resend it drops, so a seq that restarted would lose
// whatever it carries.
func logOf(t *testing.T, chunks []IntegrationJobOutputRequest, index int) string {
	t.Helper()
	var joined strings.Builder
	next := 0
	for _, chunk := range chunks {
		if chunk.Check.Index != index {
			continue
		}
		if chunk.Seq != next {
			t.Errorf("check %d's chunk %d has seq %d", index, next, chunk.Seq)
		}
		next++
		joined.WriteString(chunk.Text)
	}
	return joined.String()
}

// TestFailureLinesSurviveAFloodOfOutput is the report: a check prints its FAIL lines, then more than
// 4 MB, then fails. The tail and the end of the log both name the test, and everything else about
// them is what it always was.
func TestFailureLinesSurviveAFloodOfOutput(t *testing.T) {
	const fillerLine, floodBytes = "a line of ordinary test output\n", 4_500_000
	head := "--- FAIL: TestFloodedOut (0.01s)\n    --- FAIL: TestFloodedOut/its_subtest (0.00s)\n"
	output := head + strings.Repeat(fillerLine, floodBytes/len(fillerLine)+1)[:floodBytes] + "THE-END\n"
	r := repoWithOneTask(t)
	job := v2Job(r, "task/one", "project/line", IntegrationCheckSpec{
		Name: "MERGE_CHECK",
		Command: "printf -- '--- FAIL: TestFloodedOut (0.01s)\\n    --- FAIL: TestFloodedOut/its_subtest (0.00s)\\n'; " +
			fmt.Sprintf("yes 'a line of ordinary test output' | head -c %d; printf 'THE-END\\n'; exit 1", floodBytes),
		ExpectedExitCode: 0,
		TimeoutSeconds:   120,
	})
	result, chunks := reportedJob(t, "tok", job)
	if result.State != "CHECK_FAILED" {
		t.Fatalf("state = %s, want CHECK_FAILED", result.State)
	}
	want := []string{"--- FAIL: TestFloodedOut (0.01s)", "    --- FAIL: TestFloodedOut/its_subtest (0.00s)"}

	tail := result.Checks[0].OutputTail
	assertFailureLines(t, "the item's tail", tail, want)
	if !strings.Contains(lastBytes(tail, turnTailWindow), "TestFloodedOut/its_subtest") {
		t.Errorf("the turn's %d characters do not name the test: %q", turnTailWindow, lastBytes(tail, turnTailWindow))
	}
	if len(tail) > resultTailMax {
		t.Errorf("the tail is %d bytes, want at most %d", len(tail), resultTailMax)
	}
	if before, _, _, _ := failureSectionOf(tail); !strings.HasSuffix(output, before) || !strings.HasSuffix(before, "THE-END\n") {
		t.Errorf("the tail before the section is not the end of the output; it ends %q", lastBytes(before, 40))
	}

	log := logOf(t, chunks, 1)
	assertFailureLines(t, "the log", log, want)
	if !strings.Contains(lastBytes(log, 512), "TestFloodedOut/its_subtest") {
		t.Errorf("the end of the log does not name the test: %q", lastBytes(log, 512))
	}
	if before, _, _, _ := failureSectionOf(log); before != output {
		t.Errorf("the log before the section is %d bytes and not the output's %d", len(before), len(output))
	}
	if len(log) <= floodBytes {
		t.Errorf("the log is %d bytes: the check's output did not all go up", len(log))
	}
}

// TestFailureLinesByTestRunner names what each runner the project's checks use prints when a test
// fails. The outputs are captured from the real tools (go 1.27, vitest 5.0.2, Node 26's node:test),
// passing lines and all, shortened where they repeat.
func TestFailureLinesByTestRunner(t *testing.T) {
	cases := []struct {
		name   string
		output string
		want   []string
	}{
		{
			name: "Go subtests",
			output: "chatty stdout\n" +
				"--- FAIL: TestFails (0.00s)\n" +
				"    a_test.go:4: nope\n" +
				"--- FAIL: TestParent (0.00s)\n" +
				"    --- FAIL: TestParent/sub_one (0.00s)\n" +
				"        --- FAIL: TestParent/sub_one/deeper (0.00s)\n" +
				"            a_test.go:6: deep\n" +
				"FAIL\n" +
				"FAIL\tsample\t0.001s\n" +
				"FAIL\n",
			want: []string{
				"--- FAIL: TestFails (0.00s)",
				"--- FAIL: TestParent (0.00s)",
				"    --- FAIL: TestParent/sub_one (0.00s)",
				"        --- FAIL: TestParent/sub_one/deeper (0.00s)",
				"FAIL\tsample\t0.001s",
			},
		},
		{
			name: "Go panic",
			output: "--- FAIL: TestPanics (0.00s)\n" +
				"panic: kaboom [recovered, repanicked]\n" +
				"\n" +
				"goroutine 6 [running]:\n" +
				"testing.tRunner.func1.2({0x6b4598, 0x563610})\n" +
				"\t/usr/local/go/src/testing/testing.go:2123 +0x232\n" +
				"panic({0x6b4598?, 0x563610?})\n" +
				"\t/usr/local/go/src/runtime/panic.go:859 +0x125\n",
			want: []string{
				"--- FAIL: TestPanics (0.00s)",
				"panic: kaboom [recovered, repanicked]",
			},
		},
		{
			// No `--- FAIL:` line at all: the panic is the only place this run names a test.
			name: "Go test binary past its timeout",
			output: "panic: test timed out after 10m0s\n" +
				"\trunning tests:\n" +
				"\t\tTestHang (9m59s)\n" +
				"\t\tTestParent/sub (8s)\n" +
				"\n" +
				"goroutine 7 [running]:\n" +
				"testing.(*M).startAlarm.func1()\n" +
				"\t/usr/local/go/src/testing/testing.go:2959 +0x34a\n" +
				"created by time.goFunc\n" +
				"\t/usr/local/go/src/time/sleep.go:182 +0x2d\n" +
				"FAIL\torbit\t600.036s\n" +
				"FAIL\n",
			want: []string{
				"panic: test timed out after 10m0s",
				"\trunning tests:",
				"\t\tTestHang (9m59s)",
				"\t\tTestParent/sub (8s)",
				"FAIL\torbit\t600.036s",
			},
		},
		{
			name: "Go runtime fatal error",
			output: "fatal error: concurrent map writes\n" +
				"\n" +
				"goroutine 9 [running]:\n" +
				"internal/runtime/maps.fatal({0x5c1d3a?, 0x0?})\n" +
				"FAIL\torbit\t2.104s\n",
			want: []string{
				"fatal error: concurrent map writes",
				"FAIL\torbit\t2.104s",
			},
		},
		{
			name: "Go package that did not build",
			output: "# sample [sample.test]\n" +
				"./a.go:2:23: undefined: undefinedThing\n" +
				"FAIL\tsample [build failed]\n" +
				"FAIL\n",
			want: []string{"FAIL\tsample [build failed]"},
		},
		{
			name: "vitest",
			output: "\n RUN  v5.0.2 /repo\n\n" +
				" ✓ good.test.ts (1 test) 2ms\n" +
				" ❯ broken.test.ts (0 test)\n" +
				" ❯ a.test.ts (4 tests | 3 failed) 5ms\n" +
				"   ❯ a suite (3)\n" +
				"     × fails here 3ms\n" +
				"     ❯ inner (1)\n" +
				"       × fails deeper 0ms\n" +
				"   × top level failure 1ms\n" +
				"\n⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯\n\n" +
				" FAIL  broken.test.ts [ broken.test.ts ]\n" +
				"Error: Cannot find module './does-not-exist' imported from /repo/broken.test.ts\n" +
				" ❯ broken.test.ts:1:1\n" +
				"      1| import './does-not-exist';\n" +
				"       | ^\n" +
				"\n⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯\n\n" +
				" FAIL  a.test.ts > a suite > fails here\n" +
				"AssertionError: expected 1 to be 2 // Object.is equality\n" +
				"\n- Expected\n+ Received\n\n- 2\n+ 1\n\n" +
				" ❯ a.test.ts:3:40\n" +
				" FAIL  a.test.ts > a suite > inner > fails deeper\n" +
				"Error: boom\n" +
				" FAIL  a.test.ts > top level failure\n" +
				"AssertionError: expected 'a' to be 'b' // Object.is equality\n" +
				"\n Test Files  2 failed | 1 passed (3)\n" +
				"      Tests  3 failed | 2 passed (5)\n",
			want: []string{
				"     × fails here 3ms",
				"       × fails deeper 0ms",
				"   × top level failure 1ms",
				" FAIL  broken.test.ts [ broken.test.ts ]",
				" FAIL  a.test.ts > a suite > fails here",
				" FAIL  a.test.ts > a suite > inner > fails deeper",
				" FAIL  a.test.ts > top level failure",
			},
		},
		{
			// FORCE_COLOR=1: every failure line is painted, and the paint is not what a reader needs.
			name: "vitest in colour",
			output: " \x1b[31m❯\x1b[39m a.test.ts \x1b[2m(\x1b[22m\x1b[2m4 tests\x1b[22m\x1b[2m | \x1b[22m\x1b[31m3 failed\x1b[39m\x1b[2m)\x1b[22m\x1b[32m 6\x1b[2mms\x1b[22m\x1b[39m\n" +
				"\x1b[31m     \x1b[31m×\x1b[31m fails here\x1b[39m\x1b[32m 3\x1b[2mms\x1b[22m\x1b[39m\n" +
				"\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m a.test.ts\x1b[2m > \x1b[22ma suite\x1b[2m > \x1b[22mfails here\n" +
				"\x1b[31m\x1b[1mAssertionError\x1b[22m: expected 1 to be 2 // Object.is equality\x1b[39m\n",
			want: []string{
				"     × fails here 3ms",
				" FAIL  a.test.ts > a suite > fails here",
			},
		},
		{
			// What `node --test` prints on Node 26 when stdout is not a terminal: src/apiserver's `npm test`
			// has no reporter flag, so this and not TAP is what a merge check reads from it.
			name: "node:test default reporter",
			output: "✔ passes (0.439686ms)\n" +
				"✖ fails at top level (0.522523ms)\n" +
				"▶ a suite\n" +
				"  ✖ nested failure (3.34183ms)\n" +
				"  ✔ nested pass (0.086227ms)\n" +
				"✖ a suite (3.637496ms)\n" +
				"ℹ tests 7\n" +
				"ℹ fail 4\n" +
				"\n✖ failing tests:\n\n" +
				"test at a.test.mjs:4:1\n" +
				"✖ fails at top level (0.522523ms)\n" +
				"  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n",
			want: []string{
				"✖ fails at top level (0.522523ms)",
				"  ✖ nested failure (3.34183ms)",
				"✖ a suite (3.637496ms)",
				"✖ failing tests:",
				"✖ fails at top level (0.522523ms)",
			},
		},
		{
			name: "node:test TAP reporter",
			output: "TAP version 13\n" +
				"# Subtest: passes\n" +
				"ok 1 - passes\n" +
				"  ---\n" +
				"  duration_ms: 0.438556\n" +
				"  ...\n" +
				"# Subtest: fails at top level\n" +
				"not ok 2 - fails at top level\n" +
				"  ---\n" +
				"  failureType: 'testCodeFailure'\n" +
				"  error: |-\n" +
				"    Expected values to be strictly equal:\n" +
				"  ...\n" +
				"# Subtest: a suite\n" +
				"    # Subtest: nested failure\n" +
				"    not ok 1 - nested failure\n" +
				"      ---\n" +
				"      ...\n" +
				"    # Subtest: nested pass\n" +
				"    ok 2 - nested pass\n" +
				"not ok 3 - a suite\n" +
				"1..3\n" +
				"# tests 4\n" +
				"# fail 2\n",
			want: []string{
				"not ok 2 - fails at top level",
				"    not ok 1 - nested failure",
				"not ok 3 - a suite",
			},
		},
		{
			name:   "plain TAP",
			output: "1..3\nok 1 - fine\nnot ok 2\nnot ok 3 - no description but this\n",
			want:   []string{"not ok 2", "not ok 3 - no description but this"},
		},
		{
			// A failure line is its first word: anywhere else on a line it is somebody quoting one, and
			// a package's output is full of tests that talk about failing.
			name: "lines that only mention a failure",
			output: "    a_test.go:9: the child printed --- FAIL: TestChild (0.00s)\n" +
				"2026/11/03 05:55:19 panic: recovered and carried on\n" +
				"note: not ok is only a word here\n" +
				"# not ok 7 - a TAP comment\n" +
				"ok 3 - not ok\n" +
				"FAILED to reach the host, retrying\n" +
				"FAIL\n" +
				"panic(0x1234)\n" +
				"\tTestNotARunningTest\n" +
				"\t\tTestNoDuration\n" +
				"a × b = c\n" +
				"--- FAIL: TestTheRealOne (0.00s)\n",
			want: []string{"--- FAIL: TestTheRealOne (0.00s)"},
		},
		{
			// PostgreSQL's text holds no NUL, so a log chunk carrying one would be refused.
			name:   "bytes a stored text cannot hold",
			output: "panic: a NUL\x00 and a broken \xff byte\n",
			want:   []string{"panic: a NUL and a broken  byte"},
		},
		{
			name:   "carriage returns",
			output: "progress 10%\rprogress 20%\r--- FAIL: TestAfterAProgressBar (0.00s)\r\nnot ok 1 - a Windows line ending\r\n",
			want:   []string{"--- FAIL: TestAfterAProgressBar (0.00s)", "not ok 1 - a Windows line ending"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := checkThatPrints(t, tc.output)
			assertFailureLines(t, "the tail", result.OutputTail, tc.want)
		})
	}
}

// TestFailureLinesAcrossWrites: what the output pipe hands over in pieces is still one line, and a
// line the command never ended is still a line.
func TestFailureLinesAcrossWrites(t *testing.T) {
	t.Run("a line split between two writes", func(t *testing.T) {
		result := runIntegrationCheck(t.TempDir(), IntegrationCheckSpec{
			Name:           "MERGE_CHECK",
			Command:        "printf -- '--- FAIL: TestSpl'; sleep 0.2; printf 'it (0.00s)\\n'; " + floodCommand + "; exit 1",
			TimeoutSeconds: 60,
		})
		assertFailureLines(t, "the tail", result.OutputTail, []string{"--- FAIL: TestSplit (0.00s)"})
	})
	t.Run("a last line with no newline", func(t *testing.T) {
		result := runIntegrationCheck(t.TempDir(), IntegrationCheckSpec{
			Name:           "MERGE_CHECK",
			Command:        "printf 'panic: at the very end'; exit 1",
			TimeoutSeconds: 60,
		})
		if want := "panic: at the very end\n" + failureLinesHeading + "\npanic: at the very end"; result.OutputTail != want {
			t.Errorf("tail = %q, want %q", result.OutputTail, want)
		}
	})
}

// numberedFailures is n failure lines, each padded to at least width bytes.
func numberedFailures(n, width int) []string {
	lines := make([]string, n)
	for i := range lines {
		line := fmt.Sprintf("--- FAIL: TestNumber%04d (0.00s)", i)
		if pad := width - len(line); pad > 0 {
			line = fmt.Sprintf("--- FAIL: TestNumber%04d_%s (0.00s)", i, strings.Repeat("p", pad-1))
		}
		lines[i] = line
	}
	return lines
}

// TestFailureLinesStayInsideTheirLimits: the section is at most 64 lines and 8 KB, says how many
// lines it left out, and leaves the result inside the 16 KB it always had.
func TestFailureLinesStayInsideTheirLimits(t *testing.T) {
	note := func(n int) string { return fmt.Sprintf("More failure lines omitted: %d", n) }
	inBounds := func(t *testing.T, result IntegrationCheckResult) []string {
		t.Helper()
		_, section, lines, found := failureSectionOf(result.OutputTail)
		if !found {
			t.Fatalf("no section; the tail ends %q", lastBytes(result.OutputTail, 200))
		}
		if len(section) > failureSectionMax {
			t.Errorf("the section is %d bytes, want at most %d", len(section), failureSectionMax)
		}
		if len(result.OutputTail) > resultTailMax {
			t.Errorf("the tail is %d bytes, want at most %d", len(result.OutputTail), resultTailMax)
		}
		return lines
	}

	t.Run("exactly at the line limit says nothing", func(t *testing.T) {
		all := numberedFailures(failureLinesMax, 0)
		lines := inBounds(t, checkThatPrints(t, strings.Join(all, "\n")+"\n"))
		if strings.Join(lines, "\n") != strings.Join(all, "\n") {
			t.Errorf("kept:\n%s\nwant every one of the %d, and no note", strings.Join(lines, "\n"), len(all))
		}
	})
	t.Run("one past the line limit says one", func(t *testing.T) {
		all := numberedFailures(failureLinesMax+1, 0)
		lines := inBounds(t, checkThatPrints(t, strings.Join(all, "\n")+"\n"))
		want := append(append([]string{}, all[:failureLinesMax]...), note(1))
		if strings.Join(lines, "\n") != strings.Join(want, "\n") {
			t.Errorf("kept:\n%s\nwant the first %d and %q", strings.Join(lines, "\n"), failureLinesMax, note(1))
		}
	})
	t.Run("far past the line limit keeps the first and counts the rest", func(t *testing.T) {
		all := numberedFailures(5000, 0)
		lines := inBounds(t, checkThatPrints(t, strings.Join(all, "\n")+"\n"))
		want := append(append([]string{}, all[:failureLinesMax]...), note(5000-failureLinesMax))
		if strings.Join(lines, "\n") != strings.Join(want, "\n") {
			t.Errorf("kept:\n%s\nwant the first %d and %q", strings.Join(lines, "\n"), failureLinesMax, note(5000-failureLinesMax))
		}
	})
	t.Run("past the byte limit first", func(t *testing.T) {
		// Sixty lines of 400 bytes is 24 KB: the bytes run out long before the lines do.
		all := numberedFailures(60, 400)
		lines := inBounds(t, checkThatPrints(t, strings.Join(all, "\n")+"\n"))
		if len(lines) < 2 {
			t.Fatalf("kept %d lines: %q", len(lines), lines)
		}
		kept := len(lines) - 1
		if want := note(len(all) - kept); lines[kept] != want {
			t.Errorf("the section ends %q, want %q: it kept %d of %d", lines[kept], want, kept, len(all))
		}
		if kept >= len(all) || strings.Join(lines[:kept], "\n") != strings.Join(all[:kept], "\n") {
			t.Errorf("kept %d lines, want the first ones of %d in order", kept, len(all))
		}
	})
	t.Run("a very long line is clipped and the next one still counts", func(t *testing.T) {
		long := "panic: " + strings.Repeat("x", 1<<20)
		lines := inBounds(t, checkThatPrints(t, long+"\n--- FAIL: TestAfterTheLongLine (0.00s)\n"))
		if len(lines) != 2 {
			t.Fatalf("kept %d lines, want the clipped one and the next", len(lines))
		}
		if want := long[:failureLineMaxRunes] + "…"; lines[0] != want {
			t.Errorf("the long line kept %d bytes ending %q, want %d runes and an ellipsis", len(lines[0]), lastBytes(lines[0], 20), failureLineMaxRunes)
		}
		if lines[1] != "--- FAIL: TestAfterTheLongLine (0.00s)" {
			t.Errorf("the next line came out %q", lines[1])
		}
	})
	t.Run("a long line of multi-byte characters keeps them whole", func(t *testing.T) {
		long := "panic: " + strings.Repeat("€", 1<<18)
		lines := inBounds(t, checkThatPrints(t, long+"\n"))
		if len(lines) != 1 {
			t.Fatalf("kept %d lines, want one", len(lines))
		}
		if want := string([]rune(long)[:failureLineMaxRunes]) + "…"; lines[0] != want {
			t.Errorf("the line kept %d runes ending %q, want %d and an ellipsis", utf8.RuneCountInString(lines[0]), lastBytes(lines[0], 12), failureLineMaxRunes)
		}
	})
	t.Run("a line never ended holds no more than any other", func(t *testing.T) {
		result := runIntegrationCheck(t.TempDir(), IntegrationCheckSpec{
			Name:           "MERGE_CHECK",
			Command:        "printf 'panic: '; head -c 4500000 /dev/zero | tr '\\0' 'x'; exit 1",
			TimeoutSeconds: 60,
		})
		lines := inBounds(t, result)
		if len(lines) != 1 || !strings.HasPrefix(lines[0], "panic: xxx") || !strings.HasSuffix(lines[0], "…") {
			t.Errorf("kept %d lines, want the one clipped: %q", len(lines), lastBytes(strings.Join(lines, "\n"), 40))
		}
	})
}

// TestFailureLinesBelongOnlyToAFailedCheck: whether a check passed is exactly what it was, a pass has
// no section however much failure it printed, and a failure with nothing to name has none either. In
// those cases the tail and the log are the command's output and nothing else.
func TestFailureLinesBelongOnlyToAFailedCheck(t *testing.T) {
	const printed = "--- FAIL: TestPrinted (0.00s)\nnot ok 1 - printed\n"
	printCommand := "printf -- '--- FAIL: TestPrinted (0.00s)\\nnot ok 1 - printed\\n'; "
	named := []string{"--- FAIL: TestPrinted (0.00s)", "not ok 1 - printed"}
	cases := []struct {
		name     string
		command  string
		output   string
		expected int
		state    string
		exitCode int
		section  []string
	}{
		{name: "exit 0 that printed failure lines passes", command: printCommand + "exit 0", output: printed, state: "LANDED"},
		{name: "the exit code it declares passes", command: printCommand + "exit 3", output: printed, expected: 3, state: "LANDED", exitCode: 3},
		{name: "exit 0 where it declares 3 fails", command: printCommand + "exit 0", output: printed, expected: 3, state: "CHECK_FAILED", section: named},
		{name: "exit 1 fails", command: printCommand + "exit 1", output: printed, state: "CHECK_FAILED", exitCode: 1, section: named},
		{name: "exit 1 with no failure line fails with no section", command: "printf 'nothing to name\\n'; exit 1", output: "nothing to name\n", state: "CHECK_FAILED", exitCode: 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := repoWithOneTask(t)
			result, chunks := reportedJob(t, "tok", v2Job(r, "task/one", "project/line", IntegrationCheckSpec{
				Name: "MERGE_CHECK", Command: tc.command, ExpectedExitCode: tc.expected, TimeoutSeconds: 60,
			}))
			if result.State != tc.state {
				t.Fatalf("state = %s, want %s", result.State, tc.state)
			}
			check := result.Checks[0]
			if check.ExitCode == nil || *check.ExitCode != tc.exitCode {
				t.Fatalf("exit code = %v, want %d", check.ExitCode, tc.exitCode)
			}
			log := logOf(t, chunks, 1)
			if tc.section == nil {
				assertNoFailureSection(t, "the tail", check.OutputTail)
				assertNoFailureSection(t, "the log", log)
				if check.OutputTail != tc.output || log != tc.output {
					t.Errorf("tail = %q, log = %q, want each to be the command's output %q", check.OutputTail, log, tc.output)
				}
				return
			}
			assertFailureLines(t, "the tail", check.OutputTail, tc.section)
			assertFailureLines(t, "the log", log, tc.section)
		})
	}
}

// TestFailureLinesOfATimedOutCheck: a check its budget ended never reported an exit code and is as
// failed as any other; the lines it printed before that are the only verdict it has.
func TestFailureLinesOfATimedOutCheck(t *testing.T) {
	r := repoWithOneTask(t)
	result, chunks := reportedJob(t, "tok", v2Job(r, "task/one", "project/line", IntegrationCheckSpec{
		Name:           "MERGE_CHECK",
		Command:        "printf -- '--- FAIL: TestBeforeTheBudget (0.00s)\\n'; " + floodCommand + "; exec sleep 60",
		TimeoutSeconds: 5,
	}))
	if result.State != "CHECK_FAILED" {
		t.Fatalf("state = %s, want CHECK_FAILED", result.State)
	}
	check := result.Checks[0]
	if !check.TimedOut || check.ExitCode != nil {
		t.Fatalf("timedOut = %v, exit code = %v, want a check its budget ended", check.TimedOut, check.ExitCode)
	}
	want := []string{"--- FAIL: TestBeforeTheBudget (0.00s)"}
	assertFailureLines(t, "the tail", check.OutputTail, want)
	assertFailureLines(t, "the log", logOf(t, chunks, 1), want)
}

// TestFailureLinesBelongToTheCheckThatFailed: a job's checks each have their own output. The one that
// passed keeps a clean log even after printing failure lines, and the one that failed names only its
// own, as the next chunk of its own log.
func TestFailureLinesBelongToTheCheckThatFailed(t *testing.T) {
	r := repoWithOneTask(t)
	result, chunks := reportedJob(t, "tok", v2Job(r, "task/one", "project/line",
		IntegrationCheckSpec{
			Name:           "TASK_ACCEPTANCE",
			Command:        "printf -- '--- FAIL: TestInTheCheckThatPassed (0.00s)\\n'; exit 0",
			TimeoutSeconds: 60,
		},
		IntegrationCheckSpec{
			Name:           "MERGE_CHECK",
			Command:        "printf -- '--- FAIL: TestInTheCheckThatFailed (0.00s)\\n'; exit 1",
			TimeoutSeconds: 60,
		},
	))
	if result.State != "CHECK_FAILED" || len(result.Checks) != 2 {
		t.Fatalf("state = %s with %d checks, want CHECK_FAILED with two", result.State, len(result.Checks))
	}
	assertNoFailureSection(t, "the passing check's tail", result.Checks[0].OutputTail)
	assertNoFailureSection(t, "the passing check's log", logOf(t, chunks, 1))
	want := []string{"--- FAIL: TestInTheCheckThatFailed (0.00s)"}
	assertFailureLines(t, "the failing check's tail", result.Checks[1].OutputTail, want)
	assertFailureLines(t, "the failing check's log", logOf(t, chunks, 2), want)
	for _, chunk := range chunks {
		if chunk.Check.Index == 2 && chunk.Check.Name != "MERGE_CHECK" {
			t.Errorf("check 2's chunk names %+v", chunk.Check)
		}
	}
}

// TestFailureLinesOfAPromotionCheck is the job the report was about: a CHECK_PROMOTION runs its
// checks on the merged tree, and its log and result read the same as a landing's.
func TestFailureLinesOfAPromotionCheck(t *testing.T) {
	r := newIntegrationRepo(t)
	r.checkoutNew("project/p", "main")
	r.write("feature.txt", "from the project\n")
	source := r.commit("task on the project branch")
	r.push("project/p")
	r.checkout("main")
	job := r.promotionCommand("CHECK_PROMOTION", "project/p", "PROJECT_BRANCH")
	job.SourceSha = source
	job.ReportBeforePush = true
	job.ClaimGeneration = "1"
	job.LeaseOwner = "the-process"
	job.Checks = []IntegrationCheckSpec{{
		Name:           "MERGE_CHECK",
		Command:        "printf -- '--- FAIL: TestOnThePromotion (0.00s)\\n'; " + floodCommand + "; exit 1",
		TimeoutSeconds: 60,
	}}
	result, chunks := reportedJob(t, "tok", job)
	if result.State != "CHECK_FAILED" {
		t.Fatalf("state = %s, want CHECK_FAILED", result.State)
	}
	want := []string{"--- FAIL: TestOnThePromotion (0.00s)"}
	assertFailureLines(t, "the tail", result.Checks[0].OutputTail, want)
	assertFailureLines(t, "the log", logOf(t, chunks, 1), want)
}

// TestFailureLinesOnALegacyClaim: a claim with no output stream uploads nothing, as ever; its result
// is where the item's tail comes from, so that is where the lines go.
func TestFailureLinesOnALegacyClaim(t *testing.T) {
	r := repoWithOneTask(t)
	result, chunks := reportedJob(t, "tok", r.command("task/one", "project/line", IntegrationCheckSpec{
		Name:           "MERGE_CHECK",
		Command:        "printf -- '--- FAIL: TestOnALegacyClaim (0.00s)\\n'; " + floodCommand + "; exit 1",
		TimeoutSeconds: 60,
	}))
	if result.State != "CHECK_FAILED" {
		t.Fatalf("state = %s, want CHECK_FAILED", result.State)
	}
	if len(chunks) != 0 {
		t.Errorf("a legacy claim uploaded %d chunks, want none", len(chunks))
	}
	assertFailureLines(t, "the tail", result.Checks[0].OutputTail, []string{"--- FAIL: TestOnALegacyClaim (0.00s)"})
}

// TestFailureLinesCarryNoSecrets: the section reaches a line the tail would have dropped, so it holds
// that line to what the log is held to: the runner's token and a URL's userinfo do not leave the
// machine in it, in the log or in the result.
func TestFailureLinesCarryNoSecrets(t *testing.T) {
	const token, password = "the-runners-secret-token-0123456789", "s3cret-pass"
	command := "printf 'panic: dial postgres://app:" + password + "@db/orbit with " + token + "\\n'; "
	want := []string{"panic: dial postgres://" + integrationOutputRedacted + "@db/orbit with " + integrationOutputRedacted}
	r := repoWithOneTask(t)
	result, chunks := reportedJob(t, token, v2Job(r, "task/one", "project/line", IntegrationCheckSpec{
		Name:           "MERGE_CHECK",
		Command:        command + floodCommand + "; exit 1",
		TimeoutSeconds: 60,
	}))
	tail, log := result.Checks[0].OutputTail, logOf(t, chunks, 1)
	assertFailureLines(t, "the tail", tail, want)
	assertFailureLines(t, "the log", log, want)
	for _, secret := range []string{token, password} {
		if strings.Contains(tail, secret) || strings.Contains(log, secret) {
			t.Errorf("%q left the machine", secret)
		}
	}

	t.Run("a secret past where the line is clipped", func(t *testing.T) {
		// Redacted first and clipped after: the other way round leaves the front half of an address
		// that no rule can tell is one any more.
		padding := strings.Repeat("y", failureLineMaxRunes-len("panic: postgres://app:s3c"))
		tail := checkThatPrints(t, "panic: "+padding+"postgres://app:"+password+"@db/orbit\n").OutputTail
		_, section, _, found := failureSectionOf(tail)
		if !found || strings.Contains(section, "s3c") {
			t.Errorf("found = %v, section = %q", found, lastBytes(section, 80))
		}
	})
	t.Run("a claim with no uploader", func(t *testing.T) {
		tail := checkThatPrints(t, "panic: dial postgres://app:"+password+"@db/orbit\n").OutputTail
		assertFailureLines(t, "the tail", tail, []string{"panic: dial postgres://" + integrationOutputRedacted + "@db/orbit"})
	})
}

// TestFailureLineScanDoesNotKeepTheOutput: the lines are found as the output goes by, and what stays
// in memory has nothing to do with how much of it there was, for either way an output can be big.
func TestFailureLineScanDoesNotKeepTheOutput(t *testing.T) {
	const written = 16 << 20
	cases := []struct {
		name  string
		piece string
	}{
		{"one line that never ends", strings.Repeat("x", 32<<10)},
		{"nothing but failure lines", strings.Repeat("--- FAIL: TestRepeated (0.00s)\n", 1<<10)},
		{"ordinary lines", strings.Repeat("a line of ordinary test output\n", 1<<10)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out := newIntegrationOutput()
			var before, after runtime.MemStats
			runtime.GC()
			runtime.ReadMemStats(&before)
			piece := []byte(tc.piece)
			for sent := 0; sent < written; sent += len(piece) {
				if _, err := out.Write(piece); err != nil {
					t.Fatalf("write: %v", err)
				}
			}
			runtime.GC()
			runtime.ReadMemStats(&after)
			if grew := int64(after.HeapAlloc) - int64(before.HeapAlloc); grew > 4<<20 {
				t.Errorf("%d bytes written left %d bytes on the heap", written, grew)
			}
			runtime.KeepAlive(out)
		})
	}
}
