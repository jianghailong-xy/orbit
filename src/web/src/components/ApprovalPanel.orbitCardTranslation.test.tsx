// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalTranslation } from '@orbit/shared';
import { ApprovalPanel, orbitCardTranslation } from './ApprovalPanel';
import type { ApprovalInfo } from '../api';

// Settings › Translation on Orbit's own cards (board docs/mocks/session-translation/04-owner-cards.html,
// part 2): the create, batch, project, blocker and DAG-change cards draw the agent's words in the owner's
// language from approval.translation, with one "Translated · Show original" flip for the whole card, and
// the original when there is no translation or it failed.

const card = (toolName: string, input: Record<string, unknown>, translation?: ApprovalTranslation): ApprovalInfo =>
  ({ id: `${toolName}-1`, sessionId: 's1', toolName, status: 'PENDING', createdAt: '2026-11-17T05:00:00Z', input, translation }) as ApprovalInfo;

interface Fixture {
  toolName: string;
  input: Record<string, unknown>;
  translation: ApprovalTranslation;
  /** Words the card draws in each language. */
  original: string[];
  translated: string[];
}

const FIXTURES: Fixture[] = [
  {
    toolName: 'orbit_task_create',
    input: {
      title: 'Fix the Safari login',
      description: 'The login button does nothing in Safari.',
      acceptanceCriteria: 'Logging in works in Safari 18.',
      completionCriterion: 'EVIDENCE_JUDGMENT',
    },
    translation: { lang: 'zh-Hans', title: '修复 Safari 登录', description: 'Safari 里登录按钮没反应。', acceptanceCriteria: 'Safari 18 能登录。' },
    original: ['Fix the Safari login', 'The login button does nothing in Safari.', 'Logging in works in Safari 18.'],
    translated: ['修复 Safari 登录', 'Safari 里登录按钮没反应。', 'Safari 18 能登录。'],
  },
  {
    toolName: 'orbit_task_batch',
    input: {
      tasks: [{ title: 'Write the migration', ref: 'a' }, { title: 'Backfill', dependsOnRefs: ['a'] }],
      preview: { taskCount: 2, startingNow: 1, blocked: 1, tasks: [{ title: 'Write the migration', ref: 'a' }, { title: 'Backfill', dependsOnRefs: ['a'] }] },
    },
    translation: { lang: 'zh-Hans', tasks: [{ title: '写迁移' }, { title: '回填' }] },
    original: ['Write the migration', 'Backfill'],
    translated: ['写迁移', '回填'],
  },
  {
    toolName: 'orbit_project_create',
    input: {
      title: 'CSV export',
      goal: 'Ship the new CSV export.',
      acceptanceCriteriaItems: [{ text: 'The export keeps cost_center.' }, { text: 'The finance sheet still loads.' }],
    },
    translation: {
      lang: 'zh-Hans',
      title: 'CSV 导出',
      goal: '上线新的 CSV 导出。',
      acceptanceCriteriaItems: [{ text: '导出保留 cost_center。' }, { text: '财务表仍能打开。' }],
    },
    original: ['CSV export', 'Ship the new CSV export.', 'The export keeps cost_center.', 'The finance sheet still loads.'],
    translated: ['CSV 导出', '上线新的 CSV 导出。', '导出保留 cost_center。', '财务表仍能打开。'],
  },
  {
    toolName: 'orbit_blocker_resolve',
    input: {
      projectTitle: 'CSV export', reason: 'The provider is back online.',
      blocker: { kind: 'PROVIDER', requiredAction: 'Sign the provider in again.' },
    },
    translation: { lang: 'zh-Hans', reason: '服务商已经恢复在线。' },
    original: ['The provider is back online.'],
    translated: ['服务商已经恢复在线。'],
  },
  {
    toolName: 'orbit_dag_change',
    input: {
      note: 'Backfill no longer waits on the migration.',
      preview: { listTitle: 'Data', ops: [{ op: 'remove', taskTitle: 'Backfill', dependsOnTitle: 'Migration' }], edgesBefore: 1, edgesAfter: 0 },
    },
    translation: { lang: 'zh-Hans', note: '回填不再等迁移。' },
    original: ['Backfill no longer waits on the migration.'],
    translated: ['回填不再等迁移。'],
  },
];

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const mount = (a: ApprovalInfo) => act(() => root.render(<ApprovalPanel approval={a} onDecide={() => {}} />));
const text = () => host.textContent ?? '';
const flip = () => host.querySelector<HTMLButtonElement>('.chat-translate-foot.is-card .chat-translate-action');

describe.each(FIXTURES)('$toolName card', (f) => {
  it('draws the translation with "Translated · Show original", and the original once flipped', () => {
    mount(card(f.toolName, f.input, f.translation));
    for (const words of f.translated) expect(text()).toContain(words);
    for (const words of f.original) expect(text()).not.toContain(words);
    expect(host.querySelector('.chat-translate-foot.is-card')?.textContent).toBe('Translated·Show original');

    act(() => flip()!.click());
    for (const words of f.original) expect(text()).toContain(words);
    for (const words of f.translated) expect(text()).not.toContain(words);
    expect(host.querySelector('.chat-translate-foot.is-card')?.textContent).toBe('Original·Show translation');

    act(() => flip()!.click());
    for (const words of f.translated) expect(text()).toContain(words);
  });

  it('draws the original, with no flip, when there is no translation or it failed', () => {
    for (const translation of [undefined, { lang: 'zh-Hans', failed: true } as ApprovalTranslation]) {
      mount(card(f.toolName, f.input, translation));
      for (const words of f.original) expect(text()).toContain(words);
      expect(text()).not.toContain('Show original');
      expect(flip()).toBeNull();
    }
  });
});

describe('orbitCardTranslation', () => {
  it('answers only a usable translation carrying a field the card draws', () => {
    expect(orbitCardTranslation(card('orbit_task_create', {}, { lang: 'zh-Hans', description: '描述' }))?.description).toBe('描述');
    expect(orbitCardTranslation(card('orbit_task_create', {}, { lang: 'zh-Hans', failed: true }))).toBeUndefined();
    expect(orbitCardTranslation(card('orbit_dag_change', {}, { lang: 'zh-Hans', reason: '不是这张卡的' }))).toBeUndefined();
    expect(orbitCardTranslation(card('Bash', {}, { lang: 'zh-Hans', description: '删掉 build' }))).toBeUndefined();
  });

  it('keeps an untranslated field in the original', () => {
    mount(card('orbit_task_create', { title: 'Fix the Safari login', description: 'The login button does nothing.' }, { lang: 'zh-Hans', description: '登录按钮没反应。' }));
    expect(text()).toContain('Fix the Safari login');
    expect(text()).toContain('登录按钮没反应。');
  });
});
