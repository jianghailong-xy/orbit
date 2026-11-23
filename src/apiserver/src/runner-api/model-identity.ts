import { Logger } from '@nestjs/common';
import { deepSeekCall } from '../sessions/naming';

/**
 * Which model ids name the same model, for Settings → Model routing: rows of one model on different engines show
 * one name and share one Quality figure (model-quality.ts). Display only: routing never reads any of it.
 *
 * Two steps. The id rules (modelRuleKey) take off what an engine wraps an id in, so `claude-sonnet-5-5` on Claude
 * Code and on Antigravity, or a Cursor variant of it, are one key with no question asked. An Antigravity id's level
 * (`claude-opus-5-5-high`) is taken off by the caller that knows the engine (antigravityBaseModel), never here. What the rules cannot
 * settle — `kimi-code/k3` beside `kimi-k3`, an alias like `deepseek-flash` beside `deepseek-v4-flash` — is asked
 * of DeepSeek on the server's own key, once per key, in the background (learnModelIdentities), and its answer kept
 * in model_identity, so the page stays the same from one load to the next. A key nobody has decided is its own model.
 */

/** A model's identity: the rule key of the model it is (its own when it is no other's), and its vendor name. */
export interface ModelIdentity {
  key: string;
  name: string | null;
}

/** A model id as the page lists it, with what it knows about it, for DeepSeek to judge. */
export interface ModelSighting {
  model: string;
  /** The engine's or the owner's name for it, when there is one. */
  label?: string | null;
  /** The provider slug it was seen under. */
  provider: string;
}

/**
 * An id with an engine's wrapping taken off: lower case; DeepSeek Harness's `["deepseek", "deepseek-v4-pro"]`
 * token read as its model; a Cursor variant's `[context=1m]` dropped; a `vendor/` prefix dropped; a dot between
 * digits written as a dash (`5.5` and `5-5`). Two ids with one key are one model; two keys may still be, which is
 * DeepSeek's to say. A trailing level is NOT dropped: `-max` names Qwen3.7 Max (`qwen3.7-max`), not an effort.
 */
export function modelRuleKey(model: string): string {
  let id = model.trim();
  if (id.startsWith('[')) {
    try {
      const parts = JSON.parse(id) as unknown;
      if (Array.isArray(parts) && typeof parts[parts.length - 1] === 'string') id = parts[parts.length - 1] as string;
    } catch {
      // Not a token: read as written.
    }
  }
  id = id.toLowerCase().replace(/\[.*\]$/, '');
  id = id.slice(id.lastIndexOf('/') + 1);
  return id.replace(/(\d)\.(?=\d)/g, '$1-') || model;
}

/** The fields of the client this needs; a Prisma client or a double. */
export interface ModelIdentityDb {
  modelIdentity: {
    findMany(args: { where: { ruleKey: { in: string[] } } }): PromiseLike<Array<{ ruleKey: string; canonicalKey: string; name: string | null }>>;
    createMany(args: { data: Array<{ ruleKey: string; canonicalKey: string; name: string | null }>; skipDuplicates: true }): PromiseLike<unknown>;
  };
}

/** Each id's identity: what model_identity holds for its rule key, else its rule key alone. Reads only. */
export async function readModelIdentities(db: ModelIdentityDb, models: Iterable<string>): Promise<Map<string, ModelIdentity>> {
  const keys = new Map<string, string>();
  for (const model of models) keys.set(model, modelRuleKey(model));
  const rows = keys.size ? await db.modelIdentity.findMany({ where: { ruleKey: { in: [...new Set(keys.values())] } } }) : [];
  const decided = new Map(rows.map((row) => [row.ruleKey, { key: row.canonicalKey, name: row.name }]));
  return new Map([...keys].map(([model, key]) => [model, decided.get(key) ?? { key, name: null }]));
}

/** At most this many keys go in one question; the rest wait for the next load. */
const BATCH = 40;
/** After a failed question this process asks nothing for this long, so a page load is not a DeepSeek call while it is down. */
const BACKOFF_MS = 10 * 60_000;
const TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT =
  'You identify AI language models. Coding tools and API vendors spell the same model differently: a tool ' +
  'prefix (kimi-code/k3), a vendor prefix, a short alias, or a display label. You get KNOWN models (key and ' +
  'name) and NEW model keys, each with the labels and providers it was seen under. For each NEW key say ' +
  'whether it is the very same model, same version, as one KNOWN key or another NEW key. Different versions, ' +
  'sizes or variants (pro vs flash, 5.5 vs 5.6, highspeed) are different models. An alias that tracks the ' +
  'newest release is the same as a versioned key only if you are sure which version it serves now. When in ' +
  'doubt, answer null. Also give each NEW key the vendor\'s own display name (e.g. "Claude Sonnet 5.5", ' +
  '"Kimi K3", "DeepSeek V4 Flash"), or null if you do not know the model. Reply with JSON only: ' +
  '{"models":[{"key":"<new key>","sameAs":"<a known or new key, or null>","name":"<name or null>"}]}';

/** One question to DeepSeek: the JSON text of its answer, or null when it gave none. */
export type AskModelIdentity = (system: string, task: string) => Promise<string | null>;

const askDeepSeek: AskModelIdentity = async (system, task) => {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) return null;
  const call = deepSeekCall(apiKey, system, task, { maxTokens: 4096 });
  const resp = await fetch(call.url, {
    method: 'POST',
    headers: call.headers,
    body: JSON.stringify(call.body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) {
    await resp.body?.cancel().catch(() => undefined);
    throw new Error(`DeepSeek answered ${resp.status}`);
  }
  const text = call.text(await resp.json());
  return typeof text === 'string' ? text : null;
};

const asking = new Set<string>();
let quietUntil = 0;
const logger = new Logger('ModelIdentity');

/** For specs: forget what is being asked and any back-off. */
export function resetModelIdentityLearning(): void {
  asking.clear();
  quietUntil = 0;
}

/**
 * Ask DeepSeek about the keys of `sightings` that model_identity has not decided, and keep its answers. Never
 * throws: a failure writes nothing and the keys are asked again after BACKOFF_MS. Without a server DeepSeek key
 * it asks nothing, and every key stays its own model.
 */
export async function learnModelIdentities(
  db: ModelIdentityDb,
  sightings: readonly ModelSighting[],
  ask: AskModelIdentity = askDeepSeek,
  now = Date.now(),
): Promise<void> {
  if (now < quietUntil || (ask === askDeepSeek && !process.env.DEEPSEEK_API_KEY?.trim())) return;
  const seen = new Map<string, { ids: Set<string>; labels: Set<string>; providers: Set<string> }>();
  for (const { model, label, provider } of sightings) {
    const key = modelRuleKey(model);
    const entry = seen.get(key) ?? { ids: new Set(), labels: new Set(), providers: new Set() };
    entry.ids.add(model);
    if (label && label !== model) entry.labels.add(label);
    entry.providers.add(provider);
    seen.set(key, entry);
  }
  let batch: string[] = [];
  try {
    const decided = await db.modelIdentity.findMany({ where: { ruleKey: { in: [...seen.keys()] } } });
    const done = new Set(decided.map((row) => row.ruleKey));
    batch = [...seen.keys()].filter((key) => !done.has(key) && !asking.has(key)).slice(0, BATCH);
    if (batch.length === 0) return;
    for (const key of batch) asking.add(key);
    const known = new Map(decided.filter((row) => row.canonicalKey === row.ruleKey).map((row) => [row.ruleKey, row.name]));
    // A decided key that is another's names its model: known so the new ones can join it.
    for (const row of decided) if (!known.has(row.canonicalKey)) known.set(row.canonicalKey, row.name);
    const task = JSON.stringify({
      known: [...known].map(([key, name]) => ({ key, name })),
      new: batch.map((key) => ({
        key,
        ids: [...seen.get(key)!.ids],
        labels: [...seen.get(key)!.labels],
        providers: [...seen.get(key)!.providers],
      })),
    });
    const answer = await ask(SYSTEM_PROMPT, task);
    if (answer === null) throw new Error('DeepSeek gave no answer');
    const rows = identityRows(answer, batch, known);
    if (rows.length) await db.modelIdentity.createMany({ data: rows, skipDuplicates: true });
  } catch (error) {
    quietUntil = now + BACKOFF_MS;
    logger.warn(`Could not learn model identities: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    for (const key of batch) asking.delete(key);
  }
}

/**
 * The rows DeepSeek's answer comes to. A `sameAs` must name a known model or another key of the batch; anything
 * else, and a key it left out, is no answer (a left-out key is asked again). A chain inside the batch is followed
 * to its end; a model joining a known one takes the known one's name.
 */
export function identityRows(
  answer: string,
  batch: readonly string[],
  known: ReadonlyMap<string, string | null>,
): Array<{ ruleKey: string; canonicalKey: string; name: string | null }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1));
  } catch {
    throw new Error('DeepSeek answered with no JSON');
  }
  const inBatch = new Set(batch);
  const answers = new Map<string, { sameAs: string | null; name: string | null }>();
  for (const item of (parsed as { models?: unknown })?.models instanceof Array ? (parsed as { models: unknown[] }).models : []) {
    const { key, sameAs, name } = (item ?? {}) as { key?: unknown; sameAs?: unknown; name?: unknown };
    if (typeof key !== 'string' || !inBatch.has(key) || answers.has(key)) continue;
    const target = typeof sameAs === 'string' && sameAs !== key && (known.has(sameAs) || inBatch.has(sameAs)) ? sameAs : null;
    const clean = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
    answers.set(key, { sameAs: target, name: clean || null });
  }
  const root = (key: string): string => {
    const visited = new Set<string>();
    let at = key;
    while (!known.has(at) && answers.get(at)?.sameAs && !visited.has(at)) {
      visited.add(at);
      at = answers.get(at)!.sameAs!;
    }
    return at;
  };
  return [...answers].map(([key, { name }]) => {
    const canonicalKey = root(key);
    const rootName = known.has(canonicalKey) ? known.get(canonicalKey) : answers.get(canonicalKey)?.name;
    return { ruleKey: key, canonicalKey, name: rootName ?? name };
  });
}
