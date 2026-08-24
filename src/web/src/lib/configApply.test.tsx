// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Tooltip } from 'antd';
import { AgentProvider } from '@orbit/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_FIELDS,
  appliesMidTurn,
  configPillHints,
  type ConfigField,
  type ConfigPillState,
} from './configApply';
import { runtimeForProvider } from './workspaceDefaults';

/**
 * What the composer's config pills PROMISE about a change made through them, checked against what
 * the change actually does. The two used to be one sentence for all four fields ("the server
 * defers the re-spawn, so it applies on the next turn"); model and permission mode stopped
 * working that way when they moved onto the engine's control channel, and a tooltip that still
 * said it would be worse than no tooltip at all.
 *
 * Read off the RENDERED tooltip rather than the helper's return value, because the copy only
 * matters where a user meets it. That needs a DOM: antd renders a tooltip into a portal, which
 * `renderToStaticMarkup` skips entirely (`@rc-component/portal` returns null with no document),
 * so this file mounts into jsdom the way ProjectBlockingLeaderboard.test.tsx does; every other
 * test in `lib` keeps running in node.
 *
 * Nothing here asserts a rendering ORDER or a fixed sentence per pill. Each pill's copy is turned
 * back into the claim it makes — "even mid-turn" / "on the next turn" / no claim at all — and that
 * claim is compared with `appliesMidTurn`. Re-word a hint and this suite stays green; make one lie
 * about its field, or say nothing where the runtime is not known, and it goes red.
 */

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // antd's trigger measures its child. jsdom has no layout and no observer to report it with.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const LIVE_CLAUDE: ConfigPillState = {
  live: true,
  runnerOnline: true,
  trashed: false,
  missing: false,
  runtime: AgentProvider.CLAUDE,
};

/**
 * The four pills of one composer row, rendered together as the composer renders them: the tooltip
 * wraps the span, and `open` stands in for the hover that would otherwise be needed to see it.
 *
 * Each pill gets its own popup container, so which copy belongs to which field is answered by DOM
 * containment rather than by the order antd happened to append the popups in — and antd's
 * test-mode ids are all the same string, so `aria-describedby` could not answer it either.
 */
async function copyForEachField(state: ConfigPillState): Promise<Record<ConfigField, string>> {
  const hints = configPillHints(state);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <>
        {CONFIG_FIELDS.map((field) => (
          <div key={field} data-field={field}>
            <Tooltip
              title={hints[field]}
              open
              getPopupContainer={(node) => node.parentElement ?? document.body}
            >
              <span className="composer-pill">{field}</span>
            </Tooltip>
          </div>
        ))}
      </>,
    );
  });
  const out = {} as Record<ConfigField, string>;
  for (const field of CONFIG_FIELDS) {
    // The tooltip's own body, found the way a screen reader finds it (`role="tooltip"`) rather
    // than by an antd class name that a version bump renames.
    const shown =
      container.querySelector(`[data-field="${field}"] [role="tooltip"]`)?.textContent ?? '';
    expect(shown, `the ${field} pill rendered no tooltip at all`).not.toBe('');
    out[field] = shown;
  }
  await act(async () => root.unmount());
  container.remove();
  return out;
}

/**
 * The copy, read as the promise it makes: true = reaches the turn already running, false = waits
 * for the next one, null = says nothing about timing. A hint that manages to claim both is a bug
 * in the copy, not something to silently resolve one way.
 */
function promisedTiming(copy: string): boolean | null {
  const midTurn = /even mid-turn/.test(copy);
  const nextTurn = /on the next turn/.test(copy);
  if (midTurn && nextTurn) throw new Error(`this hint claims both timings: "${copy}"`);
  return midTurn ? true : nextTurn ? false : null;
}

describe('what the config pills promise about when a change lands', () => {
  it('tells the control-channel half from the spawn-only half on a Claude session', async () => {
    const copy = await copyForEachField(LIVE_CLAUDE);

    // The claim each pill makes has to be the one its field actually keeps. Driven off
    // CONFIG_FIELDS, so a fifth pill cannot join the row without being described here.
    const checked: ConfigField[] = [];
    for (const field of CONFIG_FIELDS) {
      expect(promisedTiming(copy[field]), `the ${field} pill: "${copy[field]}"`).toBe(
        appliesMidTurn(field, AgentProvider.CLAUDE),
      );
      checked.push(field);
    }
    expect(checked).toEqual(['model', 'permissionMode', 'effort', 'provider']);

    // …and the two halves have to READ differently. One shared sentence would satisfy every
    // assertion above the moment both halves were described with it.
    for (const immediate of ['model', 'permissionMode'] as const) {
      for (const deferred of ['effort', 'provider'] as const) {
        expect(copy[immediate]).not.toBe(copy[deferred]);
      }
    }
  });

  /**
   * `set_model` / `set_permission_mode` are Claude Code's; a Codex, Kimi or OpenCode session
   * re-spawns for all four fields exactly as it did before any of this. Telling one of those
   * "even mid-turn" would be a promise nothing in the stack keeps.
   */
  it('promises no other runtime the control channel it does not have', async () => {
    for (const runtime of [AgentProvider.CODEX, AgentProvider.KIMI, AgentProvider.OPENCODE]) {
      const copy = await copyForEachField({ ...LIVE_CLAUDE, runtime });
      for (const field of CONFIG_FIELDS) {
        expect(promisedTiming(copy[field]), `${runtime}'s ${field} pill: "${copy[field]}"`).toBe(
          false,
        );
      }
      // Spelled out for the two that moved: on Claude these read "even mid-turn", and the whole
      // point of the gate is that here they must not.
      expect(copy.model).toMatch(/on the next turn/);
      expect(copy.permissionMode).toMatch(/on the next turn/);
    }
  });

  /**
   * A configured (BYOK) identity is judged by the runtime it BORROWS, never by its slug — the
   * client's `runtimeForProvider` mirroring the server's `execRuntime`. Judged by slug, an
   * Anthropic-compatible endpoint would be told it re-spawns when it does not, and a
   * Codex-compatible one would be promised a control channel it has no engine for.
   */
  it('judges a BYOK slug by the runtime it borrows', async () => {
    const configured = [
      { slug: 'acme-anthropic', label: 'Acme', runtime: 'claude', models: [] },
      { slug: 'acme-openai', label: 'Acme GPT', runtime: 'codex', models: [] },
    ];
    const onClaude = await copyForEachField({
      ...LIVE_CLAUDE,
      runtime: runtimeForProvider('acme-anthropic', configured),
    });
    expect(promisedTiming(onClaude.model)).toBe(true);
    expect(promisedTiming(onClaude.permissionMode)).toBe(true);
    expect(promisedTiming(onClaude.effort)).toBe(false);

    const onCodex = await copyForEachField({
      ...LIVE_CLAUDE,
      runtime: runtimeForProvider('acme-openai', configured),
    });
    expect(promisedTiming(onCodex.model)).toBe(false);
    expect(promisedTiming(onCodex.permissionMode)).toBe(false);
  });

  /**
   * Until GET /providers answers, a custom slug's runtime is a guess, and the guess that costs
   * something is "claude" — the fallback every other resolution here uses. Say nothing instead.
   */
  it('promises nothing while the provider identity is still unresolved', async () => {
    const copy = await copyForEachField({ ...LIVE_CLAUDE, runtime: undefined });

    for (const field of CONFIG_FIELDS) {
      expect(promisedTiming(copy[field]), `the ${field} pill: "${copy[field]}"`).toBeNull();
    }
    // The Model pill has something better to say than silence: which model it is even showing.
    expect(copy.model).toMatch(/resolved from the provider default/);
  });

  /** A draft or an ended session PATCHes nothing — the pick rides along with create/resume. */
  it('promises nothing on a session that is not live', async () => {
    const copy = await copyForEachField({ ...LIVE_CLAUDE, live: false });

    for (const field of CONFIG_FIELDS) {
      expect(promisedTiming(copy[field]), `the ${field} pill: "${copy[field]}"`).toBeNull();
      expect(copy[field]).not.toBe('');
    }
  });

  /**
   * When the change cannot be made at all, when it would have landed is not the question being
   * asked. Every pill answers the one that is.
   */
  it('gives the reason it cannot be changed instead of a timing', async () => {
    const blocked: [string, Partial<ConfigPillState>, RegExp][] = [
      ['runner offline', { runnerOnline: false }, /Runner offline/],
      ['trashed', { trashed: true }, /Restore this session/],
      ['missing', { missing: true }, /Session not found/],
    ];
    for (const [name, state, expected] of blocked) {
      const copy = await copyForEachField({ ...LIVE_CLAUDE, ...state });
      for (const field of CONFIG_FIELDS) {
        // The Model pill keeps its own precedence: an unresolved identity outranks everything,
        // and it is resolved in every case here, so all four must read the reason.
        expect(copy[field], `${name}: the ${field} pill`).toMatch(expected);
        expect(promisedTiming(copy[field]), `${name}: the ${field} pill`).toBeNull();
      }
    }
  });

  /**
   * The mode pill answers two questions, and the answers are independent: what the mode MEANS on
   * this runtime (the shared semantics table) and as of when a change to it applies. Adding the
   * second must not evict the first — that note is the only warning a user gets that the mode they
   * picked is not the mode they will get.
   */
  it('keeps the permission-mode caveat alongside the timing', async () => {
    const note = 'Auto needs Opus 5, Fable 5 or Sonnet 5.';
    const copy = (await copyForEachField({ ...LIVE_CLAUDE, permissionNote: note })).permissionMode;

    expect(promisedTiming(copy)).toBe(true);
    // …and as its own sentence, not run onto the end of the timing clause, which would read as
    // one claim ("applies mid-turn Auto needs Opus 5").
    expect(copy).toContain(`. ${note}`);
  });
});
