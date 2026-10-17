package main

// A session process's scope: everything the process starts, however it detaches, ends with the session
// (docs/cursor-runtime-contract.md §3.4). Cursor CLI runs every command in a process group and session of
// its own, and a command can leave that in turn, so neither the CLI's process group nor its ppid tree
// holds what a session started once the CLI has gone: a CLI killed mid-turn leaves its commands running,
// adopted by init, where no teardown of the CLI's tree can find them.
//
// On Linux (session_scope_linux.go) the process runs under a keeper — this binary again, started as
// `orbit session-scope` — that makes itself a child subreaper (PR_SET_CHILD_SUBREAPER). An orphan is
// adopted by the nearest subreaper above it rather than by init, so everything the session starts stays
// the keeper's descendant whatever process group or session it moves to. Once the process ends, by any
// path — the stop, the session's end, a crash, a lost lease, the runner going away — the keeper kills
// every descendant left and reaps it, and only then exits, the way the process did. The keeper is the
// runner's child, in the runner's own cgroup, so the service manager's view of the runner is what it was:
// a runner restart under systemd (KillMode=mixed) still ends whatever is left, and an OOM kill in it still
// counts against the runner's unit (OOMPolicy=stop). Elsewhere (session_scope_other.go) the process is
// started as every engine's is: the leader of its own process group, torn down by
// terminateSessionProcessTree.
//
// Only Cursor CLI sessions run in a scope (startCursorACP); every other engine starts its process with
// startSessionProcess, as before.

// sessionScopeCommand is the keeper's subcommand. main runs it before anything else, so the environment
// it was given reaches the session's process unchanged.
const sessionScopeCommand = "session-scope"
