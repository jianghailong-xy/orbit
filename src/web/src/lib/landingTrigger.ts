import type { IntegrationTimelineTrigger } from '@orbit/shared';
import { mainBranchName } from './projectStart';
import type { SentencePart } from './landingSentence';

/**
 * What put a landing's attempt on the queue, drawn as the opening message of its turn — the chat's user bubble, who it
 * came from on the muted line over it (owner 2026-11-11, docs/mocks/landings-chat-trigger). The words are these; the
 * facts are the section's `trigger` fields. Nothing is read out of a server sentence.
 */
export const LANDING_TRIGGER_COPY = {
  FROM_TASK_DONE: 'From the task · Done',
  FROM_COORDINATOR_RERUN: 'From the coordinator · Rerun',
  FROM_YOU_RERUN: 'From you · Rerun',
  FROM_ORBIT_RERUN: 'From Orbit · Rerun',
  FROM_ORBIT: 'From Orbit',
  FROM_AUTOMATIC: 'From Automatic',
  FROM_YOU: 'From you',
  LAND: 'Land',
  MERGE: 'Merge',
  INTO: 'into',
  CHECK: 'Check',
  BEFORE_MERGING_INTO: 'before merging into',
  LOOK_FOR_WORK_ON: 'Look for finished work on',
  STARTED_INTEGRATING: 'the project started integrating',
  ENDED_ON_ANOTHER_BRANCH: 'the task\'s work ended on another branch',
  ATTEMPT: 'attempt',
  OF: 'of',
} as const;

export interface TriggerMessage {
  /** The muted line over the bubble: who. */
  from: string;
  /** The bubble: what was handed over. */
  parts: SentencePart[];
}

const plain = (text: string): SentencePart => ({ text });
const strong = (text: string): SentencePart => ({ text, strong: true });
const code = (text: string): SentencePart => ({ text, code: true });

/** The message for one attempt's trigger. `task` is the task's name (or the round's title); `tasks` a merge round's
 *  task count; `main` the line a merge goes into; `attempt` Automatic's Nth try, where the timeline says so. */
export function triggerMessage(trigger: IntegrationTimelineTrigger, context: {
  task: string;
  tasks?: number | null;
  main?: string | null;
  attempt?: { attempt: number; limit: number } | null;
}): TriggerMessage {
  const C = LANDING_TRIGGER_COPY;
  const branch = mainBranchName(trigger.sourceRef);
  const handed = (): SentencePart[] => [
    plain(' · '), code(branch),
    ...(trigger.sourceSha ? [plain(' · '), code(trigger.sourceSha.slice(0, 7))] : []),
  ];
  const land = (): SentencePart[] => [plain(`${C.LAND} `), strong(context.task), ...handed()];
  const main = context.main ?? 'main';
  switch (trigger.cause) {
    case 'DONE':
      return { from: C.FROM_TASK_DONE, parts: land() };
    case 'RETRY': {
      const from = trigger.by === 'COORDINATOR' ? C.FROM_COORDINATOR_RERUN
        : trigger.by === 'OWNER' ? C.FROM_YOU_RERUN : C.FROM_ORBIT_RERUN;
      return { from, parts: trigger.reason ? [plain(trigger.reason)] : land() };
    }
    case 'BACKFILL':
      return { from: C.FROM_ORBIT, parts: [...land(), plain(` · ${C.STARTED_INTEGRATING}`)] };
    case 'BEHIND_WORK':
      return { from: C.FROM_ORBIT, parts: [...land(), plain(` · ${C.ENDED_ON_ANOTHER_BRANCH}`)] };
    case 'CHECK':
      return {
        from: C.FROM_ORBIT,
        parts: [plain(`${C.CHECK} `), code(branch),
          ...(trigger.sourceSha ? [plain(' · '), code(trigger.sourceSha.slice(0, 7))] : []),
          plain(` ${C.BEFORE_MERGING_INTO} ${main}`)],
      };
    case 'CONFIRMED': {
      const tasks = context.tasks ?? null;
      const what = tasks != null ? [plain(`${C.MERGE} `), strong(`${tasks} ${tasks === 1 ? 'task' : 'tasks'}`), plain(` ${C.INTO} ${main}`)]
        : [plain(`${C.MERGE} ${C.INTO} ${main}`)];
      const attempt = context.attempt && trigger.by === 'AUTOMATIC'
        ? [plain(` · ${C.ATTEMPT} ${context.attempt.attempt} ${C.OF} ${context.attempt.limit}`)] : [];
      return { from: trigger.by === 'AUTOMATIC' ? C.FROM_AUTOMATIC : C.FROM_YOU, parts: [...what, ...handed(), ...attempt] };
    }
    case 'OBSERVE':
      return { from: C.FROM_ORBIT, parts: [plain(`${C.LOOK_FOR_WORK_ON} `), code(branch)] };
  }
}
