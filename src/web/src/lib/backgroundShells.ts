import type { RunEvent } from '../components/Transcript';
import { resultText } from '../components/Transcript';

// Derives the set of background shell processes (and their latest polled output) from a
// session's event stream — the data behind the "Background processes" tray.
//
// The runner has NO special handling for Claude's background Bash: it forwards the raw
// tool_use/tool_result verbatim (see src/runner-go/claude.go). So everything we know is
// already in the event stream, and we reconstruct it here:
//   • start          → a `Bash` tool_use with input.run_in_background === true
//   • its result     → "Command running in background with ID: <id>. Output is being
//                       written to: <path>. You will be notified when it completes. …"
//   • interim output → the agent polls that <id>.output file with the `Read` tool
//
// Verified against the production event store: there are NO BashOutput/KillShell tool
// events (Claude polls via Read on the file) and NO persisted completion event — which
// is why completion is best-effort (see classifyShellStatus).

export type BgShellStatus = 'running' | 'done' | 'unknown';

export interface BgShell {
  /** Claude-assigned background shell id, e.g. "bei75180m". */
  shellId: string;
  /** The command that was launched. */
  command: string;
  /** Optional Bash `description` — preferred as the row title when present. */
  description?: string;
  /** The <id>.output file the command's output is written to (may be '' if unparsed). */
  outputPath: string;
  /** seq of the launching tool_use — stable key + chronological order. */
  startedSeq: number;
  /** Wall-clock of the launch (relative "started Nm ago"). */
  startedTs?: string;
  /** Text of the most recent Read-on-output snapshot the agent pulled. */
  latestOutput?: string;
  /** seq of that Read (so a newer poll wins over an older one). */
  latestOutputSeq?: number;
  /** Wall-clock of that Read ("updated Nm ago"). */
  latestOutputTs?: string;
  /** Best-effort lifecycle state — see classifyShellStatus. */
  status: BgShellStatus;
}

export interface BgShellCtx {
  /** Whether the session is still live (not in a terminal state). */
  sessionLive: boolean;
}

// "Command running in background with ID: <id>." — capture up to the first period/space.
const BG_ID_RE = /running in background with ID:\s+(\S+?)[.\s]/i;
// "Output is being written to: <path>.output." — greedy so it spans the whole path and
// stops at the `.output` extension (the path segments themselves contain no dots).
const BG_PATH_RE = /written to:\s+(\S+\.output)/i;
// Pull the <id> back out of a "…/tasks/<id>.output" file path (fallback Read match).
const OUTPUT_SUFFIX_RE = /([^/]+)\.output$/;

export function deriveBackgroundShells(
  events: RunEvent[],
  ctx: BgShellCtx = { sessionLive: true },
): BgShell[] {
  // tool_result → its originating tool_use, keyed by toolUseId (same linkage buildNodes uses).
  const resultByToolUseId = new Map<string, any>();
  for (const ev of events) {
    if (ev.type === 'tool_result') {
      const id = ev.payload?.toolUseId;
      if (id != null) resultByToolUseId.set(String(id), ev.payload);
    }
  }

  const byId = new Map<string, BgShell>(); // shellId → shell
  const byPath = new Map<string, BgShell>(); // outputPath → shell (exact-match fast path)

  for (const ev of events) {
    if (ev.type !== 'tool_use') continue;
    const p = ev.payload ?? {};
    const input = p.input ?? {};

    // 1) Background Bash launch.
    if (p.name === 'Bash' && input.run_in_background === true) {
      const res = resultByToolUseId.get(String(p.id));
      if (!res) continue; // result not in yet — re-derives once it arrives
      const content = resultText(res.content);
      const idM = content.match(BG_ID_RE);
      if (!idM) continue; // not a recognizable "running in background" confirmation
      const shellId = idM[1];
      if (byId.has(shellId)) continue; // de-dupe (shell ids are unique)
      const pathM = content.match(BG_PATH_RE);
      const outputPath = pathM ? pathM[1] : '';
      const shell: BgShell = {
        shellId,
        command: String(input.command ?? ''),
        description: input.description ? String(input.description) : undefined,
        outputPath,
        startedSeq: ev.seq,
        startedTs: ev.ts ?? undefined,
        status: 'running',
      };
      byId.set(shellId, shell);
      if (outputPath) byPath.set(outputPath, shell);
      continue;
    }

    // 2) Agent polling a background output file with Read → latest output snapshot.
    if (p.name === 'Read') {
      const fp = input.file_path ? String(input.file_path) : '';
      if (!fp.endsWith('.output')) continue;
      let shell = byPath.get(fp);
      if (!shell) {
        const m = fp.match(OUTPUT_SUFFIX_RE);
        if (m) shell = byId.get(m[1]); // fallback: match by <id> if the path prefix differs
      }
      if (!shell) continue;
      const res = resultByToolUseId.get(String(p.id));
      if (!res) continue;
      if (shell.latestOutputSeq == null || ev.seq >= shell.latestOutputSeq) {
        shell.latestOutput = resultText(res.content);
        shell.latestOutputSeq = ev.seq;
        shell.latestOutputTs = ev.ts ?? undefined;
      }
    }
  }

  const shells = [...byId.values()].sort((a, b) => a.startedSeq - b.startedSeq);
  for (const s of shells) s.status = classifyShellStatus(s, ctx);
  return shells;
}

/**
 * BEST-EFFORT completion classification — the single place to swap in a reliable
 * signal later.
 *
 * There is currently no dependable "this background process finished" signal in the
 * event stream: the production store has 0 BashOutput/KillShell events, no exit-code
 * sidecar file sits next to <id>.output, and the completion notice Claude shows the
 * model is not persisted as its own event. So today we only know a process EXISTS, not
 * that it ended:
 *   • session still live → 'running'
 *   • session ended      → 'unknown'  (it can't still be running, but don't claim 'done')
 *
 * FUTURE (plan phase 2): when the runner emits a real completion event
 * (e.g. `background_exit { shellId, exitCode }`), consume it here and return
 * 'done'/'failed'. The tray + completion toast both key off this function, so nothing
 * else has to change.
 */
export function classifyShellStatus(_shell: BgShell, ctx: BgShellCtx): BgShellStatus {
  return ctx.sessionLive ? 'running' : 'unknown';
}
