import type { RunnerModelInfo } from './dto';

/**
 * How a Cursor CLI session names its model and the settings it runs that model with
 * (docs/cursor-runtime-contract.md §10).
 *
 * The runner drives Cursor CLI with the parameterized model picker: a model is selected by its bare
 * name (`claude-opus-5-5`; Auto is `default`), and each setting it takes is a select option of its own
 * that only that model lists — an effort, a context size, a fast lane. A session has no field for a
 * context size or for Cursor's fast lane (`fastMode` is the engine-level switch, which Cursor CLI does
 * not have), so both ride in the session's model value, written the way Cursor writes a variant:
 * `claude-opus-5-5[context=1m,fast=true]`. The effort stays in the session's `effort`. Auto takes no
 * settings, so it is always the bare `default`.
 *
 * The ids and values are Cursor's own, as the runner's catalogue lists them (`parameters` on a
 * RunnerModelInfo): opaque, never rebuilt from a label and never carried from one model to another.
 * A setting at the model's own default is left out, so a model on every default is its bare name. The
 * runner selects the bare model first and then each of these settings the model lists: the value
 * named, else the model's default. A setting the model does not list, or a value it does not offer, is
 * left at the model's own and logged. Web, iOS and Android write and read the value with these two
 * functions' rules.
 */

/** Auto, Cursor CLI's own pick for each request: the model a session runs when it names none. It takes
 *  no settings (§10). */
export const CURSOR_AUTO_MODEL = 'default';

/** The settings a Cursor model value carries, by Cursor's option ids: the context size and the fast
 *  lane. Clients offer exactly these, and the runner sets exactly these; the effort is `effort`'s. */
export const CURSOR_VARIANT_PARAMETERS = ['context', 'fast'] as const;

/** A Cursor model value read apart: the model's bare name and the settings it names, by id. */
export interface CursorModelVariant {
  model: string;
  parameters: Record<string, string>;
}

/** One `id=value` of a variant. Neither side may hold what the syntax itself is made of. */
const PAIR = /^([^\s=,[\]]+)=([^\s=,[\]]+)$/;

/**
 * Reads a Cursor model value: `name[id=value,…]`, with at least one setting, is the model `name` with
 * those settings, and anything else is a model's name as it stands, naming no settings — `default[]`
 * and every other empty `[]`, Claude Code's `claude-opus-5[1m]`, a value with an empty name or a
 * malformed or repeated setting. Such a value reaches Cursor CLI unread, as it did before variants.
 */
export function decodeCursorModel(value: string | null | undefined): CursorModelVariant {
  const text = (value ?? '').trim();
  const open = text.indexOf('[');
  const asIs = { model: text, parameters: {} };
  if (open <= 0 || !text.endsWith(']') || text.indexOf(']') !== text.length - 1 || text.lastIndexOf('[') !== open) {
    return asIs;
  }
  const parameters: Record<string, string> = {};
  for (const pair of text.slice(open + 1, -1).split(',')) {
    const match = PAIR.exec(pair);
    if (!match || match[1] in parameters) return asIs;
    parameters[match[1]] = match[2];
  }
  return { model: text.slice(0, open), parameters };
}

/**
 * Writes a Cursor model value: the model's bare name, followed by the settings given, in the order of
 * their ids, when there are any. A setting with no value is left out, and so is one at the model's own
 * default, where the model's catalogue row (`row`) says what that is, and one the syntax cannot hold.
 * Auto (or no model at all) takes none. decodeCursorModel reads back the name and the settings written.
 */
export function encodeCursorModel(
  model: string,
  parameters: Readonly<Record<string, string | null | undefined>> = {},
  row?: Pick<RunnerModelInfo, 'parameters'> | null,
): string {
  const name = model.trim();
  if (!name || name === CURSOR_AUTO_MODEL) return name;
  const defaults = new Map((row?.parameters ?? []).map((parameter) => [parameter.id, parameter.default]));
  const pairs = Object.entries(parameters)
    .filter((entry): entry is [string, string] =>
      typeof entry[1] === 'string' && entry[1] !== defaults.get(entry[0]) && PAIR.test(`${entry[0]}=${entry[1]}`))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return pairs.length ? `${name}[${pairs.map(([id, value]) => `${id}=${value}`).join(',')}]` : name;
}
