import { describe, expect, it } from 'vitest';
import {
  describeNote,
  lastTypedUserMessage,
  lastTypedUserMessageText,
  splitRecordedNote,
} from './deliveredMessage';

// The exact shapes the server appends (ReferenceExpansionService, ListEventsService,
// background-jobs-context).
const CONDITIONS = `<list-conditions list="6ba7b810-9dad-11d1-80b4-00c04fd430c8" title="FineWeb">
  配额挡住派发｜12 个就绪任务被配额挡住｜首次 2026-08-15T03:11:00.000Z，最近 2026-08-15T04:07:00.000Z，累计 47 次
  以上是控制面在你上次收到消息之后观察到的，不是用户说的。
</list-conditions>`;

const BACKGROUND_JOBS = `<background-jobs>
  你不在的时候结束了：
    bgj_3a1af2b50428｜job｜npm run build｜completed｜退出码 0｜输出 /root/.orbit/runs/x/bgj_3a1af2b50428.output
  这是控制面替你记下的，不是用户说的。输出文件由 runner 持有，engine 换过也还在。
</background-jobs>`;

const REF_LIST = `<referenced-list id="6ba7b810-9dad-11d1-80b4-00c04fd430c8">
  标题   FineWeb CC-MAIN-2025-26
  规模   DONE 249 / OPEN 248
</referenced-list>`;

const REF_TASK = `<referenced-task id="550e8400-e29b-41d4-a716-446655440000">
  标题   [W 009/250] → WARC
  状态   DONE
</referenced-task>`;

const COORDINATOR = `<orbit_project_coordinator_context>
  你是项目（id: 4gfFCpGvM8ZoqYTZwH3cCB）的协调会话。
  这里用来协调任务，不是替任务干活。
</orbit_project_coordinator_context>`;

describe('splitRecordedNote', () => {
  it('splits exactly where the recorded note begins', () => {
    const note = `\n\n${BACKGROUND_JOBS}`;

    expect(splitRecordedNote({ text: `继续${note}`, controlPlaneNote: note })).toEqual({
      text: '继续',
      note: BACKGROUND_JOBS,
    });
  });

  it('leaves what the person typed whole, even a block of the same kind', () => {
    // Someone pasted a board, and delivery then appended the current one: only the second is Orbit's.
    const typed = `这是什么？\n\n${CONDITIONS}`;
    const note = `\n\n${CONDITIONS}`;

    expect(splitRecordedNote({ text: `${typed}${note}`, controlPlaneNote: note })?.text).toBe(typed);
  });

  it('has nothing to split without a note, or with one that is not the end of the text', () => {
    expect(splitRecordedNote({ text: `q\n\n${CONDITIONS}` })).toBeNull();
    expect(splitRecordedNote({ text: 'q', controlPlaneNote: `\n\n${CONDITIONS}` })).toBeNull();
  });
});

describe('describeNote', () => {
  it('names a recorded note by the block it opens with', () => {
    expect(describeNote(`\n\n${BACKGROUND_JOBS}`)).toBe('background jobs');
    expect(describeNote(CONDITIONS)).toBe('list conditions');
    expect(describeNote(COORDINATOR)).toBe('project coordinator context');
  });

  it('names every block one delivery appended, and counts a repeat instead of listing it twice', () => {
    // Delivery appends references, then the condition board, then background jobs, then the
    // coordinator's role: a coordinator with a build still running gets two blocks in one note.
    const appended = `\n\n${REF_TASK}\n\n${REF_TASK}\n\n${BACKGROUND_JOBS}\n\n${COORDINATOR}`;

    expect(describeNote(appended)).toBe('referenced task ×2, background jobs, project coordinator context');
    expect(describeNote(`\n\n${REF_LIST}\n\n${COORDINATOR}`)).toBe('referenced list, project coordinator context');
  });

  it('still names an opening it does not recognise, generically', () => {
    expect(describeNote('<orbit_something_new>\n  x\n</orbit_something_new>')).toBe('context');
    expect(describeNote('<background-jobs-v2>\n  x\n</background-jobs-v2>')).toBe('context');
    expect(describeNote('[Image #1]')).toBe('context');
  });
});

describe('lastTypedUserMessageText', () => {
  it('skips a newer image-only echo made non-empty solely by coordinator context', () => {
    const note = `\n\n${COORDINATOR}`;
    const events = [
      { type: 'user', payload: { text: `real question${note}`, controlPlaneNote: note } },
      { type: 'user', payload: { text: note, controlPlaneNote: note } },
    ];

    expect(lastTypedUserMessageText(events, 'old opening', 2)).toBe('real question');
  });

  it('does not treat an undelivered first-turn prompt as injected echo', () => {
    const prompt = `explain this literal example\n\n${COORDINATOR}`;

    expect(lastTypedUserMessageText([], prompt, 0)).toBe(prompt);
  });

  it('re-sends what was typed, not the note delivery appended to it', () => {
    // A retry carrying the echo would store the block as words the person wrote.
    const note = `\n\n${BACKGROUND_JOBS}`;
    const events = [{ type: 'user', payload: { text: `部署一下${note}`, controlPlaneNote: note } }];

    expect(lastTypedUserMessageText(events, 'old opening', 1)).toBe('部署一下');
  });

  it.each([
    ['<referenced-task>', REF_TASK],
    ['<orbit_project_coordinator_context>', COORDINATOR],
    ['<list-conditions>', CONDITIONS],
    ['<background-jobs>', BACKGROUND_JOBS],
  ])('re-sends a message with no recorded note as echoed, a %s block at its end included', (_, block) => {
    // Only a recorded note says where the person's words end; without one, all of it is theirs.
    const echoed = `这是什么？\n\n${block}`;

    expect(lastTypedUserMessageText([{ type: 'user', payload: { text: echoed } }], 'old opening', 1)).toBe(echoed);
  });
});

describe('lastTypedUserMessage', () => {
  // The attachments are already on the server: `turn_id` points at the turn that was swallowed and
  // the bytes never moved. A retry that sends `images: []` asks the person to find the two files
  // again for a message the control plane still holds whole.
  const PNG_A = '0199aa00-0000-7000-8000-00000000a001';
  const PNG_B = '0199aa00-0000-7000-8000-00000000a002';

  it('recovers the ids of the attachments sent with the message it re-sends', () => {
    const events = [
      {
        type: 'user',
        payload: {
          text: '看看这两张图',
          attachments: [
            { id: PNG_A, mime: 'image/png', name: 'before.png' },
            { id: PNG_B, mime: 'image/png', name: 'after.png' },
          ],
        },
      },
    ];

    expect(lastTypedUserMessage(events, null, 1)).toEqual({
      text: '看看这两张图',
      attachmentIds: [PNG_A, PNG_B],
    });
  });

  it('reads the older id-only echo the same way', () => {
    // Events recorded before the refs carried mime/name echo `images` instead.
    const events = [{ type: 'user', payload: { text: '再试一次', images: [{ id: PNG_A }] } }];

    expect(lastTypedUserMessage(events, null, 1).attachmentIds).toEqual([PNG_A]);
  });

  it('takes the attachments from the same turn as the text, never a newer one', () => {
    // The text is found by walking back past echoes that carry no words of their own. Whatever
    // rides with the retry has to be what was sent WITH that message: attachments picked up from a
    // later turn would re-send somebody else's files under this message's words.
    const note = `\n\n${COORDINATOR}`;
    const events = [
      { type: 'user', payload: { text: '这两张', attachments: [{ id: PNG_A }] } },
      { type: 'user', payload: { text: note, controlPlaneNote: note, attachments: [{ id: PNG_B }] } },
    ];

    expect(lastTypedUserMessage(events, null, 2)).toEqual({ text: '这两张', attachmentIds: [PNG_A] });
  });

  it('carries nothing for a message that had no attachments', () => {
    expect(lastTypedUserMessage([{ type: 'user', payload: { text: '部署一下' } }], null, 1)).toEqual({
      text: '部署一下',
      attachmentIds: [],
    });
  });

  it('carries nothing for the first-turn prompt fallback, which has no echoed turn to read', () => {
    expect(lastTypedUserMessage([], 'open with this', 0)).toEqual({
      text: 'open with this',
      attachmentIds: [],
    });
  });

  it('is the one reading the text accessor is built on', () => {
    // Two scans could disagree about which turn is the last typed one, and then the retry would
    // send one message's words with another's files.
    const events = [
      { type: 'user', payload: { text: '看看这两张图', attachments: [{ id: PNG_A }, { id: PNG_B }] } },
    ];

    expect(lastTypedUserMessageText(events, null, 1)).toBe(lastTypedUserMessage(events, null, 1).text);
  });
});
