/**
 * Credentials taken out of free text before Orbit stores or shows it (docs/wiki-design.md §10.2). A watch
 * delivery's failure text goes through here, and so will what an agent proposes to the wiki, the dossier cut from a
 * session and a rendered entry. Each shape below is replaced by `[redacted]` and the text around it is left as it
 * was, so a reader still sees what was said, and that something was withheld.
 *
 * Nothing here reads the database. The values of the owner's `workspace.env` arrive as `literals` and are replaced
 * wherever they appear verbatim, whatever their shape.
 */

export const REDACTED = '[redacted]';

/** A literal shorter than this is left alone: a value like `dev` or `on` is everywhere and says nothing secret. */
const MIN_LITERAL_CHARS = 4;

// A JSON web token, signed or not. It starts where no `-` or word character comes before it, so that a long run of
// `eyJ-eyJ-…` is read once rather than once for every `eyJ` in it.
const JSON_WEB_TOKEN = /(?<![\w-])eyJ[\w-]+\.[\w-]+\.[\w-]*/g;
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/g;
const AWS_ACCESS_KEY_ID = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const SLACK_TOKEN = /\bxox[abprs]-[0-9A-Za-z-]{10,}/g;
const GOOGLE_API_KEY = /\bAIza[\w-]{30,}/g;
const GITLAB_TOKEN = /\bglpat-[\w.-]{20,}/g;
const NPM_TOKEN = /\bnpm_[A-Za-z0-9]{30,}/g;

/** Each secret shape, and what replaces it, in the order they are applied. */
const SECRETS: ReadonlyArray<readonly [RegExp, string]> = [
  // A PEM private key, from its BEGIN line to the END line of the same label, or to the end of the text when that
  // line was cut off. The newlines may be JSON-escaped, as in a service account's "private_key".
  [/-----BEGIN ([A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?(?:-----END \1-----|$)/g, REDACTED],
  // The userinfo of any URL, up to its last `@`: postgres://orbit:hunter2@db:5432/orbit, redis://:p@ss@cache.
  [/([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#]+@/gi, `$1${REDACTED}@`],
  // An authorization scheme and its credentials. A word after the scheme is prose ("Bearer tokens", "a basic
  // example"), so a credential shorter than twenty characters needs a digit or a capital in it.
  [/\b(Bearer|Basic|bearer|basic|BEARER|BASIC)([ \t]+)(?:(?=[\w.~+/=-]*[0-9A-Z])[\w.~+/=-]{6,}|[\w.~+/=-]{20,})/g, `$1$2${REDACTED}`],
  [JSON_WEB_TOKEN, REDACTED],
  // Provider keys: sk-…, pk-…, rk-… (sk-ant-…, sk-proj-…) and Stripe's sk_live_…, GitHub tokens, AWS access key
  // ids, Slack, Google, GitLab and npm tokens.
  [/\b(?:sk|pk|rk)-[\w-]{16,}/g, REDACTED],
  [/\b(?:sk|pk|rk)_(?:live|test)_[0-9A-Za-z]{10,}/g, REDACTED],
  [GITHUB_TOKEN, REDACTED],
  [AWS_ACCESS_KEY_ID, REDACTED],
  [SLACK_TOKEN, REDACTED],
  [GOOGLE_API_KEY, REDACTED],
  [GITLAB_TOKEN, REDACTED],
  [NPM_TOKEN, REDACTED],
  // A value given to a name that says it holds a secret, whatever comes before or after that word in the name:
  // POSTGRES_PASSWORD=…, ANTHROPIC_API_KEY: …, x-api-key: …, "clientSecret": "…", password := "…". Nothing is
  // asked of the character before the word: a `\b` there let POSTGRES_PASSWORD through, `_` being a word character.
  // `tokens` is a count (max_tokens: 4096), not a token. A quoted value is replaced up to its closing quote.
  [
    /((?:password|passwd|pwd|secret|token(?!s)|api[_-]?key|access[_-]?key|private[_-]?key)\w{0,64})(["']?[ \t]*(?:=>|:=|={1,3}|:(?!:))[ \t]*)(?:(["'])(?:\\.|(?!\3)[^\\\n])*\3|\S+)/gi,
    `$1$2$3${REDACTED}$3`,
  ],
];

export interface SecretRedaction {
  text: string;
  /** Whether anything was replaced. A text with nothing to take out comes back as it was. */
  redacted: boolean;
}

/**
 * `text` with every secret shape in it replaced, then every literal wherever it appears verbatim, the longest first
 * so that a value holding another is taken whole. The shapes go first: a literal such as `postgres` or `Bearer`,
 * replaced before them, would take away the scheme or the word a shape finds its credential after.
 */
export function redactSecrets(text: string, options: { literals?: readonly string[] } = {}): SecretRedaction {
  let redacted = SECRETS.reduce((current, [shape, replacement]) => current.replace(shape, replacement), text);
  const literals = [...new Set(options.literals ?? [])]
    .filter((literal) => literal.length >= MIN_LITERAL_CHARS)
    .sort((a, b) => b.length - a.length);
  for (const literal of literals) redacted = redacted.split(literal).join(REDACTED);
  return { text: redacted, redacted: redacted !== text };
}

/**
 * The credentials a file is refused for (docs/orbit-files-design.md §2.9), each with what a refusal calls it. Narrower
 * than SECRETS on purpose. Taking a word too many out of a text costs that word, but refusing a file costs the whole
 * file and sends an agent back to committing it to a public repository. So each shape here is one an issuer gives its
 * keys, and none goes by a name (`password=`), a scheme (`Bearer`) or a URL's userinfo, which ordinary test logs are
 * full of.
 */
export const ISSUED_CREDENTIALS: ReadonlyArray<{ kind: string; shape: RegExp }> = [
  // A BEGIN line with key material straight after it, or the armor header only a real block has there. The line breaks
  // may be JSON-escaped, and the lines indented, as in YAML. The line alone is text about keys, as in a runbook or a
  // parser's error, and holds nothing to protect. No shape here may nest one repetition inside another: an upload is
  // text an agent chose, this runs on the server's event loop, and a nested one over crafted text never returns.
  {
    kind: 'a private key',
    shape: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----(?:\\+[nr]|\s)+(?:[A-Za-z0-9+/=]{40}|(?:Proc-Type|Version|Comment): )/,
  },
  { kind: 'a JSON web token', shape: JSON_WEB_TOKEN },
  // An issuer's prefix and a key's length after it, or `sk-` and 32 letters and digits in one run, as a legacy OpenAI
  // key and a DeepSeek key have. SECRETS' wider `sk-…` also takes every fixture and slug: `sk-ant-fixture-1`,
  // `sk-lab-fake-key`.
  { kind: 'an API key', shape: /\bsk-(?:(?:ant|proj|svcacct|admin)-[\w-]{32,}|[0-9A-Za-z]{32,})/ },
  // Not `pk_`, which is public, and not `_test_`, which is made to be in test logs.
  { kind: 'a Stripe live key', shape: /\b[sr]k_live_[0-9A-Za-z]{24,}/ },
  { kind: 'a GitHub token', shape: GITHUB_TOKEN },
  { kind: 'an AWS access key id', shape: AWS_ACCESS_KEY_ID },
  { kind: 'a Slack token', shape: SLACK_TOKEN },
  { kind: 'a Google API key', shape: GOOGLE_API_KEY },
  { kind: 'a GitLab token', shape: GITLAB_TOKEN },
  { kind: 'an npm token', shape: NPM_TOKEN },
];

/**
 * Where the first of ISSUED_CREDENTIALS in `text` is, and what it looks like. The credential's own text stays in here, so
 * that no caller can repeat it.
 */
export function findIssuedCredential(text: string): { kind: string; index: number } | null {
  for (const { kind, shape } of ISSUED_CREDENTIALS) {
    const index = text.search(shape);
    if (index !== -1) return { kind, index };
  }
  return null;
}
