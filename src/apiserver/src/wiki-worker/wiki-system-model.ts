import { Logger } from '@nestjs/common';
import { WIKI_SYSTEM_MODEL, WIKI_SYSTEM_MODEL_ENV } from '@orbit/shared';

/**
 * The System model as the wiki-worker's environment sets it (contract `systemModel.env`, design §2.1): an
 * endpoint speaking the Anthropic Messages API, the key it is sent as a Bearer, the model to name, and how
 * many requests the queue keeps in flight across every space. Shaped after `wiki/wiki-rollout.ts`: a pure
 * read of the environment that says what it could not take as written, and a log of that said once.
 *
 *   ORBIT_WIKI_MODEL_BASE_URL     the endpoint, an http(s) URL; calls go to `{base}/v1/messages`
 *   ORBIT_WIKI_MODEL_API_KEY      the key
 *   ORBIT_WIKI_MODEL              the model's name
 *   ORBIT_WIKI_MODEL_CONCURRENCY  requests in flight at once; 4 when unset
 *
 * The first three are the System model: with any of them missing or unusable it is unconfigured, and the
 * worker probes and calls nothing. Only the worker reads these — the apiserver's environment has none of
 * them — and nothing read here leaves the worker except the model's name: no problem quotes the key or the
 * address, so the reason a state row gives can be built from them.
 */
export interface WikiSystemModelConfig {
  /** baseUrl, apiKey and model are all set and usable. */
  configured: boolean;
  /** The endpoint without a trailing slash; null unless configured. */
  baseUrl: string | null;
  /** Null unless configured. */
  apiKey: string | null;
  /** ORBIT_WIKI_MODEL as set, configured or not; null when it is not. */
  model: string | null;
  concurrency: number;
  /** The variables of the first three that are missing or unusable: why the model is unconfigured. */
  missing: readonly string[];
  /** What the environment said that could not be taken as written, each with how it was read instead. */
  problems: readonly string[];
}

export function readWikiSystemModel(env: NodeJS.ProcessEnv = process.env): WikiSystemModelConfig {
  const problems: string[] = [];
  const value = (name: string) => (env[name] ?? '').trim();
  const base = value(WIKI_SYSTEM_MODEL_ENV.baseUrl);
  const apiKey = value(WIKI_SYSTEM_MODEL_ENV.apiKey);
  const model = value(WIKI_SYSTEM_MODEL_ENV.model);

  let baseUrl: string | null = null;
  if (base !== '') {
    let url: URL | null = null;
    try {
      url = new URL(base);
    } catch {
      url = null;
    }
    // fetch refuses a URL that carries credentials, so one would fail every call: the key has its own variable.
    if (url && (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) {
      baseUrl = base.replace(/\/+$/, '');
    } else {
      // The value is not quoted: it is the address.
      problems.push(`${WIKI_SYSTEM_MODEL_ENV.baseUrl} is not an http or https URL without credentials: the System model is unconfigured`);
    }
  }

  const missing: string[] = [];
  if (baseUrl === null) missing.push(WIKI_SYSTEM_MODEL_ENV.baseUrl);
  if (apiKey === '') missing.push(WIKI_SYSTEM_MODEL_ENV.apiKey);
  if (model === '') missing.push(WIKI_SYSTEM_MODEL_ENV.model);
  // Some set and some not is a configuration somebody started; none set is a deployment without a System model.
  if (missing.length > 0 && (base !== '' || apiKey !== '' || model !== '')) {
    const unset = missing.filter((name) => value(name) === '');
    if (unset.length > 0) {
      problems.push(`${unset.join(', ')} ${unset.length === 1 ? 'is' : 'are'} not set: the System model needs `
        + `${WIKI_SYSTEM_MODEL_ENV.baseUrl}, ${WIKI_SYSTEM_MODEL_ENV.apiKey} and ${WIKI_SYSTEM_MODEL_ENV.model}, and is unconfigured`);
    }
  }

  let concurrency: number = WIKI_SYSTEM_MODEL.defaultConcurrency;
  const asked = value(WIKI_SYSTEM_MODEL_ENV.concurrency);
  if (asked !== '') {
    if (/^\d+$/.test(asked) && Number.isSafeInteger(Number(asked)) && Number(asked) >= 1) {
      concurrency = Number(asked);
    } else {
      problems.push(`${WIKI_SYSTEM_MODEL_ENV.concurrency}=${JSON.stringify(env[WIKI_SYSTEM_MODEL_ENV.concurrency])} is not a `
        + `positive whole number: ${WIKI_SYSTEM_MODEL.defaultConcurrency} is used`);
    }
  }

  const configured = missing.length === 0;
  return {
    configured,
    baseUrl: configured ? baseUrl : null,
    apiKey: configured ? apiKey : null,
    model: model === '' ? null : model,
    concurrency,
    missing,
    problems,
  };
}

const log = new Logger('WikiSystemModel');
let announced: string | undefined;

/** The System model as this process's environment sets it, said once in the log whenever what it says changes. */
export function currentWikiSystemModel(): WikiSystemModelConfig {
  const config = readWikiSystemModel(process.env);
  // Never the key: it is not part of what is said, nor of what decides whether to say it again.
  const said = [config.baseUrl, config.model, config.concurrency, ...config.missing, ...config.problems].join('|');
  if (said !== announced) {
    announced = said;
    for (const problem of config.problems) log.warn(problem);
    log.log(
      config.configured && config.baseUrl
        // The worker's own log may name where it calls: the origin, never a path's or a query's secrets.
        ? `System model ${config.model} at ${new URL(config.baseUrl).origin}; ${config.concurrency} request(s) in flight at once`
        : `No System model is configured (${config.missing.join(', ')}): the wiki worker probes and calls nothing`,
    );
  }
  return config;
}
