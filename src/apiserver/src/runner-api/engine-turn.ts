import { RunEventType } from '@orbit/shared';

type EventLike = { seq: number; type: string; payload?: unknown };

/** Events only a generating engine produces. A `system` handshake or a background-task
 *  notification can land on a genuinely idle session, so neither counts. */
const GENERATING: ReadonlySet<string> = new Set<string>([
  RunEventType.ASSISTANT,
  RunEventType.THINKING,
  RunEventType.TOOL_USE,
  RunEventType.TOOL_RESULT,
]);

const isRuntimeHandshake = (e: EventLike): boolean =>
  e.type === RunEventType.SYSTEM &&
  ['init', 'resumed'].includes(String((e.payload as { subtype?: unknown } | null)?.subtype ?? ''));

/**
 * A Bash tool pair the runner emitted for a shell command it ran itself — a user `!cmd` or an
 * EXECUTABLE acceptance — which bypasses the engine entirely (runner-go shell.go,
 * executable_acceptance.go). It deliberately wears the engine's own Bash tool shape so the
 * transcript renders it identically, so only the `shell-` id the runner tags it with tells them
 * apart; the Web already reads that same marker.
 *
 * Counting it as generating latched the flag on with nothing left to clear it: a shell turn ends
 * through /turn-complete and never emits a `turn_end` event, so the frontier stayed a tool event
 * forever and the session drew a working spinner while parked and idle. Runner activity is not
 * engine activity — the same reason the runner's own `user` echo decides nothing above.
 */
const isRunnerShellTool = (e: EventLike): boolean => {
  if (e.type !== RunEventType.TOOL_USE && e.type !== RunEventType.TOOL_RESULT) return false;
  const payload = e.payload as { id?: unknown; toolUseId?: unknown } | null;
  const id = payload?.id ?? payload?.toolUseId;
  return typeof id === 'string' && id.startsWith('shell-');
};

/**
 * Whether a durable event batch leaves the engine mid-turn — see Session.engineTurnActive.
 *
 * A runtime starts turns the control plane never dispatched (a background task reporting in, a
 * scheduled wake-up). Those never reach /turn-complete, so `status` alone cannot tell a parked
 * session from one that is streaming tools. Only the event frontier can, which is why this reads
 * the highest-seq event that decides the question rather than any event in the batch: a batch
 * routinely carries a turn ending *and* the next turn's first tool.
 *
 * Both clearing signals matter. A turn ending is the ordinary one. A runtime handshake is the
 * backstop: a runner killed mid-turn emits no turn end, and without this its session would keep
 * a working spinner until it was resumed and parked again.
 *
 * Returns undefined when nothing in the batch decides either way, so the stored value stands.
 */
export function engineTurnActiveAfter(events: EventLike[]): boolean | undefined {
  let decided: { seq: number; active: boolean } | undefined;
  for (const e of events) {
    const active = isRunnerShellTool(e)
      ? undefined
      : GENERATING.has(e.type)
        ? true
        : e.type === RunEventType.TURN_END || isRuntimeHandshake(e)
          ? false
          : undefined;
    if (active === undefined) continue;
    if (!decided || e.seq > decided.seq) decided = { seq: e.seq, active };
  }
  return decided?.active;
}

/** The phases a runtime may name. One member: see Session.enginePhase for why it is not an enum. */
const NAMED_PHASES: ReadonlySet<string> = new Set<string>(['compacting']);

/**
 * What one event says about the engine's phase — a name, `null` for "the phase is over", or
 * `undefined` for "says nothing".
 *
 * Any engine output ends a phase, because a phase names a stretch in which the engine produces
 * nothing else: output is proof that stretch is over. That matters more than it sounds. The frame
 * that closes a compaction is not guaranteed to arrive — a compaction that ends by simply getting
 * on with the turn goes straight to generating — and without this the session would read as
 * compacting until the next claim cleared it.
 *
 * A runner shell tool is excluded for the same reason it is excluded above: runner activity is
 * not engine activity, and it can run while the engine is genuinely mid-phase.
 */
const enginePhaseOf = (e: EventLike): string | null | undefined => {
  if (isRunnerShellTool(e)) return undefined;
  if (GENERATING.has(e.type)) return null;
  if (e.type !== RunEventType.SYSTEM) return undefined;
  const named = (e.payload as { enginePhase?: unknown } | null)?.enginePhase;
  if (typeof named !== 'string') return undefined;
  if (NAMED_PHASES.has(named)) return named;
  // 'none' is the runner saying a phase ended. Anything else is a runner newer than this server
  // naming a phase it has never heard of, which must read as "no named phase" rather than be
  // stored and shown to a client that would not know what to say about it either.
  return null;
};

/**
 * The engine phase this batch leaves the session in — see Session.enginePhase.
 *
 * Highest-seq wins, like engineTurnActiveAfter above and for the same reason: a single batch
 * routinely carries a compaction starting and the output that ends it. Returns undefined when
 * nothing in the batch decides, so the stored value stands.
 */
export function enginePhaseAfter(events: EventLike[]): string | null | undefined {
  let decided: { seq: number; phase: string | null } | undefined;
  for (const e of events) {
    const phase = enginePhaseOf(e);
    if (phase === undefined) continue;
    if (!decided || e.seq > decided.seq) decided = { seq: e.seq, phase };
  }
  return decided?.phase;
}
