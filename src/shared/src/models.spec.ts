import { describe, expect, it } from 'vitest';
import { AgentProvider } from './enums';
import {
  DEFAULT_MODEL_BY_PROVIDER,
  fastModeAvailable,
  isRetiredModel,
  modelForProvider,
} from './models';

describe('isRetiredModel', () => {
  const catalogue = [{ value: 'claude-opus-5' }, { value: 'claude-sonnet-5' }];

  it('retires an id the provider no longer offers', () => {
    expect(isRetiredModel('claude-opus-4-8', catalogue)).toBe(true);
    expect(isRetiredModel('claude-opus-5', catalogue)).toBe(false);
    // Whitespace is not a difference — the same normalization the resolvers apply.
    expect(isRetiredModel('  claude-sonnet-5 ', catalogue)).toBe(false);
  });

  it('never retires against an unknown or empty catalogue', () => {
    // A runner that has not reported one yet says nothing about what the provider offers;
    // reading silence as "offers nothing" would blank every pin the moment one goes offline.
    expect(isRetiredModel('claude-opus-4-8', undefined)).toBe(false);
    expect(isRetiredModel('claude-opus-4-8', null)).toBe(false);
    expect(isRetiredModel('claude-opus-4-8', [])).toBe(false);
  });

  it('keeps a blank model — OpenCode picking for itself is a choice, not a stale id', () => {
    expect(isRetiredModel('', catalogue)).toBe(false);
    expect(isRetiredModel(null, catalogue)).toBe(false);
    expect(isRetiredModel(undefined, catalogue)).toBe(false);
  });

  it('keeps what the Runtime itself reports, catalogued or not', () => {
    // claude's settings.json names aliases (`opus`, `opusplan`, `best`) and gateway ids that the
    // quick-pick catalogue never lists. The runtime vouching for it is what makes it current.
    expect(isRetiredModel('opus', catalogue, 'opus')).toBe(false);
    expect(isRetiredModel('claude-opus-5[1m]', catalogue, 'claude-opus-5[1m]')).toBe(false);
    // …but only the one it actually reports.
    expect(isRetiredModel('opusplan', catalogue, 'opus')).toBe(true);
  });
});

describe('modelForProvider', () => {
  it('keeps a matching override for each provider', () => {
    expect(modelForProvider(AgentProvider.CODEX, 'gpt-5.4')).toBe('gpt-5.4');
    expect(modelForProvider(AgentProvider.CLAUDE, 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(modelForProvider(AgentProvider.KIMI, 'kimi-code/kimi-for-coding')).toBe(
      'kimi-code/kimi-for-coding',
    );
    expect(modelForProvider(AgentProvider.OPENCODE, 'anthropic/claude-sonnet-5')).toBe(
      'anthropic/claude-sonnet-5',
    );
    expect(modelForProvider(AgentProvider.ANTIGRAVITY, 'gemini-3.8-flash')).toBe('gemini-3.8-flash');
  });

  it('falls back to the provider default when no override is given', () => {
    expect(modelForProvider(AgentProvider.CODEX, null)).toBe(DEFAULT_MODEL_BY_PROVIDER[AgentProvider.CODEX]);
    expect(modelForProvider(AgentProvider.CODEX, undefined)).toBe('gpt-5.6-sol');
    expect(modelForProvider(AgentProvider.CLAUDE, '')).toBe('claude-opus-5');
    expect(modelForProvider(AgentProvider.KIMI, undefined)).toBe('kimi-code/kimi-for-coding');
    expect(modelForProvider(AgentProvider.OPENCODE, undefined)).toBe('');
    // No `--model` at all: agy runs its own default.
    expect(modelForProvider(AgentProvider.ANTIGRAVITY, undefined)).toBe('');
    expect(modelForProvider(AgentProvider.ANTIGRAVITY, '')).toBe('');
  });

  it('coerces a Claude model on a Codex session to the Codex default (the reported bug)', () => {
    // The exact mismatch from the 400: `codex -m claude-opus-4-8`.
    expect(modelForProvider(AgentProvider.CODEX, 'claude-opus-4-8')).toBe('gpt-5.6-sol');
    expect(modelForProvider(AgentProvider.CODEX, 'claude-fable-5')).toBe('gpt-5.6-sol');
  });

  it('coerces a GPT model on a Claude session to the Claude default', () => {
    expect(modelForProvider(AgentProvider.CLAUDE, 'gpt-5.5')).toBe('claude-opus-5');
  });

  it('coerces obvious cross-runtime models involving Kimi', () => {
    expect(modelForProvider(AgentProvider.KIMI, 'claude-opus-5')).toBe(
      'kimi-code/kimi-for-coding',
    );
    expect(modelForProvider(AgentProvider.KIMI, 'gpt-5.6-sol')).toBe(
      'kimi-code/kimi-for-coding',
    );
    expect(modelForProvider(AgentProvider.CLAUDE, 'kimi-code/kimi-for-coding')).toBe(
      'claude-opus-5',
    );
    expect(modelForProvider(AgentProvider.CODEX, 'kimi-k2.7-code')).toBe('gpt-5.6-sol');
  });

  it('leaves an unknown/custom id untouched (e.g. an ANTHROPIC_MODEL endpoint override)', () => {
    expect(modelForProvider(AgentProvider.CLAUDE, 'my-proxy/llama-3')).toBe('my-proxy/llama-3');
    expect(modelForProvider(AgentProvider.CODEX, 'o4-preview')).toBe('o4-preview');
  });

  it('drops a stale bare model when an older client switches an agent to OpenCode', () => {
    expect(modelForProvider(AgentProvider.OPENCODE, 'claude-opus-5')).toBe('');
    expect(modelForProvider(AgentProvider.OPENCODE, 'gpt-5.6-sol')).toBe('');
    expect(modelForProvider(AgentProvider.OPENCODE, 'anthropic/claude-sonnet-4')).toBe(
      'anthropic/claude-sonnet-4',
    );
    // A namespaced id is opaque: OpenCode legitimately routes to any upstream provider,
    // so the built-in prefix guards must not rewrite `kimi-code/…` here.
    expect(modelForProvider(AgentProvider.OPENCODE, 'kimi-code/kimi-for-coding')).toBe(
      'kimi-code/kimi-for-coding',
    );
  });

  it('keeps agy model slugs on Antigravity and nothing else, with no catalogue to ask', () => {
    // A runner that has reported no catalogue yet leaves only the historical prefix rule, which is
    // the API-key space every `agy models` list has always contained. What `agy models` lists,
    // folded to a base name, and the full slug it also accepts:
    expect(modelForProvider(AgentProvider.ANTIGRAVITY, 'gemini-3.1-pro')).toBe('gemini-3.1-pro');
    expect(modelForProvider(AgentProvider.ANTIGRAVITY, 'gemini-3.8-flash-high')).toBe(
      'gemini-3.8-flash-high',
    );
    // agy refuses to start on a model it does not list, so a stale pin from another runtime is
    // dropped and agy picks its own instead of failing the turn.
    expect(modelForProvider(AgentProvider.ANTIGRAVITY, 'claude-opus-5')).toBe('');
    expect(modelForProvider(AgentProvider.ANTIGRAVITY, 'gpt-5.6-sol')).toBe('');
    expect(modelForProvider(AgentProvider.ANTIGRAVITY, 'kimi-code/kimi-for-coding')).toBe('');
    expect(modelForProvider(AgentProvider.ANTIGRAVITY, 'google/gemini-3.1-pro')).toBe('');
  });

  it('coerces an agy model on another runtime to that runtime\'s default', () => {
    expect(modelForProvider(AgentProvider.CLAUDE, 'gemini-3.8-flash')).toBe('claude-opus-5');
    expect(modelForProvider(AgentProvider.CODEX, 'gemini-3.1-pro')).toBe('gpt-5.6-sol');
    expect(modelForProvider(AgentProvider.KIMI, 'gemini-3.1-pro')).toBe('kimi-code/kimi-for-coding');
    expect(modelForProvider(AgentProvider.OPENCODE, 'gemini-3.1-pro')).toBe('');
  });
});

/**
 * Antigravity's model space is whatever the assigned runner's `agy models` lists, and a Google
 * sign-in widens it past `gemini-…`: the account catalogue adds Claude Opus/Sonnet 5.5 and
 * GPT-OSS rows (contract §16.7). Reading those ids by prefix discarded every one of them and the
 * session silently ran agy's own Gemini default instead of the model that was picked.
 *
 * The runner folds each slug into one row per base model (`claude-opus-5-5`), so the full slug agy
 * also accepts (`claude-opus-5-5-medium`) is matched by its base — and a runner that has not
 * reported a catalogue keeps the historical prefix rule.
 */
describe('modelForProvider on Antigravity reads the assigned runner’s agy catalogue', () => {
  // `agy models` on a runner with a Google sign-in: 18 slugs folded into 7 rows.
  const googleCatalog = [
    { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
    { value: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    { value: 'gpt-oss-120b', label: 'GPT-OSS 120B' },
  ];

  it('keeps a Google sign-in’s models verbatim, base name and level-suffixed slug alike', () => {
    expect(modelForProvider(AgentProvider.ANTIGRAVITY, 'claude-opus-5-5', googleCatalog)).toBe(
      'claude-opus-5-5',
    );
    expect(modelForProvider(AgentProvider.ANTIGRAVITY, 'claude-sonnet-5-5', googleCatalog)).toBe(
      'claude-sonnet-5-5',
    );
    expect(modelForProvider(AgentProvider.ANTIGRAVITY, 'gpt-oss-120b', googleCatalog)).toBe(
      'gpt-oss-120b',
    );
    // The full slugs `agy models` prints — the runner splits them back into `--model`/`--effort`.
    expect(modelForProvider(AgentProvider.ANTIGRAVITY, 'claude-opus-5-5-high', googleCatalog)).toBe(
      'claude-opus-5-5-high',
    );
    expect(modelForProvider(AgentProvider.ANTIGRAVITY, 'claude-sonnet-5-5-medium', googleCatalog))
      .toBe('claude-sonnet-5-5-medium');
    expect(modelForProvider(AgentProvider.ANTIGRAVITY, 'gpt-oss-120b-medium', googleCatalog)).toBe(
      'gpt-oss-120b-medium',
    );
  });

  it('keeps the Gemini rows the same catalogue lists — the API-key path does not regress', () => {
    // Every API-key runner reports the same catalogue shape, without the account's extra rows.
    const apiKey = [
      { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
      { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
    ];
    for (const catalog of [googleCatalog, apiKey]) {
      expect(modelForProvider(AgentProvider.ANTIGRAVITY, 'gemini-3.8-flash', catalog)).toBe(
        'gemini-3.8-flash',
      );
      expect(modelForProvider(AgentProvider.ANTIGRAVITY, 'gemini-3.8-flash-high', catalog)).toBe(
        'gemini-3.8-flash-high',
      );
    }
    // …and a catalogue that is silent keeps the prefix rule that has always answered for it.
    for (const silent of [undefined, null, []]) {
      expect(modelForProvider(AgentProvider.ANTIGRAVITY, 'gemini-3.8-flash', silent)).toBe(
        'gemini-3.8-flash',
      );
      expect(modelForProvider(AgentProvider.ANTIGRAVITY, 'gemini-3.8-flash-high', silent)).toBe(
        'gemini-3.8-flash-high',
      );
      expect(modelForProvider(AgentProvider.ANTIGRAVITY, 'claude-opus-5-5', silent)).toBe('');
    }
  });

  it('falls back to agy’s own default for an id the catalogue does not list', () => {
    // A catalogue that has spoken is authoritative in both directions: an id agy does not list is
    // one it refuses to start on, so the session runs agy's own default instead of failing the turn.
    expect(modelForProvider(AgentProvider.ANTIGRAVITY, 'claude-opus-5', googleCatalog)).toBe('');
    expect(modelForProvider(AgentProvider.ANTIGRAVITY, 'gpt-5.6-sol', googleCatalog)).toBe('');
    // A Gemini id this catalogue does not carry: agy would refuse it too (the list is agy's own).
    expect(modelForProvider(AgentProvider.ANTIGRAVITY, 'gemini-9-ultra', googleCatalog)).toBe('');
    // An API-key session switched to an account that dropped a model it was pinned to.
    expect(
      modelForProvider(AgentProvider.ANTIGRAVITY, 'gemini-3.7-flash', [
        { value: 'gemini-3.8-flash' },
      ]),
    ).toBe('');
  });

  it('leaves the same ids alone on the runtimes that own those prefixes', () => {
    // The account catalogue borrows other vendors' id spaces; the runtimes that own them keep
    // deciding for themselves, catalogue or not (`offered` is the runner's rows for THIS space).
    expect(modelForProvider(AgentProvider.CLAUDE, 'claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(modelForProvider(AgentProvider.CODEX, 'gpt-oss-120b')).toBe('gpt-oss-120b');
  });
});

describe('fastModeAvailable', () => {
  it('offers the fast lane on the Claude models that have one', () => {
    expect(fastModeAvailable(AgentProvider.CLAUDE, 'claude-opus-5')).toBe(true);
    expect(fastModeAvailable(AgentProvider.CLAUDE, 'claude-opus-4-8')).toBe(true);
  });

  it('refuses it on a Claude model that does not', () => {
    // Claude Code's own answer, and the reason the pickers must ask rather than assume: it
    // refuses fast mode outright on anything whose capability list does not carry it, so a
    // session pinned here would carry a setting the engine drops without saying so.
    expect(fastModeAvailable(AgentProvider.CLAUDE, 'claude-sonnet-5')).toBe(false);
    expect(fastModeAvailable(AgentProvider.CLAUDE, 'claude-haiku-4-5')).toBe(false);
    expect(fastModeAvailable(AgentProvider.CLAUDE, '')).toBe(false);
  });

  it('refuses it on the runtimes that have no fast lane at all', () => {
    // The Opus id is deliberate — it is the one that would pass if this were asked of the model
    // alone.
    for (const runtime of [AgentProvider.KIMI, AgentProvider.OPENCODE]) {
      expect(fastModeAvailable(runtime, 'claude-opus-5')).toBe(false);
    }
    // A configured (BYOK) slug reaches here as its BORROWED runtime, never as the slug: one that
    // borrows claude is answered like Claude (a second Anthropic account is the common case, and
    // the CLI's own first-party check covers the other), and an UNRESOLVED one — which is what
    // this looks like — must not be a yes.
    expect(fastModeAvailable('', 'claude-opus-5')).toBe(false);
    expect(fastModeAvailable('acme-anthropic', 'claude-opus-5')).toBe(false);
  });
});

describe('fastModeAvailable on Codex', () => {
  const catalog = (serviceTiers?: string[]) => ({
    [AgentProvider.CODEX]: [{ value: 'gpt-6-astra', label: 'GPT-6-Astra', serviceTiers }],
  });

  it("offers it on a model whose catalogue row advertises Codex's priority tier", () => {
    expect(fastModeAvailable(AgentProvider.CODEX, 'gpt-6-astra', catalog(['priority']))).toBe(true);
  });

  it('refuses it on a row that advertises no such tier, and on a model with no row at all', () => {
    // No row is a no here, unlike an effort level: codex does not refuse an unadvertised tier, it
    // drops it from the request without a word, so "unknown" must not draw a control that does
    // nothing.
    expect(fastModeAvailable(AgentProvider.CODEX, 'gpt-6-astra', catalog([]))).toBe(false);
    expect(fastModeAvailable(AgentProvider.CODEX, 'gpt-6-astra', catalog())).toBe(false);
    expect(fastModeAvailable(AgentProvider.CODEX, 'gpt-5.6-sol', catalog(['priority']))).toBe(false);
    expect(fastModeAvailable(AgentProvider.CODEX, 'gpt-6-astra')).toBe(false);
  });

  it('never answers a Claude model from a Codex catalogue, or the other way round', () => {
    expect(fastModeAvailable(AgentProvider.CLAUDE, 'gpt-6-astra', catalog(['priority']))).toBe(false);
    expect(fastModeAvailable(AgentProvider.CODEX, 'claude-opus-5', catalog(['priority']))).toBe(false);
  });
});

/**
 * Where the Claude fast-lane answer comes from, on the same terms as Auto: the static set is a
 * fallback for a runner that has not spoken, so emptying it changes none of the assertions below.
 *
 * The failure being closed: Opus 5.5 shipped with a fast lane, runners reported it, and every
 * composer hid `/fast` on it because a set in this repo had not been edited.
 */
describe('fastModeAvailable on Claude reads the assigned runner’s catalogue', () => {
  const claude = (model: string, fastMode?: boolean) => ({
    [AgentProvider.CLAUDE]: [{ value: model, label: model, fastMode }],
  });

  it('offers the lane on a model the runner reports it for, whatever the static set says', () => {
    // An id in no static set — a release the clients have never heard of is usable as soon as a
    // runner's own CLI says it has the lane.
    expect(fastModeAvailable(AgentProvider.CLAUDE, 'claude-opus-9', claude('claude-opus-9', true)))
      .toBe(true);
  });

  it('withdraws it when the runner’s row says no, even for a model in the static set', () => {
    expect(fastModeAvailable(AgentProvider.CLAUDE, 'claude-opus-5', claude('claude-opus-5', false)))
      .toBe(false);
  });

  it('falls back to the static set only where the catalogue has not answered', () => {
    // Silence in its three shapes — no catalogue, no row for this model, a row from a runner too
    // old to report the field — none of which may read as "no".
    const stale = { [AgentProvider.CLAUDE]: [{ value: 'claude-opus-5', label: 'Opus 5' }] };
    for (const catalog of [undefined, null, claude('claude-sonnet-5', true), stale]) {
      expect(fastModeAvailable(AgentProvider.CLAUDE, 'claude-opus-5', catalog)).toBe(true);
      expect(fastModeAvailable(AgentProvider.CLAUDE, 'claude-haiku-4-5', catalog)).toBe(false);
    }
  });

  it('never answers a Claude model from the Codex rows', () => {
    const codexRows = {
      [AgentProvider.CODEX]: [{ value: 'claude-opus-9', label: 'x', fastMode: true }],
    };
    expect(fastModeAvailable(AgentProvider.CLAUDE, 'claude-opus-9', codexRows)).toBe(false);
  });
});
