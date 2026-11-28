/**
 * Whether `host` (a URL's hostname) is one the server must never be aimed at on somebody's say-so:
 * loopback, link-local or a private range. A basic SSRF guard; DNS is not re-resolved.
 */
export function isInternalHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '0.0.0.0' ||
    h === '::1' ||
    // WHATWG URL keeps the brackets on an IPv6 hostname.
    h === '[::1]' ||
    /^127\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

/**
 * The Gemini API model agy calls for one of its own model names, which is what the connection test
 * has to ask for to probe the model a session runs. agy names a model by family and thinking level
 * (`gemini-3.8-flash-high`, or the base name and `--effort`) and maps it onto an API id itself;
 * measured on agy 1.2.16 that id is the base name for every model it lists except 3.1 Pro, which the
 * API still serves only as a preview (docs/antigravity-runtime-contract.md §9.2). A name agy does
 * not list is asked for as it is.
 */
export function geminiApiModel(model: string): string {
  const base = model.replace(/-(low|medium|high|xhigh|max)$/, '');
  return base === 'gemini-3.1-pro' ? 'gemini-3.1-pro-preview' : base;
}
