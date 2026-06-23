import type { RunEvent } from '../components/Transcript';
import { resultText } from '../components/Transcript';

// Derives the set of background shell processes (and their latest output) from a session's
// event stream — the data behind the "Background processes" tray.
//
// The agent launches these with Bash(run_in_background); their output goes to an <id>.output
// file. We reconstruct each process from the events the runner forwards:
//   • start          → a `Bash` tool_use with input.run_in_background === true; its result
//                       text carries "…running in background with ID: <id>… written to: <path>".
//   • interim output → the agent's own `Read` polls of that file, AND the runner's live tail
//                       (background_output events — independent of the agent's polling).
//   • completion     → a background_task event parsed from Claude's <task-notification>
//                       (status completed/failed/killed) — the reliable lifecycle signal.

export type BgShellStatus = 'running' | 'done' | 'failed' | 'killed' | 'unknown';
type TerminalStatus = Exclude<BgShellStatus, 'running' | 'unknown'>;

export interface BgShell {
  /** Claude-assigned background shell id, e.g. "bei75180m". */
  shellId: string;
  /** tool_use id of the launching Bash call — correlates output/completion events. */
  toolUseId: string;
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
  /** Most recent output snapshot — newest of the agent's Read polls and the live tail. */
  latestOutput?: string;
  /** seq of that snapshot (so a newer one wins). */
  latestOutputSeq?: number;
  /** Wall-clock of that snapshot ("updated Nm ago"). */
  latestOutputTs?: string;
  /** Terminal state reported by a background_task event, if any (reliable). */
  terminal?: TerminalStatus;
  /** Resolved lifecycle state — see classifyShellStatus. */
  status: BgShellStatus;
}

export interface BgShellCtx {
  /** Whether the session is still live (not in a terminal state). */
  sessionLive: boolean;
}

// "Command running in background with ID: <id>." — capture up to the first period/space.
const BG_ID_RE = /running in background with ID:\s+(\S+?)[.\s]/i;
// "Output is being written to: <path>.output." — greedy so it spans the whole path and stops
// at the `.output` extension (the path segments themselves contain no dots).
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
  const byToolUseId = new Map<string, BgShell>(); // launching tool_use id → shell

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
        toolUseId: String(p.id ?? ''),
        command: String(input.command ?? ''),
        description: input.description ? String(input.description) : undefined,
        outputPath,
        startedSeq: ev.seq,
        startedTs: ev.ts ?? undefined,
        status: 'running',
      };
      byId.set(shellId, shell);
      if (shell.toolUseId) byToolUseId.set(shell.toolUseId, shell);
      if (outputPath) byPath.set(outputPath, shell);
      continue;
    }

    // 2) Agent polling a background output file with Read → an output snapshot.
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
      applyOutput(shell, resultText(res.content), ev.seq, ev.ts);
    }
  }

  // Second pass: the runner's live tail and the reliable completion signal, both keyed by the
  // launching tool_use id (with a shellId fallback).
  for (const ev of events) {
    if (ev.type !== 'background_output' && ev.type !== 'background_task') continue;
    const p = ev.payload ?? {};
    const shell = matchShell(p, byToolUseId, byId);
    if (!shell) continue;
    if (ev.type === 'background_output') {
      applyOutput(shell, String(p.content ?? ''), ev.seq, ev.ts);
    } else {
      const t = terminalFromStatus(String(p.status ?? ''));
      if (t) shell.terminal = t;
    }
  }

  const shells = [...byId.values()].sort((a, b) => a.startedSeq - b.startedSeq);
  for (const s of shells) s.status = classifyShellStatus(s, ctx);
  return shells;
}

function matchShell(
  p: any,
  byToolUseId: Map<string, BgShell>,
  byId: Map<string, BgShell>,
): BgShell | undefined {
  const tu = p.toolUseId ? String(p.toolUseId) : '';
  if (tu && byToolUseId.has(tu)) return byToolUseId.get(tu);
  const sid = p.shellId ? String(p.shellId) : '';
  return sid ? byId.get(sid) : undefined;
}

// Newest snapshot wins, across both the agent's Read polls and the runner's live tail.
function applyOutput(shell: BgShell, text: string, seq: number, ts?: string | null) {
  if (shell.latestOutputSeq == null || seq >= shell.latestOutputSeq) {
    shell.latestOutput = text;
    shell.latestOutputSeq = seq;
    shell.latestOutputTs = ts ?? undefined;
  }
}

function terminalFromStatus(s: string): TerminalStatus | undefined {
  if (s === 'completed') return 'done';
  if (s === 'failed') return 'failed';
  if (s === 'killed' || s === 'stopped') return 'killed';
  return undefined; // 'running' / unknown — not a terminal state
}

/**
 * Resolves a background shell's lifecycle state.
 *
 * A background_task event (parsed by the runner from Claude's <task-notification>) is the
 * reliable completion signal, so when present it wins. Absent that — while the process is
 * still running and we've had no notification — we fall back to liveness: 'running' on a live
 * session, 'unknown' once it's ended (it can't still be running, but we never observed a
 * terminal state). This is the single point that turns the raw signal into a status, so the
 * tray icon + completion toast both stay consistent.
 */
export function classifyShellStatus(shell: BgShell, ctx: BgShellCtx): BgShellStatus {
  if (shell.terminal) return shell.terminal;
  return ctx.sessionLive ? 'running' : 'unknown';
}
