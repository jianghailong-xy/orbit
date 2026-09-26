/**
 * Whether an account's sessions may orchestrate: spawn and drive other sessions through `orbit
 * mcp`, and use the tools that spend the same grant (Settings → Session orchestration).
 *
 * One switch per account, read live wherever the grant is decided — the claim and reclaim that
 * advertise the tools and issue the credential, the authorizer every call goes through, and the
 * spawn itself — so turning it off takes effect on the next call, in every workspace at once. It
 * used to be a column on each workspace (dropped in migration 0308). On unless the owner turned it
 * off: only opting out is ever written, like the notification switches.
 *
 * `owner` is required rather than optional so a read that forgot to select it fails to compile
 * instead of quietly answering "on".
 */
export function orchestrationEnabled(owner: { preferences: unknown }): boolean {
  const prefs = (owner.preferences ?? {}) as { enableOrchestration?: unknown };
  return prefs.enableOrchestration !== false;
}
