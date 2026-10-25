// Redaction for everything that leaves a run: recordings, fixtures, summaries and console lines.
// Secrets are replaced outright; machine paths and ids get stable placeholders so correlations
// (same session id in new/load/list, same path in tool calls) survive.
export class Redactor {
  constructor() {
    this.secrets = [];
    this.paths = [];
    this.ids = new Map();
  }
  secret(value, label = 'SECRET') {
    if (value && value.length >= 8) this.secrets.push([value, `<${label}>`]);
    return this;
  }
  path(from, to) {
    if (from) this.paths.push([from, to]);
    this.paths.sort((a, b) => b[0].length - a[0].length);
    return this;
  }
  text(input) {
    let s = String(input);
    for (const [from, to] of this.secrets) s = s.split(from).join(to);
    s = s.replace(/crsr_[0-9a-zA-Z_]{16,}/g, '<CURSOR_API_KEY>');
    s = s.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<JWT>');
    s = s.replace(/("(?:accessToken|refreshToken|access_token|refresh_token|authToken|apiKey|api_key|token|idToken|sessionToken)"\s*:\s*")[^"]{8,}(")/g, '$1<REDACTED>$2');
    s = s.replace(/([?&](?:challenge|uuid|code|verifier|token|state)=)[A-Za-z0-9_%.-]{6,}/g, '$1<REDACTED>');
    s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, m => (m.endsWith('@cursor.com') || m.endsWith('@anysphere.co') ? m : '<EMAIL>'));
    // Account identity in CLI output (status, about, GetMe), raw or as escaped JSON inside a string.
    s = s.replace(/(\\?")(firstName|lastName|displayName|userId|authId|workosId|publicUserId|profilePictureUrl|teamName|createdAt|country)(\\?")(\s*:\s*)(\\?"[^"\\]*\\?"|-?\d+)/g,
      (m, q, key, q2, sep) => `${q}${key}${q2}${sep}${q}<redacted>${q}`);
    s = s.replace(/(google-oauth2|auth0|github)\|[A-Za-z0-9_]+/g, '<AUTH_ID>').replace(/\buser_[A-Za-z0-9]{20,}\b/g, '<USER_ID>');
    for (const [from, to] of this.paths) s = s.split(from).join(to);
    s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, id => {
      const k = id.toLowerCase();
      if (!this.ids.has(k)) this.ids.set(k, `<UUID_${this.ids.size + 1}>`);
      return this.ids.get(k);
    });
    return s;
  }
  value(v) {
    if (v === undefined) return null;
    if (typeof v === 'string') return this.text(v);
    return JSON.parse(this.text(JSON.stringify(v)));
  }
}
