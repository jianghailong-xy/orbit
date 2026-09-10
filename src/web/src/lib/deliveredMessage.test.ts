import { describe, expect, it } from 'vitest';
import {
  describeInjected,
  describeNote,
  lastTypedUserMessageText,
  splitDeliveredMessage,
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

describe('splitDeliveredMessage', () => {
  it('takes an appended block out of the bubble and keeps it verbatim', () => {
    const out = splitDeliveredMessage(`把这个项目协调起来\n\n${COORDINATOR}`);

    expect(out.text).toBe('把这个项目协调起来');
    expect(out.injected).toHaveLength(1);
    expect(out.injected[0].tag).toBe('orbit_project_coordinator_context');
    // Verbatim, because the tooltip is the only remaining way to see what the model read.
    expect(out.injected[0].text).toBe(COORDINATOR);
  });

  it('peels several blocks and keeps the order they were appended in', () => {
    const out = splitDeliveredMessage(
      `看下 #FineWeb\n\n${REF_LIST}\n\n${REF_TASK}\n\n${COORDINATOR}`,
    );

    expect(out.text).toBe('看下 #FineWeb');
    expect(out.injected.map((b) => b.tag)).toEqual([
      'referenced-list',
      'referenced-task',
      'orbit_project_coordinator_context',
    ]);
    expect(out.injected.at(-1)?.text).toBe(COORDINATOR);
  });

  it('leaves an ordinary message byte-identical', () => {
    // Overwhelmingly the common case: one string comparison and nothing else happens.
    const plain = '把 WARC 转换拆开并行跑，它不依赖去重完成。';

    expect(splitDeliveredMessage(plain)).toEqual({ text: plain, injected: [] });
  });

  it('does not eat a tag the person typed mid-sentence', () => {
    // The reason the match is anchored to the end. Someone asking about this very feature must
    // not have their question silently rewritten.
    const asking = `为什么 <referenced-task> 这个块会出现在我自己的气泡里？\n\n它是谁加的？`;

    expect(splitDeliveredMessage(asking).text).toBe(asking);
  });

  it('does not strip an unclosed block', () => {
    const broken = `问题\n\n<referenced-list id="x">\n  一半就断了`;

    expect(splitDeliveredMessage(broken).injected).toEqual([]);
  });

  it('does not strip a tag that is not one of ours', () => {
    const code = `帮我看下这段\n\n<my-component id="x">\n  <div/>\n</my-component>`;

    expect(splitDeliveredMessage(code).injected).toEqual([]);
  });

  it('handles a message that is nothing but injected context', () => {
    // A server-seeded turn with no text of its own.
    const out = splitDeliveredMessage(`\n\n${COORDINATOR}`);

    expect(out.text).toBe('');
    expect(out.injected).toHaveLength(1);
  });

  it('never reads a condition board or a background-jobs block out of the text', () => {
    // Those two are told apart by the note ingest records. Someone who pastes one into the
    // composer — to ask why it showed up, say — sent exactly that, and must see exactly that.
    for (const block of [CONDITIONS, BACKGROUND_JOBS]) {
      const pasted = `这是什么？\n\n${block}`;

      expect(splitDeliveredMessage(pasted)).toEqual({ text: pasted, injected: [] });
    }
  });
});

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

describe('describeInjected', () => {
  it('names what was attached, so the reply is not unexplained', () => {
    const { injected } = splitDeliveredMessage(`q\n\n${REF_LIST}\n\n${COORDINATOR}`);

    expect(describeInjected(injected)).toBe('referenced list, project coordinator context');
  });

  it('counts a repeat instead of listing it twice', () => {
    const { injected } = splitDeliveredMessage(`q\n\n${REF_TASK}\n\n${REF_TASK}`);

    expect(describeInjected(injected)).toBe('referenced task ×2');
  });
});

describe('describeNote', () => {
  it('names a recorded note by the block it opens with, the two only a note can carry included', () => {
    expect(describeNote(`\n\n${BACKGROUND_JOBS}`)).toBe('background jobs');
    expect(describeNote(CONDITIONS)).toBe('list conditions');
    expect(describeNote(COORDINATOR)).toBe('project coordinator context');
  });

  it('names every block one delivery appended, the way the older reading names what it found', () => {
    // Delivery appends references, then the condition board, then background jobs, then the
    // coordinator's role: a coordinator with a build still running gets two blocks in one note.
    const appended = `\n\n${REF_TASK}\n\n${REF_TASK}\n\n${BACKGROUND_JOBS}\n\n${COORDINATOR}`;

    expect(describeNote(appended)).toBe('referenced task ×2, background jobs, project coordinator context');

    const older = `\n\n${REF_LIST}\n\n${COORDINATOR}`;
    expect(describeNote(older)).toBe(describeInjected(splitDeliveredMessage(`q${older}`).injected));
  });

  it('still names an opening it does not recognise, generically', () => {
    expect(describeNote('<orbit_something_new>\n  x\n</orbit_something_new>')).toBe('context');
    expect(describeNote('<background-jobs-v2>\n  x\n</background-jobs-v2>')).toBe('context');
    expect(describeNote('[Image #1]')).toBe('context');
  });
});

describe('lastTypedUserMessageText', () => {
  it('skips a newer image-only echo made non-empty solely by coordinator context', () => {
    const events = [
      { type: 'user', payload: { text: `real question\n\n${COORDINATOR}` } },
      { type: 'user', payload: { text: `\n\n${COORDINATOR}` } },
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
});
