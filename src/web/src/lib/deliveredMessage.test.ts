import { describe, expect, it } from 'vitest';
import { describeInjected, splitDeliveredMessage } from './deliveredMessage';

// The exact shapes the server appends (ReferenceExpansionService, ListEventsService).
const CONDITIONS = `<list-conditions list="6ba7b810-9dad-11d1-80b4-00c04fd430c8" title="FineWeb">
  配额挡住派发｜12 个就绪任务被配额挡住｜首次 2026-08-15T03:11:00.000Z，最近 2026-08-15T04:07:00.000Z，累计 47 次
  以上是控制面在你上次收到消息之后观察到的，不是用户说的。
</list-conditions>`;

const REF_LIST = `<referenced-list id="6ba7b810-9dad-11d1-80b4-00c04fd430c8">
  标题   FineWeb CC-MAIN-2025-26
  规模   DONE 249 / OPEN 248
</referenced-list>`;

const REF_TASK = `<referenced-task id="550e8400-e29b-41d4-a716-446655440000">
  标题   [W 009/250] → WARC
  状态   DONE
</referenced-task>`;

describe('splitDeliveredMessage', () => {
  it('takes the condition board out of the bubble and keeps it verbatim', () => {
    const out = splitDeliveredMessage(`这个列表现在什么情况？\n\n${CONDITIONS}`);

    expect(out.text).toBe('这个列表现在什么情况？');
    expect(out.injected).toHaveLength(1);
    expect(out.injected[0].tag).toBe('list-conditions');
    // Verbatim, because the tooltip is the only remaining way to see what the model read.
    expect(out.injected[0].text).toBe(CONDITIONS);
  });

  it('peels several blocks and keeps the order they were appended in', () => {
    const out = splitDeliveredMessage(`看下 #FineWeb\n\n${REF_LIST}\n\n${REF_TASK}\n\n${CONDITIONS}`);

    expect(out.text).toBe('看下 #FineWeb');
    expect(out.injected.map((b) => b.tag)).toEqual([
      'referenced-list',
      'referenced-task',
      'list-conditions',
    ]);
  });

  it('leaves an ordinary message byte-identical', () => {
    // Overwhelmingly the common case: one string comparison and nothing else happens.
    const plain = '把 WARC 转换拆开并行跑，它不依赖去重完成。';

    expect(splitDeliveredMessage(plain)).toEqual({ text: plain, injected: [] });
  });

  it('does not eat a tag the person typed mid-sentence', () => {
    // The reason the match is anchored to the end. Someone asking about this very feature must
    // not have their question silently rewritten.
    const asking = `为什么 <list-conditions> 这个块会出现在我自己的气泡里？\n\n它是谁加的？`;

    expect(splitDeliveredMessage(asking).text).toBe(asking);
  });

  it('does not strip an unclosed block', () => {
    const broken = `问题\n\n<list-conditions list="x">\n  一半就断了`;

    expect(splitDeliveredMessage(broken).injected).toEqual([]);
  });

  it('does not strip a tag that is not one of ours', () => {
    const code = `帮我看下这段\n\n<my-component id="x">\n  <div/>\n</my-component>`;

    expect(splitDeliveredMessage(code).injected).toEqual([]);
  });

  it('handles a message that is nothing but injected context', () => {
    // A server-seeded turn with no text of its own.
    const out = splitDeliveredMessage(`\n\n${CONDITIONS}`);

    expect(out.text).toBe('');
    expect(out.injected).toHaveLength(1);
  });
});

describe('describeInjected', () => {
  it('names what was attached, so the reply is not unexplained', () => {
    const { injected } = splitDeliveredMessage(`q\n\n${REF_LIST}\n\n${CONDITIONS}`);

    expect(describeInjected(injected)).toBe('referenced list, list conditions');
  });

  it('counts a repeat instead of listing it twice', () => {
    const { injected } = splitDeliveredMessage(`q\n\n${REF_TASK}\n\n${REF_TASK}`);

    expect(describeInjected(injected)).toBe('referenced task ×2');
  });
});
