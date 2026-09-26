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
  // A JSON web token, signed or not. It starts where no `-` or word character comes before it, so that a long run of
  // `eyJ-eyJ-…` is read once rather than once for every `eyJ` in it.
  [/(?<![\w-])eyJ[\w-]+\.[\w-]+\.[\w-]*/g, REDACTED],
  // Provider keys: sk-…, pk-…, rk-… (sk-ant-…, sk-proj-…) and Stripe's sk_live_…, GitHub tokens, AWS access key
  // ids, Slack, Google, GitLab and npm tokens.
  [/\b(?:sk|pk|rk)-[\w-]{16,}/g, REDACTED],
  [/\b(?:sk|pk|rk)_(?:live|test)_[0-9A-Za-z]{10,}/g, REDACTED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bxox[abprs]-[0-9A-Za-z-]{10,}/g, REDACTED],
  [/\bAIza[\w-]{30,}/g, REDACTED],
  [/\bglpat-[\w.-]{20,}/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{30,}/g, REDACTED],
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
